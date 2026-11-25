// Mock data layer. Shapes mirror the HousePerpExchange views, but values are plain JS numbers
// (the live adapter converts 1e18 WAD values with ethers.formatEther before handing them to the UI).

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const CITIES = [
  { id: 0, symbol: "NYC", printInH: 74, city: "New York", country: "US", base: 330, drift: 0.045, vol: 0.006, skewScale: 400_000_000, skew: 182_000, long: 1_240_000, short: 1_058_000, coords: "40.71N 74.00W" },
  { id: 1, symbol: "LA", printInH: 130, city: "Los Angeles", country: "US", base: 440, drift: 0.062, vol: 0.007, skewScale: 350_000_000, skew: -96_000, long: 812_000, short: 908_000, coords: "34.05N 118.24W" },
  { id: 2, symbol: "MIA", printInH: 10.2, city: "Miami", country: "US", base: 430, drift: 0.09, vol: 0.009, skewScale: 300_000_000, skew: 240_000, long: 1_020_000, short: 780_000, coords: "25.76N 80.19W" },
  { id: 3, symbol: "SF", printInH: 200, city: "San Francisco", country: "US", base: 350, drift: -0.01, vol: 0.008, skewScale: 300_000_000, skew: -151_000, long: 610_000, short: 761_000, coords: "37.77N 122.42W" },
  { id: 4, symbol: "LDN", printInH: 2.67, city: "London", country: "UK", base: 290, drift: 0.02, vol: 0.005, skewScale: 350_000_000, skew: 41_000, long: 702_000, short: 661_000, coords: "51.50N 0.12W" },
];

const DAY = 86_400_000;
const DAYS = 5 * 365;
const NOW = Date.now();

// Daily index history (5Y). Real estate: slow drift, seasonality, monthly prints phased in over 7 days.
function makeHistory(c) {
  const r = rng(c.id * 7919 + 13);
  const pts = [];
  let v = c.base / Math.exp(c.drift * 5) * (0.96 + r() * 0.06);
  let regime = 0;
  for (let i = DAYS; i >= 0; i--) {
    if (i % 180 === 0) regime = (r() - 0.5) * 0.0006;
    const season = Math.sin(((DAYS - i) / 365) * Math.PI * 2) * 0.00012;
    v *= 1 + c.drift / 365 + regime + season + (r() - 0.5) * c.vol * 0.35;
    pts.push({ t: NOW - i * DAY, index: v });
  }
  // rescale so last point lands on base
  const k = c.base / pts[pts.length - 1].index;
  return pts.map((p, j) => {
    const index = p.index * k;
    const prem = Math.sin(j / 9 + c.id) * 0.0012 + Math.sin(j / 31) * 0.0008 + (c.skew / c.skewScale) * 0.8;
    return { t: p.t, index, mark: index * (1 + prem) };
  });
}

const histories = Object.fromEntries(CITIES.map((c) => [c.id, makeHistory(c)]));

export function getHistory(id, range) {
  const days = { "1M": 30, "6M": 182, "1Y": 365, "5Y": DAYS }[range] ?? 365;
  const h = histories[id];
  const slice = h.slice(-days - 1);
  const step = Math.max(1, Math.floor(slice.length / 220));
  return slice.filter((_, i) => i % step === 0 || i === slice.length - 1);
}

// Funding/day history per city (14 days) for the heatmap; wad-style fraction, e.g. 0.0004 = 0.04%/day.
export function getFundingGrid() {
  return CITIES.map((c) => {
    const r = rng(c.id * 31 + 5);
    const base = (c.skew / c.skewScale) * 1.2;
    return Array.from({ length: 14 }, (_, d) => Math.max(-0.001, Math.min(0.001, base * (0.4 + d / 18) + (r() - 0.5) * 0.00045)));
  });
}

// --- live state, mutated by the ticker ---
const live = CITIES.map((c) => {
  const h = histories[c.id];
  const last = h[h.length - 1];
  const yearAgo = h[h.length - 366];
  const dayAgo = h[h.length - 2];
  return {
    ...c,
    index: last.index,
    change24h: last.index / dayAgo.index - 1,
    change1y: last.index / yearAgo.index - 1,
    volume24h: 2_000_000 + c.id * 900_000 + c.base * 4_000,
  };
});

const tradeRng = rng(424242);
const ADDRS = ["0x7a3f…91c2", "0x1be0…04aa", "0xd44c…7e19", "0x09f1…c3b8", "0x5e6d…a1f0", "0xc0de…beef", "0x88a2…3d47"];
let trades = [];
function makeTrade(ts) {
  const m = live[Math.floor(tradeRng() * live.length)];
  const isLong = tradeRng() < 0.5 + (m.skew > 0 ? 0.08 : -0.08);
  const lev = [2, 5, 10, 20, 25, 50, 75, 100][Math.floor(tradeRng() * 8)];
  const notional = Math.round((800 + tradeRng() ** 3 * 240_000) / 10) * 10;
  const price = m.index * (1 + m.skew / m.skewScale);
  return { id: ts + Math.random(), ts, market: m.symbol, side: isLong ? "long" : "short", price, size: notional / price, notional, leverage: lev, trader: ADDRS[Math.floor(tradeRng() * ADDRS.length)] };
}
for (let i = 30; i > 0; i--) trades.push(makeTrade(NOW - i * 7_000));
trades.reverse();

