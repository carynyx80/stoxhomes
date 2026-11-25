// Data-provider interface for the UI. Today it serves the mock layer; set VITE_USE_MOCK=false
// to swap in a live adapter built on src/chain.js (see liveAdapter below for the call mapping).
import { useEffect, useState } from "react";
import * as mock from "./mock.js";

export const USE_MOCK = (import.meta.env.VITE_USE_MOCK ?? "true") !== "false";

/*
 Live mapping (all WAD -> Number(ethers.formatEther(x))):
   getMarkets()   -> for i < exchange.marketCount(): exchange.getMarket(i) {skew, skewScale, longSize, shortSize},
                     exchange.indexPrice(i), exchange.markPrice(i), exchange.fundingRatePerDay(i)
   getPool()      -> exchange.poolValue(), exchange.totalShares(), exchange.shares(account)
   getPositions() -> exchange.positionInfo(i, account) {size, margin, entryPrice, indexPrice, pnl, funding,
                     equity, liquidationPrice, liquidatable}
   modify         -> exchange.modifyPosition(i, sizeDelta, marginDelta, priceLimit)  (Increase / Reduce)
   withdrawals    -> exchange.requestWithdraw(shares), then exchange.withdraw() after withdrawCooldown (24h)
   close-only     -> oracle next scheduled print time; opening/increasing paused inside closeOnlyWindow
   getTrades()    -> exchange PositionOpened / PositionClosed event logs (queryFilter)
   getHistory()   -> oracle print events (HouseIndexOracle) or an indexer
*/
const source = mock; // TODO: replace with liveAdapter when USE_MOCK is false

function useTicker(ms = 2200) {
  const [t, setT] = useState(0);
  useEffect(() => {
    const h = setInterval(() => { if (USE_MOCK) source.tick(); setT((x) => x + 1); }, ms);
    return () => clearInterval(h);
  }, [ms]);
  return t;
}

export function useExchange() {
  const t = useTicker();
  return {
    t,
    markets: source.getMarkets(),
    pool: source.getPool(),
    positions: source.getPositions(),
    trades: source.getTrades(),
    params: source.params,
    history: source.getHistoryRows(),
    wallet: source.wallet,
  };
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

export const useHistory = (id, range) => source.getHistory(id, range);
export const getFundingGrid = () => source.getFundingGrid();
