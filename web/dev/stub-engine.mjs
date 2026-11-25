// Stub of the Stoxhome engine API (docs/ENGINE_API.md) with fake, in-memory data, for frontend work
// before the real engine is ready.  node dev/stub-engine.mjs
// Env: PORT (8787), STUB_COMPANY (company address), STUB_RPC + STUB_USDT (optional: watch a local chain for
// USDT deposits and verify payout txs), STUB_CHAIN_ID (56), STUB_CONFIRMATIONS (3).
// Dev helper: POST /dev/credit { address, amount } credits a balance without a chain.
import http from "node:http";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import { ethers } from "ethers";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
const ata = (owner, mint) => getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), true).toBase58();

const PORT = Number(process.env.PORT || 8787);
const COMPANY = process.env.STUB_COMPANY || "8oYH186qjPyYwnS58fh1NH1m5iFFJe8wPnBKVp3NGtgx";
const SOL = process.env.STUB_CHAIN !== "evm"; // v2: Solana
const addrOf = (a) => { if (SOL) { if (bs58.decode(String(a)).length !== 32) throw fail("BAD_INPUT", "Bad address"); return String(a); } return ethers.getAddress(a); };
const TOKENS = [{ symbol: "USDC", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 }, { symbol: "USDT", mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6 }];
const USDT = process.env.STUB_USDT || "0x55d398326f99059fF775485246999027B3197955";
const CHAIN_ID = Number(process.env.STUB_CHAIN_ID || 56);
const CONF = Number(process.env.STUB_CONFIRMATIONS || 3);
const FEE = 0.0005, MM = 0.005, MAXLEV = 100, DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);
const s = (x, d = 6) => (Math.round(Number(x) * 10 ** d) / 10 ** d).toString();

const MARKETS = [["NYC", "New York", 330], ["LA", "Los Angeles", 440], ["MIA", "Miami", 430], ["SF", "San Francisco", 350], ["LDN", "London", 290]]
  .map(([symbol, name, v], id) => ({ id, symbol, name: `${symbol}-USD`, city: name, index: v, target: v, skewScale: 1_000_000, skew: 0, longOI: 0, shortOI: 0, active: true, nextPrintAt: null, lastPrint: { value: v, at: now() - 20 * DAY }, vol24: 0 }));
const hist = Object.fromEntries(MARKETS.map((m) => {
  let v = m.index * 0.8; const prints = [];
  for (let i = 60; i >= 0; i--) { v *= 1 + 0.004 + Math.sin(i + m.id) * 0.004; prints.push({ at: now() - i * 30 * DAY, value: s(i === 0 ? m.index : v, 2) }); }
  return [m.id, prints];
}));
const users = new Map(); // addr -> { available, vaultShares, pendingShares, unlockAt }
const positions = new Map(); // `${id}:${addr}` -> pos
const deposits = new Map(); // key -> { address, txHash, amount, status, confirmations, block, at }
const withdrawals = []; const trades = []; const nonces = new Map(); const sessions = new Map();
const vault = { value: 250_000, shares: 250_000 };
let wid = 1, tid = 1, protocolFees = 0;
const user = (a) => { a = addrOf(a); if (!users.has(a)) users.set(a, { available: 0, vaultShares: 0, pendingShares: 0, unlockAt: 0 }); return users.get(a); };
const mark = (m) => m.index * (1 + m.skew / m.skewScale);
const fill = (m, size, open = true) => { const base = open ? (size > 0 ? Math.max(m.index, m.target) : Math.min(m.index, m.target)) : m.index; return base * (1 + (m.skew + size / 2) / m.skewScale); };
const funding = (m) => Math.max(-0.001, Math.min(0.001, (m.skew / m.skewScale) * 0.001 * 10));
const closeOnly = (m) => !!m.nextPrintAt && now() + 6 * 3600 >= m.nextPrintAt && now() <= m.nextPrintAt + DAY;
const fail = (code, message, status = 400) => Object.assign(new Error(message || code), { code, status });