export function tick() {
  for (const m of live) {
    m.index *= 1 + (tradeRng() - 0.5) * 0.00006;
    m.skew += (tradeRng() - 0.5) * 6000;
  }
  const t = makeTrade(Date.now());
  const m = live.find((x) => x.symbol === t.market);
  m.volume24h += t.notional;
  m.skew += (t.side === "long" ? 1 : -1) * t.size * 0.3;
  if (t.side === "long") m.longSize += t.size * 0.3; else m.shortSize += t.size * 0.3;
  trades = [t, ...trades].slice(0, 40);
}

// Shape mirrors exchange.getMarket(i) + indexPrice / markPrice / fundingRatePerDay
export function getMarkets() {
  return live.map((m) => {
    const mark = m.index * (1 + m.skew / m.skewScale);
    const maxFunding = 0.001; // 0.1%/day at full skew
    const funding = Math.max(-maxFunding, Math.min(maxFunding, (m.skew / m.skewScale) * 1.2));
    return {
      id: m.id, name: `${m.symbol}-USD`, symbol: m.symbol, city: m.city, country: m.country, coords: m.coords,
      index: m.index, mark, funding, skew: m.skew, skewScale: m.skewScale,
      longSize: m.longSize ?? m.long, shortSize: m.shortSize ?? m.short,
      change24h: m.change24h, change1y: m.change1y, volume24h: m.volume24h,
      nextPrintAt: m.nextPrintAt, closeOnlyFrom: m.nextPrintAt - params.closeOnlyWindow * 1000,
      closeOnly: Date.now() >= m.nextPrintAt - params.closeOnlyWindow * 1000,
    };
  });
}
for (const m of live) { m.longSize = m.long; m.shortSize = m.short; m.nextPrintAt = NOW + m.printInH * 3_600_000; }

export const getTrades = () => trades;

// Shape mirrors exchange.poolValue(), totalShares(), shares(account)
export function getPool() {
  const poolValue = 12_480_000 + trades.length * 1200;
  const totalShares = 11_902_000;
  return {
    poolValue, totalShares, shares: 48_250, sharePrice: poolValue / totalShares,
    apr: 0.187, feesApr: 0.112, fundingApr: 0.041, pnlApr: 0.034,
    utilization: 0.42,
    // mirrors exchange.withdrawRequests(account) -> requestWithdraw(shares), withdraw() after cooldown
    pendingWithdrawal: { shares: 12_000, requestedAt: NOW - 8 * 3_600_000 - 8 * 60_000, unlockAt: NOW + 15 * 3_600_000 + 52 * 60_000 },
    composition: [
      { label: "Idle USDT", value: 0.58 },
      { label: "Backing NYC", value: 0.13 },
      { label: "Backing MIA", value: 0.11 },
      { label: "Backing LA", value: 0.08 },
      { label: "Backing SF", value: 0.06 },
      { label: "Backing LDN", value: 0.04 },
    ],
  };
}

// Shape mirrors exchange.positionInfo(marketId, account)
export function getPositions() {
  const m = live[0];
  const entry = 324.18, size = 1540; // long 1,540 units ≈ $500k notional at 25x
  const margin = (entry * size) / 25;
  const pnl = (m.index - entry) * size;
  const funding = -312.4;
  const equity = margin + pnl + funding;
  const maint = 0.005 * m.index * size;
  const liquidationPrice = entry - (margin + funding - maint) / size;
  const s = live[2], sEntry = 448.9, sSize = 420, sMargin = (sEntry * sSize) / 10;
  const sPnl = (sEntry - s.index) * sSize, sFund = 58.2, sMaint = 0.005 * s.index * sSize;
  const sLiq = sEntry + (sMargin + sFund - sMaint) / sSize;
  return [{ marketId: 2, market: s.symbol, city: s.city, side: "short", size: sSize, margin: sMargin, entryPrice: sEntry, indexPrice: s.index, pnl: sPnl, funding: sFund, equity: sMargin + sPnl + sFund, liquidationPrice: sLiq, liquidatable: false, leverage: 10 },
    { marketId: 0, market: m.symbol, city: m.city, size, margin, entryPrice: entry, indexPrice: m.index, pnl, funding, equity, liquidationPrice, liquidatable: equity < maint, leverage: 25, side: "long" }].reverse();
}

export const params = { tradingFeeBps: 5, maintenanceMarginBps: 50, maxLeverage: 100, liquidationRewardBps: 20, withdrawCooldown: 86_400, closeOnlyWindow: 6 * 3600 };

// Account history (from PositionOpened / PositionModified / PositionClosed / Liquidated logs)
export const getHistoryRows = () => [
  { ts: NOW - 3_600_000 * 5, market: "NYC", action: "Increase", side: "long", size: 340, price: 328.91, pnl: null },
  { ts: NOW - 3_600_000 * 29, market: "MIA", action: "Open", side: "short", size: 420, price: 448.9, pnl: null },
  { ts: NOW - 3_600_000 * 52, market: "SF", action: "Close", side: "short", size: 900, price: 351.2, pnl: 2140.55 },
  { ts: NOW - 3_600_000 * 98, market: "LA", action: "Close", side: "long", size: 260, price: 436.05, pnl: -812.3 },
];
export const wallet = { address: "0x7a3f…91c2", balance: 25_000 };
