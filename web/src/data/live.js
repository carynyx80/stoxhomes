// Live data source: exact values from contract reads (src/chain.js), history/tape/stats from the
// indexer API (VITE_API_URL). Raw bigints are kept on `raw` fields; numbers are for display only.
import { useCallback, useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import { connectWallet, contracts, deployment, readProvider } from "../chain.js";
import oracleAbi from "../contracts/HouseIndexOracle.json";
import { META } from "./meta.js";
import { friendly } from "./errors.js";

const FAUCET = import.meta.env.VITE_FAUCET_URL || "";
export const API = (import.meta.env.VITE_API_URL || "http://127.0.0.1:4000").replace(/\/$/, "");
const WAD = 10n ** 18n;
const BPS = 10_000n;
const SLIP = 50n; // 0.5%
const SHARE_DEC = 24; // shares carry a 1e6 virtual offset on top of 18 decimals
const num = (x, d = 18) => Number(ethers.formatUnits(x ?? 0n, d));
const abs = (x) => (x < 0n ? -x : x);
const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");
const up = (q) => (q * (BPS + SLIP)) / BPS;
const down = (q) => (q * (BPS - SLIP)) / BPS;

async function api(path) {
  const r = await fetch(API + path, { signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error(`API ${r.status}`);
  return r.json();
}
const settled = (p) => p.then((v) => v, () => null);

const read = deployment ? contracts(readProvider) : null;
const oracle = deployment ? new ethers.Contract(deployment.oracle, oracleAbi, readProvider) : null;

export function useLiveExchange() {
  const [signer, setSigner] = useState(null);
  const [account, setAccount] = useState(null);
  const [state, setState] = useState(null);
  const [error, setError] = useState(deployment ? null : "No deployment for this chain in src/contracts/deployments.json");
  const [toasts, setToasts] = useState([]);
  const [busy, setBusy] = useState(null);
  const params = useRef(null);
  const loading = useRef(false);
  const again = useRef(false);

  const load = useCallback(async () => {
    if (!read) return;
    if (loading.current) { again.current = true; return; }
    loading.current = true;
    try {
      const ex = read.exchange;
      if (!params.current) {
        const [tradingFeeBps, maintenanceMarginBps, withdrawCooldown, closeOnlyBefore] = await Promise.all([
          ex.tradingFeeBps(), ex.maintenanceMarginBps(), ex.withdrawCooldown(), ex.closeOnlyBefore(),
        ]);
        params.current = { tradingFeeBps: Number(tradingFeeBps), maintenanceMarginBps: Number(maintenanceMarginBps), maxLeverage: 100, withdrawCooldown: Number(withdrawCooldown), closeOnlyWindow: Number(closeOnlyBefore) };
      }
      const P = params.current;
      const [views, poolValue, totalShares, block] = await Promise.all([ex.getAllMarkets(), ex.poolValue(), ex.totalShares(), readProvider.getBlock("latest")]);
      const ids = views.map((v) => Number(v.marketId));
      const acct = account
        ? await Promise.all([
            read.usdt.balanceOf(account), ex.shares(account), ex.pendingWithdrawal(account),
            Promise.all(ids.map((i) => ex.positionInfo(i, account))),
          ])
        : null;
      const [aStats, aPool, aMarkets, aHist, ...aTrades] = await Promise.all([
        settled(api("/stats")), settled(api("/pool?range=1M")), settled(api("/markets")),
        account ? settled(api(`/traders/${account}/history?limit=50`)) : null,
        ...ids.map((i) => settled(api(`/markets/${i}/trades?limit=15`))),
      ]);

      const markets = views.map((v) => {
        const id = Number(v.marketId), sym = v.name.replace(/-USD$/, ""), am = aMarkets?.find((x) => x.id === id);
        const sp = Number(v.scheduledPrint);
        return {
          id, name: v.name, symbol: sym, ...(META[sym] || { city: sym, country: "", coords: "" }),
          index: num(v.indexPrice), mark: num(v.markPrice), funding: num(v.fundingRatePerDay),
          skew: num(v.skew), skewScale: num(v.skewScale), longSize: num(v.longSize), shortSize: num(v.shortSize),
          change24h: am?.change24h ?? 0, change1y: null, volume24h: am?.volume24h ?? 0,
          nextPrintAt: sp ? sp * 1000 : null, closeOnlyFrom: sp ? (sp - P.closeOnlyWindow) * 1000 : null,
          closeOnly: v.closeOnly, raw: v,
        };
      });
      const pv = num(poolValue), ts = num(totalShares, SHARE_DEC);
      const backing = markets.map((m) => (pv > 0 ? (Math.abs(m.skew) * m.index) / pv : 0));
      const used = backing.reduce((a, b) => a + b, 0);
      let pending = null, positions = [], wallet = { connected: false, address: "", full: "", balance: 0 };
      let sharesRaw = 0n;
      if (acct) {
        const [bal, sh, pw, infos] = acct;
        sharesRaw = sh;
        wallet = { connected: true, address: short(account), full: account, balance: num(bal), raw: { balance: bal } };
        if (pw.pendingShares > 0n) {
          const unlock = Number(pw.unlockTime);
          pending = { shares: num(pw.pendingShares, SHARE_DEC), unlockAt: unlock * 1000, expiresAt: Number(pw.expiresAt) * 1000, estimatedAmount: num(pw.estimatedAmount), requestedAt: (unlock - P.withdrawCooldown) * 1000, raw: pw };
        }
        positions = infos.map((info, i) => ({ info, m: markets[i] })).filter(({ info }) => info.size !== 0n).map(({ info, m }) => {
          const size = num(abs(info.size)), margin = num(info.margin), idx = num(info.indexPrice);
          return {
            marketId: m.id, market: m.symbol, city: m.city, side: info.size > 0n ? "long" : "short", size, margin,
            entryPrice: num(info.entryPrice), indexPrice: idx, pnl: num(info.pnl), funding: -num(info.funding),
            equity: num(info.equity), liquidationPrice: num(info.liquidationPrice), liquidatable: info.liquidatable,
            leverage: Math.max(1, Math.round((size * idx) / Math.max(margin, 1e-9))), raw: info,
          };
        });
      }
      const sym = (id) => markets.find((m) => m.id === id)?.symbol ?? String(id);
      const trades = aTrades.flat().filter(Boolean).sort((a, b) => b.block - a.block || (b.id > a.id ? 1 : -1)).slice(0, 40).map((t) => ({
        id: t.id, ts: t.timestamp * 1000, market: sym(t.marketId), side: t.side, kind: t.kind, price: t.price, size: Math.abs(t.size), notional: t.notional,
        leverage: t.kind === "open" && t.margin ? Math.max(1, Math.round(t.notional / t.margin)) : null, trader: short(t.trader),
      }));
      const history = (aHist?.trades || []).map((t) => ({
        ts: t.timestamp * 1000, market: sym(t.marketId), action: t.kind[0].toUpperCase() + t.kind.slice(1), side: t.side,
        size: Math.abs(t.size), price: t.price, pnl: t.kind === "open" ? null : t.realizedPnl,
      }));
      const oi = markets.reduce((s, m) => s + (m.longSize + m.shortSize) * m.index, 0);
      const apr = aPool ? (aPool.feeApr30d ?? aPool.feeApr7d ?? null) : null;
      setState({
        clockOffset: Number(block.timestamp) * 1000 - Date.now(),
        markets, positions, trades, history, wallet, params: P, apiOnline: !!aStats,
        stats: { tvl: aStats?.tvl ?? pv, volume24h: aStats?.volume24h ?? markets.reduce((s, m) => s + m.volume24h, 0), oi: aStats?.totalOI ?? oi },
        pool: {
          poolValue: pv, totalShares: ts, shares: num(sharesRaw, SHARE_DEC), sharePrice: ts > 0 ? pv / ts : 1,
          apr, feesApr: apr, fundingApr: null, pnlApr: null, utilization: used,
          composition: [{ label: "Idle USDT", value: Math.max(0, 1 - used) }, ...markets.map((m, i) => ({ label: "Backing " + m.symbol, value: backing[i] }))],
          pendingWithdrawal: pending, raw: { poolValue, totalShares, shares: sharesRaw },
        },
      });
      setError(null);
    } catch (e) {
      setError("Could not reach the chain: " + friendly(e));
    } finally {
      loading.current = false;
      if (again.current) { again.current = false; load(); }
    }
  }, [account]);

  useEffect(() => { load(); const h = setInterval(load, 4000); return () => clearInterval(h); }, [load]);

  // Indexer pushes: refresh on trades / prints / LP events.
  useEffect(() => {
    let ws, stop = false, timer;
    const open = () => {
      try { ws = new WebSocket(API.replace(/^http/, "ws") + "/ws"); } catch { return; }
      ws.onmessage = (ev) => { try { const m = JSON.parse(ev.data); if (m.type !== "hello") load(); } catch {} };
      ws.onclose = () => { if (!stop) timer = setTimeout(open, 5000); };
      ws.onerror = () => ws.close();
    };
    open();
    return () => { stop = true; clearTimeout(timer); ws?.close(); };
  }, [load]);

  // wallet account changes
  useEffect(() => {
    const eth = window.ethereum;
    if (!eth?.on) return;
    const h = (accs) => { setAccount(accs?.[0] ? ethers.getAddress(accs[0]) : null); if (!accs?.[0]) setSigner(null); };
    eth.on("accountsChanged", h);
    return () => eth.removeListener?.("accountsChanged", h);
  }, []);

  // ---- toasts + tx plumbing ----
  const push = (t) => { const id = Math.random().toString(36).slice(2); setToasts((x) => [...x, { id, ...t }]); if (t.kind !== "pending") setTimeout(() => dismiss(id), 6000); return id; };
  const patch = (id, t) => { setToasts((x) => x.map((y) => (y.id === id ? { ...y, ...t } : y))); if (t.kind && t.kind !== "pending") setTimeout(() => dismiss(id), 6000); };
  const dismiss = (id) => setToasts((x) => x.filter((y) => y.id !== id));

  async function send(label, fn) {
    const id = push({ kind: "pending", text: label + " — confirm in wallet" });
    try {
      const tx = await fn();
      patch(id, { text: label + " — pending", hash: tx.hash });
      await tx.wait();
      patch(id, { kind: "ok", text: label + " — confirmed" });
      return true;
    } catch (e) {
      patch(id, { kind: "err", text: label + " failed: " + friendly(e) });
      return false;
    }
  }
  const w = signer ? contracts(signer) : null;
  async function allow(amount) {
    const a = await read.usdt.allowance(account, deployment.exchange);
    if (a >= amount) return true;
    return send("Approve USDT", () => w.usdt.approve(deployment.exchange, amount));
  }
  const guard = (name, fn) => async (...args) => {
    if (!w) { push({ kind: "err", text: "Connect a wallet first." }); return false; }
    setBusy(name);
    try { return await fn(...args); } catch (e) { push({ kind: "err", text: friendly(e) }); return false; } finally { setBusy(null); load(); }
  };
  const mkt = (id) => state.markets.find((m) => m.id === id);
  const pos = (id) => state.positions.find((p) => p.marketId === id);

  const actions = {
    connect: async () => {
      try {
        setBusy("connect");
        const s = await connectWallet();
        setSigner(s);
        setAccount(ethers.getAddress(await s.getAddress()));
        push({ kind: "ok", text: "Wallet connected" });
      } catch (e) { push({ kind: "err", text: friendly(e) }); } finally { setBusy(null); }
    },
    faucet: guard("faucet", async () => {
      if (FAUCET) {
        // Hosted faucet (public demo chain): sends gas + test USDT; 429 = cooldown.
        const id = push({ kind: "pending", text: "Requesting test funds…" });
        const r = await fetch(FAUCET, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: account }) });
        const body = await r.json().catch(() => ({}));
        if (!r.ok || body.error) { patch(id, { kind: "err", text: "Faucet: " + (body.error || `HTTP ${r.status}`) }); return false; }
        const txs = body.txs || [];
        await Promise.all(txs.map((h) => readProvider.waitForTransaction(typeof h === "string" ? h : h.hash, 1, 60_000).catch(() => null)));
        patch(id, { kind: "ok", text: `Faucet sent ${body.usdt ?? ""} USDT${body.gas ? " + " + body.gas + " ETH gas" : ""}`, hash: typeof txs[0] === "string" ? txs[0] : txs[0]?.hash });
        return true;
      }
      return send("Mint 10,000 test USDT", () => w.usdt.mint(account, 10_000n * WAD));
    }),
    open: guard("open", async ({ marketId, side, margin: marginStr, leverage }) => {
      const m = mkt(marketId), margin = ethers.parseEther(String(marginStr || 0)), L = BigInt(leverage);
      const fee = BigInt(state.params.tradingFeeBps);
      if (margin <= 0n) throw new Error("Enter a margin amount.");
      // notional <= (margin - fee) * L  with fee = notional * feeBps  =>  notional = margin*L / (1 + L*feeBps); 0.1% headroom
      const notional = (((margin * L * BPS) / (BPS + L * fee)) * 999n) / 1000n;
      const sign = side === "long" ? 1n : -1n;
      const guess = (notional * WAD) / m.raw.markPrice;
      const q = await read.exchange.quoteOpenFill(marketId, guess * sign);
      const size = ((notional * WAD) / q) * sign;
      if (!(await allow(margin))) return false;
      return send(`${side === "long" ? "Long" : "Short"} ${m.symbol} ${leverage}×`, () => w.exchange.openPosition(marketId, size, margin, sign > 0n ? up(q) : down(q)));
    }),
    increase: guard("increase", async ({ marketId, units, extraMargin }) => {
      const p = pos(marketId), sign = p.raw.size > 0n ? 1n : -1n, delta = ethers.parseEther(String(units)) * sign;
      const extra = ethers.parseEther(String(extraMargin || 0));
      if (extra > 0n) {
        if (!(await allow(extra))) return false;
        if (!(await send(`Add ${Number(extraMargin).toLocaleString()} USDT margin`, () => w.exchange.addMargin(marketId, extra)))) return false;
      }
      const q = await read.exchange.quoteOpenFill(marketId, delta);
      return send(`Increase ${p.market} by ${units} u`, () => w.exchange.modifyPosition(marketId, delta, delta > 0n ? up(q) : down(q)));
    }),
    reduce: guard("reduce", async ({ marketId, units }) => {
      const p = pos(marketId), sign = p.raw.size > 0n ? 1n : -1n;
      let amt = ethers.parseEther(String(units));
      if (amt > abs(p.raw.size)) amt = abs(p.raw.size);
      const delta = -amt * sign;
      const q = await read.exchange.quoteFill(marketId, delta);
      return send(`Reduce ${p.market} by ${units} u`, () => w.exchange.modifyPosition(marketId, delta, delta > 0n ? up(q) : down(q)));
    }),
    addMargin: guard("addMargin", async ({ marketId, amount }) => {
      const a = ethers.parseEther(String(amount));
      if (!(await allow(a))) return false;
      return send(`Add ${Number(amount).toLocaleString()} USDT margin`, () => w.exchange.addMargin(marketId, a));
    }),
    close: guard("close", async ({ marketId }) => {
      const p = pos(marketId), q = await read.exchange.quoteFill(marketId, -p.raw.size);
      return send(`Close ${p.market}`, () => w.exchange.closePosition(marketId, p.raw.size > 0n ? down(q) : up(q)));
    }),
    deposit: guard("deposit", async ({ amount }) => {
      const a = ethers.parseEther(String(amount)), { poolValue, totalShares } = state.pool.raw;
      const expected = (a * (totalShares + 1_000_000n)) / (poolValue + 1n);
      if (!(await allow(a))) return false;
      return send(`Deposit ${Number(amount).toLocaleString()} USDT`, () => w.exchange.deposit(a, down(expected)));
    }),
    requestWithdraw: guard("requestWithdraw", async ({ pct }) => {
      const s = (state.pool.raw.shares * BigInt(Math.round(pct * 100))) / 10_000n;
      return send(`Request withdrawal (${pct}% of shares)`, () => w.exchange.requestWithdraw(s));
    }),
    cancelWithdraw: guard("cancelWithdraw", () => send("Cancel withdrawal", () => w.exchange.cancelWithdraw())),
    withdraw: guard("withdraw", async () => {
      const pw = state.pool.pendingWithdrawal.raw;
      return send("Withdraw from vault", () => w.exchange.withdraw(pw.pendingShares, down(pw.estimatedAmount)));
    }),
  };

  return { ready: !!state, error, toasts, dismiss, busy, actions, live: true, faucet: !!deployment?.mockUsdt /* real-USDT deployments (testnet/mainnet): no faucet */, ...(state || {}) };
}

