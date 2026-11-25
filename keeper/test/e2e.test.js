// End-to-end: local Hardhat node on :8546 -> deploy -> 100x long -> keeper publishes a lower
// print -> time advances through the smoothing window -> keeper liquidates.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { deployLocal } from "../scripts/deploy-local.js";
import { loadConfig } from "../src/config.js";
import { startKeeper } from "../src/keeper.js";
import { connect, loadAbi } from "../src/contracts.js";
import { Publisher } from "../src/publisher.js";
import { FilePriceSource } from "../src/sources/file.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8546; // reserved for this agent/test; 8545/8547 are used elsewhere
const RPC = `http://127.0.0.1:${PORT}`;
const HEALTH_PORT = Number(process.env.HEALTH_PORT || 4100);
const TMP = path.join(here, ".tmp");
const E = (n) => ethers.parseEther(String(n));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MNEMONIC = "test test test test test test test test test test test junk"; // Hardhat default
const step = (s) => console.log(`\n=== ${s}`);

async function rpcUp() {
  const p = new ethers.JsonRpcProvider(RPC, 31337, { staticNetwork: true });
  try { await p.send("eth_chainId", []); return true; } catch { return false; } finally { p.destroy(); }
}
async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(200); }
  throw new Error(`timeout waiting for ${what}`);
}

