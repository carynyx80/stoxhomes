// End-to-end: starts a Hardhat node on 8547, deploys, generates activity, runs the indexer + API,
// and checks every endpoint against on-chain data. Run with `npm test`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, Interface, JsonRpcProvider, MaxUint256, encodeBytes32String, formatEther, parseEther } from "ethers";
import WebSocket from "ws";
import { artifact, deploy, wallets } from "../scripts/deploy-local.js";
import { start } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CONTRACTS = path.resolve(here, "..", "..", "contracts");
const PORT = Number(process.env.TEST_RPC_PORT || 8547);
const RPC = `http://127.0.0.1:${PORT}`;
const E = (n) => parseEther(String(n));
const F = (x) => Number(formatEther(x));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, tol = 1e-6, msg) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${msg ?? ""} ${a} != ${b}`);
let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`  ok - ${name}`); };

async function rpcUp() {
  try {
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
    return r.ok;
  } catch { return false; }
}

async function main() {
  if (await rpcUp()) throw new Error(`port ${PORT} already has a node; stop it first`);
  console.log(`starting hardhat node on :${PORT}`);
  const node = spawn("npx", ["hardhat", "node", "--port", String(PORT)], { cwd: CONTRACTS, detached: true, stdio: "ignore" });
  const killNode = () => { try { process.kill(-node.pid, "SIGTERM"); } catch {} };
  process.on("exit", killNode);
  let app, ws;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "housedex-api-"));
  try {
    for (let i = 0; !(await rpcUp()); i++) { if (i > 120) throw new Error("node did not start"); await sleep(500); }

    // ABIs for the indexer come from the same artifacts we deploy (web/src/contracts may lag).
    const abiDir = path.join(tmp, "abis");
    fs.mkdirSync(abiDir);
    for (const n of ["HousePerpExchange", "HouseIndexOracle", "MockUSDT"]) fs.writeFileSync(path.join(abiDir, `${n}.json`), JSON.stringify(artifact(n).abi));

    const dep = await deploy(RPC);
    console.log("deployed", dep.exchange);
    const provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: true });
    provider.pollingInterval = 200;
    const [keeper, lp, t2, t3, t4, liq] = wallets(provider, 6);
    const A = await Promise.all([keeper, lp, t2, t3, t4, liq].map((w) => w.getAddress()));
    const ex = (w) => new Contract(dep.exchange, artifact("HousePerpExchange").abi, w);
    const usdt = new Contract(dep.usdt, artifact("MockUSDT").abi, keeper);
    const oracle = new Contract(dep.oracle, artifact("HouseIndexOracle").abi, keeper);
    const exIface = new Interface(artifact("HousePerpExchange").abi);
    const send = async (p) => (await p).wait();
    const parse = (rc, name) => rc.logs.map((l) => { try { return exIface.parseLog(l); } catch { return null; } }).find((e) => e?.name === name);

    for (const w of [lp, t2, t3, t4]) {
      await send(usdt.mint(await w.getAddress(), E(2_000_000)));
      await send(new Contract(dep.usdt, artifact("MockUSDT").abi, w).approve(dep.exchange, MaxUint256));
    }
    const NYC = 0, LA = 1;
    await send(ex(lp).deposit(E(1_000_000), 0));

    // NYC print first; the LA scenario's 7-day time travel lets it fully phase in. Since the C1 fix,
    // opens fill at the published target, so opening mid-smoothing would (correctly) cost the gap.
    await send(oracle.pushIndex(encodeBytes32String("NYC"), E(340)));

    // Liquidation scenario first (it time-travels 7 days): 90x long LA, LA print -3%, liquidate.
    const laSize = E(90_000 / 440);
    await send(ex(t4).openPosition(LA, laSize, E(1000), MaxUint256));
    await send(oracle.pushIndex(encodeBytes32String("LA"), E(426.8)));
    await provider.send("evm_increaseTime", [7 * 86400 + 60]);
    await provider.send("evm_mine", []);
    const liqRc = await send(ex(liq).liquidate(LA, A[4]));
    assert.ok(parse(liqRc, "Liquidated"), "liquidation happened");

    // Index print + two NYC positions, before the indexer starts (tests backfill).
    await send(ex(t2).openPosition(NYC, E(300), E(10_000), MaxUint256));
    await send(ex(t3).openPosition(NYC, -E(300), E(5_000), 0));

    app = await start({
      RPC_URL: RPC, CHAIN_ID: String(dep.chainId), EXCHANGE_ADDRESS: dep.exchange, ORACLE_ADDRESS: dep.oracle,
      COLLATERAL_ADDRESS: dep.usdt, START_BLOCK: String(dep.startBlock), POLL_MS: "300", SNAPSHOT_EVERY: "3",
      DB_PATH: path.join(tmp, "test.db"), PORT: "0", HOST: "127.0.0.1", ABI_DIR: abiDir,
    });
    const base = `http://127.0.0.1:${app.port}`;
    const get = async (p, headers = {}) => {
      const r = await fetch(base + p, { headers });
      return { status: r.status, headers: r.headers, body: await r.json() };
    };
    const waitFor = async (fn, ms = 15000) => {
      const t0 = Date.now();
      for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error("timeout"); await sleep(200); }
    };

    const wsMsgs = [];
    ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`);
    await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });
    ws.on("message", (m) => wsMsgs.push(JSON.parse(m)));

    console.log("checks:");
    await check("backfill indexed opens", async () => {
      const { body } = await get(`/markets/${NYC}/trades`);
      assert.equal(body.length, 2);
      assert.deepEqual(body.map((t) => t.kind), ["open", "open"]);
    });

    await check("trader positions (live)", async () => {
      const { body } = await get(`/traders/${A[3]}/positions`);
      assert.equal(body.length, 1);
      assert.equal(body[0].side, "short");
      near(body[0].size, -300, 1e-9);
      assert.ok(body[0].liquidationPrice > 340);
    });

    // Live activity while the indexer polls.
    const closeRc = await send(ex(t2).closePosition(NYC, 0));
    const modRc = await send(ex(t3).modifyPosition(NYC, E(100), MaxUint256)); // reduce short 300 -> 200
    const close3Rc = await send(ex(t3).closePosition(NYC, MaxUint256));
    const head = await provider.getBlockNumber();
    await waitFor(async () => Number(app.db.getMeta("lastBlock")) >= head);

    await check("websocket pushed trades + snapshot", async () => {
      await waitFor(() => wsMsgs.filter((m) => m.type === "trade").length >= 3 && wsMsgs.some((m) => m.type === "snapshot"));
      const kinds = wsMsgs.filter((m) => m.type === "trade").map((m) => m.data.kind);
      assert.deepEqual(kinds, ["close", "modify", "close"]);
    });

    await check("/markets/:id/trades tape matches chain events", async () => {
      const { body } = await get(`/markets/NYC/trades?limit=50`);
      assert.deepEqual(body.map((t) => t.kind), ["close", "modify", "close", "open", "open"]);
      const ev = parse(closeRc, "PositionClosed");
      const t = body.find((x) => x.txHash === closeRc.hash);
      near(t.price, F(ev.args.fillPrice)); near(t.pnl, F(ev.args.pnl)); near(t.payout, F(ev.args.payout));
      assert.equal(t.trader, A[2].toLowerCase());
      const m = parse(modRc, "PositionModified");
      const tm = body.find((x) => x.txHash === modRc.hash);
      near(tm.size, F(m.args.sizeDelta)); near(tm.fee, F(m.args.fee)); near(tm.margin, F(m.args.newMargin));
      const lim = await get(`/markets/0/trades?limit=2`);
      assert.equal(lim.body.length, 2);
    });

    await check("/markets live data", async () => {
      const { body, headers } = await get("/markets", { Origin: "http://localhost:5173" });
      assert.equal(headers.get("access-control-allow-origin"), "http://localhost:5173");
      assert.equal(body.length, 5);
      const nyc = body.find((m) => m.symbol === "NYC");
      near(nyc.indexPrice, F(await ex(provider).indexPrice(NYC)), 1e-4);
      near(nyc.indexPrice, 340, 1e-6);
      assert.equal(nyc.longOI, 0); assert.equal(nyc.shortOI, 0);
      const { body: tape } = await get(`/markets/0/trades`);
      near(nyc.volume24h, tape.reduce((a, t) => a + t.notional, 0));
      assert.equal(nyc.trades24h, 5);
      assert.equal(typeof nyc.fundingRatePerDay, "number");
      assert.equal(typeof nyc.change24h, "number");
      const la = body.find((m) => m.symbol === "LA");
      assert.equal(la.trades24h, 1, "LA open was >24h ago (time travel); only the liquidation is within 24h");
      assert.equal(la.lastPrint.price, 426.8);
    });

    await check("/markets/:id/history", async () => {
      const { body } = await get(`/markets/${NYC}/history?range=1M`);
      assert.ok(body.prints.some((p) => p.price === 340 && p.fromPrice === 330));
      assert.ok(body.snapshots.length >= 1);
      assert.ok(body.snapshots.every((s) => typeof s.indexPrice === "number" && typeof s.markPrice === "number"));
      for (const r of ["6M", "1Y", "5Y"]) assert.equal((await get(`/markets/NYC/history?range=${r}`)).status, 200);
      assert.equal((await get(`/markets/NYC/history?range=2W`)).status, 400);
      assert.equal((await get(`/markets/XYZ/history`)).status, 404);
    });

    await check("/traders/:address/history + liquidation", async () => {
      const { body } = await get(`/traders/${A[2]}/history`);
      assert.deepEqual(body.trades.map((t) => t.kind), ["close", "open"]);
      const ev = parse(closeRc, "PositionClosed");
      const open = body.trades[1], close = body.trades[0];
      near(body.summary.realizedPnl, -open.fee + F(ev.args.pnl) - F(ev.args.funding) - close.fee, 1e-6);
      const l = await get(`/traders/${A[4]}/history`);
      const liqT = l.body.trades.find((t) => t.kind === "liquidation");
      assert.ok(liqT);
      near(liqT.pnl, -l.body.trades.find((t) => t.kind === "open").margin);
      assert.equal(liqT.liquidator, A[5].toLowerCase());
      assert.equal((await get(`/traders/${A[3]}/positions`)).body.length, 0);
    });

    await check("/pool", async () => {
      const { body } = await get("/pool");
      near(body.poolValue, F(await ex(provider).poolValue()), 1e-4);
      assert.equal(body.lpCount, 1);
      assert.equal(body.totalDeposited, 1_000_000);
      assert.ok(body.sharePriceHistory.length >= 1);
      assert.ok(body.fees7d > 0 && body.feeApr7d > 0 && body.feeApr30d > 0);
    });

    await check("/stats", async () => {
      const { body } = await get("/stats");
      near(body.tvl, F(await usdt.balanceOf(dep.exchange)));
      assert.equal(body.traderCount, 3);
      assert.equal(body.totalTrades, 7);
      assert.ok(body.volume24h > 0 && body.totalVolume > body.volume24h);
      assert.equal(body.totalOI, 0);
    });

    await check("/leaderboard", async () => {
      const { body } = await get("/leaderboard?period=7d");
      assert.equal(body.entries.length, 3);
      assert.equal(body.entries.at(-1).trader, A[4].toLowerCase(), "liquidated trader ranks last");
      assert.ok(body.entries[0].realizedPnl >= body.entries[1].realizedPnl);
      const all = await get("/leaderboard?period=all");
      assert.equal(all.body.entries.length, 3);
      assert.equal(all.body.entries.at(-1).trader, A[4].toLowerCase());
      assert.ok(all.body.entries.at(-1).realizedPnl < 0);
    });

    await check("CORS rejects other origins", async () => {
      const { headers } = await get("/stats", { Origin: "http://evil.example" });
      assert.equal(headers.get("access-control-allow-origin"), null);
      const ok = await get("/stats", { Origin: "http://127.0.0.1:5173" });
      assert.equal(ok.headers.get("access-control-allow-origin"), "http://127.0.0.1:5173");
    });

    await check("idempotent full re-scan", async () => {
      const before = app.db.get("SELECT COUNT(*) n FROM trades").n;
      const evs = app.db.get("SELECT COUNT(*) n FROM events").n;
      app.db.setMeta("lastBlock", dep.startBlock);
      app.cfg.reorgDepth = 10_000;
      const fresh = await app.indexer.syncOnce();
      app.cfg.reorgDepth = 10;
      assert.equal(app.db.get("SELECT COUNT(*) n FROM trades").n, before);
      assert.equal(app.db.get("SELECT COUNT(*) n FROM events").n, evs);
      assert.equal(fresh.filter((x) => x.type === "trade").length, 0, "no duplicate pushes");
    });

    await check("reorg: reverted trade is dropped", async () => {
      const snap = await provider.send("evm_snapshot", []);
      const orc = await send(ex(t2).openPosition(3, E(100), E(1000), MaxUint256));
      const h = orc.blockNumber;
      await waitFor(async () => Number(app.db.getMeta("lastBlock")) >= h);
      if (app.db.get("SELECT COUNT(*) n FROM trades WHERE market_id=3").n !== 1)
        console.log(h, orc.status, await provider.getBlockNumber(), app.db.getMeta("lastBlock"), app.db.all("SELECT block,name FROM events ORDER BY block DESC LIMIT 3"));
      assert.equal(app.db.get("SELECT COUNT(*) n FROM trades WHERE market_id=3").n, 1);
      await provider.send("evm_revert", [snap]);
      for (const w of [keeper, lp, t2, t3, t4, liq]) w.reset();
      await provider.send("evm_mine", []);
      await provider.send("evm_mine", []);
      await app.indexer.syncOnce();
      assert.equal(app.db.get("SELECT COUNT(*) n FROM trades WHERE market_id=3").n, 0);
    });

    await check("unknown events are stored raw, not fatal", async () => {
      const names = app.db.all("SELECT DISTINCT name FROM events").map((r) => r.name);
      assert.ok(names.includes("MarketAdded") && names.includes("IndexPushed"));
      assert.equal((await get("/health")).body.ok, true);
    });

    if (process.env.DUMP_EXAMPLES) {
      const ex = {};
      for (const p of ["/markets", "/markets/NYC/history?range=1M", "/markets/0/trades?limit=2", `/traders/${A[3]}/history?limit=2`, "/pool", "/stats", "/leaderboard?period=7d"])
        ex[p] = (await get(p)).body;
      ex.ws = wsMsgs.slice(0, 3);
      fs.writeFileSync(process.env.DUMP_EXAMPLES, JSON.stringify(ex, null, 2));
    }
    console.log(`\n${passed} checks passed`);
    provider.destroy();
  } finally {
    try { ws?.close(); } catch {}
    if (app) await app.stop();
    killNode();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().then(() => process.exit(0), (e) => { console.error("FAIL:", e); process.exit(1); });
