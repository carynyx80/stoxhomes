// Engine data source (custodial off-chain exchange, docs/ENGINE_API.md).
// Everything comes from VITE_ENGINE_URL (REST + /ws). The wallet is only used to sign in
// (personal_sign), to deposit (USDT.transfer to the company wallet) and, for the admin, to pay withdrawals.
import { useCallback, useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import { META } from "./meta.js";
import { useWallet, walletError } from "./wallet.js";

export const ENGINE = (import.meta.env.VITE_ENGINE_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const SLIP = 0.005;
const ERC20 = ["function balanceOf(address) view returns (uint256)", "function transfer(address to, uint256 amount) returns (bool)"];
const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");
const n = (x) => (x == null || x === "" ? 0 : Number(x));
export const explorerFor = (chainId) => ({ 56: "https://bscscan.com", 97: "https://testnet.bscscan.com" })[chainId] || null;

// decimal-string math via 18-dec bigints (no float rounding on amounts we send)
const D = 18;
const big = (s) => ethers.parseUnits(typeof s === "number" ? s.toFixed(12) : String(s), D);
const str = (b, dp = 6) => { const s = ethers.formatUnits(b, D); const [i, f = ""] = s.split("."); const ff = f.slice(0, dp).replace(/0+$/, ""); return ff ? `${i}.${ff}` : i; };
const mulF = (b, f) => (b * BigInt(Math.round(f * 1e6))) / 1_000_000n;

export const ERRORS = {
  UNAUTHORIZED: "Your session expired. Sign in again.",
  INSUFFICIENT_BALANCE: "Not enough available balance. Deposit USDT or lower the amount.",
  LEVERAGE_TOO_HIGH: "Leverage would exceed 100×. Add margin or reduce size.",
  WOULD_BE_LIQUIDATABLE: "That would put the position at its liquidation level. Lower leverage or add margin.",
  SLIPPAGE: "Price moved more than 0.5% while submitting. Try again.",
  CLOSE_ONLY: "This market is close-only until the scheduled index print. You can still close or reduce.",
  MARKET_INACTIVE: "This market is paused.",
  SKEW_CAP: "The vault can't take more one-sided exposure in this market right now.",
  POSITION_EXISTS: "You already have a position in this market. Increase or close it instead.",
  NO_POSITION: "You have no position in this market.",
  FLIP_NOT_ALLOWED: "Reducing past zero would flip the position. Close it instead.",
  WITHDRAW_LOCKED: "Your vault withdrawal is still in its 24h cooldown.",
  MIN_AMOUNT: "That amount is below the minimum.",
  RATE_LIMITED: "Too many requests. Wait a moment and try again.",
};
class EngineError extends Error { constructor(code, message, status) { super(ERRORS[code] || message || code); this.code = code; this.status = status; } }

async function call(path, { method = "GET", body, token } = {}) {
  let r;
  try {
    r = await fetch(ENGINE + path, {
      method, signal: AbortSignal.timeout(10_000),
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch { throw new EngineError("OFFLINE", "Can't reach the exchange. Check your connection."); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new EngineError(j.error || (r.status === 401 ? "UNAUTHORIZED" : "HTTP_" + r.status), j.message || `Request failed (${r.status})`, r.status);
  return j;
}
const soft = (p) => p.then((v) => v, () => null);

// ---- token storage (per address) ----
const tkKey = (a) => "housedex.token." + a.toLowerCase();
const tokens = {
  get(a) { try { const t = JSON.parse(localStorage.getItem(tkKey(a)) || "null"); return t && t.expiresAt * 1000 > Date.now() + 60_000 ? t : null; } catch { return null; } },
  set(a, t) { try { localStorage.setItem(tkKey(a), JSON.stringify(t)); } catch { /* storage blocked */ } },
  drop(a) { try { localStorage.removeItem(tkKey(a)); } catch { /* storage blocked */ } },
};

export function useEngineExchange() {
  const notifyRef = useRef(null);
  const wcRaw = useWallet((t) => notifyRef.current?.(t));
  const account = wcRaw.account;
  const [session, setSession] = useState(null); // { token, expiresAt, isAdmin, address }
  const [cfg, setCfg] = useState(null);
  const [pub, setPub] = useState(null);
  const [me, setMe] = useState(null);
  const [error, setError] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [busy, setBusy] = useState(null);
  const [signing, setSigning] = useState(false);
  const loading = useRef(false);

  // session follows the connected address; never prompts
  useEffect(() => {
    if (!account) { setSession(null); setMe(null); return; }
    const t = tokens.get(account);
    setSession(t ? { ...t, address: account } : null);
    setMe(null);
  }, [account]);
  const token = session?.address === account ? session?.token : null;

  const push = (t) => { const id = Math.random().toString(36).slice(2); setToasts((x) => [...x, { id, ...t }]); if (t.kind !== "pending") setTimeout(() => dismiss(id), 6000); return id; };
  const patch = (id, t) => { setToasts((x) => x.map((y) => (y.id === id ? { ...y, ...t } : y))); if (t.kind && t.kind !== "pending") setTimeout(() => dismiss(id), 6000); };
  const dismiss = (id) => setToasts((x) => x.filter((y) => y.id !== id));
  notifyRef.current = push;

  const expire = useCallback(() => { if (account) tokens.drop(account); setSession(null); setMe(null); }, [account]);

  const loadPublic = useCallback(async () => {
    try {
      const c = cfg || (await call("/config"));
      if (!cfg) setCfg(c);
      const ids = c.markets.map((m) => m.id);
      const [markets, vault, stats, ...tapes] = await Promise.all([
        call("/markets"), soft(call("/vault")), soft(call("/stats")), ...ids.map((i) => soft(call(`/markets/${i}/trades?limit=15`))),
      ]);
      setPub({ markets, vault, stats, tapes, at: Date.now() });
      setError(null);
    } catch (e) { setError(e.message); }
  }, [cfg]);

  const loadMe = useCallback(async () => {
    if (!token) return;
    try {
      const [m, positions, history, deposits, withdrawals] = await Promise.all([
        call("/me", { token }), call("/me/positions", { token }), soft(call("/me/history", { token })),
        soft(call("/me/deposits", { token })), soft(call("/me/withdrawals", { token })),
      ]);
      setMe({ me: m, positions, history, deposits: deposits || [], withdrawals: withdrawals || [], token });
    } catch (e) { if (e.code === "UNAUTHORIZED") { expire(); push({ kind: "info", text: ERRORS.UNAUTHORIZED }); } }
  }, [token, expire]);

  const load = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    try { await Promise.all([loadPublic(), loadMe()]); } finally { loading.current = false; }
  }, [loadPublic, loadMe]);

  useEffect(() => { load(); const h = setInterval(load, 5000); return () => clearInterval(h); }, [load]);

  // websocket: markets/trades for everyone, me/deposit/withdrawal when signed in
  useEffect(() => {
    let ws, stop = false, timer;
    const open = () => {
      try { ws = new WebSocket(ENGINE.replace(/^http/, "ws") + "/ws" + (token ? `?token=${encodeURIComponent(token)}` : "")); } catch { return; }
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === "markets" && Array.isArray(m.data)) setPub((p) => (p ? { ...p, markets: m.data } : p));
        else if (m.type === "trade") loadPublic();
        else if (["me", "deposit", "withdrawal"].includes(m.type)) loadMe();
      };
      ws.onclose = () => { if (!stop) timer = setTimeout(open, 4000); };
      ws.onerror = () => ws.close();
    };
    open();
    return () => { stop = true; clearTimeout(timer); ws?.close(); };
  }, [token, loadPublic, loadMe]);

  // ---- sign in ----
  const signIn = useCallback(async () => {
    if (!account || !wcRaw.entry) { wcRaw.openPicker(); return false; }
    if (signing) return false;
    setSigning(true);
    try {
      const { message } = await call("/auth/nonce", { method: "POST", body: { address: account } });
      const hex = ethers.hexlify(ethers.toUtf8Bytes(message));
      const signature = await wcRaw.entry.provider.request({ method: "personal_sign", params: [hex, account] });
      const t = await call("/auth/verify", { method: "POST", body: { address: account, message, signature } });
      tokens.set(account, t);
      setSession({ ...t, address: account });
      push({ kind: "ok", text: t.isAdmin ? "Signed in as Stoxhome admin" : "Signed in" });
      return true;
    } catch (e) {
      const we = walletError(e);
      push(we ? { kind: we.quiet ? "info" : "err", text: we.text } : { kind: "err", text: e.message || "Sign-in failed." });
      return false;
    } finally { setSigning(false); }
  }, [account, wcRaw, signing]);

  // ---- engine actions ----
  const act = (name, label, fn) => async (...args) => {
    if (!account) { wcRaw.openPicker(); return false; }
    if (!token) { return signIn(); }
    setBusy(name);
    const id = push({ kind: "pending", text: label(...args) + "…" });
    try {
      const out = await fn(...args);
      patch(id, { kind: "ok", text: label(...args) + " — done" });
      return out ?? true;
    } catch (e) {
      if (e.code === "UNAUTHORIZED") expire();
      patch(id, { kind: "err", text: e.message });
      return false;
    } finally { setBusy(null); load(); }
  };
  const post = (path, body) => call(path, { method: "POST", body, token });
  const quote = (marketId, size) => call(`/quote?marketId=${marketId}&size=${encodeURIComponent(size)}`);
  const accept = (price, buying) => str(mulF(big(price), buying ? 1 + SLIP : 1 - SLIP), 8);
  const posOf = (id) => (me?.positions || []).find((p) => Number(p.marketId) === Number(id));
  const signedSize = (p) => (p.side === "short" ? "-" : "") + String(p.size).replace(/^-/, "");

  const actions = {
    connect: async () => wcRaw.openPicker(),
    signIn,
    open: act("open", ({ side, leverage, marketId }) => `${side === "long" ? "Long" : "Short"} ${symOf(marketId)} ${leverage}×`, async ({ marketId, side, margin, leverage }) => {
      const fee = (cfg?.fees?.tradingBps ?? 5) / 10_000;
      const m = big(margin);
      if (m <= 0n) throw new Error("Enter a margin amount.");
      const notional = mulF(m, (leverage / (1 + leverage * fee)) * 0.999);
      const mark = big(mkt(marketId).markPrice);
      const guess = (notional * 10n ** 18n) / mark;
      const sign = side === "long" ? "" : "-";
      const q = await quote(marketId, sign + str(guess, 8));
      const size = sign + str((notional * 10n ** 18n) / big(q.fillPrice), 8);
      return post("/positions/open", { marketId, size, margin: str(m), acceptablePrice: accept(q.fillPrice, side === "long") });
    }),
    increase: act("increase", ({ marketId, units }) => `Increase ${symOf(marketId)} by ${units} u`, async ({ marketId, units, extraMargin }) => {
      const p = posOf(marketId), long = p.side === "long";
      if (Number(extraMargin) > 0) await post("/positions/margin", { marketId, delta: str(big(extraMargin)) });
      const delta = (long ? "" : "-") + str(big(units), 8);
      const q = await quote(marketId, delta);
      return post("/positions/modify", { marketId, sizeDelta: delta, acceptablePrice: accept(q.fillPrice, long) });
    }),
    reduce: act("reduce", ({ marketId, units }) => `Reduce ${symOf(marketId)} by ${units} u`, async ({ marketId, units }) => {
      const p = posOf(marketId), long = p.side === "long";
      let amt = big(units); const full = big(String(p.size).replace(/^-/, ""));
      if (amt > full) amt = full;
      const q = await quote(marketId, (long ? "" : "-") + str(amt, 8));
      return post("/positions/modify", { marketId, sizeDelta: (long ? "-" : "") + str(amt, 8), acceptablePrice: accept(q.closeFillPrice ?? q.fillPrice, !long) });
    }),
    close: act("close", ({ marketId }) => `Close ${symOf(marketId)}`, async ({ marketId }) => {
      const p = posOf(marketId), long = p.side === "long";
      const q = await quote(marketId, signedSize(p));
      return post("/positions/close", { marketId, acceptablePrice: accept(q.closeFillPrice ?? q.fillPrice, !long) });
    }),
    addMargin: act("addMargin", ({ amount }) => `Add ${amount} USDT margin`, ({ marketId, amount }) => post("/positions/margin", { marketId, delta: str(big(amount)) })),
    removeMargin: act("removeMargin", ({ amount }) => `Remove ${amount} USDT margin`, ({ marketId, amount }) => post("/positions/margin", { marketId, delta: "-" + str(big(amount)) })),
    deposit: act("vaultDeposit", ({ amount }) => `Deposit ${amount} USDT to the vault`, ({ amount }) => post("/vault/deposit", { amount: str(big(amount)) })),
    requestWithdraw: act("requestWithdraw", ({ pct }) => `Request vault withdrawal (${pct}%)`, ({ pct }) => {
      const sh = big(me.me.vault.shares);
      return post("/vault/request-withdraw", { shares: str((sh * BigInt(Math.round(pct * 100))) / 10_000n, 8) });
    }),
    cancelWithdraw: act("cancelWithdraw", () => "Cancel vault withdrawal", () => post("/vault/cancel-withdraw")),
    withdraw: act("withdraw", () => "Withdraw from vault", () => post("/vault/withdraw")),
    requestPayout: act("payout", ({ amount }) => `Withdrawal request for ${amount} USDT`, ({ amount }) => post("/withdrawals", { amount: str(big(amount)) })),
    cancelPayout: act("cancelPayout", () => "Cancel withdrawal", ({ id }) => post(`/withdrawals/${id}/cancel`)),
    depositOnChain: async ({ amount }) => {
      // USDT.transfer(company, amount) from the connected wallet, on the engine's chain
      if (!account || !wcRaw.entry) { wcRaw.openPicker(); return null; }
      setBusy("depositOnChain");
      try {
        if (wcRaw.chainId !== cfg.chainId && !(await wcRaw.switchChain(cfg.chainId))) return null;
        const bp = new ethers.BrowserProvider(wcRaw.entry.provider, "any");
        const usdt = new ethers.Contract(cfg.usdt.address, ERC20, bp);
        const value = ethers.parseUnits(String(amount), cfg.usdt.decimals ?? 18);
        if (value <= 0n) throw new Error("Enter an amount.");
        if (cfg.minDeposit && Number(amount) < Number(cfg.minDeposit)) throw new Error(`Minimum deposit is ${cfg.minDeposit} USDT.`);
        const [bal, gas] = await Promise.all([usdt.balanceOf(account), bp.getBalance(account)]);
        if (bal < value) throw new Error(`Not enough USDT in your wallet: you have ${Number(ethers.formatUnits(bal, cfg.usdt.decimals ?? 18)).toLocaleString()} USDT.`);
        if (gas === 0n) throw new Error(`You need a little ${cfg.chainId === 56 || cfg.chainId === 97 ? "BNB" : "native coin"} in this wallet to pay gas.`);
        const id = push({ kind: "pending", text: "Deposit — confirm in wallet" });
        const tx = await new ethers.Contract(cfg.usdt.address, ERC20, new ethers.JsonRpcSigner(bp, account)).transfer(cfg.companyAddress, value);
        patch(id, { kind: "ok", text: "Deposit sent — waiting for confirmations", hash: tx.hash });
        return tx.hash;
      } catch (e) {
        const we = walletError(e);
        push(we ? { kind: we.quiet ? "info" : "err", text: we.text } : { kind: "err", text: e.shortMessage || e.message });
        return null;
      } finally { setBusy(null); }
    },
  };
  function mkt(id) { return pub.markets.find((m) => Number(m.id) === Number(id)); }
  function symOf(id) { return mkt(id)?.symbol ?? id; }

  // ---- admin ----
  const admin = {
    call: (path, opts = {}) => call(path, { ...opts, token }),
    pay: async (w) => {
      // company wallet pays USDT.transfer(to, amount) in the browser, then reports the tx hash
      try {
        setBusy("pay:" + w.id);
        if (wcRaw.chainId !== cfg.chainId && !(await wcRaw.switchChain(cfg.chainId))) return false;
        const bp = new ethers.BrowserProvider(wcRaw.entry.provider, "any");
        const usdt = new ethers.Contract(cfg.usdt.address, ERC20, new ethers.JsonRpcSigner(bp, account));
        const value = ethers.parseUnits(String(w.amount), cfg.usdt.decimals ?? 18);
        const id = push({ kind: "pending", text: `Pay ${w.amount} USDT to ${short(w.to)} — confirm in wallet` });
        const tx = await usdt.transfer(w.to, value);
        patch(id, { text: "Payment sent — waiting for 1 confirmation", hash: tx.hash });
        await tx.wait();
        await call(`/admin/withdrawals/${w.id}/paid`, { method: "POST", body: { txHash: tx.hash }, token });
        patch(id, { kind: "ok", text: `Paid ${w.amount} USDT to ${short(w.to)}` });
        return true;
      } catch (e) {
        const we = walletError(e);
        push(we ? { kind: we.quiet ? "info" : "err", text: we.text } : { kind: "err", text: e.shortMessage || e.message });
        return false;
      } finally { setBusy(null); }
    },
  };

  // ---- shape for the UI ----
  const ready = !!(cfg && pub);
  let view = {};
  if (ready) {
    const markets = pub.markets.map((m) => {
      const sym = m.symbol, next = m.nextPrintAt ? Number(m.nextPrintAt) * 1000 : null;
      return {
        id: Number(m.id), name: m.name || `${sym}-USD`, symbol: sym, ...(META[sym] || { city: sym, country: "", coords: "" }),
        index: n(m.indexPrice), mark: n(m.markPrice), funding: n(m.fundingRatePerDay), skew: n(m.skew), skewScale: 0,
        longSize: n(m.longOI), shortSize: n(m.shortOI), change24h: n(m.change24h), change1y: null, volume24h: n(m.volume24h),
        nextPrintAt: next, closeOnlyFrom: next ? next - 6 * 3600_000 : null, closeOnly: !!m.closeOnly, active: m.active !== false,
        raw: { markPrice: m.markPrice },
      };
    });
    const v = pub.vault || {}, pv = n(v.poolValue);
    const backing = markets.map((m) => (pv > 0 ? (Math.abs(m.skew) * m.index) / pv : 0));
    const used = Math.min(1, backing.reduce((a, b) => a + b, 0));
    const mine = me && me.token === token ? me : null;
    const mv = mine?.me?.vault;
    const sym = (id) => markets.find((m) => m.id === Number(id))?.symbol ?? String(id);
    const trades = pub.tapes.flat().filter(Boolean).sort((a, b) => n(b.at) - n(a.at)).slice(0, 40).map((t) => ({
      id: t.id, ts: n(t.at) * 1000, market: sym(t.marketId), side: t.side, kind: t.kind, price: n(t.price), size: Math.abs(n(t.size)),
      notional: n(t.notional), leverage: t.leverage ? Math.round(n(t.leverage)) : null,
    }));
    const positions = (mine?.positions || []).map((p) => ({
      marketId: Number(p.marketId), market: p.symbol || sym(p.marketId), city: META[p.symbol]?.city, side: p.side, size: Math.abs(n(p.size)),
      margin: n(p.margin), entryPrice: n(p.entryPrice), indexPrice: n(p.indexPrice), pnl: n(p.pnl), funding: -n(p.funding),
      equity: n(p.equity), liquidationPrice: n(p.liquidationPrice), liquidatable: !!p.liquidatable, leverage: Math.max(1, Math.round(n(p.leverage))), raw: p,
    }));
    const history = (mine?.history?.trades || []).map((t) => ({
      ts: n(t.at) * 1000, market: t.symbol || sym(t.marketId), action: t.kind ? t.kind[0].toUpperCase() + t.kind.slice(1) : "Trade", side: t.side,
      size: Math.abs(n(t.size)), price: n(t.price), pnl: t.kind === "open" || t.realizedPnl == null ? null : n(t.realizedPnl),
    }));
    const bal = mine?.me?.balance;
    view = {
      clockOffset: 0, markets, positions, trades, history, apiOnline: true,
      params: { tradingFeeBps: cfg.fees?.tradingBps ?? 5, maintenanceMarginBps: cfg.fees?.maintenanceBps ?? 50, maxLeverage: cfg.fees?.maxLeverage ?? 100, withdrawCooldown: 86400, closeOnlyWindow: 6 * 3600 },
      stats: { tvl: n(pub.stats?.tvl ?? pv), volume24h: n(pub.stats?.volume24h), oi: n(pub.stats?.openInterest) },
      pool: {
        poolValue: pv, totalShares: n(v.totalShares), shares: n(mv?.shares), sharePrice: n(v.sharePrice) || 1,
        apr: v.feeApr7d != null ? n(v.feeApr7d) : null, feesApr: v.feeApr7d != null ? n(v.feeApr7d) : null, fundingApr: null, pnlApr: null,
        utilization: v.utilization != null ? n(v.utilization) : used,
        composition: [{ label: "Idle USDT", value: Math.max(0, 1 - used) }, ...markets.map((m, i) => ({ label: "Backing " + m.symbol, value: backing[i] }))],
        pendingWithdrawal: mv && n(mv.pendingShares) > 0 ? { shares: n(mv.pendingShares), unlockAt: n(mv.unlockAt) * 1000, requestedAt: (n(mv.unlockAt) - 86400) * 1000, expiresAt: 0, estimatedAmount: n(mv.pendingShares) * (n(v.sharePrice) || 1) } : null,
      },
      wallet: token && bal
        ? { connected: true, signedIn: true, address: short(account), full: account, balance: n(bal.available), margin: n(bal.margin), pendingWithdrawals: n(bal.pendingWithdrawals), equity: n(bal.equity) }
        : { connected: !!account, signedIn: !!token, address: short(account), full: account || "", balance: 0 },
      deposits: mine?.deposits || [], withdrawals: mine?.withdrawals || [],
    };
  }

  return {
    ready, error: ready ? error : error || null, live: true, engine: true, faucet: false,
    config: cfg, session: token ? session : null, isAdmin: !!(token && session?.isAdmin), signing,
    wc: { ...wcRaw, wrongChain: false, disconnect: async () => { if (account) tokens.drop(account); setSession(null); await wcRaw.disconnect(); } },
    toasts, dismiss, notify: push, busy, actions, admin, reload: load, explorer: explorerFor(cfg?.chainId),
    ...view,
  };
}
