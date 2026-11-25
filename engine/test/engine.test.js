import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, expectCode, E, U, DAY, COMPANY } from './helpers.js';
import { acct } from '../src/engine.js';
import { fmtUsdt } from '../src/fixed.js';

const alice = '0x00000000000000000000000000000000000a11ce';
const bob = '0x0000000000000000000000000000000000000b0b';
const lp = '0x00000000000000000000000000000000000000a1';
let h, e;

beforeEach(() => {
  h = makeEngine();
  e = h.engine;
  h.setIndex(0, E(300));
  e.seedVault(U(1_000_000));
  for (const a of [alice, bob, lp]) h.fund(a, U(10_000_000));
  h.check();
});

const open = (who, size, margin, acc, m = 0) => e.openPosition(who, { marketId: m, size: E(size), margin: U(margin), acceptablePrice: E(acc) });

test('starting indices', () => {
  const g = makeEngine();
  const ms = g.engine.marketsView();
  assert.deepEqual(ms.map((m) => [m.symbol, m.indexPrice]), [['NYC', '351.78'], ['LA', '446.2'], ['MIA', '454.64'], ['SF', '367.95'], ['LDN', '95.6']]);
});

test('opens a 100x long, premium paid, ledger moves margin and fees', () => {
  const p = open(alice, 1000, 3200, 301);
  assert.ok(E(p.entryPrice) > E(300));
  const fee = U(3200) - U(p.margin);
  assert.ok(fee > U(150) && fee < U(151));
  assert.equal(e.balance(acct.fees), fee / 10n);
  assert.equal(e.balance(acct.available(alice)), U(10_000_000) - U(3200));
  h.check();
});

test('rejects leverage above 100x, slippage, skew cap, duplicates', async () => {
  await expectCode(() => open(alice, 1000, 2900, 301), 'LEVERAGE_TOO_HIGH');
  await expectCode(() => open(alice, 1000, 10_000, 300), 'SLIPPAGE');
  await expectCode(() => open(alice, 11_000, 500_000, 400), 'SKEW_CAP');
  open(alice, 100, 1000, 301);
  await expectCode(() => open(alice, 100, 1000, 301), 'POSITION_EXISTS');
  await expectCode(() => open(bob, 100, 20_000_000, 301), 'INSUFFICIENT_BALANCE');
  h.check();
});

test('global skew cap 5x across markets', async () => {
  // each market ~ 2.9x pool, the second one breaches 5x total
  for (const id of [1, 2]) h.setIndex(id, E(300));
  open(alice, 9600, 300_000, 320, 0); // ~2.9M exposure
  await expectCode(() => open(bob, 9600, 300_000, 320, 1), 'SKEW_CAP');
  open(bob, 6000, 300_000, 320, 1);
  h.check();
});

test('refuses to open on a stale index; close still works', async () => {
  open(bob, 100, 1000, 301);
  h.advance(46 * DAY);
  await expectCode(() => open(alice, 100, 1000, 301), 'STALE_INDEX');
  e.closePosition(bob, { marketId: 0, acceptablePrice: 0n });
  h.check();
});

test('a short reduces skew and pays a lower price', () => {
  open(alice, 1000, 10_000, 301);
  const q = e.quote(0, E(-1000));
  assert.ok(q.fillPrice < E(e.marketsView()[0].markPrice));
  open(bob, -1000, 10_000, 299);
  assert.equal(e.marketsView()[0].skew, '0');
  h.check();
});

test('long profits when the index rises (smoothed over 7 days)', () => {
  open(alice, 1000, 10_000, 301);
  e.pushIndex('NYC', E(303));
  h.advance(7 * DAY);
  const before = h.avail(alice);
  e.closePosition(alice, { marketId: 0, acceptablePrice: 0n });
  const gained = h.avail(alice) - before;
  assert.ok(gained > U(12_000) && gained < U(13_000), fmtUsdt(gained));
  h.check();
});

test('short profits when the index falls; pool moves opposite', () => {
  const nav0 = e.poolValue();
  open(bob, -1000, 10_000, 0);
  e.pushIndex('NYC', E(297));
  h.advance(7 * DAY);
  assert.ok(e.poolValue() < nav0);
  const before = h.avail(bob);
  e.closePosition(bob, { marketId: 0, acceptablePrice: E(1000) });
  assert.ok(h.avail(bob) - before > U(12_000));
  h.check();
});

test('longs pay funding when net long (~75 over 10 days)', () => {
  open(alice, 5000, 50_000, 310);
  h.advance(10 * DAY);
  e.accrueAll();
  const p = e.positions(alice)[0];
  assert.ok(U(p.funding) > U(73) && U(p.funding) < U(77), p.funding);
  h.check();
});

