// Practice mode: separate engine + DB under /practice, faucet limit, print mirroring, isolation from real money.
// Also: configurable skew scale (default 150,000) with boot migration, history merge, closed-state flags.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createApp, mergePrints } from '../src/server.js';
import { openDb } from '../src/db.js';
import { Engine, acct } from '../src/engine.js';
import { WAD } from '../src/fixed.js';
import { MockSolanaRpc, keypair } from './solana-helpers.js';

let mock, svc, base, tmp, offset = 0;
const companyKp = keypair();
const alice = keypair();
const now = () => Math.floor(Date.now() / 1000) + offset;

async function api(method, p, body, token) {
  const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}
const ok = async (...a) => { const r = await api(...a); assert.ok(r.status < 300, `${a[0]} ${a[1]} -> ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
async function signIn(kp) {
  const { message } = await ok('POST', '/auth/nonce', { address: kp.address });
  return ok('POST', '/auth/verify', { address: kp.address, message, signature: kp.sign(message) });
}
const realEntries = () => Number(svc.db.prepare('SELECT COUNT(*) c FROM ledger_entries').get().c);

before(async () => {
  mock = new MockSolanaRpc();
  const url = await mock.listen();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-practice-'));
  svc = createApp(loadConfig({
    CHAIN: 'solana', DB_PATH: path.join(tmp, 'real.db'), PRACTICE_DB_PATH: path.join(tmp, 'practice.db'), RPC_URL: url,
    COMPANY_ADDRESS: companyKp.address, SESSION_SECRET: 'p'.repeat(32), WATCHER: '0', LOOP_MS: '100000', RATE_LIMIT_ADDR_PER_MIN: '1000',
  }), { now, log: () => {} });
  base = `http://127.0.0.1:${await svc.start(0)}`;
});
after(async () => { await svc.stop(); await mock.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('config flags: practiceAvailable, practice, tradingOpen/liquidity while the real vault is empty', async () => {
  const real = await ok('GET', '/config');
  assert.equal(real.practiceAvailable, true);
  assert.equal(real.tradingOpen, false);
  assert.equal(real.reason, 'liquidity');
  assert.ok((await ok('GET', '/markets')).every((m) => m.tradingOpen === false && m.reason === 'liquidity'));
  const pc = await ok('GET', '/practice/config');
  assert.equal(pc.practice, true);
  assert.equal(pc.tradingOpen, true);
  assert.ok((await ok('GET', '/practice/markets')).every((m) => m.tradingOpen === true));
  const v = await ok('GET', '/practice/vault');
  assert.equal(v.poolValue, '10000000', 'practice vault auto-seeded with 10M');
  assert.equal(svc.practice.balance(acct.equity), -10_000_000_000_000n);
  assert.equal(svc.engine.balance(acct.vault), 0n);
  assert.notEqual(svc.practice.db.name, svc.engine.db.name);
});

test('faucet: 10,000 practice USD, once per 24h per address; same session token on both engines', async () => {
  const a = await signIn(alice);
  const r = await ok('POST', '/practice/faucet', null, a.token);
  assert.equal(r.amount, '10000');
  assert.equal(r.nextAt, now() + 86400);
  const again = await api('POST', '/practice/faucet', null, a.token);
  assert.equal(again.status, 429);
  assert.equal(again.body.error, 'FAUCET_COOLDOWN');
  assert.equal(again.body.nextAt, r.nextAt);
  assert.equal((await ok('GET', '/practice/me', null, a.token)).balance.available, '10000');
  assert.equal((await ok('GET', '/me', null, a.token)).balance.available, '0', 'same token, real engine untouched');
  offset += 86400;
  await ok('POST', '/practice/faucet', null, (await signIn(alice)).token);
  assert.equal((await ok('GET', '/practice/me', null, a.token)).balance.available, '20000');
  assert.equal((await api('POST', '/practice/faucet')).status, 401);
  assert.ok(svc.practice.checkLedger().ok);
});

test('isolation: practice money never touches the real ledger and can never be withdrawn as real money', async () => {
  const a = await signIn(alice);
  const before = realEntries();
  const realBal = svc.db.prepare('SELECT account, balance FROM balances ORDER BY account').all();
  const q = await ok('GET', '/practice/quote?marketId=0&size=100');
  await ok('POST', '/practice/positions/open', { marketId: 0, size: '100', margin: '1000', acceptablePrice: (Number(q.fillPrice) * 1.01).toFixed(6) }, a.token);
  await ok('POST', '/practice/positions/close', { marketId: 0, acceptablePrice: '1' }, a.token);
  await ok('POST', '/practice/vault/deposit', { amount: '500' }, a.token);
  for (const [m, p] of [['POST', '/practice/withdrawals'], ['POST', '/practice/withdrawals/1/cancel'], ['GET', '/practice/me/deposits'], ['GET', '/practice/me/withdrawals'],
    ['POST', '/practice/admin/index'], ['POST', '/practice/admin/vault/seed'], ['GET', '/practice/admin/overview']]) {
    assert.equal((await api(m, p, m === 'POST' ? { amount: '100', symbol: 'NYC', value: '1' } : undefined, a.token)).body.error, 'PRACTICE_ONLY', `${m} ${p}`);
  }
  // the real engine sees none of it
  const w = await api('POST', '/withdrawals', { amount: '100' }, a.token);
  assert.equal(w.body.error, 'INSUFFICIENT_BALANCE');
  assert.equal(realEntries(), before);
  assert.deepEqual(svc.db.prepare('SELECT account, balance FROM balances ORDER BY account').all(), realBal);
  assert.equal(svc.engine.liabilities().users, 0n);
  assert.equal((await ok('GET', '/me', null, a.token)).balance.equity, '0');
  // practice books only external accounts it controls: no external:deposits / withdrawals at all
  const ext = svc.practice.db.prepare("SELECT DISTINCT account FROM ledger_entries WHERE account LIKE 'external:%'").all();
  assert.deepEqual(ext, []);
  assert.throws(() => svc.engine.faucet(alice.address), { code: 'NOT_PRACTICE' });
  assert.ok(svc.practice.checkLedger().ok && svc.engine.checkLedger().ok);
});

test('print mirroring: admin prints and schedules on the real engine apply to practice; identical index prices', async () => {
  const adm = await signIn(companyKp);
  const before = (await ok('GET', '/markets'))[1].indexPrice;
  await ok('POST', '/admin/index', { symbol: 'LA', value: (Number(before) * 1.05).toFixed(2), source: 'test' }, adm.token);
  await ok('POST', '/admin/schedule-print', { symbol: 'MIA', at: now() + 3600 }, adm.token);
  const same = async () => {
    const r = await ok('GET', '/markets');
    const p = await ok('GET', '/practice/markets');
    assert.deepEqual(p.map((m) => [m.indexPrice, m.targetPrice, m.closeOnly, m.nextPrintAt, m.lastPrint]), r.map((m) => [m.indexPrice, m.targetPrice, m.closeOnly, m.nextPrintAt, m.lastPrint]));
    return r;
  };
  let r = await same();
  assert.equal(r[2].closeOnly, true);
  offset += 3 * 86400; // mid phase-in
  r = await same();
  assert.notEqual(r[1].indexPrice, before);
  const h1 = await ok('GET', '/markets/1/history?range=ALL');
  const h2 = await ok('GET', '/practice/markets/1/history?range=ALL');
  assert.deepEqual(h2.prints, h1.prints);
});

test('history: historical monthly prints merged for every range including ALL; change1y', async () => {
  const all = await ok('GET', '/markets/0/history?range=ALL');
  const y5 = await ok('GET', '/markets/0/history?range=5Y');
  const m1 = await ok('GET', '/markets/0/history?range=1M');
  assert.ok(all.prints.length > 200, `ALL has ${all.prints.length}`);
  assert.ok(all.prints[0].at < Date.UTC(2001, 0) / 1000);
  assert.ok(y5.prints.length < all.prints.length && y5.prints.length > 50);
  assert.ok(m1.prints.length >= 1);
  for (let i = 1; i < all.prints.length; i++) assert.ok(all.prints[i].at >= all.prints[i - 1].at, 'sorted');
  assert.equal((await api('GET', '/markets/0/history?range=2Y')).status, 400);
  const mk = await ok('GET', '/markets');
  assert.ok(mk.every((m) => typeof m.change1y === 'string' && Number.isFinite(Number(m.change1y))));
  assert.ok('change24h' in mk[0]);
  // merge rules: historical rows only before the engine's own first print; range filter applies
  const own = [{ at: 1000, value: '2' }];
  const merged = mergePrints(own, [{ at: 10, value: 1 }, { at: 1000, value: 9 }, { at: 2000, value: 9 }], 'ALL', 3000);
  assert.deepEqual(merged.map((p) => [p.at, p.value]), [[10, '1'], [1000, '2']]);
});

test('admin overview setup checklist', async () => {
  const adm = await signIn(companyKp);
  let ov = await ok('GET', '/admin/overview', null, adm.token);
  assert.deepEqual([ov.setup.solOk, ov.setup.capitalOk, ov.setup.vaultSeeded], [false, false, false]);
  assert.equal(ov.setup.vaultValue, '0');
  mock.lamports.set(companyKp.address, 100_000_000n);
  const { deriveAta, MINTS } = await import('../src/solana.js');
  mock.tokenBalances.set(deriveAta(companyKp.address, MINTS.USDC), 5_000_000_000n);
  await ok('POST', '/admin/vault/seed', { amount: '1000' }, adm.token);
  ov = await ok('GET', '/admin/overview', null, adm.token);
  assert.deepEqual([ov.setup.solOk, ov.setup.capitalOk, ov.setup.vaultSeeded], [true, true, true]);
  assert.equal(ov.setup.sol, '0.1');
  assert.equal((await ok('GET', '/config')).tradingOpen, true);
});

test('skew scale: default 150,000; a ~$50k position moves the mark ~0.1%; existing rows migrate on boot', async () => {
  const file = path.join(tmp, 'migrate.db');
  const oldScale = 1_000_000n * WAD;
  const e1 = new Engine({ db: openDb(file), companyAddress: companyKp.address, skewScale: oldScale }).init();
  assert.equal(e1.loadMarkets()[0].skewScale, oldScale);
  e1.db.close();
  const e2 = new Engine({ db: openDb(file), companyAddress: companyKp.address }).init();
  assert.ok(e2.loadMarkets().every((m) => m.skewScale === 150_000n * WAD));
  e2.db.close();
  assert.equal(loadConfig({ SESSION_SECRET: 'x'.repeat(20), SKEW_SCALE: '250000' }).skewScale, 250_000n * WAD);
  // $50k on the practice engine
  const a = await signIn(alice);
  const m0 = (await ok('GET', '/practice/markets'))[0];
  const size = (50_000 / Number(m0.indexPrice)).toFixed(6);
  const q = await ok('GET', `/practice/quote?marketId=0&size=${size}`);
  await ok('POST', '/practice/positions/open', { marketId: 0, size, margin: '5000', acceptablePrice: (Number(q.fillPrice) * 1.01).toFixed(6) }, a.token);
  const m1 = (await ok('GET', '/practice/markets'))[0];
  const move = Number(m1.markPrice) / Number(m1.indexPrice) - 1;
  assert.ok(move > 0.0009 && move < 0.0011, `mark moved ${move}`);
  // funding responds in proportion: rate = (skew / skewScale) * 0.1%/day
  const rate = Number(m1.fundingRatePerDay);
  assert.ok(Math.abs(rate - move * 0.001) < 1e-8, `${rate} vs ${move * 0.001}`);
});

test('websocket: /practice/ws streams practice markets; unknown paths are refused', async () => {
  const { default: WebSocket } = await import('ws');
  const ws = new WebSocket(base.replace('http', 'ws') + '/practice/ws');
  const msg = await new Promise((resolve, reject) => { ws.on('message', (d) => resolve(JSON.parse(d.toString()))); ws.on('error', reject); });
  assert.equal(msg.type, 'markets');
  assert.ok(msg.data.every((m) => m.longOI !== undefined));
  ws.close();
  const bad = new WebSocket(base.replace('http', 'ws') + '/nope/ws');
  await new Promise((resolve) => { bad.on('error', resolve); bad.on('close', resolve); });
});
