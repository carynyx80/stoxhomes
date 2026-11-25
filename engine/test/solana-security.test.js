// Adversarial security POCs / defences for the Solana money layer (src/solana.js).
// "POC: ..." tests assert that the bad outcome HAPPENS with the current code.
// "DEFENCE: ..." tests assert that an attack is blocked.
// Mock RPC only (no network, no servers). Crafted jsonParsed transactions.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bs58 from 'bs58';
import { ed25519 } from '@noble/curves/ed25519';
import { openDb } from '../src/db.js';
import { Engine, acct } from '../src/engine.js';
import {
  SolanaAdapter, MINTS, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, deriveAta, parseCompanyTransfer,
  verifySolSignature, normSolAddress, decodePubkey,
} from '../src/solana.js';
import fs from 'node:fs';

const COMPANY = '8oYH186qjPyYwnS58fh1NH1m5iFFJe8wPnBKVp3NGtgx';
const USDC = MINTS.USDC;
const USDT = MINTS.USDT;
const U = (x) => BigInt(Math.round(x * 1e6));
const key = () => bs58.encode(ed25519.getPublicKey(ed25519.utils.randomPrivateKey()));
const fakeSig = () => bs58.encode(crypto.randomBytes(64));

async function expectCode(fn, code) {
  try { await fn(); } catch (e) { assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`); return; }
  assert.fail(`expected error ${code}`);
}

/** Build a jsonParsed tx. keys: [{pubkey, signer, source}]; bal: [{i, mint, owner, pre, post, programId}] */
function mkTx({ keys, bal, err = null, slot = 1000 }) {
  const tb = (field) => bal.filter((b) => b[field] !== undefined).map((b) => ({
    accountIndex: b.i, mint: b.mint, owner: b.owner, programId: b.programId || TOKEN_PROGRAM_ID,
    uiTokenAmount: { amount: String(b[field]), decimals: 6 },
  }));
  return {
    slot, blockTime: 1795603074, version: 0,
    meta: { err, status: err ? { Err: err } : { Ok: null }, preTokenBalances: tb('pre'), postTokenBalances: tb('post'), innerInstructions: [] },
    transaction: { message: { accountKeys: keys.map((k) => (typeof k === 'string' ? { pubkey: k, signer: false, source: 'transaction' } : { signer: false, source: 'transaction', ...k })) } },
  };
}

/** Mock RPC: `history` per address is newest-first [{signature, tx}]. */
class MockRpc {
  constructor() { this.hist = new Map(); this.txs = new Map(); this.lagBefore = false; this.calls = 0; }
  push(address, sig, tx) { // newest first
    if (!this.hist.has(address)) this.hist.set(address, []);
    this.hist.get(address).unshift(sig);
    if (tx) this.txs.set(sig, tx);
  }
  async getSignatures(address, { until, before, limit = 1000 } = {}) {
    this.calls++;
    const list = this.hist.get(address) || [];
    if (before && this.lagBefore) return []; // a lagging fallback node that does not know `before` yet
    let start = 0;
    if (before) { start = list.indexOf(before) + 1; if (start === 0) return []; }
    const out = [];
    for (let i = start; i < list.length && out.length < limit; i++) {
      if (list[i] === until) break;
      out.push({ signature: list[i], err: null });
    }
    return out;
  }
  async getTransaction(sig) { return this.txs.has(sig) ? this.txs.get(sig) : null; }
}

function setup({ startSignature } = {}) {
  const clock = { t: 1_795_600_000 };
  const db = openDb(':memory:');
  const engine = new Engine({ db, companyAddress: COMPANY, now: () => clock.t }).init();
  const rpc = new MockRpc();
  const config = {
    companyAddress: COMPANY, cluster: 'mainnet-beta', minDeposit: U(1), pollMs: 1e9, maxTxPerPoll: 1e9,
    tokens: [{ symbol: 'USDC', mint: USDC, decimals: 6 }, { symbol: 'USDT', mint: USDT, decimals: 6 }],
  };
  const ad = new SolanaAdapter({ engine, rpc, config });
  const ata = { USDC: ad.bySymbol.get('USDC').ata, USDT: ad.bySymbol.get('USDT').ata };
  // genesis signature so the cursor starts at a known point
  const g = startSignature || fakeSig();
  rpc.push(ata.USDC, g, null); rpc.push(ata.USDT, g, null);
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(`sol_until:${USDC}`, g);
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(`sol_until:${USDT}`, g);
  const avail = (a) => engine.balance(acct.available(a));
  const fund = (a, amt) => engine.tx(() => engine.post([[acct.deposits, -amt], [acct.available(a), amt]], `t:${a}:${amt}`));
  return { engine, db, rpc, ad, ata, avail, fund, clock };
}

/** Simple deposit: `from` (signer) sends `amt` of `mint` from fromAta to company ATA. */
function depositTx(h, { from, amt, mint = USDC, sym = 'USDC', fromAta = key(), extraKeys = [], extraBal = [] }) {
  return mkTx({
    keys: [{ pubkey: from, signer: true }, fromAta, h.ata[sym], ...extraKeys],
    bal: [
      { i: 1, mint, owner: from, pre: amt + 5n, post: 5n },
      { i: 2, mint, owner: COMPANY, pre: 0n, post: amt },
      ...extraBal,
    ],
  });
}

// ============================================================ deposits

test('DEFENCE: plain deposit credited once to the sending owner; re-polling and duplicate sigs never double-credit', async () => {
  const h = setup();
  const alice = key();
  const s = fakeSig();
  h.rpc.push(h.ata.USDC, s, depositTx(h, { from: alice, amt: U(100) }));
  await h.ad.poll();
  await h.ad.poll();
  assert.equal(h.avail(alice), U(100));
  // replay the same signature again in history (RPC returns it twice / paging overlap)
  h.rpc.push(h.ata.USDC, s, null);
  await h.ad.poll();
  assert.equal(h.avail(alice), U(100));
  // a fresh adapter on the same DB (restart) with the cursor reset still does not re-credit
  h.db.prepare("UPDATE meta SET value = '' WHERE key = ?").run(`sol_until:${USDC}`);
  await h.ad.poll();
  assert.equal(h.avail(alice), U(100));
  assert.ok(h.engine.checkLedger().ok);
});

test('DEFENCE: fake mint, and Token-2022 balance rows claiming the USDC mint, are ignored', () => {
  const h = setup();
  const atk = key();
  const fakeMint = key();
  const tx1 = depositTx(h, { from: atk, amt: U(1000), mint: fakeMint });
  assert.equal(parseCompanyTransfer(tx1, { mint: USDC, companyAta: h.ata.USDC, company: COMPANY }).kind, 'none');
  const tx2 = mkTx({
    keys: [{ pubkey: atk, signer: true }, key(), h.ata.USDC],
    bal: [
      { i: 1, mint: USDC, owner: atk, pre: U(1000), post: 0n, programId: TOKEN_2022_PROGRAM_ID },
      { i: 2, mint: USDC, owner: COMPANY, pre: 0n, post: U(1000), programId: TOKEN_2022_PROGRAM_ID },
    ],
  });
  assert.equal(parseCompanyTransfer(tx2, { mint: USDC, companyAta: h.ata.USDC, company: COMPANY }).kind, 'none');
});

test('DEFENCE: a non-ATA token account owned by the company (or a look-alike address) is not treated as the company ATA', () => {
  const h = setup();
  const atk = key();
  const lookAlike = key(); // owner=company, real USDC mint, but not the derived ATA
  const tx = mkTx({
    keys: [{ pubkey: atk, signer: true }, key(), lookAlike],
    bal: [{ i: 1, mint: USDC, owner: atk, pre: U(50), post: 0n }, { i: 2, mint: USDC, owner: COMPANY, pre: 0n, post: U(50) }],
  });
  assert.equal(parseCompanyTransfer(tx, { mint: USDC, companyAta: h.ata.USDC, company: COMPANY }).kind, 'none');
});

test('DEFENCE: failed tx, multiple sending owners and unknown sender are never auto-credited', async () => {
  const h = setup();
  const a = key(); const b = key();
  const failed = depositTx(h, { from: a, amt: U(10) }); failed.meta.err = { InstructionError: [0, 'Custom'] };
  const multi = mkTx({
    keys: [{ pubkey: a, signer: true }, key(), h.ata.USDC, key()],
    bal: [{ i: 1, mint: USDC, owner: a, pre: U(10), post: 0n }, { i: 3, mint: USDC, owner: b, pre: U(10), post: 0n },
      { i: 2, mint: USDC, owner: COMPANY, pre: 0n, post: U(20) }],
  });
  const noOwner = mkTx({
    keys: [{ pubkey: a, signer: true }, key(), h.ata.USDC],
    bal: [{ i: 1, mint: USDC, owner: undefined, pre: U(10), post: 0n }, { i: 2, mint: USDC, owner: COMPANY, pre: 0n, post: U(10) }],
  });
  for (const tx of [failed, multi, noOwner]) h.rpc.push(h.ata.USDC, fakeSig(), tx);
  await h.ad.poll();
  assert.equal(h.avail(a), 0n);
  assert.equal(h.avail(b), 0n);
  // a (malicious-RPC / crafted) failed tx that still shows balance changes is held as unattributed:'failed'
  const st = h.db.prepare('SELECT status, reason FROM sol_deposits ORDER BY id').all();
  assert.deepEqual(st.map((r) => [r.status, r.reason]), [['unattributed', 'failed'], ['unattributed', 'multiple_senders'], ['unattributed', 'unknown_sender']]);
});

test('DEFENCE: sender closing its token account in the same tx (pre only, no post row) is credited the right amount', () => {
  const h = setup();
  const a = key();
  const tx = mkTx({
    keys: [{ pubkey: a, signer: true }, key(), h.ata.USDC],
    bal: [{ i: 1, mint: USDC, owner: a, pre: U(42) }, { i: 2, mint: USDC, owner: COMPANY, pre: U(1), post: U(43) }],
  });
  const p = parseCompanyTransfer(tx, { mint: USDC, companyAta: h.ata.USDC, company: COMPANY });
  assert.equal(p.kind, 'deposit'); assert.equal(p.sender, a); assert.equal(p.amount, U(42));
});

test('DEFENCE: v0 tx with address-lookup-table keys: accountIndex maps over static+loaded keys (jsonParsed accountKeys)', () => {
  const h = setup();
  const a = key();
  const tx = mkTx({
    keys: [{ pubkey: a, signer: true }, key(), key(), { pubkey: key(), source: 'lookupTable' }, { pubkey: h.ata.USDC, source: 'lookupTable' }],
    bal: [{ i: 1, mint: USDC, owner: a, pre: U(7), post: 0n }, { i: 4, mint: USDC, owner: COMPANY, pre: 0n, post: U(7) }],
  });
  const p = parseCompanyTransfer(tx, { mint: USDC, companyAta: h.ata.USDC, company: COMPANY });
  assert.equal(p.kind, 'deposit'); assert.equal(p.amount, U(7)); assert.equal(p.sender, a);
});

test('DEFENCE: delegate transfer credits the token-account OWNER (victim), not the delegate signer', () => {
  const h = setup();
  const victim = key(); const delegate = key();
  const tx = mkTx({
    keys: [{ pubkey: delegate, signer: true }, key(), h.ata.USDC],
    bal: [{ i: 1, mint: USDC, owner: victim, pre: U(100), post: 0n }, { i: 2, mint: USDC, owner: COMPANY, pre: 0n, post: U(100) }],
  });
  const p = parseCompanyTransfer(tx, { mint: USDC, companyAta: h.ata.USDC, company: COMPANY });
  assert.equal(p.sender, victim);
});

test('DEFENCE: ATA derivation matches the real mainnet fixture (owner -> its USDC token account)', () => {
  const tx = JSON.parse(fs.readFileSync(new URL('./fixtures/usdc-transfer-1.json', import.meta.url)));
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey || k);
  for (const b of tx.meta.postTokenBalances) {
    assert.equal(deriveAta(b.owner, b.mint), keys[b.accountIndex]);
  }
});

test('DEFENCE (was POC L1): non-signer PDA (AMM vault authority in a CPI swap routed to the company ATA) is held as unattributed, not credited to the PDA', async () => {
  const h = setup();
  const swapper = key();
  const poolAuthority = 'F1KKNyUCsQcZLRjwQ4abX6Ri8gDAQ46nHwSHFKA5sFQv'; // from fixture: pool vault authority (program PDA)
  const tx = mkTx({
    keys: [{ pubkey: swapper, signer: true }, key(), h.ata.USDC, key()],
    bal: [
      { i: 1, mint: USDC, owner: poolAuthority, pre: U(10000), post: U(9500) }, // pool vault pays out USDC
      { i: 2, mint: USDC, owner: COMPANY, pre: 0n, post: U(500) },
    ],
  });
  h.rpc.push(h.ata.USDC, fakeSig(), tx);
  await h.ad.poll();
  assert.equal(h.avail(poolAuthority), 0n);
  assert.equal(h.avail(swapper), 0n);
  assert.deepEqual({ ...h.db.prepare('SELECT status, reason FROM sol_deposits').get() }, { status: 'unattributed', reason: 'program_owned_sender' });
});

test('DEFENCE (was POC M1): more than 20 pages (20,000 sigs) of new history -> older signatures are still fetched and the victim deposit is credited', async () => {
  const h = setup();
  const victim = key();
  const vs = fakeSig();
  h.rpc.push(h.ata.USDC, vs, depositTx(h, { from: victim, amt: U(5000) }));
  // attacker spam: 20,000 cheap txs that merely touch the company ATA (no balance change), ~0.1 SOL of fees
  const spam = mkTx({ keys: [{ pubkey: key(), signer: true }, h.ata.USDC], bal: [] });
  for (let i = 0; i < 20000; i++) h.rpc.push(h.ata.USDC, `spam${i}`, spam);
  await h.ad.poll();
  assert.equal(h.avail(victim), U(5000));
});

test('DEFENCE (was POC M2): lagging fallback RPC answering [] to a `before` page aborts the poll without advancing; the deposit is credited next poll', async () => {
  const h = setup();
  const victim = key();
  const vs = fakeSig();
  h.rpc.push(h.ata.USDC, vs, depositTx(h, { from: victim, amt: U(250) }));
  const filler = mkTx({ keys: [{ pubkey: key(), signer: true }, h.ata.USDC], bal: [] });
  for (let i = 0; i < 1000; i++) h.rpc.push(h.ata.USDC, `f${i}`, filler);
  h.rpc.lagBefore = true; // page 2 is served by an endpoint that does not have `before` yet
  const cur = h.ad.cursor().USDC;
  await assert.rejects(() => h.ad.poll(), /inconsistent signature paging/);
  assert.equal(h.ad.cursor().USDC, cur);
  h.rpc.lagBefore = false;
  await h.ad.poll();
  assert.equal(h.avail(victim), U(250));
});

test('DEFENCE: getTransaction returning null (not yet finalized on this node) stops the scan without advancing the cursor', async () => {
  const h = setup();
  const a = key();
  const s = fakeSig();
  h.rpc.push(h.ata.USDC, s, null);
  const before = h.ad.cursor().USDC;
  await h.ad.poll();
  assert.equal(h.ad.cursor().USDC, before);
  h.rpc.txs.set(s, depositTx(h, { from: a, amt: U(20) }));
  await h.ad.poll();
  assert.equal(h.avail(a), U(20));
});

// ========================================================= withdrawals

function payoutTx(h, { to, amt, mint = USDC, sym = 'USDC', toAta = key(), extra = [] }) {
  return mkTx({
    keys: [{ pubkey: COMPANY, signer: true }, h.ata[sym], toAta],
    bal: [{ i: 1, mint, owner: COMPANY, pre: U(1e6), post: U(1e6) - amt }, { i: 2, mint, owner: to, pre: 0n, post: amt }, ...extra],
  });
}

test('FIXED (H1): user cancels an UNLOCKED withdrawal, then a payout lands -> recovery hold claws it back; no double withdrawal', async () => {
  const h = setup();
  const user = key();
  h.fund(user, U(100));
  const w = h.engine.requestWithdrawal(user, U(100), U(10), 'USDC');
  // admin presses Pay without locking; before it finalizes the user cancels (allowed: unlocked)
  const sig = fakeSig();
  const tx = payoutTx(h, { to: user, amt: U(100) });
  h.engine.cancelWithdrawal(user, w.id);
  assert.equal(h.avail(user), U(100));
  // tx finalizes; watcher finds no pending withdrawal -> unmatched -> backstop moves 100 into a recovery hold
  h.rpc.push(h.ata.USDC, sig, tx);
  h.rpc.txs.set(sig, tx);
  await h.ad.poll();
  assert.equal(h.db.prepare('SELECT status FROM sol_outgoing WHERE signature = ?').get(sig).status, 'unmatched');
  assert.equal(h.avail(user), 0n);
  assert.equal(h.engine.balance(acct.locked(user)), U(100));
  const alerts = h.engine.alerts();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].held, '100');
  assert.equal(alerts[0].shortfall, '0');
  // the same 100 cannot be withdrawn again
  await expectCode(() => h.engine.requestWithdrawal(user, U(100), U(10), 'USDC'), 'INSUFFICIENT_BALANCE');
  // admin settles the hold as paid on chain: ledger matches reality
  h.engine.resolveAlert(alerts[0].id, 'paid');
  assert.equal(h.engine.balance(acct.withdrawals), U(100));
  assert.equal(h.engine.balance(acct.locked(user)), 0n);
  assert.ok(h.engine.checkLedger().ok);
});

test('FIXED (H1): recovery hold never goes below zero and records the shortfall', async () => {
  const h = setup();
  const user = key();
  h.fund(user, U(100));
  const w = h.engine.requestWithdrawal(user, U(100), U(10), 'USDC');
  h.engine.cancelWithdrawal(user, w.id);
  h.engine.vaultDeposit(user, U(70)); // user moves 70 away before the payout lands
  const sig = fakeSig();
  h.rpc.push(h.ata.USDC, sig, payoutTx(h, { to: user, amt: U(100) }));
  await h.ad.poll();
  const [a] = h.engine.alerts();
  assert.equal(a.held, '30');
  assert.equal(a.shortfall, '70');
  assert.equal(h.avail(user), 0n);
  assert.ok(h.engine.checkLedger().ok);
});

test('FIXED (H1): reject of a LOCKED withdrawal is refused (PAYOUT_MAY_LAND) until blockhash expiry AND a scan past it', async () => {
  const h = setup();
  const user = key();
  h.fund(user, U(100));
  let height = 500;
  h.rpc.getBlockHeight = async () => height;
  const w = h.engine.requestWithdrawal(user, U(100), U(10), 'USDC');
  h.engine.lockWithdrawal(w.id, { blockhash: key(), lastValidBlockHeight: 650 });
  await expectCode(() => h.engine.cancelWithdrawal(user, w.id), 'WITHDRAW_LOCKED');
  await expectCode(() => h.engine.rejectWithdrawal(w.id, 'x'), 'PAYOUT_MAY_LAND'); // engine refuses without proof
  const row = () => h.engine.s.wd.get(w.id);
  await expectCode(() => h.ad.verifyUnlock(row()), 'PAYOUT_MAY_LAND'); // chain not past 650
  height = 651;
  await expectCode(() => h.ad.verifyUnlock(row()), 'PAYOUT_MAY_LAND'); // watcher has not scanned past 650
  await h.ad.poll();
  assert.equal(await h.ad.verifyUnlock(row()), true);
  h.engine.rejectWithdrawal(w.id, 'expired', { unlockVerified: true });
  assert.equal(h.avail(user), U(100));
  // a lock without blockhash info can never be proven safe
  const w2 = h.engine.requestWithdrawal(user, U(50), U(10), 'USDC');
  h.engine.lockWithdrawal(w2.id);
  await expectCode(() => h.ad.verifyUnlock(h.engine.s.wd.get(w2.id)), 'PAYOUT_MAY_LAND');
});

test('DEFENCE: /paid rejects wrong mint, wrong owner, underpayment, failed tx, unrelated tx, and reuse for a second withdrawal', async () => {
  const h = setup();
  const user = key(); const other = key();
  h.fund(user, U(300));
  const w1 = h.engine.requestWithdrawal(user, U(100), U(10), 'USDC');
  const w2 = h.engine.requestWithdrawal(user, U(100), U(10), 'USDC');
  const put = (tx) => { const s = fakeSig(); h.rpc.txs.set(s, tx); return s; };
  await expectCode(() => h.ad.markPaid(w1.id, { signature: put(payoutTx(h, { to: user, amt: U(100), mint: USDT, sym: 'USDT' })) }), 'TX_MISMATCH');
  await expectCode(() => h.ad.markPaid(w1.id, { signature: put(payoutTx(h, { to: other, amt: U(100) })) }), 'TX_MISMATCH');
  await expectCode(() => h.ad.markPaid(w1.id, { signature: put(payoutTx(h, { to: user, amt: U(99.999999) })) }), 'TX_MISMATCH');
  // underpayment hidden among several transfers: two 50s into two different accounts of the user
  const split = mkTx({
    keys: [{ pubkey: COMPANY, signer: true }, h.ata.USDC, key(), key()],
    bal: [{ i: 1, mint: USDC, owner: COMPANY, pre: U(1000), post: U(900) }, { i: 2, mint: USDC, owner: user, pre: 0n, post: U(50) }, { i: 3, mint: USDC, owner: user, pre: 0n, post: U(50) }],
  });
  await expectCode(() => h.ad.markPaid(w1.id, { signature: put(split) }), 'TX_MISMATCH');
  const failed = payoutTx(h, { to: user, amt: U(100) }); failed.meta.err = { InstructionError: [1, 'Custom'] };
  await expectCode(() => h.ad.markPaid(w1.id, { signature: put(failed) }), 'TX_FAILED');
  const unrelated = depositTx(h, { from: user, amt: U(100) });
  await expectCode(() => h.ad.markPaid(w1.id, { signature: put(unrelated) }), 'TX_MISMATCH');
  // a real user->user transfer that never touches the company ATA
  const p2p = mkTx({ keys: [{ pubkey: other, signer: true }, key(), key()], bal: [{ i: 1, mint: USDC, owner: other, pre: U(100), post: 0n }, { i: 2, mint: USDC, owner: user, pre: 0n, post: U(100) }] });
  await expectCode(() => h.ad.markPaid(w1.id, { signature: put(p2p) }), 'TX_MISMATCH');
  const good = put(payoutTx(h, { to: user, amt: U(100) }));
  await h.ad.markPaid(w1.id, { signature: good });
  await expectCode(() => h.ad.markPaid(w2.id, { signature: good }), 'TX_MISMATCH');
  assert.equal(h.engine.s.wd.get(w2.id).status, 'pending');
});

test('DEFENCE: watcher auto-match then admin /paid with the same signature cannot mark a second withdrawal', async () => {
  const h = setup();
  const user = key();
  h.fund(user, U(200));
  const w1 = h.engine.requestWithdrawal(user, U(100), U(10), 'USDC');
  const w2 = h.engine.requestWithdrawal(user, U(100), U(10), 'USDC');
  const sig = fakeSig();
  h.rpc.push(h.ata.USDC, sig, payoutTx(h, { to: user, amt: U(100) }));
  await h.ad.poll();
  assert.equal(h.engine.s.wd.get(w1.id).status, 'paid');
  await expectCode(() => h.ad.markPaid(w2.id, { signature: sig }), 'TX_MISMATCH');
});

test('DEFENCE: an outgoing USDT payout does not auto-match a USDC withdrawal of the same amount', async () => {
  const h = setup();
  const user = key();
  h.fund(user, U(100));
  const w = h.engine.requestWithdrawal(user, U(100), U(10), 'USDC');
  h.rpc.push(h.ata.USDT, fakeSig(), payoutTx(h, { to: user, amt: U(100), mint: USDT, sym: 'USDT' }));
  await h.ad.poll();
  assert.equal(h.engine.s.wd.get(w.id).status, 'pending');
});

// ================================================================ auth

test('DEFENCE (was POC L2): universal forgery for a small-order public key (identity point) is rejected', () => {
  const identity = new Uint8Array(32); identity[0] = 1; // encoding of the neutral point
  const addr = bs58.encode(identity);
  assert.equal(normSolAddress(addr), addr); // passes address validation
  const sig = new Uint8Array(64); sig[0] = 1; // R = identity, S = 0
  assert.equal(verifySolSignature('any message, any nonce', bs58.encode(sig), addr), false);
});

test('DEFENCE: malleated signature (S + L) and wrong-key / truncated signatures are rejected', () => {
  const sk = ed25519.utils.randomPrivateKey();
  const addr = bs58.encode(ed25519.getPublicKey(sk));
  const msg = 'www.stoxhome.xyz wants you to sign in';
  const sig = ed25519.sign(Buffer.from(msg), sk);
  assert.equal(verifySolSignature(msg, bs58.encode(sig), addr), true);
  const L = 2n ** 252n + 27742317777372353535851937790883648493n;
  let s = 0n; for (let i = 31; i >= 0; i--) s = (s << 8n) | BigInt(sig[32 + i]);
  const s2 = s + L; const mal = new Uint8Array(sig);
  for (let i = 0; i < 32; i++) mal[32 + i] = Number((s2 >> BigInt(8 * i)) & 0xffn);
  assert.equal(verifySolSignature(msg, bs58.encode(mal), addr), false);
  assert.equal(verifySolSignature(msg + 'x', bs58.encode(sig), addr), false);
  assert.equal(verifySolSignature(msg, bs58.encode(sig.slice(0, 63)), addr), false);
  assert.equal(verifySolSignature(msg, bs58.encode(sig), key()), false);
});

test('DEFENCE: base58 address edge cases (wrong length, leading-1 padding, 0/O/I/l, non-canonical) are rejected', () => {
  const good = key();
  assert.equal(normSolAddress(good), good);
  assert.throws(() => decodePubkey('1' + good), /BAD_INPUT|32 bytes|base58/);
  assert.throws(() => normSolAddress('0' + good.slice(1)));
  assert.throws(() => normSolAddress(bs58.encode(crypto.randomBytes(33))));
  assert.throws(() => normSolAddress(' ' + good));
});

// ============================================================== ledger

test('DEFENCE: 6-decimal token amounts are credited 1:1 as micro-USD (no rounding), 1 raw unit stays 1 micro', async () => {
  const h = setup();
  const a = key();
  h.ad.cfg.minDeposit = 1n;
  h.rpc.push(h.ata.USDT, fakeSig(), depositTx(h, { from: a, amt: 1n, mint: USDT, sym: 'USDT' }));
  h.rpc.push(h.ata.USDC, fakeSig(), depositTx(h, { from: a, amt: 123456789n }));
  await h.ad.poll();
  assert.equal(h.avail(a), 123456790n);
  assert.ok(h.engine.checkLedger().ok);
});

// ================================================================ SIWS (src/auth.js, chain 'solana')
import { Auth } from '../src/auth.js';

function mkAuth() {
  const clock = { t: 1_795_600_000 };
  const db = openDb(':memory:');
  const auth = new Auth({ db, secret: 'x'.repeat(32), domain: 'www.stoxhome.xyz', chainId: 0, companyAddress: COMPANY, now: () => clock.t, chain: 'solana' });
  return { auth, clock, db };
}
const signB58 = (msg, sk) => bs58.encode(ed25519.sign(Buffer.from(msg, 'utf8'), sk));

test('DEFENCE: SIWS nonce is single-use, bound to address+exact message+domain, and expires', async () => {
  const { auth, clock } = mkAuth();
  const sk = ed25519.utils.randomPrivateKey();
  const addr = bs58.encode(ed25519.getPublicKey(sk));
  const { message } = auth.createNonce(addr);
  assert.ok(message.startsWith('www.stoxhome.xyz wants you to sign in with your Solana account:\n' + addr));
  const r = auth.verify({ address: addr, message, signature: signB58(message, sk) });
  assert.equal(r.isAdmin, false);
  await expectCode(() => auth.verify({ address: addr, message, signature: signB58(message, sk) }), 'UNAUTHORIZED'); // replay
  // signature for another address over the issued message
  const sk2 = ed25519.utils.randomPrivateKey();
  const m2 = auth.createNonce(addr).message;
  await expectCode(() => auth.verify({ address: addr, message: m2, signature: signB58(m2, sk2) }), 'UNAUTHORIZED');
  // message edited (other domain) with same nonce
  const m3 = auth.createNonce(addr).message;
  const evil = m3.replace('www.stoxhome.xyz', 'evil.example');
  await expectCode(() => auth.verify({ address: addr, message: evil, signature: signB58(evil, sk) }), 'UNAUTHORIZED');
  // expiry
  const m4 = auth.createNonce(addr).message;
  clock.t += 601;
  await expectCode(() => auth.verify({ address: addr, message: m4, signature: signB58(m4, sk) }), 'UNAUTHORIZED');
});

test('DEFENCE: isAdmin only for the exact base58 company key; forged/edited session tokens are rejected', () => {
  const { auth } = mkAuth();
  const tok = auth.sign({ a: key(), c: 'solana', e: 2e9 });
  // I1: tokens without the chain claim, for another chain, or with a non-base58 address are refused (same secret)
  assert.equal(auth.check(auth.sign({ a: key(), e: 2e9 })), null);
  assert.equal(auth.check(auth.sign({ a: key(), c: 'evm', e: 2e9 })), null);
  assert.equal(auth.check(auth.sign({ a: '0x106342ec570e207afda9fda63125d7a9071127f2', c: 'solana', e: 2e9 })), null);
  assert.equal(auth.check(tok).isAdmin, false);
  const [body, mac] = tok.split('.');
  const forged = Buffer.from(JSON.stringify({ a: COMPANY, e: 2e9 })).toString('base64url') + '.' + mac;
  assert.equal(auth.check(forged), null);
  assert.equal(auth.check(body + '.' + mac.slice(0, -2)), null);
  let lc = null; try { lc = auth.normAddress(COMPANY.toLowerCase()); } catch { /* invalid is fine */ }
  assert.notEqual(lc, COMPANY); // base58 is case-sensitive: no case-folding onto the admin key
  assert.equal(auth.check(auth.sign({ a: COMPANY.toLowerCase(), c: 'solana', e: 2e9 })).isAdmin, false); // a different key
  assert.equal(auth.check(auth.sign({ a: COMPANY, c: 'solana', e: 2e9 })).isAdmin, true);
});

test('DEFENCE (was POC L2): SIWS sign-in as the small-order identity-point address without a private key is rejected', () => {
  const { auth } = mkAuth();
  const id = new Uint8Array(32); id[0] = 1;
  const addr = bs58.encode(id);
  const { message } = auth.createNonce(addr);
  const sig = new Uint8Array(64); sig[0] = 1;
  assert.throws(() => auth.verify({ address: addr, message, signature: bs58.encode(sig) }), (e) => e.code === 'UNAUTHORIZED');
});

test('DEFENCE (H1 fix, engine-level): after admin lockWithdrawal the user cannot cancel; the payout then auto-matches', async (t) => {
  const h = setup();
  if (typeof h.engine.lockWithdrawal !== 'function') return t.skip('lockWithdrawal not present');
  const user = key();
  h.fund(user, U(100));
  const w = h.engine.requestWithdrawal(user, U(100), U(10), 'USDC');
  h.engine.lockWithdrawal(w.id);
  await expectCode(() => h.engine.cancelWithdrawal(user, w.id), 'WITHDRAW_LOCKED');
  const sig = fakeSig();
  h.rpc.push(h.ata.USDC, sig, payoutTx(h, { to: user, amt: U(100) }));
  await h.ad.poll();
  assert.equal(h.engine.s.wd.get(w.id).status, 'paid');
  assert.equal(h.avail(user), 0n);
});
