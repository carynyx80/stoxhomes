// /chain/balances and /chain/send (safe deposit relay): wire-format serializer, validation, HTTP.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/server.js';
import { deriveAta, MINTS, TOKEN_PROGRAM_ID, ATA_PROGRAM_ID, COMPUTE_BUDGET_PROGRAM_ID, validateRelayTx, deserializeTx } from '../src/solana.js';
import { MockSolanaRpc, randomKey } from './solana-helpers.js';

const SYSTEM = '11111111111111111111111111111111';
const COMPANY = '8oYH186qjPyYwnS58fh1NH1m5iFFJe8wPnBKVp3NGtgx';
const ATA = { USDC: deriveAta(COMPANY, MINTS.USDC), USDT: deriveAta(COMPANY, MINTS.USDT) };
const TOKENS = [{ symbol: 'USDC', mint: MINTS.USDC, decimals: 6, ata: ATA.USDC }, { symbol: 'USDT', mint: MINTS.USDT, decimals: 6, ata: ATA.USDT }];

const shortvec = (n) => { const out = []; for (;;) { let b = n & 0x7f; n >>= 7; if (n) { out.push(b | 0x80); } else { out.push(b); return Buffer.from(out); } } };

/** Minimal Solana message compiler + signer (fee payer first). ixs: [{ program, keys: [{ pubkey, signer, writable }], data }] */
function buildTx({ payer, ixs, version = 'legacy', lookups = [], badSig = false, extraSigners = [] }) {
  const metas = new Map();
  const add = (pubkey, signer, writable) => {
    const m = metas.get(pubkey) || { pubkey, signer: false, writable: false };
    m.signer ||= signer; m.writable ||= writable; metas.set(pubkey, m);
  };
  add(payer.address, true, true);
  for (const ix of ixs) { for (const k of ix.keys) add(k.pubkey, k.signer, k.writable); add(ix.program, false, false); }
  const all = [...metas.values()];
  const order = [
    ...all.filter((m) => m.pubkey === payer.address),
    ...all.filter((m) => m.pubkey !== payer.address && m.signer && m.writable),
    ...all.filter((m) => m.pubkey !== payer.address && m.signer && !m.writable),
    ...all.filter((m) => !m.signer && m.writable),
    ...all.filter((m) => !m.signer && !m.writable),
  ];
  const idx = (k) => order.findIndex((m) => m.pubkey === k);
  const nSigners = order.filter((m) => m.signer).length;
  const header = Buffer.from([nSigners, order.filter((m) => m.signer && !m.writable).length, order.filter((m) => !m.signer && !m.writable).length]);
  const parts = [];
  if (version === 0) parts.push(Buffer.from([0x80]));
  parts.push(header, shortvec(order.length), ...order.map((m) => Buffer.from(bs58.decode(m.pubkey))), Buffer.from(bs58.decode(randomKey())));
  parts.push(shortvec(ixs.length));
  for (const ix of ixs) {
    parts.push(Buffer.from([idx(ix.program)]), shortvec(ix.keys.length), Buffer.from(ix.keys.map((k) => idx(k.pubkey))), shortvec(ix.data.length), Buffer.from(ix.data));
  }
  if (version === 0) {
    parts.push(shortvec(lookups.length));
    for (const l of lookups) parts.push(Buffer.from(bs58.decode(l)), shortvec(1), Buffer.from([0]), shortvec(0));
  }
  const message = Buffer.concat(parts);
  const signers = [payer, ...extraSigners];
  const sigs = order.filter((m) => m.signer).map((m) => {
    const kp = signers.find((s) => s.address === m.pubkey);
    if (!kp || badSig) return Buffer.alloc(64);
    return Buffer.from(nacl.sign.detached(message, kp.secretKey));
  });
  return Buffer.concat([shortvec(sigs.length), ...sigs, message]).toString('base64');
}