test('liquidates a 100x long after a ~1% drop; reward to protocol fees', () => {
  open(alice, 1000, 3200, 301);
  const p0 = e.positions(alice)[0];
  assert.equal(p0.liquidatable, false);
  assert.ok(E(p0.liquidationPrice) < E(300) && E(p0.liquidationPrice) > E(297));
  assert.equal(e.liquidate(0, alice), null);
  e.pushIndex('NYC', E(297));
  assert.equal(e.positions(alice)[0].liquidatable, false); // smoothing: no one-block cliff
  h.advance(7 * DAY);
  const fees0 = e.balance(acct.fees);
  const liq = e.tick();
  assert.equal(liq.length, 1);
  assert.ok(e.balance(acct.fees) >= fees0);
  assert.equal(e.positions(alice).length, 0);
  const m = e.loadMarkets()[0];
  assert.equal(m.skew, 0n);
  assert.equal(m.marginTotal, 0n);
  assert.equal(e.balance(acct.margin(alice)), 0n);
  h.check();
});

test('positions that would be liquidatable at open are rejected', async () => {
  // a large skew premium on a 100x position eats the margin immediately
  e.seedVault(U(10_000_000));
  await expectCode(() => open(alice, 50_000, 165_000, 400), 'WOULD_BE_LIQUIDATABLE');
});

test('cannot remove margin past 100x; add/remove margin moves ledger', async () => {
  open(alice, 1000, 10_000, 301);
  await expectCode(() => e.changeMargin(alice, { marketId: 0, delta: -U(8000) }), 'LEVERAGE_TOO_HIGH');
  e.changeMargin(alice, { marketId: 0, delta: U(500) });
  e.changeMargin(alice, { marketId: 0, delta: -U(1000) });
  h.check();
});

test('modify: increase, partial reduce, no flip; reduce to zero closes', async () => {
  open(alice, 1000, 20_000, 301);
  let p = e.modifyPosition(alice, { marketId: 0, sizeDelta: E(500), acceptablePrice: E(302) });
  assert.equal(p.size, '1500');
  p = e.modifyPosition(alice, { marketId: 0, sizeDelta: E(-700), acceptablePrice: 0n });
  assert.equal(p.size, '800');
  await expectCode(() => e.modifyPosition(alice, { marketId: 0, sizeDelta: E(-900), acceptablePrice: 0n }), 'FLIP_NOT_ALLOWED');
  assert.equal(e.modifyPosition(alice, { marketId: 0, sizeDelta: E(-800), acceptablePrice: 0n }), null);
  assert.equal(e.positions(alice).length, 0);
  const m = e.loadMarkets()[0];
  assert.equal(m.skew, 0n);
  assert.equal(m.sumSizeEntry, 0n);
  assert.equal(m.marginTotal, 0n);
  h.check();
});

test('round trips lose money (fees); no rounding drift with odd sizes', () => {
  const before = h.avail(alice);
  open(alice, '1234.567890123456789', 50_000, 302);
  e.closePosition(alice, { marketId: 0, acceptablePrice: 0n });
  assert.ok(h.avail(alice) < before);
  const m = e.loadMarkets()[0];
  assert.equal(m.skew, 0n);
  assert.equal(m.sumSizeEntry, 0n);
  h.check();
});

test('opens use the worse of smoothed and target (phase-in is not a free option)', async () => {
  e.pushIndex('NYC', E(330));
  const q = e.quote(0, E(100));
  assert.ok(q.fillPrice >= E(330));
  const qs = e.quote(0, E(-100));
  assert.ok(qs.fillPrice < E(300));
  // C1 POC from the review: open after +10% push, close 7 days later: no risk-free profit
  await expectCode(() => open(alice, 9000, 35_000, 340), 'WOULD_BE_LIQUIDATABLE');
  const before = h.avail(alice);
  open(alice, 9000, 400_000, 340);
  h.advance(7 * DAY);
  e.closePosition(alice, { marketId: 0, acceptablePrice: 0n });
  assert.ok(h.avail(alice) < before, 'no profit from the phase-in');
  h.check();
});

test('close-only window 6h before print, 24h grace; reductions still allowed', async () => {
  open(bob, 100, 1000, 301);
  e.schedulePrint('NYC', h.clock.t + 5 * 3600);
  await expectCode(() => open(alice, 100, 1000, 301), 'CLOSE_ONLY');
  await expectCode(() => e.modifyPosition(bob, { marketId: 0, sizeDelta: E(10), acceptablePrice: E(310) }), 'CLOSE_ONLY');
  e.modifyPosition(bob, { marketId: 0, sizeDelta: E(-10), acceptablePrice: 0n });
  h.advance(5 * 3600 + 24 * 3600 + 1);
  open(alice, 100, 1000, 301); // grace expired
  e.schedulePrint('NYC', h.clock.t + 3600);
  e.pushIndex('NYC', E(301)); // a print clears the schedule
  open(lp, 100, 1000, 302);
  h.check();
});

test('pause market', async () => {
  e.setActive(0, false);
  await expectCode(() => open(alice, 100, 1000, 301), 'MARKET_INACTIVE');
  e.setActive(0, true);
  open(alice, 100, 1000, 301);
});

