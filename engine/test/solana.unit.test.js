import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bs58 from 'bs58';
import {
  deriveAta, findProgramAddress, decodePubkey, normSolAddress, verifySolSignature, parseCompanyTransfer, tokenDeltas,
  SolRpc, MINTS, TOKEN_2022_PROGRAM_ID, ATA_PROGRAM_ID, isOnCurve,
} from '../src/solana.js';
import { Auth } from '../src/auth.js';
import { openDb } from '../src/db.js';
import { craftTx, keypair, MockSolanaRpc, randomKey } from './solana-helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const COMPANY = '8oYH186qjPyYwnS58fh1NH1m5iFFJe8wPnBKVp3NGtgx';
// Reference values computed with @solana/spl-token getAssociatedTokenAddressSync.
const COMPANY_USDC_ATA = 'FqfMexmmUhqTWGwTNjz56pY7wB9ucg8LQjXH4njiWzQH';
const COMPANY_USDT_ATA = '7KDPNodKa18Vn7Hd53NQ8D6ePpknjcuS83UBy9U9JrXK';
const fixtures = fs.readdirSync(path.join(here, 'fixtures')).filter((f) => f.startsWith('usdc-transfer-'))
  .map((f) => ({ name: f, tx: JSON.parse(fs.readFileSync(path.join(here, 'fixtures', f), 'utf8')) }));

test('ATA derivation: company USDC/USDT ATAs match spl-token', () => {
  const usdc = deriveAta(COMPANY, MINTS.USDC);
  const usdt = deriveAta(COMPANY, MINTS.USDT);
  console.log(`# company USDC ATA ${usdc}`);
  console.log(`# company USDT ATA ${usdt}`);
  assert.equal(usdc, COMPANY_USDC_ATA);
  assert.equal(usdt, COMPANY_USDT_ATA);
  const [, bump] = findProgramAddress([decodePubkey(COMPANY), decodePubkey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), decodePubkey(MINTS.USDC)], ATA_PROGRAM_ID);
  assert.ok(bump >= 0 && bump <= 255);
  assert.equal(isOnCurve(decodePubkey(usdc)), false, 'PDAs are off-curve');
  assert.equal(isOnCurve(decodePubkey(COMPANY)), true, 'wallets are on-curve');
});

test('ATA derivation matches token accounts in real mainnet transactions', () => {
  let matched = 0;
  let total = 0;
  for (const { tx } of fixtures) {
    const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey);
    for (const b of tx.meta.postTokenBalances) {
      if (b.mint !== MINTS.USDC || !b.owner) continue;
      total++;
      if (deriveAta(b.owner, b.mint, b.programId) === keys[b.accountIndex]) matched++;
    }
  }
  console.log(`# fixtures: ${matched}/${total} USDC token accounts are ATAs of their owner`);
  assert.ok(matched >= 1);
});

test('address validation: base58, 32 bytes, canonical', () => {
  assert.equal(normSolAddress(COMPANY), COMPANY);
  for (const bad of ['', '0x106342ec570e207afda9fda63125d7a9071127f2', 'O0Il' + COMPANY.slice(4), COMPANY + '1', bs58.encode(Buffer.alloc(31, 1)), bs58.encode(Buffer.alloc(33, 1)), 123, null]) {
    assert.throws(() => normSolAddress(bad), { code: 'BAD_INPUT' }, String(bad));
  }
});

test('SIWS: message, ed25519 verify with a real keypair, wrong key/tamper rejected', () => {
  const kp = keypair();
  const other = keypair();
  const db = openDb(':memory:');
  const auth = new Auth({ db, secret: 's'.repeat(32), domain: 'www.stoxhome.xyz', companyAddress: COMPANY, now: () => 1_790_000_000, chain: 'solana' });
  const { message } = auth.createNonce(kp.address);
  assert.match(message, /^www\.stoxhome\.xyz wants you to sign in with your Solana account:\n/);
  assert.ok(message.includes(`\n${kp.address}\n`));
  assert.ok(message.includes('Solana mainnet'));
  const sig = kp.sign(message);
  assert.equal(bs58.decode(sig).length, 64);
  assert.equal(verifySolSignature(message, sig, kp.address), true);
  assert.equal(verifySolSignature(message, sig, other.address), false);
  assert.equal(verifySolSignature(message + ' ', sig, kp.address), false);
  assert.throws(() => auth.verify({ address: kp.address, message, signature: other.sign(message) }), { code: 'UNAUTHORIZED' });
  assert.throws(() => auth.verify({ address: kp.address, message, signature: '0x' + 'ab'.repeat(65) }), { code: 'BAD_INPUT' });
  const r = auth.verify({ address: kp.address, message, signature: sig });
  assert.equal(r.isAdmin, false);
  assert.deepEqual(auth.check(r.token), { address: kp.address, isAdmin: false });
  assert.throws(() => auth.verify({ address: kp.address, message, signature: sig }), { code: 'UNAUTHORIZED' }, 'nonce reuse');
  assert.throws(() => auth.createNonce('notbase58!'), { code: 'BAD_INPUT' });
});