const kp = () => { const k = nacl.sign.keyPair(); return { address: bs58.encode(k.publicKey), secretKey: k.secretKey }; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const cuPrice = () => ({ program: COMPUTE_BUDGET_PROGRAM_ID, keys: [], data: Buffer.concat([Buffer.from([3]), u64(1000)]) });
const cuLimit = () => ({ program: COMPUTE_BUDGET_PROGRAM_ID, keys: [], data: Buffer.from([2, 0x40, 0x0d, 0x03, 0x00]) });
const createAta = (payer, ata = ATA.USDC, owner = COMPANY, mint = MINTS.USDC) => ({
  program: ATA_PROGRAM_ID, data: Buffer.from([1]),
  keys: [{ pubkey: payer.address, signer: true, writable: true }, { pubkey: ata, signer: false, writable: true }, { pubkey: owner, signer: false, writable: false },
    { pubkey: mint, signer: false, writable: false }, { pubkey: SYSTEM, signer: false, writable: false }, { pubkey: TOKEN_PROGRAM_ID, signer: false, writable: false }],
});
const transferChecked = (user, { amount = 25_000_000, mint = MINTS.USDC, dest = ATA.USDC, decimals = 6 } = {}) => ({
  program: TOKEN_PROGRAM_ID, data: Buffer.concat([Buffer.from([12]), u64(amount), Buffer.from([decimals])]),
  keys: [{ pubkey: deriveAta(user.address, mint), signer: false, writable: true }, { pubkey: mint, signer: false, writable: false },
    { pubkey: dest, signer: false, writable: true }, { pubkey: user.address, signer: true, writable: false }],
});
const ctx = { company: COMPANY, tokens: TOKENS };
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return 'OK'; };

test('relay validation: allowed deposit shapes (legacy and v0)', () => {
  const u = kp();
  const tx = buildTx({ payer: u, ixs: [cuLimit(), cuPrice(), createAta(u), transferChecked(u)] });
  const v = validateRelayTx(tx, ctx);
  assert.deepEqual(v.transfers, [{ mint: MINTS.USDC, amount: 25_000_000n }]);
  assert.equal(v.payer, u.address);
  assert.equal(deserializeTx(Buffer.from(tx, 'base64')).version, 'legacy');
  const v0 = buildTx({ payer: u, version: 0, ixs: [createAta(u, ATA.USDT, COMPANY, MINTS.USDT), transferChecked(u, { mint: MINTS.USDT, dest: ATA.USDT })] });
  assert.equal(validateRelayTx(v0, ctx).transfers[0].mint, MINTS.USDT);
});

test('relay validation: rejects everything else with TX_NOT_ALLOWED', () => {
  const u = kp();
  const attacker = kp();
  const cases = {
    'transfer to a non-company account': [transferChecked(u, { dest: deriveAta(attacker.address, MINTS.USDC) })],
    'transfer to the USDT ATA with the USDC mint': [transferChecked(u, { dest: ATA.USDT })],
    'unknown mint': [transferChecked(u, { mint: randomKey(), dest: ATA.USDC })],
    'wrong decimals': [transferChecked(u, { decimals: 9 })],
    'plain SPL transfer (not checked)': [{ ...transferChecked(u), data: Buffer.concat([Buffer.from([3]), u64(1)]) }],
    'SPL approve': [{ ...transferChecked(u), data: Buffer.concat([Buffer.from([4]), u64(1)]) }],
    'system transfer': [{ program: SYSTEM, keys: [{ pubkey: u.address, signer: true, writable: true }, { pubkey: attacker.address, signer: false, writable: true }], data: Buffer.from([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]) }, transferChecked(u)],
    'ATA create for someone else': [createAta(u, deriveAta(attacker.address, MINTS.USDC), attacker.address), transferChecked(u)],
    'compute budget heap request': [{ program: COMPUTE_BUDGET_PROGRAM_ID, keys: [], data: Buffer.from([1, 0, 0, 1, 0]) }, transferChecked(u)],
    'no transfer at all': [cuPrice()],
    'zero amount': [transferChecked(u, { amount: 0 })],
  };
  for (const [name, ixs] of Object.entries(cases)) assert.equal(code(() => validateRelayTx(buildTx({ payer: u, ixs }), ctx)), 'TX_NOT_ALLOWED', name);
  assert.equal(code(() => validateRelayTx(buildTx({ payer: u, ixs: [transferChecked(u)], badSig: true }), ctx)), 'TX_NOT_ALLOWED', 'unsigned');
  // signature by someone other than the fee payer
  const forged = Buffer.from(buildTx({ payer: u, ixs: [transferChecked(u)] }), 'base64');
  forged[5] ^= 1;
  assert.equal(code(() => validateRelayTx(forged.toString('base64'), ctx)), 'TX_NOT_ALLOWED', 'tampered signature');
  const tamperedMsg = Buffer.from(buildTx({ payer: u, ixs: [transferChecked(u)] }), 'base64');
  tamperedMsg[tamperedMsg.length - 2] ^= 1; // amount byte
  assert.equal(code(() => validateRelayTx(tamperedMsg.toString('base64'), ctx)), 'TX_NOT_ALLOWED', 'tampered message');
  assert.equal(code(() => validateRelayTx(buildTx({ payer: u, version: 0, lookups: [randomKey()], ixs: [transferChecked(u)] }), ctx)), 'TX_NOT_ALLOWED', 'lookup tables');
  assert.equal(code(() => validateRelayTx(Buffer.alloc(1300, 1).toString('base64'), ctx)), 'TX_NOT_ALLOWED', 'oversize');
  assert.equal(code(() => validateRelayTx(Buffer.from([1, 2, 3]).toString('base64'), ctx)), 'TX_NOT_ALLOWED', 'garbage');
  assert.equal(code(() => validateRelayTx('not base64!', ctx)), 'BAD_INPUT');
  assert.equal(code(() => validateRelayTx(12, ctx)), 'BAD_INPUT');
});

