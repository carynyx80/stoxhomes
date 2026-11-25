import { parseUsdt } from './fixed.js';

function req(env, k) {
  const v = env[k];
  if (v === undefined || v === '') throw new Error(`Missing required env var ${k}`);
  return v;
}

export function loadConfig(env = process.env) {
  const prod = env.NODE_ENV === 'production';
  const cfg = {
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