test('parse REAL mainnet USDC transfers (jsonParsed, legacy and v0)', () => {
  assert.ok(fixtures.length >= 3);
  for (const { name, tx } of fixtures) {
    const d = tokenDeltas(tx, MINTS.USDC);
    const recv = d.find((x) => x.delta > 0n);
    const send = d.find((x) => x.delta < 0n);
    // Treat the recipient as "the company": a deposit attributed to the sending owner.
    const p = parseCompanyTransfer(tx, { mint: MINTS.USDC, companyAta: recv.account, company: recv.owner });
    assert.equal(p.kind, 'deposit', name);
    assert.equal(p.amount, recv.delta, name);
    const signerKeys = new Set(tx.transaction.message.accountKeys.filter((k) => k.signer).map((k) => k.pubkey));
    if (isOnCurve(decodePubkey(send.owner)) || signerKeys.has(send.owner)) {
      assert.equal(p.sender, send.owner, name);
      assert.equal(p.reason, null, name);
    } else {
      // sender is a program-owned PDA (e.g. an AMM vault paying out in a swap): never auto-credited
      assert.equal(p.sender, null, name);
      assert.equal(p.reason, 'program_owned_sender', name);
    }
    // From the sender's side it is an outgoing payment to the recipient's owner.
    const o = parseCompanyTransfer(tx, { mint: MINTS.USDC, companyAta: send.account, company: send.owner });
    assert.equal(o.kind, 'outgoing', name);
    assert.deepEqual(o.recipients.map((x) => [x.owner, x.amount]), [[recv.owner, recv.delta]], name);
    // Unrelated account: nothing.
    assert.equal(parseCompanyTransfer(tx, { mint: MINTS.USDC, companyAta: randomKey(), company: COMPANY }).kind, 'none');
    console.log(`# ${name}: v=${tx.version} ${send.owner.slice(0, 6)}.. -> ${recv.owner.slice(0, 6)}.. ${recv.delta} raw, ${p.reason || 'attributed'}`);
  }
});

