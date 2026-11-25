// HTTP-level tests: auth, validation, CORS, rate limiting, WebSocket, config (no chain needed).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Wallet } from 'ethers';
import WebSocket from 'ws';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/server.js';

let svc, base, tmp, wallet, token, clockOffset = 0;
const now = () => Math.floor(Date.now() / 1000) + clockOffset;
const fakeRpc = { balanceOf: async () => 0n, blockNumber: async () => 1, chainId: async () => 56 };

async function api(method, p, body, headers = {}) {
  const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json, headers: res.headers };
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-http-'));
  const config = loadConfig({
    CHAIN: 'evm', DB_PATH: path.join(tmp, 'e.db'), SESSION_SECRET: 'x'.repeat(32), CORS_ORIGINS: 'https://www.stoxhome.xyz', WATCHER: '0',
    RATE_LIMIT_PER_MIN: '1000', RATE_LIMIT_ADDR_PER_MIN: '40', LOOP_MS: '100000',
  });
  svc = createApp(config, { now, rpc: fakeRpc, log: () => {} });
  base = `http://127.0.0.1:${await svc.start(0)}`;
  wallet = Wallet.createRandom();
});

after(async () => {
  await svc.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('config: required env', () => {
  assert.throws(() => loadConfig({}), /SESSION_SECRET/);
  assert.throws(() => loadConfig({ CHAIN: 'evm', NODE_ENV: 'production', SESSION_SECRET: 'y'.repeat(32) }), /START_BLOCK/);
  const c = loadConfig({ CHAIN: 'evm', SESSION_SECRET: 'y'.repeat(32) });
  assert.equal(c.port, 4000);
  assert.equal(c.chainId, 56);
  assert.equal(c.confirmations, 15);
  assert.equal(c.logChunk, 2000);
  assert.equal(c.minDeposit, 10_000_000n);
  assert.equal(c.minWithdraw, 10_000_000n);
});

test('health, config, markets, vault, stats', async () => {
  assert.deepEqual(Object.keys((await api('GET', '/health')).body).slice(0, 3), ['ok', 'lastBlock', 'chainId']);
  const cfg = (await api('GET', '/config')).body;
  assert.equal(cfg.fees.maxLeverage, 100);
  assert.equal(cfg.markets.length, 5);
  const ms = (await api('GET', '/markets')).body;
  assert.equal(ms[0].indexPrice, '351.78');
  assert.equal(ms[4].symbol, 'LDN');
  assert.ok((await api('GET', '/markets/0/history?range=1Y')).body.prints.length >= 1);
  assert.equal((await api('GET', '/markets/0/history?range=2Y')).status, 400);
  assert.equal((await api('GET', '/markets/NYC/trades?limit=5')).status, 200);
  assert.equal((await api('GET', '/markets/99/trades')).status, 404);
  assert.equal((await api('GET', '/vault')).body.poolValue, '0');
  assert.equal((await api('GET', '/stats')).status, 200);
  assert.equal((await api('GET', '/quote?marketId=0&size=-10')).status, 200);
  assert.equal((await api('GET', '/quote?marketId=0&size=1e5')).body.error, 'BAD_INPUT');
});

test('auth: SIWE message, single-use nonce, expiry, bad signatures', async () => {
  const address = wallet.address.toLowerCase();
  const { message } = (await api('POST', '/auth/nonce', { address })).body;
  assert.match(message, /^www\.stoxhome\.xyz wants you to sign in/);
  assert.match(message, /Chain ID: 56/);
  // wrong signer
  const other = Wallet.createRandom();
  const badSig = await other.signMessage(message);
  assert.equal((await api('POST', '/auth/verify', { address, message, signature: badSig })).status, 401);
  // tampered message
  const sig = await wallet.signMessage(message);
  assert.equal((await api('POST', '/auth/verify', { address, message: message.replace('Stoxhome', 'Evil'), signature: sig })).status, 401);
  const ok = await api('POST', '/auth/verify', { address, message, signature: sig });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.isAdmin, false);
  token = ok.body.token;
  assert.equal((await api('POST', '/auth/verify', { address, message, signature: sig })).status, 401, 'nonce reuse');
  // expired nonce
  const m2 = (await api('POST', '/auth/nonce', { address })).body.message;
  clockOffset += 601;
  assert.equal((await api('POST', '/auth/verify', { address, message: m2, signature: await wallet.signMessage(m2) })).status, 401);
  clockOffset -= 601;
  // token tamper
  const [b, mac] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ a: '0x106342ec570e207afda9fda63125d7a9071127f2', e: now() + 999 })).toString('base64url');
  assert.equal((await api('GET', '/admin/overview', undefined, { authorization: `Bearer ${forged}.${mac}` })).status, 401);
  assert.equal((await api('GET', '/me', undefined, { authorization: `Bearer ${b}.${mac}` })).status, 200);
  assert.equal((await api('POST', '/auth/nonce', { address: 'nope' })).body.error, 'BAD_INPUT');
});