function posView(p) {
  const m = MARKETS[p.marketId], pnl = (m.index - p.entry) * p.size, eq = p.margin + pnl;
  const absN = Math.abs(p.size) * m.index;
  const liq = p.entry - (p.margin - MM * absN) / p.size;
  return { marketId: p.marketId, symbol: m.symbol, side: p.size > 0 ? "long" : "short", size: s(Math.abs(p.size), 8), entryPrice: s(p.entry, 6), indexPrice: s(m.index, 6), margin: s(p.margin), pnl: s(pnl), funding: "0", equity: s(eq), leverage: s(absN / p.margin, 2), liquidationPrice: s(liq, 4), liquidatable: eq < MM * absN };
}
function marketView(m) {
  return { id: m.id, symbol: m.symbol, name: m.name, indexPrice: s(m.index), targetPrice: s(m.target), markPrice: s(mark(m)), fundingRatePerDay: s(funding(m), 8), longOI: s(m.longOI, 4), shortOI: s(m.shortOI, 4), skew: s(m.skew, 4), longOIUsd: s(m.longOI * m.index), shortOIUsd: s(m.shortOI * m.index), closeOnly: closeOnly(m), nextPrintAt: m.nextPrintAt, lastPrint: m.lastPrint, change24h: "0", volume24h: s(m.vol24), active: m.active };
}
const sharePrice = () => (vault.shares > 0 ? vault.value / vault.shares : 1);
function meView(a) {
  const u = user(a); const mine = [...positions.values()].filter((p) => p.trader === a);
  const margin = mine.reduce((t, p) => t + p.margin, 0), upnl = mine.reduce((t, p) => t + (MARKETS[p.marketId].index - p.entry) * p.size, 0);
  const pend = withdrawals.filter((w) => w.address === a && w.status === "pending").reduce((t, w) => t + w.amount, 0);
  const vv = (u.vaultShares + u.pendingShares) * sharePrice();
  return { address: a, balance: { available: s(u.available), margin: s(margin), pendingWithdrawals: s(pend), vaultValue: s(vv), equity: s(u.available + margin + upnl + pend + vv) }, vault: { shares: s(u.vaultShares, 8), pendingShares: s(u.pendingShares, 8), unlockAt: u.unlockAt } };
}
const wView = (w) => ({ id: w.id, amount: s(w.amount), to: w.address, status: w.status, txHash: w.txHash || null, at: w.at, reason: w.reason || null });
function trade(p, kind, size, price, lev) {
  const t = { id: String(tid++), at: now(), marketId: p.marketId, side: p.size > 0 || size > 0 ? "long" : "short", kind, size: s(size, 8), price: s(price), notional: s(Math.abs(size) * price), leverage: lev ? s(lev, 1) : null, trader: p.trader };
  trades.unshift(t); MARKETS[p.marketId].vol24 += Math.abs(size) * price; broadcast({ type: "trade", data: pubTrade(t) }); return t;
}
const pubTrade = ({ trader, ...t }) => t;