let mock, svc, base, tmp;
before(async () => {
  mock = new MockSolanaRpc();
  const url = await mock.listen();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-relay-'));
  svc = createApp(loadConfig({ CHAIN: 'solana', DB_PATH: path.join(tmp, 'e.db'), RPC_URL: url, SESSION_SECRET: 'r'.repeat(32), WATCHER: '0', LOOP_MS: '100000' }), { log: () => {} });
  base = `http://127.0.0.1:${await svc.start(0)}`;
});
after(async () => { await svc.stop(); await mock.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
const api = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};

test('GET /config advertises features; GET /chain/balances (ATA via getAccountInfo, missing = 0, cached)', async () => {
  assert.deepEqual((await api('GET', '/config')).body.features, ['chain/balances', 'chain/send']);
  const u = kp();
  mock.lamports.set(u.address, 1_500_000_000n);
  const usdcAta = deriveAta(u.address, MINTS.USDC);
  mock.tokenBalances.set(usdcAta, 12_345_678n);
  mock.mintOf = new Map([[usdcAta, MINTS.USDC]]);
  const r = await api('GET', `/chain/balances?owner=${u.address}`);
  assert.deepEqual(r.body, { sol: '1.5', tokens: { USDC: '12.345678', USDT: '0' } });
  const calls = mock.calls.getAccountInfo;
  mock.tokenBalances.set(usdcAta, 1n);
  assert.deepEqual((await api('GET', `/chain/balances?owner=${u.address}`)).body, r.body, 'cached for 5s');
  assert.equal(mock.calls.getAccountInfo, calls);
  assert.equal((await api('GET', '/chain/balances?owner=0xabc')).body.error, 'BAD_INPUT');
  assert.equal((await api('GET', '/chain/balances')).body.error, 'BAD_INPUT');
});

test('POST /chain/send relays only safe deposits; rejects a transfer to a non-company account; rate limited', async () => {
  const u = kp();
  const good = buildTx({ payer: u, ixs: [cuPrice(), createAta(u), transferChecked(u)] });
  const r = await api('POST', '/chain/send', { tx: good });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.signature, bs58.encode(Buffer.from(good, 'base64').subarray(1, 65)));
  assert.deepEqual(mock.sent, [good]);
  const evil = buildTx({ payer: u, ixs: [transferChecked(u, { dest: deriveAta(kp().address, MINTS.USDC) })] });
  const rej = await api('POST', '/chain/send', { tx: evil });
  assert.equal(rej.status, 400);
  assert.equal(rej.body.error, 'TX_NOT_ALLOWED');
  assert.equal(mock.sent.length, 1, 'never forwarded');
  mock.rejectSend = true;
  assert.equal((await api('POST', '/chain/send', { tx: buildTx({ payer: u, ixs: [transferChecked(u)] }) })).body.error, 'TX_REJECTED');
  mock.rejectSend = false;
  let limited = 0;
  for (let i = 0; i < 12; i++) if ((await api('POST', '/chain/send', { tx: good })).status === 429) limited++;
  assert.ok(limited > 0, 'per-IP rate limit');
});
