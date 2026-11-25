// Solana end-to-end against a mock JSON-RPC serving crafted finalized transactions.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/server.js';
import { deriveAta, MINTS, TOKEN_2022_PROGRAM_ID } from '../src/solana.js';
import { MockSolanaRpc, craftTx, keypair, randomKey, randomSig } from './solana-helpers.js';

const C = 1_000_000; // raw units per USD (6 decimals)
let mock, svc, base, tmp;
const companyKp = keypair();
const company = companyKp.address;
const alice = keypair();
const bob = keypair();
const ATA = { USDC: deriveAta(company, MINTS.USDC), USDT: deriveAta(company, MINTS.USDT) };

async function api(method, p, body, token) {
  const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}
const ok = async (...a) => { const r = await api(...a); assert.ok(r.status < 300, `${a[0]} ${a[1]} -> ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
async function signIn(kp) {
  const { message } = await ok('POST', '/auth/nonce', { address: kp.address });
  return ok('POST', '/auth/verify', { address: kp.address, message, signature: kp.sign(message) });
}
const check = () => { const c = svc.engine.checkLedger(); assert.ok(c.ok, c.errors.join('; ')); };

/** user -> company deposit, visible in the company ATA history */
function deposit(kp, token, usd, extra = {}) {
  const mint = MINTS[token];
  const tx = craftTx({ payer: kp.address, ...extra.tx, moves: [
    { owner: kp.address, mint, pre: 100_000 * C, post: 100_000 * C - usd * C },
    { owner: company, mint, pre: extra.companyPre ?? null, post: (extra.companyPre ?? 0) + usd * C },
    ...(extra.moves || []),
  ] });
  return mock.publish(tx, [ATA[token]]);
}
/** company -> user payout */
function payout(toOwner, token, usd, { publish = true, err = null, fromAccount, mint } = {}) {
  const m = mint || MINTS[token];
  const tx = craftTx({ payer: company, err, moves: [
    { owner: company, mint: m, pre: 1_000_000 * C, post: 1_000_000 * C - usd * C, account: fromAccount },
    { owner: toOwner, mint: m, pre: null, post: usd * C },
  ] });
  const sig = tx.transaction.signatures[0];
  if (publish) mock.publish(tx, [ATA[token]]);
  else mock.txs.set(sig, tx);
  return sig;
}

before(async () => {
  mock = new MockSolanaRpc();
  const url = await mock.listen();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-sol-'));
  const config = loadConfig({
    CHAIN: 'solana', NODE_ENV: 'production', DB_PATH: path.join(tmp, 'e.db'), RPC_URL: `http://127.0.0.1:1,${url}`,
    COMPANY_ADDRESS: company, SESSION_SECRET: 'sol-secret-sol-secret-1234', WATCHER: '0', LOOP_MS: '100000',
  });
  svc = createApp(config, { log: () => {} });
  base = `http://127.0.0.1:${await svc.start(0)}`;
});

