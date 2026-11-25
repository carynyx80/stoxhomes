import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../src/math.js';
import { WAD, floorDiv, ceilDiv, parseUsdt, parseSignedWad, fmtUsdt, fmtWad, notionalMicro } from '../src/fixed.js';
import { E, U, DAY } from './helpers.js';
import { AppError } from '../src/fixed.js';

const S = M.PARAMS.skewScale;

test('fixed: parse/format round trip and strictness', () => {
  assert.equal(parseUsdt('1250.5'), 1_250_500_000n);
  assert.equal(fmtUsdt(1_250_500_000n), '1250.5');
  assert.equal(parseSignedWad('-1.000000000000000001'), -(WAD + 1n));
  assert.equal(fmtWad(-(WAD + 1n)), '-1.000000000000000001');
  for (const bad of ['1e5', '-1', '0x10', '1.2345678', '', ' ', 'NaN', '1,000']) {
    assert.throws(() => parseUsdt(bad), AppError, bad);
  }
  assert.throws(() => parseUsdt(1e21), AppError);
  assert.equal(floorDiv(-7n, 2n), -4n);
  assert.equal(floorDiv(7n, 2n), 3n);
  assert.equal(ceilDiv(7n, 2n), 4n);
  assert.equal(ceilDiv(-7n, 2n), -3n);
});

test('oracle: smooths a new print over 7 days', () => {
  const f = { fromPrice: E(300), toPrice: E(330), updatedAt: 0, period: 7 * DAY };
  assert.equal(M.smoothedPrice(f, 0), E(300));
  assert.equal(M.smoothedPrice(f, 3.5 * DAY), E(315));
  assert.equal(M.smoothedPrice(f, 7.5 * DAY), E(330));
  const down = { fromPrice: E(300), toPrice: E(270), updatedAt: 0, period: 7 * DAY };
  assert.equal(M.smoothedPrice(down, 3.5 * DAY), E(285));
});

test('oracle: prints capped at ±10%', () => {
  assert.equal(M.printWithinCap(E(300), E(330)), true);
  assert.equal(M.printWithinCap(E(300), E(270)), true);
  assert.equal(M.printWithinCap(E(300), E('330.000000000000000001')), false);
  assert.equal(M.printWithinCap(E(300), E(400)), false);
  assert.equal(M.printWithinCap(E(300), 0n), false);
});

test('mark = index * (1 + skew/skewScale)', () => {
  assert.equal(M.markPrice(E(300), E(10_000), S), E(303)); // 1% premium
  assert.equal(M.markPrice(E(300), E(-10_000), S), E(297));
  assert.equal(M.markPrice(E(300), 0n, S), E(300));
});

test('fill uses the average premium before and after', () => {
  // from zero skew, a 10k long fills at +0.5%
  assert.equal(M.fillPrice(E(300), 0n, E(10_000), S), E('301.5'));
  // splitting a trade gives the same average fill (linear premium)
  const one = M.fillPrice(E(300), 0n, E(2000), S) * 2000n;
  const a = M.fillPrice(E(300), 0n, E(1000), S) * 1000n + M.fillPrice(E(300), E(1000), E(1000), S) * 1000n;
  assert.ok((one > a ? one - a : a - one) <= 10n * 2000n);
  // a short against long skew gets a price below index+full premium
  assert.ok(M.fillPrice(E(300), E(1000), E(-1000), S) < M.markPrice(E(300), E(1000), S));
});

test('opens fill at the worse of smoothed and target', () => {
  assert.equal(M.openBasePrice(E(300), E(330), E(1)), E(330)); // long gets the higher
  assert.equal(M.openBasePrice(E(300), E(330), E(-1)), E(300)); // short gets the lower
  assert.equal(M.openBasePrice(E(300), E(270), E(1)), E(300));
  assert.equal(M.openBasePrice(E(300), E(270), E(-1)), E(270));
});

