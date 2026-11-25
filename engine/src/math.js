// Pure economics ported from HousePerpExchange.sol / HouseIndexOracle.sol.
// All prices/sizes WAD BigInt; money in micro-USDT BigInt unless suffixed Wad.
import { WAD, BPS, abs, floorDiv, WAD_PER_MICRO, notionalMicro } from './fixed.js';

export const PARAMS = Object.freeze({
  tradingFeeBps: 5n, // 0.05%
  maintenanceMarginBps: 50n, // 0.5%
  liquidationFeeBps: 20n, // 0.2%
  protocolFeeShareBps: 1_000n, // 10% of fees
  maxLeverage: 100n,
  maxSkewToPoolBps: 30_000n, // 3x per market
  maxTotalSkewToPoolBps: 50_000n, // 5x global
  skewScale: 150_000n * WAD, // default; engines take SKEW_SCALE from config
  maxFundingRatePerDay: WAD / 1000n, // 0.1%/day
  smoothingPeriod: 7n * 86400n,
  maxPrintMoveBps: 1_000n, // 10%
  closeOnlyBefore: 6n * 3600n,
  printGrace: 24n * 3600n,
  withdrawCooldown: 24n * 3600n,
  maxOracleAge: 45n * 86400n,
  virtualShares: 1_000_000n,
  virtualAssets: 1n,
});

/** Oracle: linear interpolation from fromPrice to toPrice over period. */
export function smoothedPrice(feed, now) {
  const elapsed = BigInt(now) - BigInt(feed.updatedAt);
  const period = BigInt(feed.period);
  if (elapsed >= period || period === 0n) return feed.toPrice;
  if (elapsed <= 0n) return feed.fromPrice;
  if (feed.toPrice >= feed.fromPrice) return feed.fromPrice + ((feed.toPrice - feed.fromPrice) * elapsed) / period;
  return feed.fromPrice - ((feed.fromPrice - feed.toPrice) * elapsed) / period;
}

/** Whether a print of newPrice from current is within the ±maxPrintMoveBps cap. */
export function printWithinCap(current, newPrice, capBps = PARAMS.maxPrintMoveBps) {
  if (newPrice <= 0n) return false;
  const diff = abs(newPrice - current);
  return diff * BPS <= current * capBps;
}

export function applyPremium(price, premium) {
  const adj = (price * (WAD + premium)) / WAD;
  return adj > 0n ? adj : 0n;
}

export function markPrice(index, skew, skewScale = PARAMS.skewScale) {
  return applyPremium(index, (skew * WAD) / skewScale);
}

/** Fill at the average premium before and after the trade. */
export function fillPrice(base, skew, size, skewScale = PARAMS.skewScale) {
  const before = (skew * WAD) / skewScale;
  const after = ((skew + size) * WAD) / skewScale;
  return applyPremium(base, (before + after) / 2n);
}

/** Opens/increases use the worse (for the trader) of smoothed and target. */
export function openBasePrice(smoothed, target, size) {
  if (size > 0n) return target > smoothed ? target : smoothed;
  return target < smoothed ? target : smoothed;
}

/** Close-out price used to value the pool: closing all skew at once. */
export function closeOutPrice(index, skew, skewScale = PARAMS.skewScale) {
  return applyPremium(index, (skew * WAD) / skewScale / 2n);
}

export function fundingRatePerDay(skew, skewScale = PARAMS.skewScale, maxRate = PARAMS.maxFundingRatePerDay) {
  let p = (skew * WAD) / skewScale;
  if (p > WAD) p = WAD;
  if (p < -WAD) p = -WAD;
  return (p * maxRate) / WAD;
}

/** Funding index delta (WAD-USD per WAD unit of size) for dt seconds. */
export function pendingFunding(skew, price, dt, skewScale, maxRate) {
  dt = BigInt(dt);
  if (dt <= 0n) return 0n;
  return (((fundingRatePerDay(skew, skewScale, maxRate) * price) / WAD) * dt) / 86400n;
}

/** Funding owed by a position (WAD-USD); positive = position pays. */
export function fundingOwedWad(size, fundingIndex, entryFunding) {
  return (size * (fundingIndex - entryFunding)) / WAD;
}

/** Unrealized PnL in WAD-USD at price. */
export function pnlWad(size, sizeEntry, price) {
  return (size * price) / WAD - sizeEntry;
}

/** Equity in micro-USDT: margin + floor(pnl - funding). */
export function equityMicro(pos, price, fundingIndex) {
  const w = pnlWad(pos.size, pos.sizeEntry, price) - fundingOwedWad(pos.size, fundingIndex, pos.entryFunding);
  return pos.margin + floorDiv(w, WAD_PER_MICRO);
}

export function maintenanceMicro(size, price, mmBps = PARAMS.maintenanceMarginBps) {
  return (notionalMicro(size, price) * mmBps) / BPS;
}

export function isLiquidatable(pos, price, fundingIndex) {
  return equityMicro(pos, price, fundingIndex) < maintenanceMicro(pos.size, price);
}

export function tradingFee(size, price, feeBps = PARAMS.tradingFeeBps) {
  return (notionalMicro(size, price) * feeBps) / BPS;
}

export function protocolCut(fee) {
  return (fee * PARAMS.protocolFeeShareBps) / BPS;
}

/** Solves margin + size*(p - entry) - funding = mm * |size| * p for p (WAD). */
export function liquidationPrice(size, entryPrice, marginMicro, fundingWad, mmBps = PARAMS.maintenanceMarginBps) {
  const k = (mmBps * WAD) / BPS;
  const numer = (size * entryPrice) / WAD - marginMicro * WAD_PER_MICRO + fundingWad;
  const denom = size > 0n ? (size * (WAD - k)) / WAD : (size * (WAD + k)) / WAD;
  if (denom === 0n) return 0n;
  const p = (numer * WAD) / denom;
  return p > 0n ? p : 0n;
}

export function sharesToAssets(shares, nav, totalShares) {
  return (shares * (nav + PARAMS.virtualAssets)) / (totalShares + PARAMS.virtualShares);
}

export function assetsToShares(amount, nav, totalShares) {
  return (amount * (totalShares + PARAMS.virtualShares)) / (nav + PARAMS.virtualAssets);
}

/**
 * Trader aggregate PnL against the pool for one market (micro), marked at the close-out price,
 * minus accrued funding owed, clamped at -marginTotal (losses beyond margin are not credited).
 */
export function marketTraderPnlMicro(m, index, fundingIndex) {
  const closeOut = closeOutPrice(index, m.skew, m.skewScale);
  const pnl = (m.skew * closeOut) / WAD - m.sumSizeEntry;
  const funding = (m.skew * fundingIndex) / WAD - m.sumSizeFunding; // owed by traders
  let t = floorDiv(pnl - funding, WAD_PER_MICRO);
  if (t < -m.marginTotal) t = -m.marginTotal;
  return t;
}

export function isCloseOnly(scheduledPrint, now) {
  const t = BigInt(scheduledPrint || 0);
  const n = BigInt(now);
  return t !== 0n && n + PARAMS.closeOnlyBefore >= t && n <= t + PARAMS.printGrace;
}