// ---- routes ----
const routes = {
  "GET /config": () => SOL ? ({ chain: "solana", cluster: "mainnet-beta", companyAddress: COMPANY, tokens: TOKENS.map((t) => ({ ...t, companyTokenAccount: ata(COMPANY, t.mint) })), withdrawTokens: ["USDC", "USDT"], commitment: "finalized", minDeposit: "10", minWithdraw: "10", fees: { tradingBps: 5, maintenanceBps: 50, liquidationFeeBps: 20, maxLeverage: MAXLEV }, markets: MARKETS.map(({ id, symbol, name }) => ({ id, symbol, name })) }) : ({ chainId: CHAIN_ID, companyAddress: COMPANY, usdt: { address: USDT, decimals: 18 }, confirmations: CONF, minDeposit: "10", minWithdraw: "10", fees: { tradingBps: 5, maintenanceBps: 50, liquidationFeeBps: 20, maxLeverage: MAXLEV }, markets: MARKETS.map(({ id, symbol, name }) => ({ id, symbol, name })) }),
  "GET /markets": () => MARKETS.map(marketView),
  "GET /markets/:id/history": ({ params }) => ({ prints: hist[params.id] || [], snapshots: [] }),
  "GET /markets/:id/trades": ({ params, q }) => trades.filter((t) => t.marketId === Number(params.id)).slice(0, Number(q.limit || 50)).map(pubTrade),
  "GET /quote": ({ q }) => { const m = MARKETS[q.marketId], z = Number(q.size); return { fillPrice: s(fill(m, z)), fee: s(Math.abs(z) * fill(m, z) * FEE), closeFillPrice: s(fill(m, -z, false)) }; },
  "GET /vault": () => ({ poolValue: s(vault.value), totalShares: s(vault.shares, 8), sharePrice: s(sharePrice(), 8), feeApr7d: "0.124", utilization: s(Math.min(1, MARKETS.reduce((t, m) => t + Math.abs(m.skew) * m.index, 0) / vault.value), 4) }),
  "GET /stats": () => ({ tvl: s(vault.value + [...users.values()].reduce((t, u) => t + u.available, 0)), volume24h: s(MARKETS.reduce((t, m) => t + m.vol24, 0)), openInterest: s(MARKETS.reduce((t, m) => t + (m.longOI + m.shortOI) * m.index, 0)), traders: users.size }),
  "GET /health": () => ({ ok: true, lastBlock: lastBlock, chainId: CHAIN_ID }),
  "POST /auth/nonce": ({ body }) => {
    const a = addrOf(body.address), nonce = crypto.randomBytes(8).toString("hex");
    if (SOL) { const message = `localhost wants you to sign in with your Solana account:\n${a}\n\nSign in to Stoxhome.\n\nURI: http://localhost\nVersion: 1\nChain ID: mainnet\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`; nonces.set(a, message); return { message }; }
    const message = `stoxhome.local wants you to sign in with your Ethereum account:\n${a}\n\nSign in to Stoxhome.\n\nURI: http://localhost\nVersion: 1\nChain ID: 56\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
    nonces.set(a, message); return { message };
  },
  "POST /auth/verify": ({ body }) => {
    const a = addrOf(body.address);
    if (nonces.get(a) !== body.message) throw fail("UNAUTHORIZED", "Unknown or expired nonce", 401);
    const good = SOL ? nacl.sign.detached.verify(new TextEncoder().encode(body.message), bs58.decode(body.signature), bs58.decode(a)) : ethers.verifyMessage(body.message, body.signature) === a;
    if (!good) throw fail("UNAUTHORIZED", "Bad signature", 401);
    nonces.delete(a); const token = crypto.randomBytes(24).toString("hex"), expiresAt = now() + 7 * DAY;
    sessions.set(token, { address: a, expiresAt }); user(a);
    return { token, expiresAt, isAdmin: a === COMPANY };
  },
  "GET /me": ({ me }) => meView(me),
  "GET /me/deposits": ({ me }) => [...deposits.values()].filter((d) => d.address === me).sort((a, b) => b.at - a.at).map(({ address, block, ...d }) => ({ ...d, amount: s(d.amount) })),
  "GET /me/withdrawals": ({ me }) => withdrawals.filter((w) => w.address === me).slice().reverse().map(wView),
  "GET /me/positions": ({ me }) => [...positions.values()].filter((p) => p.trader === me).map(posView),
  "GET /me/history": ({ me }) => ({ trades: trades.filter((t) => t.trader === me).map((t) => ({ ...pubTrade(t), symbol: MARKETS[t.marketId].symbol })), margin: [], vault: [] }),
  "POST /positions/open": ({ me, body }) => {
    const m = MARKETS[body.marketId], u = user(me), size = Number(body.size), margin = Number(body.margin);
    if (!m.active) throw fail("MARKET_INACTIVE"); if (closeOnly(m)) throw fail("CLOSE_ONLY");
    if (positions.has(`${m.id}:${me}`)) throw fail("POSITION_EXISTS");
    if (margin > u.available) throw fail("INSUFFICIENT_BALANCE");
    const f = fill(m, size); if (size > 0 ? f > Number(body.acceptablePrice) : f < Number(body.acceptablePrice)) throw fail("SLIPPAGE");
    const notional = Math.abs(size) * f, fee = notional * FEE, net = margin - fee;
    if (notional > net * MAXLEV + 1e-9) throw fail("LEVERAGE_TOO_HIGH");
    u.available -= margin; protocolFees += fee * 0.1; vault.value += fee * 0.9;
    const p = { marketId: m.id, trader: me, size, entry: f, margin: net }; positions.set(`${m.id}:${me}`, p);
    m.skew += size; if (size > 0) m.longOI += size; else m.shortOI -= size;
    trade(p, "open", size, f, notional / net); notify(me); return posView(p);
  },
  "POST /positions/modify": ({ me, body }) => {
    const m = MARKETS[body.marketId], p = positions.get(`${m.id}:${me}`), d = Number(body.sizeDelta);
    if (!p) throw fail("NO_POSITION");
    const inc = Math.sign(d) === Math.sign(p.size);
    if (!inc && Math.abs(d) > Math.abs(p.size) + 1e-12) throw fail("FLIP_NOT_ALLOWED");
    if (inc && closeOnly(m)) throw fail("CLOSE_ONLY");
    const f = fill(m, d, inc); if (d > 0 ? f > Number(body.acceptablePrice) : f < Number(body.acceptablePrice)) throw fail("SLIPPAGE");
    const fee = Math.abs(d) * f * FEE;
    if (inc) { const ns = p.size + d; if (Math.abs(ns) * f > (p.margin - fee) * MAXLEV) throw fail("LEVERAGE_TOO_HIGH"); p.entry = (p.entry * p.size + f * d) / ns; p.size = ns; p.margin -= fee; }
    else { const realized = (f - p.entry) * -d; p.margin += realized - fee; p.size += d; vault.value -= realized; }
    vault.value += fee; m.skew += d; if (d > 0) (inc ? (m.longOI += d) : (m.shortOI -= d)); else (inc ? (m.shortOI -= d) : (m.longOI += d));
    if (Math.abs(p.size) < 1e-12) { user(me).available += p.margin; positions.delete(`${m.id}:${me}`); }
    trade(p, "modify", d, f); notify(me); return Math.abs(p.size) < 1e-12 ? {} : posView(p);
  },
  "POST /positions/close": ({ me, body }) => {
    const m = MARKETS[body.marketId], p = positions.get(`${m.id}:${me}`); if (!p) throw fail("NO_POSITION");
    const f = fill(m, -p.size, false); if (p.size > 0 ? f < Number(body.acceptablePrice) : f > Number(body.acceptablePrice)) throw fail("SLIPPAGE");
    const pnl = (f - p.entry) * p.size, fee = Math.abs(p.size) * f * FEE, payout = Math.max(0, p.margin + pnl - fee);
    user(me).available += payout; vault.value -= pnl - fee; m.skew -= p.size; if (p.size > 0) m.longOI -= p.size; else m.shortOI += p.size;
    positions.delete(`${m.id}:${me}`); trade(p, "close", -p.size, f); notify(me); return { realizedPnl: s(pnl - fee), payout: s(payout) };
  },
  "POST /positions/margin": ({ me, body }) => {
    const p = positions.get(`${body.marketId}:${me}`), u = user(me), d = Number(body.delta); if (!p) throw fail("NO_POSITION");
    if (d > u.available) throw fail("INSUFFICIENT_BALANCE");
    if (d < 0 && Math.abs(p.size) * MARKETS[p.marketId].index > (p.margin + d) * MAXLEV) throw fail("LEVERAGE_TOO_HIGH");
    p.margin += d; u.available -= d; notify(me); return posView(p);
  },
  "POST /vault/deposit": ({ me, body }) => { const u = user(me), a = Number(body.amount); if (a > u.available) throw fail("INSUFFICIENT_BALANCE"); const sh = a / sharePrice(); u.available -= a; u.vaultShares += sh; vault.value += a; vault.shares += sh; notify(me); return { shares: s(sh, 8) }; },
  "POST /vault/request-withdraw": ({ me, body }) => { const u = user(me); let sh = Number(body.shares); if (sh > u.vaultShares + 1e-6) throw fail("INSUFFICIENT_BALANCE"); sh = Math.min(sh, u.vaultShares); u.vaultShares -= sh; u.pendingShares += sh; u.unlockAt = now() + DAY; notify(me); return { unlockAt: u.unlockAt }; },
  "POST /vault/cancel-withdraw": ({ me }) => { const u = user(me); u.vaultShares += u.pendingShares; u.pendingShares = 0; u.unlockAt = 0; notify(me); return {}; },
  "POST /vault/withdraw": ({ me }) => { const u = user(me); if (now() < u.unlockAt) throw fail("WITHDRAW_LOCKED"); const a = u.pendingShares * sharePrice(); vault.value -= a; vault.shares -= u.pendingShares; u.pendingShares = 0; u.unlockAt = 0; u.available += a; notify(me); return { amount: s(a) }; },
  "POST /withdrawals": ({ me, body }) => { const u = user(me), a = Number(body.amount); if (a < 10) throw fail("MIN_AMOUNT"); if (a > u.available) throw fail("INSUFFICIENT_BALANCE"); u.available -= a; const w = { id: String(wid++), address: me, amount: a, status: "pending", at: now() }; withdrawals.push(w); notify(me, "withdrawal"); return wView(w); },
  "POST /withdrawals/:id/cancel": ({ me, params }) => { const w = withdrawals.find((x) => x.id === params.id && x.address === me); if (!w || w.status !== "pending") throw fail("NOT_PENDING", "Only pending withdrawals can be cancelled"); w.status = "cancelled"; user(me).available += w.amount; notify(me, "withdrawal"); return wView(w); },
  "GET /admin/overview": async () => {
    const usersL = [...users.values()].reduce((t, u) => t + u.available, 0) + [...positions.values()].reduce((t, p) => t + p.margin, 0) + withdrawals.filter((w) => w.status === "pending").reduce((t, w) => t + w.amount, 0);
    const onchain = rpc ? Number(ethers.formatUnits(await usdtC.balanceOf(COMPANY), 18)) : 300_000;
    const pend = withdrawals.filter((w) => w.status === "pending");
    return { companyUsdtOnChain: s(onchain), liabilities: { users: s(usersL), vault: s(vault.value), protocolFees: s(protocolFees) }, surplus: s(onchain - usersL - vault.value - protocolFees), pendingWithdrawals: { count: pend.length, amount: s(pend.reduce((t, w) => t + w.amount, 0)) } };
  },
  "GET /admin/withdrawals": ({ q }) => withdrawals.filter((w) => !q.status || w.status === q.status).map(wView),
  "POST /admin/withdrawals/:id/paid": async ({ params, body }) => {
    const w = withdrawals.find((x) => x.id === params.id); if (!w || w.status !== "pending") throw fail("NOT_PENDING", "Withdrawal is not pending");
    if (rpc) {
      const rc = await rpc.getTransactionReceipt(body.txHash); if (!rc || rc.status !== 1) throw fail("TX_NOT_FOUND", "Payment transaction not found or failed");
      const ok = rc.logs.some((l) => l.address.toLowerCase() === USDT.toLowerCase() && l.topics[0] === TRANSFER && ethers.getAddress("0x" + l.topics[1].slice(26)) === COMPANY && ethers.getAddress("0x" + l.topics[2].slice(26)) === w.address && BigInt(l.data) >= ethers.parseUnits(s(w.amount), 18));
      if (!ok) throw fail("TX_MISMATCH", "That transaction doesn't pay this withdrawal");
    }
    w.status = "paid"; w.txHash = body.txHash; notify(w.address, "withdrawal"); return wView(w);
  },
  "POST /admin/withdrawals/:id/reject": ({ params, body }) => { const w = withdrawals.find((x) => x.id === params.id); if (!w || w.status !== "pending") throw fail("NOT_PENDING", "Withdrawal is not pending"); w.status = "rejected"; w.reason = body.reason; user(w.address).available += w.amount; notify(w.address, "withdrawal"); return wView(w); },
  "POST /admin/index": ({ body }) => { const m = MARKETS.find((x) => x.symbol === body.symbol); const v = Number(body.value); if (!m || !(v > 0)) throw fail("BAD_PARAM", "Unknown market or value"); if (Math.abs(v / m.index - 1) > 0.1) throw fail("BAD_PARAM", "Print moves more than 10%"); m.target = v; m.lastPrint = { value: s(v), at: now() }; m.nextPrintAt = null; hist[m.id].push({ at: now(), value: s(v, 2) }); return marketView(m); },
  "POST /admin/schedule-print": ({ body }) => { const m = MARKETS.find((x) => x.symbol === body.symbol); if (!m) throw fail("BAD_PARAM", "Unknown market"); m.nextPrintAt = Number(body.at); return marketView(m); },
  "POST /admin/markets/:id": ({ params, body }) => { const m = MARKETS[params.id]; m.active = !!body.active; return marketView(m); },
  "POST /admin/vault/seed": ({ body }) => { const a = Number(body.amount); vault.value += a; vault.shares += a / sharePrice(); return { ok: true }; },
  "POST /dev/credit": ({ body }) => { user(body.address).available += Number(body.amount); notify(ethers.getAddress(body.address)); return { ok: true }; },
};
const AUTH = (k) => /^(GET \/me|POST \/(positions|vault|withdrawals)|GET \/admin|POST \/admin)/.test(k);
const ADMIN = (k) => k.includes(" /admin");

const compiled = Object.entries(routes).map(([k, fn]) => {
  const [method, path] = k.split(" "), names = [];
  const re = new RegExp("^" + path.replace(/:(\w+)/g, (_, n) => (names.push(n), "([^/]+)")) + "$");
  return { k, method, re, names, fn };
});
const server = http.createServer(async (req, res) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  const url = new URL(req.url, "http://x");
  const r = compiled.find((c) => c.method === req.method && c.re.test(url.pathname));
  const send = (code, obj) => { res.writeHead(code, { ...cors, "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (!r) return send(404, { error: "NOT_FOUND", message: "No such route" });
  try {
    const m = url.pathname.match(r.re), params = Object.fromEntries(r.names.map((n, i) => [n, m[i + 1]]));
    let body = {}; if (req.method === "POST") { const chunks = []; for await (const c of req) chunks.push(c); body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}; }
    let me = null;
    if (AUTH(r.k)) {
      const t = (req.headers.authorization || "").replace(/^Bearer /, ""), sess = sessions.get(t);
      if (!sess || sess.expiresAt < now()) throw fail("UNAUTHORIZED", "Sign in first", 401);
      me = sess.address;
      if (ADMIN(r.k) && me !== COMPANY) throw fail("UNAUTHORIZED", "Admin only", 403);
    }
    send(200, (await r.fn({ params, q: Object.fromEntries(url.searchParams), body, me })) ?? {});
  } catch (e) { send(e.status || 400, { error: e.code || "BAD_REQUEST", message: e.message }); }
});

// ---- websocket ----
const wss = new WebSocketServer({ server, path: "/ws" });
const socks = new Set();
wss.on("connection", (ws, req) => {
  const t = new URL(req.url, "http://x").searchParams.get("token"); ws.addr = sessions.get(t)?.address || null;
  socks.add(ws); ws.on("close", () => socks.delete(ws));
  ws.send(JSON.stringify({ type: "markets", data: MARKETS.map(marketView) }));
});
function broadcast(msg) { const s = JSON.stringify(msg); for (const ws of socks) if (ws.readyState === 1) ws.send(s); }
function notify(addr, type = "me") { const s = JSON.stringify({ type, data: { address: addr } }); for (const ws of socks) if (ws.addr === addr && ws.readyState === 1) ws.send(s); }
setInterval(() => {
  for (const m of MARKETS) m.index += (m.target - m.index) / (7 * 24 * 60); // phase prints in
  broadcast({ type: "markets", data: MARKETS.map(marketView) });
}, 3000);

// ---- optional chain watcher (local Hardhat + MockUSDT as USDT) ----
const TRANSFER = ethers.id("Transfer(address,address,uint256)");
const rpc = process.env.STUB_RPC ? new ethers.JsonRpcProvider(process.env.STUB_RPC, undefined, { staticNetwork: true }) : null;
const usdtC = rpc ? new ethers.Contract(USDT, ["function balanceOf(address) view returns (uint256)"], rpc) : null;
let lastBlock = 0, scanned = 0;
if (rpc) {
  scanned = await rpc.getBlockNumber();
  setInterval(async () => {
    try {
      lastBlock = await rpc.getBlockNumber();
      if (lastBlock > scanned) {
        const logs = await rpc.getLogs({ address: USDT, fromBlock: scanned + 1, toBlock: lastBlock, topics: [TRANSFER, null, ethers.zeroPadValue(COMPANY, 32)] });
        for (const l of logs) {
          const key = `${l.transactionHash}:${l.index}`; if (deposits.has(key)) continue;
          const from = ethers.getAddress("0x" + l.topics[1].slice(26)); if (from === COMPANY) continue;
          deposits.set(key, { address: from, txHash: l.transactionHash, amount: Number(ethers.formatUnits(BigInt(l.data), 18)), status: "confirming", confirmations: 0, block: l.blockNumber, at: now() });
        }
        scanned = lastBlock;
      }
      for (const d of deposits.values()) {
        if (d.status === "credited") continue;
        const c = lastBlock - d.block + 1;
        if (c !== d.confirmations) { d.confirmations = c; notify(d.address, "deposit"); }
        if (c >= CONF) { d.status = "credited"; user(d.address).available += d.amount; notify(d.address, "deposit"); notify(d.address); }
      }
    } catch (e) { console.error("[stub] watcher", e.shortMessage || e.message); }
  }, 1500);
}

server.listen(PORT, () => console.log(`[stub-engine] http://127.0.0.1:${PORT} company ${COMPANY}${rpc ? " watching " + process.env.STUB_RPC : ""}`));
