import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, E, U, DAY } from './helpers.js';
import { AppError, WAD } from '../src/fixed.js';
import { acct } from '../src/engine.js';

// Deterministic PRNG (mulberry32)
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STEPS = Number(process.env.INVARIANT_STEPS || 2500);

function runSeed(seed) {
  const r = rng(seed);
  const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const pick = (arr) => arr[int(0, arr.length - 1)];
  const h = makeEngine();
  const e = h.engine;
  const users = Array.from({ length: 8 }, (_, i) => '0x' + (i + 1).toString(16).padStart(40, '0'));
  e.seedVault(U(int(200_000, 2_000_000)));
  const counts = {};
  let ok = 0;
  let rejected = 0;

  const invariants = (step, action) => {
    try {
      h.check();
      const l = e.liabilities();
      // liabilities equal the sum of the parts
      let users = 0n;
      for (const row of h.db.prepare("SELECT balance FROM balances WHERE account LIKE 'user:%'").all()) users += BigInt(row.balance);
      assert.equal(l.users, users);
      assert.equal(l.total, users + e.balance(acct.vault) + e.balance(acct.fees));
      assert.ok(e.balance(acct.vault) >= 0n && e.balance(acct.fees) >= 0n);
      // shares conservation
      let sh = 0n;
      for (const v of h.db.prepare('SELECT shares, pending_shares FROM vault_shares').all()) sh += BigInt(v.shares) + BigInt(v.pending_shares);
      assert.equal(sh, e.totalShares());
      // market aggregates match positions
      for (const m of e.loadMarkets()) {
        let skew = 0n; let longs = 0n; let shorts = 0n; let se = 0n;
        for (const p of h.db.prepare('SELECT size, size_entry FROM positions WHERE market_id = ?').all(m.id)) {
          const s = BigInt(p.size);
          skew += s; se += BigInt(p.size_entry);
          if (s > 0n) longs += s; else shorts -= s;
          assert.ok(s !== 0n);
        }
        assert.equal(m.skew, skew);
        assert.equal(m.longSize, longs);
        assert.equal(m.shortSize, shorts);
        assert.equal(m.sumSizeEntry, se);
      }
    } catch (err) {
      err.message = `seed ${seed} step ${step} (${action}): ${err.message}`;
      throw err;
    }
  };

  const actions = {
    deposit: () => h.fund(pick(users), U(int(10, 200_000))),
    open: () => {
      const u = pick(users); const m = int(0, 4);
      const idx = E(e.marketsView()[m].indexPrice);
      const lev = BigInt(int(1, 110));
      const margin = U(int(10, 50_000));
      const notional = margin * lev; // micro
      const size = (notional * 10n ** 12n * WAD) / idx * (r() < 0.5 ? 1n : -1n);
      if (size === 0n) return;
      const acc = size > 0n ? idx * 2n : 0n;
      e.openPosition(u, { marketId: m, size, margin, acceptablePrice: acc });
    },
    close: () => {
      const p = h.db.prepare('SELECT market_id, address FROM positions').all();
      if (!p.length) return;
      const x = pick(p);
      e.closePosition(x.address, { marketId: Number(x.market_id), acceptablePrice: null });
    },
    modify: () => {
      const p = h.db.prepare('SELECT * FROM positions').all();
      if (!p.length) return;
      const x = pick(p);
      const size = BigInt(x.size);
      const frac = BigInt(int(-120, 120));
      const delta = (size * frac) / 100n;
      if (delta === 0n) return;
      e.modifyPosition(x.address, { marketId: Number(x.market_id), sizeDelta: delta, acceptablePrice: delta > 0n ? E(100_000) : 0n });
    },
    margin: () => {
      const p = h.db.prepare('SELECT * FROM positions').all();
      if (!p.length) return;
      const x = pick(p);
      const d = U(int(1, 5000)) * (r() < 0.5 ? -1n : 1n);
      e.changeMargin(x.address, { marketId: Number(x.market_id), delta: d });
    },
    print: () => {
      const m = int(0, 4);
      const idx = E(e.marketsView()[m].indexPrice);
      const bps = BigInt(int(-1100, 1100));
      e.pushIndex(['NYC', 'LA', 'MIA', 'SF', 'LDN'][m], (idx * (10_000n + bps)) / 10_000n, 'fuzz');
    },
    schedule: () => e.schedulePrint(['NYC', 'LA', 'MIA', 'SF', 'LDN'][int(0, 4)], h.clock.t + int(1, 2 * DAY)),
    time: () => { h.advance(pick([2, 60, 3600, 6 * 3600, DAY, 3 * DAY])); },
    tick: () => e.tick(),
    vaultDeposit: () => e.vaultDeposit(pick(users), U(int(10, 100_000))),
    vaultRequest: () => {
      const u = pick(users);
      const v = h.db.prepare('SELECT shares FROM vault_shares WHERE address = ?').get(u);
      if (!v || BigInt(v.shares) === 0n) return;
      const s = (BigInt(v.shares) * BigInt(int(1, 100))) / 100n;
      e.vaultRequestWithdraw(u, s);
    },
    vaultCancel: () => e.vaultCancelWithdraw(pick(users)),
    vaultWithdraw: () => e.vaultWithdraw(pick(users)),
    withdrawReq: () => e.requestWithdrawal(pick(users), U(int(1, 50_000)), U(10)),
    withdrawResolve: () => {
      const w = h.db.prepare("SELECT id, address FROM withdrawals WHERE status = 'pending'").all();
      if (!w.length) return;
      const x = pick(w);
      const k = int(0, 2);
      if (k === 0) e.cancelWithdrawal(x.address, Number(x.id));
      else if (k === 1) e.rejectWithdrawal(Number(x.id), 'fuzz');
      else e.markWithdrawalPaid(Number(x.id), '0x' + 'ab'.repeat(32));
    },
  };
  const weights = { deposit: 8, open: 18, close: 8, modify: 10, margin: 5, print: 5, schedule: 1, time: 8, tick: 6, vaultDeposit: 4, vaultRequest: 3, vaultCancel: 1, vaultWithdraw: 3, withdrawReq: 4, withdrawResolve: 4 };
  const bag = Object.entries(weights).flatMap(([k, w]) => Array(w).fill(k));

  for (let step = 0; step < STEPS; step++) {
    const a = pick(bag);
    counts[a] = (counts[a] || 0) + 1;
    try {
      actions[a]();
      ok++;
    } catch (err) {
      if (!(err instanceof AppError)) { err.message = `seed ${seed} step ${step} (${a}) threw non-AppError: ${err.message}`; throw err; }
      rejected++;
    }
    invariants(step, a);
  }
  // Final: close everything that can be closed, liquidate the rest; ledger still balanced.
  for (const p of h.db.prepare('SELECT market_id, address FROM positions').all()) {
    try { e.closePosition(p.address, { marketId: Number(p.market_id), acceptablePrice: null }); } catch (err) { if (!(err instanceof AppError)) throw err; }
  }
  invariants(STEPS, 'final');
  return { ok, rejected, counts, trades: Number(h.db.prepare('SELECT COUNT(*) c FROM trades').get().c), liquidations: Number(h.db.prepare("SELECT COUNT(*) c FROM trades WHERE kind = 'liquidation'").get().c), entries: Number(h.db.prepare('SELECT COUNT(*) c FROM ledger_entries').get().c) };
}

for (const seed of [1, 42, 1337]) {
  test(`random invariant run, seed ${seed}, ${STEPS} steps`, () => {
    const res = runSeed(seed);
    console.log(`# seed ${seed}: ${STEPS} steps, ${res.ok} applied, ${res.rejected} rejected, ${res.trades} trades, ${res.liquidations} liquidations, ${res.entries} ledger entries`);
    assert.ok(res.trades > 50, 'fuzzer should exercise trading');
  });
}