test('input validation on trading and cash endpoints', async () => {
  const auth = { authorization: `Bearer ${token}` };
  const cases = [
    ['/positions/open', { marketId: 0, size: '1', margin: '-5', acceptablePrice: '400' }],
    ['/positions/open', { marketId: 0, size: 1, margin: '10', acceptablePrice: '400' }],
    ['/positions/open', { marketId: 'DROP TABLE', size: '1', margin: '10', acceptablePrice: '400' }],
    ['/positions/open', { marketId: 0, size: '1', margin: '10.1234567', acceptablePrice: '400' }],
    ['/positions/open', { marketId: 0, size: '1', margin: '10' }],
    ['/positions/modify', { marketId: 0, sizeDelta: 'abc', acceptablePrice: '1' }],
    ['/withdrawals', { amount: '1e9' }],
    ['/withdrawals', { amount: { $gt: 0 } }],
    ['/vault/deposit', { amount: '-1' }],
  ];
  for (const [p, b] of cases) {
    const r = await api('POST', p, b, auth);
    assert.equal(r.status, 400, `${p} ${JSON.stringify(b)} -> ${r.status} ${JSON.stringify(r.body)}`);
  }
  assert.equal((await api('POST', '/positions/open', '{bad json', auth)).body.error, 'BAD_INPUT');
  const r = await api('POST', '/positions/open', { marketId: 0, size: '1', margin: '10', acceptablePrice: '400' }, auth);
  assert.equal(r.body.error, 'SKEW_CAP'); // empty vault: no capacity
  assert.equal((await api('POST', '/withdrawals', { amount: '10' }, auth)).body.error, 'INSUFFICIENT_BALANCE');
  assert.equal((await api('POST', '/admin/index', { symbol: 'NYC', value: '1' }, auth)).status, 403);
});

test('CORS allowlist', async () => {
  const good = await api('OPTIONS', '/markets', undefined, { origin: 'https://www.stoxhome.xyz' });
  assert.equal(good.status, 204);
  assert.equal(good.headers.get('access-control-allow-origin'), 'https://www.stoxhome.xyz');
  const bad = await api('OPTIONS', '/markets', undefined, { origin: 'https://evil.example' });
  assert.equal(bad.status, 403);
  const get = await api('GET', '/markets', undefined, { origin: 'https://evil.example' });
  assert.equal(get.headers.get('access-control-allow-origin'), null);
});

test('websocket: markets broadcast', async () => {
  const ws = new WebSocket(base.replace('http', 'ws') + `/ws?token=${token}`);
  const msg = await new Promise((resolve, reject) => {
    ws.on('message', (d) => resolve(JSON.parse(d.toString())));
    ws.on('error', reject);
  });
  assert.equal(msg.type, 'markets');
  assert.equal(msg.data.length, 5);
  const second = new Promise((resolve) => ws.once('message', (d) => resolve(JSON.parse(d.toString()))));
  svc.tick();
  assert.equal((await second).type, 'markets');
  ws.close();
});

test('rate limiting per address', async () => {
  const auth = { authorization: `Bearer ${token}` };
  let limited = 0;
  for (let i = 0; i < 60; i++) {
    const r = await api('GET', '/me', undefined, auth);
    if (r.status === 429) { limited++; assert.equal(r.body.error, 'RATE_LIMITED'); }
  }
  assert.ok(limited > 0);
});
