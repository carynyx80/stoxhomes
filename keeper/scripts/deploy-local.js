// Deploys MockUSDT + HouseIndexOracle + HousePerpExchange to a local node using the compiled
// Hardhat artifacts (mirrors contracts/scripts/deploy.js) and writes keeper/deployments.local.json.
// Does NOT touch web/src/contracts. Usage: RPC_URL=http://127.0.0.1:8546 node scripts/deploy-local.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ethers } from "ethers";
import { loadAbi } from "../src/contracts.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ART = path.resolve(here, "../../contracts/artifacts/contracts");
const E = (n) => ethers.parseEther(String(n));
export const MARKETS = [
  { symbol: "NYC", name: "New York", index: 330 },
  { symbol: "LA", name: "Los Angeles", index: 440 },
  { symbol: "MIA", name: "Miami", index: 430 },
  { symbol: "SF", name: "San Francisco", index: 350 },
  { symbol: "LDN", name: "London", index: 290 },
];

async function deploy(name, signer, ...args) {
  const { abi, bytecode } = loadAbi(name, ART);
  const c = await new ethers.ContractFactory(abi, bytecode, signer).deploy(...args);
  await c.waitForDeployment();
  return c;
}

export async function deployLocal(rpcUrl = "http://127.0.0.1:8546", { out } = {}) {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const deployer = new ethers.NonceManager(await provider.getSigner(0));
  const deployerAddr = await deployer.getAddress();
  const usdt = await deploy("MockUSDT", deployer);
  const oracle = await deploy("HouseIndexOracle", deployer, deployerAddr);
  const exchange = await deploy("HousePerpExchange", deployer, deployerAddr, await usdt.getAddress(), await oracle.getAddress());
  for (const m of MARKETS) {
    const id = ethers.encodeBytes32String(m.symbol);
    await (await oracle.createFeed(id, E(m.index))).wait();
    await (await exchange.addMarket(`${m.symbol}-USD`, id, E(1_000_000), E(0.001), 30_000)).wait();
  }
  await (await usdt.mint(deployerAddr, E(2_000_000))).wait();
  await (await usdt.approve(await exchange.getAddress(), ethers.MaxUint256)).wait();
  await (await exchange.deposit(E(1_000_000), 0)).wait();
  const chainId = Number((await provider.getNetwork()).chainId);
  const d = { usdt: await usdt.getAddress(), mockUsdt: true, oracle: await oracle.getAddress(), exchange: await exchange.getAddress(), markets: MARKETS };
  if (out) fs.writeFileSync(out, JSON.stringify({ [chainId]: d }, null, 2));
  provider.destroy();
  return { chainId, ...d };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = path.resolve(here, "../deployments.local.json");
  const d = await deployLocal(process.env.RPC_URL || "http://127.0.0.1:8546", { out });
  console.log(JSON.stringify(d, null, 2));
  console.log(`Wrote ${out}  (use DEPLOYMENTS_FILE=deployments.local.json)`);
}