// ---- chart history: API snapshots + prints, falling back to on-chain oracle prints ----
const RANGE_S = { "1M": 30 * 86400, "6M": 182 * 86400, "1Y": 365 * 86400, "5Y": 5 * 365 * 86400 };

export async function fetchHistory(market, range, nowMs) {
  const to = Math.floor(nowMs / 1000), from = to - RANGE_S[range];
  let pts = [];
  try {
    const h = await api(`/markets/${market.id}/history?range=${range}`);
    pts = [
      ...h.prints.map((p) => ({ t: p.timestamp * 1000, index: p.price, mark: p.price })),
      ...h.snapshots.map((s) => ({ t: s.timestamp * 1000, index: s.indexPrice, mark: s.markPrice })),
    ];
  } catch {
    try {
      const id = market.raw.oracleId;
      const [created, pushed] = await Promise.all([oracle.queryFilter(oracle.filters.FeedCreated(id)), oracle.queryFilter(oracle.filters.IndexPushed(id))]);
      const blocks = await Promise.all([...created, ...pushed].map((l) => l.getBlock()));
      pts = [...created, ...pushed].map((l, i) => {
        const price = num(l.fragment.name === "FeedCreated" ? l.args.price : l.args.toPrice);
        return { t: blocks[i].timestamp * 1000, index: price, mark: price };
      });
    } catch { pts = []; }
  }
  pts = pts.filter((p) => p.t >= from * 1000).sort((a, b) => a.t - b.t);
  const first = pts[0] ?? { index: market.index, mark: market.index };
  return [{ t: from * 1000, index: first.index, mark: first.index }, ...pts, { t: to * 1000, index: market.index, mark: market.mark }];
}