test('print cap rejects > 10%', async () => {
  await expectCode(() => e.pushIndex('NYC', E(331)), 'MOVE_TOO_LARGE');
  e.pushIndex('NYC', E(330));
});

test('vault: LP earns fees; cooldown; escrowed shares; payout = min(request, now)', async () => {
  const { shares } = e.vaultDeposit(lp, U(1_000_000));
  open(alice, 1000, 10_000, 301);
  e.closePosition(alice, { marketId: 0, acceptablePrice: 0n });
  e.vaultRequestWithdraw(lp, shares);
  await expectCode(() => e.vaultRequestWithdraw(lp, 1n), 'WITHDRAW_PENDING');
  await expectCode(() => e.vaultWithdraw(lp), 'WITHDRAW_LOCKED');
  // traders win after the request: LP gets the lower "now" value
  open(bob, 1000, 10_000, 302);
  e.pushIndex('NYC', E(303));
  h.advance(DAY);
  const before = h.avail(lp);
  const { amount } = e.vaultWithdraw(lp);
  assert.equal(h.avail(lp) - before, amount);
  assert.ok(amount < U(1_000_100));
  assert.ok(amount > U(990_000));
  h.check();
});

test('vault: withdrawal blocked if it would breach the skew cap', async () => {
  const { shares } = e.vaultDeposit(lp, U(1_000_000));
  open(alice, 12_000, 100_000, 320);
  e.vaultRequestWithdraw(lp, shares);
  h.advance(DAY);
  e.pushIndex('NYC', E(300)); // keep index fresh
  await expectCode(() => e.vaultWithdraw(lp), 'INSUFFICIENT_LIQUIDITY');
  e.vaultCancelWithdraw(lp);
  h.check();
});

test('vault: profits cannot exceed vault cash (H1)', async () => {
  const g = makeEngine();
  g.setIndex(0, E(300));
  g.engine.seedVault(U(100_000));
  g.fund(alice, U(1_000_000));
  g.engine.openPosition(alice, { marketId: 0, size: E(950), margin: U(300_000), acceptablePrice: E(301) });
  for (let i = 0; i < 5; i++) { g.engine.pushIndex('NYC', E(300) * (110n ** BigInt(i + 1)) / (100n ** BigInt(i + 1))); g.advance(7 * DAY); }
  await expectCode(() => g.engine.closePosition(alice, { marketId: 0, acceptablePrice: 0n }), 'INSUFFICIENT_LIQUIDITY');
  await expectCode(() => g.engine.modifyPosition(alice, { marketId: 0, sizeDelta: E(-940), acceptablePrice: 0n }), 'INSUFFICIENT_LIQUIDITY');
  g.check();
});

test('withdrawals: lock, cancel, reject, paid; min amount; capped by available', async () => {
  await expectCode(() => e.requestWithdrawal(alice, U(5), U(10)), 'MIN_AMOUNT');
  await expectCode(() => e.requestWithdrawal(alice, U(20_000_000), U(10)), 'INSUFFICIENT_BALANCE');
  const w1 = e.requestWithdrawal(alice, U(100), U(10));
  assert.equal(e.balance(acct.locked(alice)), U(100));
  h.check();
  e.cancelWithdrawal(alice, w1.id);
  await expectCode(() => e.cancelWithdrawal(alice, w1.id), 'NOT_PENDING');
  const w2 = e.requestWithdrawal(alice, U(100), U(10));
  await expectCode(() => e.cancelWithdrawal(bob, w2.id), 'NOT_FOUND');
  e.rejectWithdrawal(w2.id, 'test');
  const w3 = e.requestWithdrawal(alice, U(100), U(10));
  e.markWithdrawalPaid(w3.id, '0x' + '1'.repeat(64));
  assert.equal(e.balance(acct.withdrawals), U(100));
  assert.equal(h.avail(alice), U(10_000_000) - U(100));
  h.check();
});

test('ledger is append-only', () => {
  assert.throws(() => h.db.prepare('UPDATE ledger_entries SET amount = 0').run(), /append-only/);
  assert.throws(() => h.db.prepare('DELETE FROM ledger_entries').run(), /append-only/);
});

test('failed operations roll back atomically', async () => {
  const snap = h.db.prepare('SELECT COUNT(*) c FROM ledger_entries').get().c;
  await expectCode(() => open(alice, 1000, 2900, 301), 'LEVERAGE_TOO_HIGH');
  assert.equal(h.db.prepare('SELECT COUNT(*) c FROM ledger_entries').get().c, snap);
  assert.equal(h.db.prepare('SELECT COUNT(*) c FROM positions').get().c, 0n);
});

test('liabilities and company seed', () => {
  const l = e.liabilities();
  assert.equal(l.vault, U(1_000_000));
  assert.equal(l.users, U(30_000_000));
  assert.equal(e.balance(acct.equity), -U(1_000_000));
  assert.ok(e.me(COMPANY).balance.vaultValue.startsWith('1000000'));
});
