import { parseUsdt } from './fixed.js';
import { MINTS, normSolAddress } from './solana.js';

function req(env, k) {
  const v = env[k];
  if (v === undefined || v === '') throw new Error(`Missing required env var ${k}`);
  return v;
}

export function loadConfig(env = process.env) {
  const chain = (env.CHAIN || 'solana').toLowerCase();
  if (chain === 'solana') return loadSolanaConfig(env);
  if (chain !== 'evm') throw new Error('CHAIN must be solana or evm');
  return loadEvmConfig(env);
}

function common(env) {
  const prod = env.NODE_ENV === 'production';
  const cfg = {
    prod,
    port: Number(env.PORT || 4000),
    dbPath: env.DB_PATH || (prod ? '/data/engine.db' : './engine.db'),
    pollMs: Number(env.POLL_MS || 5000),
    loopMs: Number(env.LOOP_MS || 2000),
    minDeposit: parseUsdt(env.MIN_DEPOSIT || '10', 'MIN_DEPOSIT'),
    minWithdraw: parseUsdt(env.MIN_WITHDRAW || '10', 'MIN_WITHDRAW'),
    allowedDomain: env.ALLOWED_DOMAIN || 'www.stoxhome.xyz',
    sessionSecret: env.SESSION_SECRET || '',
    corsOrigins: (env.CORS_ORIGINS || 'https://www.stoxhome.xyz,https://stoxhome.xyz').split(',').map((s) => s.trim()).filter(Boolean),
    rateLimitPerMin: Number(env.RATE_LIMIT_PER_MIN || 120),
    rateLimitAddrPerMin: Number(env.RATE_LIMIT_ADDR_PER_MIN || 60),
    trustProxy: env.TRUST_PROXY !== '0',
    watcherEnabled: env.WATCHER !== '0',
  };
  if (!cfg.sessionSecret || cfg.sessionSecret.length < 16) throw new Error('SESSION_SECRET is required (>= 16 chars)');
  return cfg;
}

const B58 = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

function loadSolanaConfig(env) {
  const cfg = {
    ...common(env),
    chain: 'solana',
    cluster: env.SOLANA_CLUSTER || 'mainnet-beta',
    chainId: env.SOLANA_CLUSTER || 'mainnet-beta',
    rpcUrls: (env.RPC_URL || 'https://solana-rpc.publicnode.com,https://api.mainnet-beta.solana.com').split(',').map((s) => s.trim()).filter(Boolean),
    companyAddress: env.COMPANY_ADDRESS || '8oYH186qjPyYwnS58fh1NH1m5iFFJe8wPnBKVp3NGtgx',
    tokens: [
      { symbol: 'USDC', mint: env.USDC_MINT || MINTS.USDC, decimals: 6 },
      { symbol: 'USDT', mint: env.USDT_MINT || MINTS.USDT, decimals: 6 },
    ],
    startSignature: env.START_SIGNATURE || null,
    startSignatures: { USDC: env.START_SIGNATURE_USDC || null, USDT: env.START_SIGNATURE_USDT || null },
    maxTxPerPoll: Number(env.MAX_TX_PER_POLL || 200),
    blockhashCacheMs: Number(env.BLOCKHASH_CACHE_MS || 5000),
    pollMs: Number(env.POLL_MS || 10000),
  };
  cfg.companyAddress = normSolAddress(cfg.companyAddress, 'COMPANY_ADDRESS');
  for (const t of cfg.tokens) normSolAddress(t.mint, `${t.symbol}_MINT`);
  for (const s of [cfg.startSignature, cfg.startSignatures.USDC, cfg.startSignatures.USDT]) {
    if (s && !B58.test(s)) throw new Error('START_SIGNATURE must be a base58 transaction signature');
  }
  if (!cfg.rpcUrls.length) throw new Error('RPC_URL required');
  return cfg;
}

function loadEvmConfig(env) {
  const prod = env.NODE_ENV === 'production';
  const cfg = {
    chain: 'evm',
    prod,
    port: Number(env.PORT || 4000),
    dbPath: env.DB_PATH || (prod ? '/data/engine.db' : './engine.db'),
    rpcUrls: (env.RPC_URL || 'https://bsc-dataseed.bnbchain.org').split(',').map((s) => s.trim()).filter(Boolean),
    chainId: Number(env.CHAIN_ID || 56),
    usdtAddress: (env.USDT_ADDRESS || '0x55d398326f99059fF775485246999027B3197955').toLowerCase(),
    usdtDecimals: Number(env.USDT_DECIMALS || 18),
    companyAddress: (env.COMPANY_ADDRESS || '0x106342ec570e207afda9fda63125d7a9071127f2').toLowerCase(),
    startBlock: env.START_BLOCK !== undefined && env.START_BLOCK !== '' ? Number(env.START_BLOCK) : null,
    confirmations: Number(env.CONFIRMATIONS || 15),
    logChunk: Number(env.LOG_CHUNK || 2000),
    pollMs: Number(env.POLL_MS || 5000),
    loopMs: Number(env.LOOP_MS || 2000),
    minDeposit: parseUsdt(env.MIN_DEPOSIT || '10', 'MIN_DEPOSIT'),
    minWithdraw: parseUsdt(env.MIN_WITHDRAW || '10', 'MIN_WITHDRAW'),
    allowedDomain: env.ALLOWED_DOMAIN || 'www.stoxhome.xyz',
    sessionSecret: env.SESSION_SECRET || '',
    corsOrigins: (env.CORS_ORIGINS || 'https://www.stoxhome.xyz,https://stoxhome.xyz').split(',').map((s) => s.trim()).filter(Boolean),
    rateLimitPerMin: Number(env.RATE_LIMIT_PER_MIN || 120),
    rateLimitAddrPerMin: Number(env.RATE_LIMIT_ADDR_PER_MIN || 60),
    trustProxy: env.TRUST_PROXY !== '0',
    watcherEnabled: env.WATCHER !== '0',
  };
  if (!cfg.sessionSecret || cfg.sessionSecret.length < 16) throw new Error('SESSION_SECRET is required (>= 16 chars)');
  if (prod && cfg.startBlock === null) throw new Error('START_BLOCK is required in production');
  if (cfg.startBlock !== null && (!Number.isInteger(cfg.startBlock) || cfg.startBlock < 0)) throw new Error('START_BLOCK must be a non-negative integer');
  if (!/^0x[0-9a-f]{40}$/.test(cfg.companyAddress)) throw new Error('COMPANY_ADDRESS invalid');
  if (!/^0x[0-9a-f]{40}$/.test(cfg.usdtAddress)) throw new Error('USDT_ADDRESS invalid');
  if (!(cfg.confirmations >= 1)) throw new Error('CONFIRMATIONS must be >= 1');
  if (!(cfg.logChunk >= 1)) throw new Error('LOG_CHUNK must be >= 1');
  req({ x: cfg.rpcUrls[0] }, 'x');
  return cfg;
}
