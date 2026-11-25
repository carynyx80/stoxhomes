// End-to-end: local Hardhat chain (port 8561) + MockUSDT + the engine over HTTP.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CONTRACTS = path.resolve(here, '../../contracts');
const RPC = 'http://127.0.0.1:8561';
const DAY = 86400;

let node, provider, usdt, company, user, svc, base, tmp;
let offset = 0;
const now = () => Math.floor(Date.now() / 1000) + offset;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForRpc() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) });
      if (r.ok) return;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error('hardhat node did not start');
}

async function api(method, p, bodyObj, token) {
  const res = await fetch(base + p, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: bodyObj ? JSON.stringify(bodyObj) : undefined,
  });
  const json = await res.json();
  return { status: res.status, body: json };
}
const ok = async (...a) => { const r = await api(...a); assert.ok(r.status < 300, `${a[0]} ${a[1]} -> ${r.status} ${JSON.stringify(r.body)}`); return r.body; };

async function signIn(signer) {
  const address = (await signer.getAddress()).toLowerCase();
  const { message } = await ok('POST', '/auth/nonce', { address });
  // EIP-191 personal_sign through the node's JSON-RPC, as a browser wallet would
  const signature = await provider.send('personal_sign', [ethers.hexlify(ethers.toUtf8Bytes(message)), address]);
  const r = await ok('POST', '/auth/verify', { address, message, signature });
  // nonce is single-use
  const replay = await api('POST', '/auth/verify', { address, message, signature });
  assert.equal(replay.status, 401);
  return r;
}

const mine = (n) => provider.send('hardhat_mine', ['0x' + n.toString(16)]);
const check = () => { const c = svc.engine.checkLedger(); assert.ok(c.ok, c.errors.join('; ')); };

