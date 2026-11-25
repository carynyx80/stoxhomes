// Deploys MockUSDT + HouseIndexOracle + HousePerpExchange to a local node using ethers and the
// compiled Hardhat artifacts in ../contracts/artifacts. Does not touch web/src/contracts.
//   RPC_URL=http://127.0.0.1:8547 node scripts/deploy-local.js [out.json]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ContractFactory, JsonRpcProvider, Wallet, HDNodeWallet, Mnemonic, NonceManager, encodeBytes32String, parseEther } from "ethers";

const here = path.dirname(fileURLToPath(import.meta.url));
const ART = path.resolve(here, "..", "..", "contracts", "artifacts", "contracts");
export const MNEMONIC = "test test test test test test test test test test test junk";
export const MARKETS = [
  { symbol: "NYC", name: "New York", index: 330 },
  { symbol: "LA", name: "Los Angeles", index: 440 },
  { symbol: "MIA", name: "Miami", index: 430 },
  { symbol: "SF", name: "San Francisco", index: 350 },
  { symbol: "LDN", name: "London", index: 290 },
];

export function artifact(name) {
  const sub = name === "MockUSDT" ? "mocks/MockUSDT.sol" : `${name}.sol`;
  return JSON.parse(fs.readFileSync(path.join(ART, sub, `${name}.json`), "utf8"));
}

export function wallets(provider, n = 10) {
  const m = Mnemonic.fromPhrase(MNEMONIC);
  return Array.from({ length: n }, (_, i) =>
    new NonceManager(HDNodeWallet.fromMnemonic(m, `m/44'/60'/0'/0/${i}`).connect(provider))
  );
}

export async function deploy(rpcUrl, { seedPool = 0 } = {}) {
  const provider = new JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });
  provider.pollingInterval = 200;
  const [deployer] = wallets(provider, 1);
  const me = await deployer.getAddress();
  const fac = (n) => { const a = artifact(n); return new ContractFactory(a.abi, a.bytecode, deployer); };
  const startBlock = await provider.getBlockNumber();
  const usdt = await (await fac("MockUSDT").deploy()).waitForDeployment();
  const oracle = await (await fac("HouseIndexOracle").deploy(me)).waitForDeployment();
  const exchange = await (await fac("HousePerpExchange").deploy(me, await usdt.getAddress(), await oracle.getAddress())).waitForDeployment();
  for (const m of MARKETS) {
    const id = encodeBytes32String(m.symbol);
    await (await oracle.createFeed(id, parseEther(String(m.index)))).wait();
    await (await exchange.addMarket(`${m.symbol}-USD`, id, parseEther("1000000"), parseEther("0.001"), 30_000)).wait();
  }
  if (seedPool > 0) {
    await (await usdt.mint(me, parseEther(String(seedPool)))).wait();
    await (await usdt.approve(await exchange.getAddress(), parseEther(String(seedPool)))).wait();
    await (await exchange.deposit(parseEther(String(seedPool)), 0)).wait();
  }
  const out = {
    chainId: Number((await provider.getNetwork()).chainId), startBlock: startBlock + 1,
    usdt: await usdt.getAddress(), oracle: await oracle.getAddress(), exchange: await exchange.getAddress(), markets: MARKETS,
  };
  provider.destroy();
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = await deploy(process.env.RPC_URL || "http://127.0.0.1:8547", { seedPool: Number(process.env.SEED_POOL || 1_000_000) });
  console.log(JSON.stringify(out, null, 2));
  if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 2));
}
