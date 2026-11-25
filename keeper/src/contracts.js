// Loads ABIs at runtime (Hardhat artifacts first, web ABI copies as fallback), so new
// functions/events added to the contracts are picked up without changing the keeper.
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import { REPO_ROOT } from "./config.js";

export function loadAbi(name, artifactsDir) {
  const candidates = [
    path.join(artifactsDir, `${name}.sol`, `${name}.json`),
    path.join(artifactsDir, "mocks", `${name}.sol`, `${name}.json`),
    path.join(REPO_ROOT, "web", "src", "contracts", `${name}.json`),
  ];
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    return Array.isArray(j) ? { abi: j } : { abi: j.abi, bytecode: j.bytecode };
  }
  throw new Error(`ABI for ${name} not found (looked in ${candidates.join(", ")})`);
}

export function resolveAddresses(cfg) {
  let exchange = cfg.exchangeAddress, oracle = cfg.oracleAddress;
  if ((!exchange || !oracle) && fs.existsSync(cfg.deploymentsFile)) {
    const d = JSON.parse(fs.readFileSync(cfg.deploymentsFile, "utf8"))[String(cfg.chainId)];
    if (d) { exchange ||= d.exchange; oracle ||= d.oracle; }
  }
  if (!exchange) throw new Error("EXCHANGE_ADDRESS not set and not found in deployments file");
  return { exchange, oracle };
}

export async function connect(cfg) {
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl, cfg.chainId, { staticNetwork: true });
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== cfg.chainId) throw new Error(`RPC chainId ${net.chainId} != CHAIN_ID ${cfg.chainId}`);
  let signer = null;
  if (cfg.privateKey) signer = new ethers.NonceManager(new ethers.Wallet(cfg.privateKey, provider));
  const addrs = resolveAddresses(cfg);
  const exAbi = loadAbi("HousePerpExchange", cfg.artifactsDir).abi;
  const exchange = new ethers.Contract(addrs.exchange, exAbi, signer ?? provider);
  let oracleAddr = addrs.oracle;
  if (!oracleAddr) oracleAddr = await exchange.oracle();
  const oracle = new ethers.Contract(oracleAddr, loadAbi("HouseIndexOracle", cfg.artifactsDir).abi, signer ?? provider);
  return { provider, signer, exchange, oracle, keeperAddress: signer ? await signer.getAddress() : null };
}

export function txOverrides(cfg) {
  const o = {};
  if (cfg.gasPriceGwei !== undefined) o.gasPrice = ethers.parseUnits(String(cfg.gasPriceGwei), "gwei");
  if (cfg.gasLimit !== undefined) o.gasLimit = cfg.gasLimit;
  return o;
}

/** Best-effort custom error name from an ethers error. */
export function errorName(err, ...ifaces) {
  if (err?.revert?.name) return err.revert.name;
  const data = err?.data ?? err?.info?.error?.data ?? err?.error?.data;
  for (const i of ifaces) {
    try { const p = i.parseError(typeof data === "string" ? data : data?.data); if (p) return p.name; } catch {}
  }
  return err?.shortMessage || err?.reason || err?.message || String(err);
}

export async function checkGasCap(cfg, provider) {
  if (cfg.maxGasPriceGwei === undefined) return true;
  const fee = await provider.getFeeData();
  const gp = fee.gasPrice ?? 0n;
  return gp <= ethers.parseUnits(String(cfg.maxGasPriceGwei), "gwei");
}