test('crafted variants: failed, multi-sender, below-minimum amount, Token-2022 noise, internal', () => {
  const base = fixtures[0].tx;
  const d = tokenDeltas(base, MINTS.USDC);
  const recv = d.find((x) => x.delta > 0n);
  const ctx = { mint: MINTS.USDC, companyAta: recv.account, company: recv.owner };
  // failed: real tx with meta.err set
  const failed = structuredClone(base);
  failed.meta.err = { InstructionError: [2, { Custom: 1 }] };
  assert.equal(parseCompanyTransfer(failed, ctx).reason, 'failed');
  // multi-sender: add a second decreasing token account with a different owner
  const multi = structuredClone(base);
  const extraIdx = multi.transaction.message.accountKeys.length;
  multi.transaction.message.accountKeys.push({ pubkey: randomKey(), signer: false, writable: true, source: 'transaction' });
  const mk = (amt) => ({ accountIndex: extraIdx, mint: MINTS.USDC, owner: randomKey(), programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', uiTokenAmount: { amount: String(amt), decimals: 6 } });
  const e1 = mk(5_000_000); const e2 = { ...mk(4_000_000), owner: e1.owner };
  multi.meta.preTokenBalances.push(e1);
  multi.meta.postTokenBalances.push(e2);
  const pm = parseCompanyTransfer(multi, ctx);
  assert.equal(pm.reason, 'multiple_senders');
  assert.equal(pm.sender, null);
  // Token-2022 noise: a look-alike balance entry with the same mint string under Token-2022, plus another mint
  const noisy = structuredClone(base);
  noisy.meta.preTokenBalances.push({ ...mk(9_000_000), programId: TOKEN_2022_PROGRAM_ID });
  noisy.meta.postTokenBalances.push({ ...mk(0), programId: TOKEN_2022_PROGRAM_ID });
  noisy.meta.preTokenBalances.push({ ...mk(1), mint: randomKey(), accountIndex: 0 });
  const pn = parseCompanyTransfer(noisy, ctx);
  assert.equal(pn.reason, null);
  assert.equal(pn.amount, recv.delta);
  // below-minimum (crafted small amounts) parses fine; the watcher applies MIN_DEPOSIT
  const user = keypair().address;
  const company = keypair().address;
  const small = craftTx({ moves: [{ owner: user, mint: MINTS.USDT, pre: 10_000_000, post: 5_000_000 }, { owner: company, mint: MINTS.USDT, pre: null, post: 5_000_000 }] });
  const ps = parseCompanyTransfer(small, { mint: MINTS.USDT, companyAta: deriveAta(company, MINTS.USDT), company });
  assert.equal(ps.amount, 5_000_000n);
  assert.equal(ps.sender, user);
  // no sender at all (mint into company ATA)
  const minted = craftTx({ moves: [{ owner: company, mint: MINTS.USDT, pre: 0, post: 50_000_000 }] });
  assert.equal(parseCompanyTransfer(minted, { mint: MINTS.USDT, companyAta: deriveAta(company, MINTS.USDT), company }).reason, 'unknown_sender');
  // company moving between its own accounts
  const own = craftTx({ moves: [{ owner: company, mint: MINTS.USDT, pre: 50, post: 0, account: randomKey() }, { owner: company, mint: MINTS.USDT, pre: 0, post: 50 }] });
  assert.equal(parseCompanyTransfer(own, { mint: MINTS.USDT, companyAta: deriveAta(company, MINTS.USDT), company }).kind, 'internal');
});

test('SolRpc: fallbacks, retry on 429, getTransaction v1 option, missing token account = 0', async () => {
  const mock = new MockSolanaRpc();
  const url = await mock.listen();
  try {
    const rpc = new SolRpc(['http://127.0.0.1:1', url], { baseDelayMs: 10 });
    mock.fail429 = 3;
    const bh = await rpc.getLatestBlockhash();
    assert.ok(bh.blockhash && bh.lastValidBlockHeight);
    assert.equal(mock.fail429, 0);
    const tx = craftTx({ moves: [{ owner: COMPANY, mint: MINTS.USDC, pre: 0, post: 1 }] });
    mock.publish(tx, []);
    assert.ok(await rpc.getTransaction(tx.transaction.signatures[0]));
    assert.equal(await rpc.getTokenBalance(COMPANY_USDC_ATA), 0n);
    mock.tokenBalances.set(COMPANY_USDC_ATA, 123n);
    assert.equal(await rpc.getTokenBalance(COMPANY_USDC_ATA), 123n);
    await assert.rejects(rpc.call('getTokenAccountsByOwner', [COMPANY]), /blocked/);
    // publicnode-style 403 on getTokenAccountBalance: falls back to getAccountInfo jsonParsed
    mock.blockIndexed = true;
    mock.mintOf = new Map([[COMPANY_USDC_ATA, MINTS.USDC]]);
    const only = new SolRpc([url], { baseDelayMs: 10 });
    assert.equal(await only.getTokenBalance(COMPANY_USDC_ATA, MINTS.USDC), 123n);
    assert.equal(await only.getTokenBalance(COMPANY_USDT_ATA, MINTS.USDT), 0n);
    await assert.rejects(only.getTokenBalance(COMPANY_USDC_ATA, MINTS.USDT), /not a token account/);
  } finally { await mock.close(); }
});

test('watcher: company ATA without history starts empty and keeps polling; START_SIGNATURE honoured', async () => {
  const { makeEngine } = await import('./helpers.js');
  const { SolanaAdapter } = await import('../src/solana.js');
  const mock = new MockSolanaRpc();
  const url = await mock.listen();
  try {
    const companyKp = keypair();
    const user = keypair().address;
    const h = makeEngine();
    const tokens = [{ symbol: 'USDC', mint: MINTS.USDC, decimals: 6 }, { symbol: 'USDT', mint: MINTS.USDT, decimals: 6 }];
    const mk = (extra = {}) => new SolanaAdapter({ engine: h.engine, rpc: new SolRpc([url], { baseDelayMs: 5 }), config: { companyAddress: companyKp.address, tokens, minDeposit: 10_000_000n, ...extra } });
    const w = mk();
    await w.poll(); // ATA does not exist: no history
    assert.equal(w.cursor().USDC, '');
    const ata = deriveAta(companyKp.address, MINTS.USDC);
    const tx = craftTx({ moves: [{ owner: user, mint: MINTS.USDC, pre: 50_000_000, post: 0 }, { owner: companyKp.address, mint: MINTS.USDC, pre: null, post: 50_000_000 }] });
    const sig = mock.publish(tx, [ata]);
    await w.poll();
    assert.equal(h.avail(user), 50_000_000n);
    assert.equal(w.cursor().USDC, sig);
    h.check();
    // A second engine with START_SIGNATURE scans only what came after it.
    const h2 = makeEngine();
    const tx2 = craftTx({ moves: [{ owner: user, mint: MINTS.USDC, pre: 20_000_000, post: 0 }, { owner: companyKp.address, mint: MINTS.USDC, pre: 50_000_000, post: 70_000_000 }] });
    mock.publish(tx2, [ata]);
    const w2 = new SolanaAdapter({ engine: h2.engine, rpc: new SolRpc([url]), config: { companyAddress: companyKp.address, tokens, minDeposit: 10_000_000n, startSignature: sig } });
    await w2.poll();
    assert.equal(h2.engine.balance(`user:${user}:available`), 20_000_000n);
  } finally { await mock.close(); }
});
