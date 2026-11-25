// Env-driven configuration. The private key is held in a closure and never logged.
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addSecret } from "./log.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const KEEPER_ROOT = path.resolve(here, "..");
export const REPO_ROOT = path.resolve(KEEPER_ROOT, "..");

const bool = (v, d = false) => (v === undefined || v === "" ? d : /^(1|true|yes|on)$/i.test(v));
const num = (v, d) => (v === undefined || v === "" ? d : Number(v));

export function loadConfig(env = process.env) {
  const pk = env.KEEPER_PRIVATE_KEY || "";
  addSecret(pk);
  const cfg = {
    rpcUrl: env.RPC_URL || "http://127.0.0.1:8545",
    chainId: num(env.CHAIN_ID, 31337),
    pollMs: num(env.POLL_MS, 3000),
    startBlock: num(env.START_BLOCK, 0),
    dryRun: bool(env.DRY_RUN, false),
    logChunk: num(env.LOG_CHUNK, 5000),
    // liquidator
    concurrency: Math.max(1, num(env.LIQ_CONCURRENCY, 4)),
    gasPriceGwei: env.GAS_PRICE_GWEI ? Number(env.GAS_PRICE_GWEI) : undefined,
    maxGasPriceGwei: env.MAX_GAS_PRICE_GWEI ? Number(env.MAX_GAS_PRICE_GWEI) : undefined,
    gasLimit: env.GAS_LIMIT ? BigInt(env.GAS_LIMIT) : undefined,
    // publisher
    priceSource: env.PRICE_SOURCE || "file", // file | http
    pricesFile: path.resolve(KEEPER_ROOT, env.PRICES_FILE || "data/index-prints.json"),
    priceHttpUrl: env.PRICE_HTTP_URL || "",
    publisherStateFile: path.resolve(KEEPER_ROOT, env.PUBLISHER_STATE_FILE || "data/.publisher-state.json"),
    releaseCalendarFile: path.resolve(KEEPER_ROOT, env.RELEASE_CALENDAR_FILE || "data/release-calendar.json"),
    publishEveryMs: num(env.PUBLISH_EVERY_MS, 60_000),
    // addresses / abis
    exchangeAddress: env.EXCHANGE_ADDRESS || "",
    oracleAddress: env.ORACLE_ADDRESS || "",
    deploymentsFile: path.resolve(KEEPER_ROOT, env.DEPLOYMENTS_FILE || "../web/src/contracts/deployments.json"),
    artifactsDir: path.resolve(KEEPER_ROOT, env.ARTIFACTS_DIR || "../contracts/artifacts/contracts"),
    healthPort: num(env.HEALTH_PORT, 4100),
  };
  Object.defineProperty(cfg, "privateKey", { value: pk, enumerable: false });
  cfg.toJSON = () => {
    const { toJSON, ...rest } = cfg;
    return { ...rest, privateKey: pk ? "<redacted>" : "<unset>" };
  };
  return cfg;
}
