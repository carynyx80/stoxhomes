import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getMonthlyPrints, latest, changeOver } from '../src/historical.js';

const SYMBOLS = ['NYC', 'LA', 'MIA', 'SF', 'LDN'];
const EXPECTED_LATEST = { NYC: 351.78, LA: 446.2, MIA: 454.64, SF: 367.95, LDN: 95.6 };
const SEP_2026 = Date.UTC(2026, 8, 1) / 1000;

test('all five series present, non-empty, sorted, first-of-month UTC', () => {
  for (const sym of SYMBOLS) {
    const s = getMonthlyPrints(sym);
    assert.ok(s.length > 0, `${sym} empty`);
    for (let i = 0; i < s.length; i++) {
      assert.ok(Number.isFinite(s[i].value), `${sym}[${i}] value`);
      const d = new Date(s[i].at * 1000);
      assert.equal(d.getUTCDate(), 1);
      assert.equal(d.getUTCHours(), 0);
      if (i) assert.ok(s[i].at > s[i - 1].at, `${sym} not sorted at ${i}`);
    }
  }
});

test('latest values match published Sep 2026 prints', () => {
  for (const sym of SYMBOLS) {
    const l = latest(sym);
    assert.equal(l.at, SEP_2026, `${sym} latest month`);
    assert.equal(l.value, EXPECTED_LATEST[sym], `${sym} latest value`);
  }
});

test('NYC 1Y change is about +5.8%', () => {
  const c = changeOver('NYC', 12);
  assert.ok(Math.abs(c - 0.058) < 0.001, `got ${c}`);
});

test('changeOver returns null when out of range', () => {
  assert.equal(changeOver('NYC', 10_000), null);
});
