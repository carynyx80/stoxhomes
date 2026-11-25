import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");
export const REPO = path.resolve(ROOT, "..");

// Minimal .env loader (no dependency). Existing env vars win.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    const v = m[2].replace(/^["']|["']$/g, "");
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

export function loadConfig(overrides = {}) {
  loadDotEnv(path.join(ROOT, ".env"));
  const env = { ...process.env, ...overrides };
  const abiDir = path.resolve(env.ABI_DIR || path.join(REPO, "web", "src", "contracts"));
  const chainId = Number(env.CHAIN_ID || 31337);
  let dep = {};
  try {
    const all = JSON.parse(fs.readFileSync(path.join(abiDir, "deployments.json"), "utf8"));
    dep = all[String(chainId)] || {};
  } catch {}
  const origins = (env.CORS_ORIGINS || "http://localhost:5173,http://127.0.0.1:5173")
    .split(",").map((s) => s.trim()).filter(Boolean);
  return {
    rpcUrl: env.RPC_URL || "http://127.0.0.1:8545",
    chainId,
    exchange: env.EXCHANGE_ADDRESS || dep.exchange,
    oracle: env.ORACLE_ADDRESS || dep.oracle,
    collateral: env.COLLATERAL_ADDRESS || dep.usdt,
    marketsMeta: dep.markets || [],
    startBlock: Number(env.START_BLOCK || 0),
    pollMs: Number(env.POLL_MS || 3000),
    reorgDepth: Number(env.REORG_DEPTH || 10),
    logChunk: Number(env.LOG_CHUNK || 2000),
    snapshotEvery: Number(env.SNAPSHOT_EVERY || 20),
    dbPath: env.DB_PATH || path.join(ROOT, "data", "housedex.db"),
    port: Number(env.PORT ?? 4000),
    host: env.HOST || "0.0.0.0",
    corsOrigins: origins,
    abiDir,
  };
}
