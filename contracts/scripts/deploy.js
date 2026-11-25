// Deploys MockUSDT (testnet/local only), HouseIndexOracle and HousePerpExchange,
// creates the city markets, and writes addresses + ABIs for the web app.
//   npx hardhat run scripts/deploy.js --network localhost
//   npx hardhat run scripts/deploy.js --network bscTestnet
const fs = require("fs");
const path = require("path");
const { ethers, network, artifacts } = require("hardhat");

const E = (n) => ethers.parseEther(String(n));

// Sample starting index levels (not live data). Replace with real published values
// from your index provider before launch.
const MARKETS = [
  { symbol: "NYC", name: "New York", index: 330 },
  { symbol: "LA", name: "Los Angeles", index: 440 },
  { symbol: "MIA", name: "Miami", index: 430 },
  { symbol: "SF", name: "San Francisco", index: 350 },
  { symbol: "LDN", name: "London", index: 290 },
];

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Deploying on ${network.name} from ${deployer.address}`);

  let usdtAddress = process.env.COLLATERAL_ADDRESS;
  if (!usdtAddress) {
    const usdt = await (await ethers.getContractFactory("MockUSDT")).deploy();
    await usdt.waitForDeployment();
    usdtAddress = await usdt.getAddress();
    console.log("MockUSDT", usdtAddress);
  }

  const oracle = await (await ethers.getContractFactory("HouseIndexOracle")).deploy(deployer.address);
  await oracle.waitForDeployment();
  const exchange = await (await ethers.getContractFactory("HousePerpExchange")).deploy(
    deployer.address,
    usdtAddress,
    await oracle.getAddress()
  );
  await exchange.waitForDeployment();
  console.log("HouseIndexOracle", await oracle.getAddress());
  console.log("HousePerpExchange", await exchange.getAddress());

  for (const m of MARKETS) {
    const id = ethers.encodeBytes32String(m.symbol);
    await (await oracle.createFeed(id, E(m.index))).wait();
    // skewScale 1M units, max funding 0.1%/day, |skew| capped at 3x pool value
    await (await exchange.addMarket(`${m.symbol}-USD`, id, E(1_000_000), E(0.001), 30_000)).wait();
    console.log(`  market ${m.symbol}-USD @ ${m.index}`);
  }

  // Local dev convenience: fund the deployer and seed the pool.
  if (!process.env.COLLATERAL_ADDRESS && (network.name === "localhost" || network.name === "hardhat")) {
    const usdt = await ethers.getContractAt("MockUSDT", usdtAddress);
    await (await usdt.mint(deployer.address, E(2_000_000))).wait();
    await (await usdt.approve(await exchange.getAddress(), ethers.MaxUint256)).wait();
    await (await exchange.deposit(E(1_000_000))).wait();
    console.log("  seeded pool with 1,000,000 USDT");
  }

  const out = path.join(__dirname, "..", "..", "web", "src", "contracts");
  fs.mkdirSync(out, { recursive: true });
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const file = path.join(out, "deployments.json");
  const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  existing[chainId] = {
    usdt: usdtAddress,
    mockUsdt: !process.env.COLLATERAL_ADDRESS,
    oracle: await oracle.getAddress(),
    exchange: await exchange.getAddress(),
    markets: MARKETS,
  };
  fs.writeFileSync(file, JSON.stringify(existing, null, 2));
  for (const name of ["MockUSDT", "HouseIndexOracle", "HousePerpExchange"]) {
    const { abi } = await artifacts.readArtifact(name);
    fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(abi, null, 2));
  }
  console.log(`Wrote ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
