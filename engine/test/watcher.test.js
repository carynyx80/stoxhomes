// Deposit/withdrawal watcher against a fake RPC: confirmations, chunking, idempotency, reorgs,
// minimum deposit, exact-amount oldest-first auto-matching, range-splitting on RPC errors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, U, COMPANY } from './helpers.js';
import { Watcher, TRANSFER_TOPIC } from '../src/chain.js';
import { acct } from '../src/engine.js';

const TOKEN = '0x55d398326f99059ff775485246999027b3197955';
const pad = (a) => '0x' + a.replace(/^0x/, '').padStart(64, '0');
const user = '0x00000000000000000000000000000000000000aa';
const raw = (usdt) => '0x' + (BigInt(Math.round(usdt * 1e6)) * 10n ** 12n).toString(16);

class FakeRpc {
  constructor() { this.head = 100; this.logs = []; this.calls = 0; this.failBigRanges = false; }
  async blockNumber() { return this.head; }
  async getLogs(f) {
    this.calls++;
    const from = Number(BigInt(f.fromBlock));
    const to = Number(BigInt(f.toBlock));
    if (this.failBigRanges && to - from > 3) throw new Error('range too large');
    return this.logs.filter((l) => {
      const b = Number(BigInt(l.blockNumber));
      if (b < from || b > to || l.address !== f.address) return false;
      return f.topics.every((t, i) => t === null || t === undefined || l.topics[i] === t);
    });
  }
  add(block, from, to, usdt, idx = 0, txHash) {
    const l = {
      address: TOKEN, topics: [TRANSFER_TOPIC, pad(from), pad(to)], data: raw(usdt), blockNumber: '0x' + block.toString(16),
      blockHash: '0x' + block.toString(16).padStart(64, '0'), transactionHash: txHash || '0x' + (block * 1000 + idx).toString(16).padStart(64, '0'),
      logIndex: '0x' + idx.toString(16), removed: false,
    };
    this.logs.push(l);
    return l;
  }
}

function setup(opts = {}) {
  const h = makeEngine();
  const rpc = new FakeRpc();
  const config = {
    companyAddress: COMPANY, usdtAddress: TOKEN, usdtDecimals: 18, confirmations: 15, logChunk: 7, startBlock: 90,
    minDeposit: U(10), prod: true, pollMs: 1000, ...opts,
  };
  const w = new Watcher({ engine: h.engine, rpc, config });
  return { h, rpc, w };
}

test('credits only after confirmations, idempotent', async () => {
  const { h, rpc, w } = setup();
  rpc.add(95, user, COMPANY, 100);
  await w.poll(); // head 100, safe 86: nothing confirmed
  assert.equal(w.depositsFor(user)[0].status, 'confirming');
  assert.equal(w.depositsFor(user)[0].confirmations, 6);
  assert.equal(h.avail(user), 0n);
  rpc.head = 109; // 95 has 15 confirmations
  await w.poll();
  assert.equal(h.avail(user), U(100));
  w.setMeta('last_block', 80); // force rescan
  await w.poll();
  await w.poll();
  assert.equal(h.avail(user), U(100), 'no double credit');
  h.check();
});

test('below-minimum deposits are recorded but not credited; self-transfers ignored', async () => {
  const { h, rpc, w } = setup();
  rpc.add(91, user, COMPANY, 5);
  rpc.add(92, COMPANY, COMPANY, 50);
  rpc.head = 200;
  await w.poll();
  assert.equal(w.depositsFor(user)[0].status, 'below_minimum');
  assert.equal(h.avail(user), 0n);
  h.check();
});

test('reorged-out unconfirmed deposits are dropped', async () => {
  const { h, rpc, w } = setup();
  const l = rpc.add(98, user, COMPANY, 100);
  await w.poll();
  assert.equal(w.depositsFor(user)[0].status, 'confirming');
  rpc.logs = rpc.logs.filter((x) => x !== l); // reorg removes the tx
  rpc.head = 120;
  await w.poll();
  assert.equal(w.depositsFor(user)[0].status, 'dropped');
  assert.equal(h.avail(user), 0n);
  h.check();
});