test('funding: proportional to skew, capped at 0.1%/day', () => {
  assert.equal(M.fundingRatePerDay(E(500_000), S), WAD / 2000n);
  assert.equal(M.fundingRatePerDay(E(5_000_000), S), WAD / 1000n);
  assert.equal(M.fundingRatePerDay(E(-5_000_000), S), -WAD / 1000n);
  // contract test: 5000 long for 10 days at ~300 → funding ≈ 75 USDT
  const perUnit = M.pendingFunding(E(5000), E(300), 10 * DAY, S, M.PARAMS.maxFundingRatePerDay);
  const owed = M.fundingOwedWad(E(5000), perUnit, 0n);
  assert.ok(owed > E(73) && owed < E(77), fmtWad(owed));
  // per-second accrual is additive
  const a = M.pendingFunding(E(5000), E(300), DAY, S, M.PARAMS.maxFundingRatePerDay);
  const b = M.pendingFunding(E(5000), E(300), 3600, S, M.PARAMS.maxFundingRatePerDay) * 24n;
  assert.ok(a - b < 100n);
});

test('liquidation price: 100x long around 297-300; matches isLiquidatable', () => {
  const fill = M.fillPrice(E(300), 0n, E(1000), S);
  const fee = M.tradingFee(E(1000), fill);
  const margin = U(3200) - fee;
  const pos = { size: E(1000), margin, entryPrice: fill, entryFunding: 0n, sizeEntry: (E(1000) * fill) / WAD };
  const liq = M.liquidationPrice(pos.size, pos.entryPrice, pos.margin, 0n);
  assert.ok(liq < E(300) && liq > E(297), fmtWad(liq));
  assert.equal(M.isLiquidatable(pos, liq + E('0.01'), 0n), false);
  assert.equal(M.isLiquidatable(pos, liq - E('0.01'), 0n), true);
  // short
  const sfill = M.fillPrice(E(300), 0n, E(-1000), S);
  const spos = { size: E(-1000), margin, entryPrice: sfill, entryFunding: 0n, sizeEntry: (E(-1000) * sfill) / WAD };
  const sliq = M.liquidationPrice(spos.size, spos.entryPrice, spos.margin, 0n);
  assert.ok(sliq > E(300) && sliq < E(303), fmtWad(sliq));
  assert.equal(M.isLiquidatable(spos, sliq - E('0.01'), 0n), false);
  assert.equal(M.isLiquidatable(spos, sliq + E('0.01'), 0n), true);
});

test('fees: 0.05% of notional, 10% protocol share', () => {
  assert.equal(notionalMicro(E(1000), E(300)), U(300_000));
  assert.equal(M.tradingFee(E(1000), E(300)), U(150));
  assert.equal(M.protocolCut(U(150)), U(15));
});

test('vault share math with virtual offset', () => {
  // first deposit: 1 USDT = 1e12 raw shares
  const s1 = M.assetsToShares(U(1000), 0n, 0n);
  assert.equal(s1, U(1000) * 1_000_000n);
  assert.equal(M.sharesToAssets(s1, U(1000), s1), U(1000));
  // inflation attack: 1 micro deposit then 1000 USDT donation; victim still gets fair shares
  const atk = M.assetsToShares(1n, 0n, 0n); // 1e6 shares
  const nav = 1n + U(1000);
  const vic = M.assetsToShares(U(1999), nav, atk);
  const vicValue = M.sharesToAssets(vic, nav + U(1999), atk + vic);
  assert.ok(vicValue > U(1998), fmtUsdt(vicValue));
});

test('pool marks trader PnL at close-out price and caps losses at margin', () => {
  const m = { skew: E(10_000), skewScale: S, sumSizeEntry: E(10_000) * E(300) / WAD, sumSizeFunding: 0n, marginTotal: U(50_000) };
  // close-out at 300*(1+0.5%) = 301.5 → traders +15,000
  assert.equal(M.marketTraderPnlMicro(m, E(300), 0n), U(15_000));
  // large drop: traders lose more than margin → clamped
  assert.equal(M.marketTraderPnlMicro(m, E(200), 0n), -U(50_000));
});

test('close-only from 6h before a scheduled print, 24h grace', () => {
  const t = 1_000_000;
  assert.equal(M.isCloseOnly(0, t), false);
  assert.equal(M.isCloseOnly(t + 6 * 3600 + 1, t), false);
  assert.equal(M.isCloseOnly(t + 6 * 3600, t), true);
  assert.equal(M.isCloseOnly(t - 24 * 3600, t), true);
  assert.equal(M.isCloseOnly(t - 24 * 3600 - 1, t), false);
});
