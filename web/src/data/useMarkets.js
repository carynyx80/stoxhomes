// Data-provider interface for the UI. VITE_USE_MOCK (default "true") serves src/data/mock.js;
// VITE_USE_MOCK=false serves the live source in src/data/live.js (contracts via src/chain.js + indexer API).
import { useEffect, useState } from "react";
import * as mock from "./mock.js";
import { useLiveExchange, fetchHistory } from "./live.js";

export const USE_MOCK = (import.meta.env.VITE_USE_MOCK ?? "true") !== "false";

/*
 Live mapping (WAD -> display numbers via ethers.formatUnits; raw bigints kept on `raw`):
   markets        -> exchange.getAllMarkets() (index, mark, funding, skew, OI, closeOnly, scheduledPrint) + API /markets (24h vol/change)
   pool           -> exchange.poolValue(), totalShares(), shares(acct), pendingWithdrawal(acct) + API /pool (fee APR)
   positions      -> exchange.positionInfo(i, acct) for every market
   trades (tape)  -> API /markets/:id/trades, refreshed on WebSocket /ws pushes
   history        -> API /traders/:addr/history
   stats strip    -> API /stats (falls back to on-chain pool value / OI)
   chart          -> API /markets/:id/history, falling back to oracle FeedCreated/IndexPushed logs
   actions        -> openPosition (quoteOpenFill, 0.5% slippage), modifyPosition (increase: quoteOpenFill,
                     reduce: quoteFill), addMargin, closePosition (quoteFill), deposit(amount, minSharesOut),
                     requestWithdraw(shares), cancelWithdraw(), withdraw(shares, minAmountOut), MockUSDT.mint / VITE_FAUCET_URL
*/

function useMockExchange() {
  const [, setT] = useState(0);
  const [toasts, setToasts] = useState([]);
  useEffect(() => {
    const h = setInterval(() => { mock.tick(); setT((x) => x + 1); }, 2200);
    return () => clearInterval(h);
  }, []);
  const markets = mock.getMarkets(), pool = mock.getPool();
  const note = (text) => { const id = Math.random(); setToasts((x) => [...x, { id, kind: "ok", text: "Mock mode — " + text }]); setTimeout(() => setToasts((x) => x.filter((y) => y.id !== id)), 4000); return true; };
  const actions = Object.fromEntries(["connect", "faucet", "open", "increase", "reduce", "addMargin", "close", "deposit", "requestWithdraw", "cancelWithdraw", "withdraw"].map((k) => [k, async () => note(k + " (no transaction sent)")]));
  return {
    ready: true, live: false, error: null, busy: null, clockOffset: 0, faucet: true, apiOnline: true,
    markets, pool, positions: mock.getPositions(), trades: mock.getTrades(), history: mock.getHistoryRows(),
    params: mock.params, wallet: { ...mock.wallet, connected: true },
    stats: { tvl: pool.poolValue, volume24h: markets.reduce((s, x) => s + x.volume24h, 0), oi: markets.reduce((s, x) => s + (x.longSize + x.shortSize) * x.index, 0) },
    toasts, dismiss: (id) => setToasts((x) => x.filter((y) => y.id !== id)), actions,
  };
}

export const useExchange = USE_MOCK ? useMockExchange : useLiveExchange;

export function useHistorySeries(market, range, nowMs, refreshKey) {
  const [data, setData] = useState(() => (USE_MOCK ? mock.getHistory(market.id, range) : null));
  useEffect(() => {
    if (USE_MOCK) { setData(mock.getHistory(market.id, range)); return; }
    let stop = false;
    fetchHistory(market, range, nowMs).then((d) => { if (!stop) setData(d); });
    return () => { stop = true; };
  }, [market.id, range, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  return data;
}

export function useNow(ms = 1000) {
  const [n, setN] = useState(Date.now());
  useEffect(() => { const h = setInterval(() => setN(Date.now()), ms); return () => clearInterval(h); }, [ms]);
  return n;
}
export const countdown = (msLeft) => {
  const s = Math.max(0, Math.floor(msLeft / 1000)), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : `${h}h ${String(m).padStart(2, "0")}m`;
};
export const getFundingGrid = () => mock.getFundingGrid();