test('splits ranges when the provider rejects large ones; scans in chunks from START_BLOCK', async () => {
  const { h, rpc, w } = setup({ startBlock: 10, logChunk: 2000 });
  rpc.failBigRanges = true;
  rpc.head = 300;
  rpc.add(11, user, COMPANY, 20);
  rpc.add(250, user, COMPANY, 30, 1);
  await w.poll();
  assert.equal(h.avail(user), U(50));
  assert.equal(w.cursor(), 286);
  h.check();
});

test('outgoing transfers auto-mark the oldest exact-amount pending withdrawal', async () => {
  const { h, rpc, w } = setup();
  h.fund(user, U(1000));
  const e = h.engine;
  const a = e.requestWithdrawal(user, U(100), U(10));
  const b = e.requestWithdrawal(user, U(100), U(10));
  const c = e.requestWithdrawal(user, U(50), U(10));
  rpc.add(95, COMPANY, user, 100, 0);
  rpc.add(96, COMPANY, user, 49, 0); // matches nothing
  rpc.head = 200;
  await w.poll();
  const st = (id) => h.db.prepare('SELECT status FROM withdrawals WHERE id = ?').get(id).status;
  assert.equal(st(a.id), 'paid');
  assert.equal(st(b.id), 'pending');
  assert.equal(st(c.id), 'pending');
  assert.equal(e.balance(acct.withdrawals), U(100));
  assert.equal(h.db.prepare("SELECT COUNT(*) c FROM outgoing WHERE status = 'unmatched'").get().c, 1n);
  h.check();
});

test('admin paid: receipt must be a successful USDT transfer from company to user for >= amount', async () => {
  const { h, rpc, w } = setup();
  h.fund(user, U(1000));
  const wd = h.engine.requestWithdrawal(user, U(100), U(10));
  const other = '0x00000000000000000000000000000000000000bb';
  const receipts = {};
  const mk = (hash, logs, status = '0x1') => { receipts[hash] = { status, logs }; return hash; };
  rpc.getReceipt = async (hash) => receipts[hash] || null;
  const H = (n) => '0x' + String(n).repeat(64).slice(0, 64);
  const lg = (from, to, amt, token = TOKEN) => ({ ...rpc.add(1, from, to, amt), address: token });
  await assert.rejects(w.verifyAndMarkPaid(wd.id, H(1)), { code: 'TX_NOT_FOUND' });
  await assert.rejects(w.verifyAndMarkPaid(wd.id, mk(H(2), [lg(COMPANY, user, 100)], '0x0')), { code: 'TX_FAILED' });
  await assert.rejects(w.verifyAndMarkPaid(wd.id, mk(H(3), [lg(COMPANY, user, 99)])), { code: 'TX_MISMATCH' });
  await assert.rejects(w.verifyAndMarkPaid(wd.id, mk(H(4), [lg(COMPANY, other, 100)])), { code: 'TX_MISMATCH' });
  await assert.rejects(w.verifyAndMarkPaid(wd.id, mk(H(5), [lg(other, user, 100)])), { code: 'TX_MISMATCH' });
  await assert.rejects(w.verifyAndMarkPaid(wd.id, mk(H(6), [lg(COMPANY, user, 100, '0x' + '9'.repeat(40))])), { code: 'TX_MISMATCH' });
  await assert.rejects(w.verifyAndMarkPaid(wd.id, 'nothex'), { code: 'BAD_INPUT' });
  const good = mk(H(7), [lg(COMPANY, user, 100)]);
  const r = await w.verifyAndMarkPaid(wd.id, good);
  assert.equal(r.status, 'paid');
  // the same log cannot pay a second withdrawal
  const wd2 = h.engine.requestWithdrawal(user, U(100), U(10));
  await assert.rejects(w.verifyAndMarkPaid(wd2.id, good), { code: 'TX_MISMATCH' });
  h.check();
});