let node, keeper;
async function main() {
  fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(TMP, { recursive: true });
  if (await rpcUp()) throw new Error(`something is already listening on ${PORT}; stop it first`);
  step(`starting hardhat node on :${PORT}`);
  node = spawn("npx", ["hardhat", "node", "--port", String(PORT)], { cwd: path.resolve(here, "../../contracts"), stdio: "ignore", detached: true });
  await waitFor(rpcUp, 60_000, "hardhat node");

  step("deploying contracts (keeper/scripts/deploy-local.js)");
  const depFile = path.join(TMP, "deployments.json");
  const d = await deployLocal(RPC, { out: depFile });
  console.log(`exchange ${d.exchange} oracle ${d.oracle} usdt ${d.usdt}`);

  const provider = new ethers.JsonRpcProvider(RPC, 31337, { staticNetwork: true });
  const usdt = new ethers.Contract(d.usdt, loadAbi("MockUSDT", path.resolve(here, "../../contracts/artifacts/contracts")).abi, provider);
  const exAbi = loadAbi("HousePerpExchange", path.resolve(here, "../../contracts/artifacts/contracts")).abi;
  const orAbi = loadAbi("HouseIndexOracle", path.resolve(here, "../../contracts/artifacts/contracts")).abi;
  const owner = await provider.getSigner(0);
  const longT = await provider.getSigner(1);
  const shortT = await provider.getSigner(2);
  const keeperWallet = ethers.HDNodeWallet.fromPhrase(MNEMONIC, undefined, "m/44'/60'/0'/0/3");
  const oracleOwner = new ethers.Contract(d.oracle, orAbi, owner);
  await (await oracleOwner.setKeeper(keeperWallet.address, true)).wait();

  step("opening positions");
  const NYC = 0n;
  for (const t of [longT, shortT]) {
    await (await usdt.connect(t).mint(t.address, E(10_000))).wait();
    await (await usdt.connect(t).approve(d.exchange, ethers.MaxUint256)).wait();
  }
  const exL = new ethers.Contract(d.exchange, exAbi, longT);
  const size = E(285), margin = E(1000);
  const fill = await exL.quoteFill(NYC, size);
  await (await exL.openPosition(NYC, size, margin, (fill * 101n) / 100n)).wait();
  let info = await exL.positionInfo(NYC, longT.address);
  const lev = Number((info.size * info.entryPrice) / E(1)) / Number(info.margin);
  console.log(`long  ${longT.address}: size ${ethers.formatEther(info.size)} NYC @ ${ethers.formatEther(info.entryPrice)}, margin ${ethers.formatEther(info.margin)}, leverage ${lev.toFixed(1)}x, liq price ${ethers.formatEther(info.liquidationPrice)}`);
  assert.ok(lev > 95, "position should be ~100x");
  const exS = new ethers.Contract(d.exchange, exAbi, shortT);
  const sfill = await exS.quoteFill(NYC, -E(10));
  await (await exS.openPosition(NYC, -E(10), E(2000), (sfill * 99n) / 100n)).wait();
  console.log(`short ${shortT.address}: size -10 NYC, 2000 margin (~1.6x, must survive)`);

  const prints = path.join(TMP, "prints.json");
  fs.writeFileSync(prints, JSON.stringify([
    { symbol: "NYC", date: "2026-09-30", value: 330 },
    { symbol: "NYC", date: "2026-10-31", value: 320 },  // -3.0%: wipes out a ~97x long
    { symbol: "LA", date: "2026-10-31", value: 500 },   // +13.6%: must be refused (> 10%)
  ]));
  const chainNow = Number((await provider.getBlock("latest")).timestamp);
  const iso = (t) => new Date(t * 1000).toISOString();
  const calendar = path.join(TMP, "release-calendar.json");
  fs.writeFileSync(calendar, JSON.stringify([
    { symbol: "NYC", releaseAt: iso(chainNow + 3 * 3600) },   // inside the 6h close-only window
    { symbol: "MIA", releaseAt: iso(chainNow + 30 * 86400) }, // far away: scheduled but still open
    { symbol: "LA", releaseAt: iso(chainNow - 86400) },       // past: ignored
  ]));
  const baseEnv = {
    RELEASE_CALENDAR_FILE: calendar,
    RPC_URL: RPC, CHAIN_ID: "31337", POLL_MS: "300", START_BLOCK: "0", DEPLOYMENTS_FILE: depFile,
    PRICES_FILE: prints, PUBLISHER_STATE_FILE: path.join(TMP, "state.json"), PUBLISH_EVERY_MS: "600000",
    HEALTH_PORT: String(HEALTH_PORT), KEEPER_PRIVATE_KEY: keeperWallet.privateKey, GAS_PRICE_GWEI: "2",
  };

  step("publisher dry run");
  const dryCfg = loadConfig({ ...baseEnv, DRY_RUN: "true", HEALTH_PORT: "0" });
  const dctx = await connect(dryCfg);
  const dres = await new Publisher(dryCfg, dctx, new FilePriceSource(prints), {}).runOnce();
  dctx.provider.destroy();
  console.table(dres.map(({ symbol, kind, date, value, releaseAt, action, reason }) => ({ symbol, kind: kind ?? "print", date, value, releaseAt, action, reason })));
  const pr = (res, sym) => res.find((r) => r.symbol === sym && !r.kind);
  const sc = (res, sym) => res.find((r) => r.symbol === sym && r.kind === "schedule");
  assert.equal(pr(dres, "NYC").action, "dry-run");
  assert.equal(pr(dres, "LA").action, "refused");
  assert.equal(sc(dres, "NYC").action, "dry-run");
  assert.equal(sc(dres, "LA").action, "skip");
  const oracleRO0 = new ethers.Contract(d.oracle, orAbi, provider);
  const exRO = new ethers.Contract(d.exchange, exAbi, provider);
  assert.equal(await oracleRO0.scheduledPrint(ethers.encodeBytes32String("NYC")), 0n, "dry run must not schedule");
  assert.equal(await exRO.isCloseOnly(NYC), false);
  assert.ok(!fs.existsSync(baseEnv.PUBLISHER_STATE_FILE), "dry run must not write state");

  step("release calendar: schedule only (no new prints yet)");
  const oldPrints = path.join(TMP, "old-prints.json");
  fs.writeFileSync(oldPrints, JSON.stringify([{ symbol: "NYC", date: "2026-09-30", value: 330 }]));
  const schedCfg = loadConfig({ ...baseEnv, DRY_RUN: "false", HEALTH_PORT: "0" });
  const sctx = await connect(schedCfg);
  const schedPub = new Publisher(schedCfg, sctx, new FilePriceSource(oldPrints), {});
  const sres = await schedPub.runOnce();
  assert.equal(sc(sres, "NYC").action, "scheduled");
  assert.equal(sc(sres, "MIA").action, "scheduled");
  assert.equal(sc(sres, "LA").action, "skip");
  assert.equal(Number(await oracleRO0.scheduledPrint(ethers.encodeBytes32String("NYC"))), chainNow + 3 * 3600);
  assert.equal(await exRO.isCloseOnly(NYC), true, "NYC inside 6h window -> close-only");
  assert.equal(await exRO.isCloseOnly(2n), false, "MIA release 30d away -> open");
  console.log(`isCloseOnly(NYC)=${await exRO.isCloseOnly(NYC)} isCloseOnly(MIA)=${await exRO.isCloseOnly(2n)}`);
  const fresh = await provider.getSigner(4);
  await (await usdt.connect(fresh).mint(fresh.address, E(1000))).wait();
  await (await usdt.connect(fresh).approve(d.exchange, ethers.MaxUint256)).wait();
  await assert.rejects(new ethers.Contract(d.exchange, exAbi, fresh).openPosition(NYC, E(1), E(100), E(1000)), (e) => /CloseOnly|0x/.test(String(e.revert?.name ?? e.data ?? e.message)), "open must revert in close-only");
  const again0 = await schedPub.runOnce();
  assert.ok(/already scheduled/.test(sc(again0, "NYC").reason), "must not re-schedule");
  sctx.provider.destroy();
  const oracleRO = new ethers.Contract(d.oracle, orAbi, provider);
  assert.equal((await oracleRO.feeds(ethers.encodeBytes32String("NYC"))).toPrice, E(330), "dry run must not push");

  step("starting keeper (liquidator + publisher)");
  const cfg = loadConfig({ ...baseEnv, DRY_RUN: "false" });
  assert.ok(!JSON.stringify(cfg).includes(keeperWallet.privateKey.slice(2)), "config serialisation must not leak key");
  keeper = await startKeeper(cfg);
  await waitFor(async () => keeper.status().publisher.printsPushed === 1, 15_000, "NYC print pushed");
  assert.equal((await oracleRO.feeds(ethers.encodeBytes32String("NYC"))).toPrice, E(320));
  assert.equal((await oracleRO.feeds(ethers.encodeBytes32String("LA"))).toPrice, E(440), "LA move must be refused");
  assert.equal(await oracleRO.scheduledPrint(ethers.encodeBytes32String("NYC")), 0n, "pushIndex clears the schedule");
  assert.equal(await exRO.isCloseOnly(NYC), false, "close-only cleared after print");
  console.log(`after push: scheduledPrint(NYC)=0, isCloseOnly(NYC)=${await exRO.isCloseOnly(NYC)}`);
  await waitFor(async () => keeper.status().openPositionsTracked === 2, 10_000, "2 positions tracked");
  await sleep(1500);
  assert.equal(keeper.status().liquidationsSent, 0, "nothing liquidatable yet (print is phased in over 7 days)");
  console.log(`NYC index right after push: ${ethers.formatEther(await oracleRO.price(ethers.encodeBytes32String("NYC")))} (smoothing)`);

  step("re-run publisher: same print must not be re-sent");
  const again = await keeper.pub.runOnce();
  assert.equal(pr(again, "NYC").action, "skip");
  assert.equal(sc(again, "NYC").action, "skip", "fulfilled release must not be re-scheduled");
  assert.equal(await exRO.isCloseOnly(NYC), false);

  step("race: liquidate a healthy position directly -> NotLiquidatable handled");
  const sInfo = await exS.positionInfo(NYC, shortT.address);
  await keeper.liq.liquidate(`0:${shortT.address.toLowerCase()}`, { marketId: NYC, trader: shortT.address }, sInfo, await provider.getBlockNumber());
  assert.equal(keeper.status().liquidator.liquidationsFailed, 0);
  assert.equal(keeper.status().liquidationsSent, 0);

  step("advancing time in 2h steps through the 7-day smoothing window (keeper polling every 300ms)");
  const balBefore = await usdt.balanceOf(keeperWallet.address);
  let lastInfo;
  for (let h = 2; h <= 7 * 24 + 2 && keeper.status().liquidator.liquidationsConfirmed === 0; h += 2) {
    lastInfo = await exL.positionInfo(NYC, longT.address);
    await provider.send("evm_increaseTime", [2 * 3600]);
    await provider.send("evm_mine", []);
    const i = await exL.positionInfo(NYC, longT.address);
    if (i.size !== 0n) console.log(`  t+${String(h).padStart(3)}h index ${Number(ethers.formatEther(i.indexPrice)).toFixed(3)} equity ${Number(ethers.formatEther(i.equity)).toFixed(2)} liquidatable ${i.liquidatable}`);
    await sleep(600);
  }
  await waitFor(async () => keeper.status().liquidator.liquidationsConfirmed === 1, 10_000, "liquidation confirmed");
  await sleep(1000); // a few more ticks: guard against double-sends
  const after = await exL.positionInfo(NYC, longT.address);
  assert.equal(after.size, 0n, "long must be liquidated");
  assert.notEqual((await exS.positionInfo(NYC, shortT.address)).size, 0n, "short must survive");
  const reward = (await usdt.balanceOf(keeperWallet.address)) - balBefore;
  const liqLogs = await provider.getLogs({ address: d.exchange, topics: [new ethers.Interface(exAbi).getEvent("Liquidated").topicHash] });
  assert.equal(liqLogs.length, 1, "exactly one Liquidated event");
  console.log(`keeper reward received: ${ethers.formatEther(reward)} USDT`);
  assert.ok(reward > 0n);

  step("health endpoint");
  const health = await (await fetch(`http://127.0.0.1:${HEALTH_PORT}/health`)).json();
  console.log(JSON.stringify({ lastProcessedBlock: health.lastProcessedBlock, openPositionsTracked: health.openPositionsTracked, liquidationsSent: health.liquidationsSent, rewardsWei: health.liquidator.rewardsWei, printsPushed: health.publisher.printsPushed, printsRefused: health.publisher.printsRefused }));
  assert.equal(health.liquidationsSent, 1);
  assert.equal(health.openPositionsTracked, 1);
  assert.ok(health.lastProcessedBlock >= (await provider.getBlockNumber()) - 1);
  provider.destroy();
  console.log("\nPASS: keeper published the print, refused the oversized move, and liquidated the 100x long");
}

let code = 0;
try { await main(); } catch (e) { console.error("\nFAIL:", e); code = 1; }
finally {
  if (keeper) await keeper.stop().catch(() => {});
  if (node) { try { process.kill(-node.pid, "SIGTERM"); } catch {} }
  fs.rmSync(TMP, { recursive: true, force: true });
}
process.exit(code);