after(async () => {
  await svc.stop();
  await mock.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('solana e2e', async () => {
  // config + blockhash proxy (cached)
  const cfg = await ok('GET', '/config');
  assert.equal(cfg.chain, 'solana');
  assert.equal(cfg.companyAddress, company);
  assert.deepEqual(cfg.tokens.map((t) => [t.symbol, t.companyTokenAccount]), [['USDC', ATA.USDC], ['USDT', ATA.USDT]]);
  assert.deepEqual(cfg.withdrawTokens, ['USDC', 'USDT']);
  const b1 = await ok('GET', '/chain/blockhash');
  const b2 = await ok('GET', '/chain/blockhash');
  assert.equal(b1.blockhash, b2.blockhash);
  assert.equal(mock.calls.getLatestBlockhash, 1);

  // Old history before the engine started is never scanned (no START_SIGNATURE)
  const preStart = deposit(bob, 'USDC', 999);
  await svc.watcher.poll();
  const a = await signIn(alice);
  const bb = await signIn(bob);
  const adm = await signIn(companyKp);
  assert.equal(adm.isAdmin, true);
  assert.equal(a.isAdmin, false);
  assert.equal((await ok('GET', '/me', null, bb.token)).balance.available, '0');

  // 1. deposit credited (USDC), idempotent on rescan
  const dsig = deposit(alice, 'USDC', 5000, { companyPre: 999 * C });
  await svc.watcher.poll();
  await svc.watcher.poll();
  let deps = await ok('GET', '/me/deposits', null, a.token);
  assert.equal(deps.length, 1);
  assert.equal(deps[0].signature, dsig);
  assert.equal(deps[0].status, 'credited');
  assert.equal(deps[0].token, 'USDC');
  assert.equal((await ok('GET', '/me', null, a.token)).balance.available, '5000');
  svc.watcher.setMeta(`sol_until:${MINTS.USDC}`, preStart); // force a rescan back to the start point
  await svc.watcher.poll();
  assert.equal((await ok('GET', '/me', null, a.token)).balance.available, '5000', 'no double credit');
  assert.equal((await ok('GET', '/me', null, bb.token)).balance.available, '0', 'pre-start history is not scanned');
  check();

  // USDT deposit with Token-2022 noise; below-minimum USDT deposit
  deposit(alice, 'USDT', 1000, { moves: [{ owner: alice.address, mint: randomKey(), pre: 5, post: 0, program: TOKEN_2022_PROGRAM_ID }] });
  const smallSig = deposit(alice, 'USDT', 5, { companyPre: 1000 * C });
  await svc.watcher.poll();
  assert.equal((await ok('GET', '/me', null, a.token)).balance.available, '6000');
  deps = await ok('GET', '/me/deposits', null, a.token);
  assert.equal(deps.find((d) => d.signature === smallSig).status, 'below_minimum');
  // lowering the minimum credits set-aside deposits from a known sender, exactly once
  const prevMin = svc.watcher.cfg.minDeposit;
  svc.watcher.cfg.minDeposit = 1_000_000n; // 1 USD
  await svc.watcher.poll();
  await svc.watcher.poll();
  assert.equal((await ok('GET', '/me', null, a.token)).balance.available, '6005', 'below-minimum deposit credited once after minimum lowered');
  deps = await ok('GET', '/me/deposits', null, a.token);
  assert.equal(deps.find((d) => d.signature === smallSig).status, 'credited');
  svc.watcher.cfg.minDeposit = prevMin;
  check();

  // unattributed: multi-sender and failed transactions
  const multiSig = deposit(bob, 'USDC', 700, { companyPre: 5999 * C, moves: [{ owner: alice.address, mint: MINTS.USDC, pre: 10 * C, post: 0, account: randomKey() }] });
  // failed txs are skipped without getTransaction (L3); a mint-like credit with no sender is unattributed
  const txCalls = mock.calls.getTransaction || 0;
  const failedSkipped = deposit(bob, 'USDC', 300, { tx: { err: { InstructionError: [0, { Custom: 1 }] } } });
  const failSig = mock.publish(craftTx({ moves: [{ owner: company, mint: MINTS.USDC, pre: 6699 * C, post: 6999 * C }] }), [ATA.USDC]);
  await svc.watcher.poll();
  assert.equal(mock.calls.getTransaction - txCalls, 2, 'failed signature not fetched');
  const un = await ok('GET', '/admin/deposits', null, adm.token);
  assert.deepEqual(un.map((d) => [d.signature, d.reason]).sort(), [[multiSig, 'multiple_senders'], [failSig, 'unknown_sender']].sort());
  assert.ok(!un.some((d) => d.signature === failedSkipped));
  assert.equal((await api('GET', '/admin/deposits', null, a.token)).status, 403);
  assert.equal((await ok('GET', '/me', null, bb.token)).balance.available, '0', 'never auto-credited');
  // admin manual credit, then refund note
  const cr = await ok('POST', `/admin/deposits/${multiSig}/credit`, { address: bob.address }, adm.token);
  assert.equal(cr.status, 'credited');
  assert.equal((await ok('GET', '/me', null, bb.token)).balance.available, '700');
  assert.equal((await api('POST', `/admin/deposits/${multiSig}/credit`, { address: bob.address }, adm.token)).body.error, 'NOT_PENDING');
  assert.equal((await api('POST', `/admin/deposits/${failSig}/credit`, { address: '0xdeadbeef' }, adm.token)).body.error, 'BAD_INPUT');
  assert.equal((await ok('POST', `/admin/deposits/${failSig}/refund-note`, { note: 'unknown sender' }, adm.token)).status, 'refund_noted');
  assert.equal((await ok('GET', '/admin/deposits', null, adm.token)).length, 0);
  check();

  // 2. trade: vault seed, open, close
  await ok('POST', '/admin/vault/seed', { amount: '100000' }, adm.token);
  const q = await ok('GET', '/quote?marketId=0&size=10');
  await ok('POST', '/positions/open', { marketId: 0, size: '10', margin: '200', acceptablePrice: (Number(q.fillPrice) * 1.01).toFixed(6) }, a.token);
  const closed = await ok('POST', '/positions/close', { marketId: 0, acceptablePrice: '1' }, a.token);
  assert.ok(Number(closed.payout) > 190);
  check();

  // 3. withdrawal auto-matched by the watcher (USDC default token)
  const w1 = await ok('POST', '/withdrawals', { amount: '100' }, a.token);
  assert.equal(w1.token, 'USDC');
  assert.equal(w1.to, alice.address);
  assert.equal((await api('POST', '/withdrawals', { amount: '100', token: 'DAI' }, a.token)).body.error, 'BAD_INPUT');
  const s1 = payout(alice.address, 'USDC', 100);
  await svc.watcher.poll();
  let ws = await ok('GET', '/me/withdrawals', null, a.token);
  assert.equal(ws.find((x) => x.id === w1.id).status, 'paid');
  assert.equal(ws.find((x) => x.id === w1.id).signature, s1);
  check();

  // 4. admin paid with signature: mismatches rejected
  const w2 = await ok('POST', '/withdrawals', { amount: '50', token: 'USDT' }, a.token);
  const tryPaid = (sig) => api('POST', `/admin/withdrawals/${w2.id}/paid`, { signature: sig }, adm.token);
  assert.equal((await tryPaid(randomSig())).body.error, 'TX_NOT_FOUND');
  assert.equal((await tryPaid('not-a-signature')).body.error, 'BAD_INPUT');
  assert.equal((await tryPaid(payout(alice.address, 'USDT', 50, { publish: false, err: { InstructionError: [1, 'x'] } }))).body.error, 'TX_FAILED');
  assert.equal((await tryPaid(payout(alice.address, 'USDC', 50, { publish: false }))).body.error, 'TX_MISMATCH', 'wrong mint');
  assert.equal((await tryPaid(payout(bob.address, 'USDT', 50, { publish: false }))).body.error, 'TX_MISMATCH', 'wrong owner');
  assert.equal((await tryPaid(payout(alice.address, 'USDT', 49, { publish: false }))).body.error, 'TX_MISMATCH', 'too little');
  assert.equal((await tryPaid(payout(alice.address, 'USDT', 50, { publish: false, fromAccount: randomKey() }))).body.error, 'TX_MISMATCH', 'not from company ATA');
  const good = payout(alice.address, 'USDT', 50, { publish: false });
  assert.equal((await ok('POST', `/admin/withdrawals/${w2.id}/paid`, { signature: good }, adm.token)).status, 'paid');
  // signature reuse is refused
  const w3 = await ok('POST', '/withdrawals', { amount: '50', token: 'USDT' }, a.token);
  assert.equal((await api('POST', `/admin/withdrawals/${w3.id}/paid`, { signature: good }, adm.token)).body.error, 'TX_MISMATCH');
  // the watcher later sees the same payout: must not pay w3 with it
  mock.publish(mock.txs.get(good), [ATA.USDT]);
  await svc.watcher.poll();
  ws = await ok('GET', '/me/withdrawals', null, a.token);
  assert.equal(ws.find((x) => x.id === w3.id).status, 'pending');
  await ok('POST', `/withdrawals/${w3.id}/cancel`, null, a.token);
  // admin lock (with the payout tx's blockhash) blocks a user cancel and an early reject
  const w5 = await ok('POST', '/withdrawals', { amount: '30' }, a.token);
  assert.equal((await api('POST', `/admin/withdrawals/${w5.id}/lock`, {}, adm.token)).body.error, 'BAD_INPUT');
  const bh = await ok('GET', '/chain/blockhash');
  const locked = await ok('POST', `/admin/withdrawals/${w5.id}/lock`, bh, adm.token);
  assert.equal(locked.processing, true);
  assert.equal(locked.lock.lastValidBlockHeight, bh.lastValidBlockHeight);
  assert.equal((await api('POST', `/withdrawals/${w5.id}/cancel`, null, a.token)).body.error, 'WITHDRAW_LOCKED');
  mock.blockHeight = bh.lastValidBlockHeight - 10;
  assert.equal((await api('POST', `/admin/withdrawals/${w5.id}/reject`, { reason: 'test' }, adm.token)).body.error, 'PAYOUT_MAY_LAND');
  mock.blockHeight = bh.lastValidBlockHeight + 1; // chain past expiry, but the watcher has not scanned past it yet
  assert.equal((await api('POST', `/admin/withdrawals/${w5.id}/reject`, { reason: 'test' }, adm.token)).body.error, 'PAYOUT_MAY_LAND');
  await svc.watcher.poll(); // full scan at height > lastValidBlockHeight, no payout seen
  await ok('POST', `/admin/withdrawals/${w5.id}/reject`, { reason: 'test' }, adm.token);
  // reject returns the funds
  const before = (await ok('GET', '/me', null, a.token)).balance.available;
  const w4 = await ok('POST', '/withdrawals', { amount: '20' }, a.token);
  await ok('POST', `/admin/withdrawals/${w4.id}/reject`, { reason: 'test' }, adm.token);
  assert.equal((await ok('GET', '/me', null, a.token)).balance.available, before);
  check();

  // 5. overview: ATA balances (USDT ATA missing -> 0) + SOL
  mock.tokenBalances.set(ATA.USDC, 200_000n * BigInt(C));
  mock.lamports.set(company, 12_345_678_900n);
  const ov = await ok('GET', '/admin/overview', null, adm.token);
  assert.equal(ov.companyTokens.USDT, '0');
  assert.equal(ov.companyOnChain, '200000');
  assert.equal(ov.companySol, '12.3456789');
  // liabilities = credited 5000 + 1000 + 5 (below-minimum, credited after minimum lowered) + 700 - paid 150 + seed 100000 = 106555
  assert.equal(ov.liabilities.total, '106555');
  assert.equal(ov.surplus, '93445');
  assert.equal(ov.ledgerOk, true);
  assert.deepEqual(ov.unattributedDeposits, []);
  assert.deepEqual(ov.alerts, []);
  assert.ok(Array.isArray(ov.unmatchedPayouts));
  console.log(`# solana overview: ${JSON.stringify(ov)}`);
  const health = await ok('GET', '/health');
  assert.equal(health.chain, 'solana');
  check();
});