before(async () => {
  node = spawn('npx', ['hardhat', 'node', '--port', '8561'], { cwd: CONTRACTS, detached: true, stdio: 'ignore' });
  await waitForRpc();
  provider = new ethers.JsonRpcProvider(RPC, undefined, { polling: false, cacheTimeout: -1 });
  company = await provider.getSigner(0);
  user = await provider.getSigner(1);
  const art = JSON.parse(fs.readFileSync(path.join(CONTRACTS, 'artifacts/contracts/mocks/MockUSDT.sol/MockUSDT.json'), 'utf8'));
  const f = new ethers.ContractFactory(art.abi, art.bytecode, company);
  usdt = await f.deploy();
  await usdt.waitForDeployment();
  await (await usdt.mint(await company.getAddress(), ethers.parseUnits('100000', 18))).wait();
  await (await usdt.mint(await user.getAddress(), ethers.parseUnits('10000', 18))).wait();
  const startBlock = await provider.getBlockNumber();

  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-e2e-'));
  const config = loadConfig({
    CHAIN: 'evm', NODE_ENV: 'production', DB_PATH: path.join(tmp, 'engine.db'), RPC_URL: `http://127.0.0.1:1,${RPC}`, CHAIN_ID: '31337',
    USDT_ADDRESS: await usdt.getAddress(), USDT_DECIMALS: '18', COMPANY_ADDRESS: await company.getAddress(),
    START_BLOCK: String(startBlock), CONFIRMATIONS: '3', LOG_CHUNK: '5', SESSION_SECRET: 'test-secret-test-secret-123',
    ALLOWED_DOMAIN: 'www.stoxhome.xyz', CORS_ORIGINS: 'https://www.stoxhome.xyz', LOOP_MS: '200', WATCHER: '0',
  });
  svc = createApp(config, { now, log: () => {} });
  const port = await svc.start(0);
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  try { if (svc) await svc.stop(); } catch { /* ignore */ }
  try { process.kill(-node.pid, 'SIGTERM'); } catch { /* ignore */ }
  await sleep(300);
  try { process.kill(-node.pid, 'SIGKILL'); } catch { /* ignore */ }
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('e2e: deposit, sign-in, liquidation, profit, vault, withdrawals, overview', async () => {
  const userAddr = (await user.getAddress()).toLowerCase();
  const health = await ok('GET', '/health');
  assert.equal(health.ok, true);

  // Sign-in (user + company admin)
  let u = await signIn(user);
  assert.equal(u.isAdmin, false);
  let adm = await signIn(company);
  assert.equal(adm.isAdmin, true);
  assert.equal((await api('GET', '/admin/overview', null, u.token)).status, 403);
  assert.equal((await api('GET', '/me')).status, 401);

  // 1. deposit: user transfers USDT to the company wallet; credited after confirmations
  const tx = await usdt.connect(user).transfer(await company.getAddress(), ethers.parseUnits('5000', 18));
  await tx.wait();
  await svc.watcher.poll();
  let deps = await ok('GET', '/me/deposits', null, u.token);
  assert.equal(deps.length, 1);
  assert.equal(deps[0].status, 'confirming');
  assert.equal((await ok('GET', '/me', null, u.token)).balance.available, '0');
  await mine(3);
  await svc.watcher.poll();
  await svc.watcher.poll(); // idempotent
  deps = await ok('GET', '/me/deposits', null, u.token);
  assert.equal(deps[0].status, 'credited');
  assert.equal((await ok('GET', '/me', null, u.token)).balance.available, '5000');
  check();

  // company seeds the vault from equity
  await ok('POST', '/admin/vault/seed', { amount: '50000' }, adm.token);

  // 3. 100x long, index drops, the engine liquidates
  const q = await ok('GET', '/quote?marketId=0&size=100');
  const notional = Number(q.fillPrice) * 100; // display math only; engine re-validates everything
  const margin = (Math.ceil((notional / 100 + Number(q.fee)) * 100) / 100 + 0.01).toFixed(2);
  const acc = (Number(q.fillPrice) * 1.001).toFixed(6);
  const p1 = await ok('POST', '/positions/open', { marketId: 0, size: '100', margin, acceptablePrice: acc }, u.token);
  assert.ok(Number(p1.leverage) > 98, p1.leverage);
  const bad = await api('POST', '/positions/open', { marketId: 0, size: '100', margin, acceptablePrice: acc }, u.token);
  assert.equal(bad.body.error, 'POSITION_EXISTS');
  const lowAcc = await api('POST', '/positions/open', { marketId: 1, size: '1', margin: '100', acceptablePrice: '1' }, u.token);
  assert.equal(lowAcc.body.error, 'SLIPPAGE');
  const nyc = (await ok('GET', '/markets'))[0];
  await ok('POST', '/admin/index', { symbol: 'NYC', value: (Number(nyc.indexPrice) * 0.95).toFixed(2), source: 'e2e' }, adm.token);
  offset += 7 * DAY;
  u = await signIn(user);
  adm = await signIn(company);
  let positions;
  for (let i = 0; i < 50; i++) {
    positions = await ok('GET', '/me/positions', null, u.token);
    if (positions.length === 0) break;
    await sleep(100);
  }
  assert.equal(positions.length, 0, 'background loop liquidated the position');
  const hist = await ok('GET', '/me/history', null, u.token);
  assert.equal(hist.trades[0].kind, 'liquidation');
  check();

  // 4. open and close another position in profit
  const q2 = await ok('GET', '/quote?marketId=1&size=10');
  await ok('POST', '/positions/open', { marketId: 1, size: '10', margin: '1000', acceptablePrice: (Number(q2.fillPrice) * 1.01).toFixed(6) }, u.token);
  const la = (await ok('GET', '/markets'))[1];
  await ok('POST', '/admin/index', { symbol: 'LA', value: (Number(la.indexPrice) * 1.05).toFixed(2) }, adm.token);
  offset += 7 * DAY + 10;
  // sessions expire after 7 days: the old token must be refused, then sign in again
  assert.equal((await api('GET', '/me', null, u.token)).status, 401);
  u = await signIn(user);
  adm = await signIn(company);
  const closed = await ok('POST', '/positions/close', { marketId: 1, acceptablePrice: '1' }, u.token);
  assert.ok(Number(closed.realizedPnl) > 0, closed.realizedPnl);
  check();

  // 5. vault deposit
  const vd = await ok('POST', '/vault/deposit', { amount: '1000' }, u.token);
  assert.ok(Number(vd.shares) > 0);
  const me5 = await ok('GET', '/me', null, u.token);
  assert.ok(Number(me5.balance.vaultValue) > 999);

  // 6. withdrawal: company pays on chain; engine auto-marks it paid
  const w = await ok('POST', '/withdrawals', { amount: '500' }, u.token);
  assert.equal(w.to, userAddr);
  assert.equal(w.status, 'pending');
  assert.equal((await api('POST', '/withdrawals', { amount: '5' }, u.token)).body.error, 'MIN_AMOUNT');
  assert.equal((await api('POST', '/withdrawals', { amount: '1000000' }, u.token)).body.error, 'INSUFFICIENT_BALANCE');
  await (await usdt.connect(company).transfer(userAddr, ethers.parseUnits('500', 18))).wait();
  await mine(3);
  await svc.watcher.poll();
  let ws = await ok('GET', '/me/withdrawals', null, u.token);
  assert.equal(ws.find((x) => x.id === w.id).status, 'paid');
  check();

  // admin /paid verifies the receipt: wrong amount rejected, right one accepted
  const w2 = await ok('POST', '/withdrawals', { amount: '300' }, u.token);
  const short = await (await usdt.connect(company).transfer(userAddr, ethers.parseUnits('250', 18))).wait();
  const rej = await api('POST', `/admin/withdrawals/${w2.id}/paid`, { txHash: short.hash }, adm.token);
  assert.equal(rej.body.error, 'TX_MISMATCH');
  const right = await (await usdt.connect(company).transfer(userAddr, ethers.parseUnits('300', 18))).wait();
  const paid = await ok('POST', `/admin/withdrawals/${w2.id}/paid`, { txHash: right.hash }, adm.token);
  assert.equal(paid.status, 'paid');
  await mine(3);
  await svc.watcher.poll(); // later scan must not double-use the log
  check();

  // 7. admin rejects another withdrawal; funds return
  const availBefore = (await ok('GET', '/me', null, u.token)).balance.available;
  const w3 = await ok('POST', '/withdrawals', { amount: '200' }, u.token);
  assert.equal((await ok('GET', '/me', null, u.token)).balance.pendingWithdrawals, '200');
  const pend = await ok('GET', '/admin/withdrawals?status=pending', null, adm.token);
  assert.ok(pend.some((x) => x.id === w3.id));
  const r3 = await ok('POST', `/admin/withdrawals/${w3.id}/reject`, { reason: 'e2e' }, adm.token);
  assert.equal(r3.status, 'rejected');
  assert.equal((await ok('GET', '/me', null, u.token)).balance.available, availBefore);
  check();

  // 8. overview: surplus = on-chain balance - liabilities
  const ov = await ok('GET', '/admin/overview', null, adm.token);
  // on chain: 100000 + 5000 - 500 - 250 - 300 = 103950; liabilities: deposits 5000 - paid 800 + seed 50000 = 54200
  assert.equal(ov.companyUsdtOnChain, '103950');
  const total = Number(ov.liabilities.users) + Number(ov.liabilities.vault) + Number(ov.liabilities.protocolFees);
  assert.ok(Math.abs(total - 54200) < 1e-6, String(total));
  assert.equal(ov.surplus, '49750');
  assert.equal(ov.pendingWithdrawals.count, 0);
  assert.equal(ov.ledgerOk, true);
  console.log(`# overview: ${JSON.stringify(ov)}`);
  check();
});
