import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { Engine, acct } from '../src/engine.js';
import { WAD } from '../src/fixed.js';

export const E = (x) => {
  // decimal string/number -> WAD bigint (test helper only; exact for decimal strings)
  const s = String(x);
  const neg = s.startsWith('-');
  const [i, f = ''] = (neg ? s.slice(1) : s).split('.');
  const v = BigInt(i) * WAD + BigInt((f + '0'.repeat(18)).slice(0, 18));
  return neg ? -v : v;
};
export const U = (x) => {
  const s = String(x);
  const neg = s.startsWith('-');
  const [i, f = ''] = (neg ? s.slice(1) : s).split('.');
  const v = BigInt(i) * 1_000_000n + BigInt((f + '000000').slice(0, 6));
  return neg ? -v : v;
};
export const DAY = 86400;
export const COMPANY = '0x106342ec570e207afda9fda63125d7a9071127f2';

export function makeEngine({ start = 1_788_000_000, skewScale = 1_000_000n * WAD } = {}) {
  const clock = { t: start };
  const db = openDb(':memory:');
  const engine = new Engine({ db, companyAddress: COMPANY, now: () => clock.t, skewScale }).init();
  const h = {
    engine, db, clock,
    advance(sec) { clock.t += sec; },
    fund(addr, amount) {
      engine.tx(() => engine.post([[acct.deposits, -amount], [acct.available(addr), amount]], `test_fund:${addr}`));
    },
    /** Force a market index (tests that mirror the contract suite at price 300). */
    setIndex(id, price) {
      db.prepare('UPDATE markets SET from_price = ?, to_price = ?, updated_at = ? WHERE id = ?').run(price.toString(), price.toString(), clock.t, id);
    },
    avail: (a) => engine.balance(acct.available(a)),
    check() {
      const c = engine.checkLedger();
      assert.ok(c.ok, c.errors.join('; '));
      assert.equal(c.total, 0n);
      const l = engine.liabilities();
      assert.equal(l.total + l.external, 0n, 'internal liabilities must equal -external');
    },
  };
  return h;
}

export async function expectCode(fn, code) {
  try {
    await fn();
  } catch (e) {
    assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    return;
  }
  assert.fail(`expected error ${code}`);
}
