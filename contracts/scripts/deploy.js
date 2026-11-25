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

// Company wallet: becomes owner of the oracle and exchange and receives protocol fees,
// unless OWNER_ADDRESS / FEE_RECIPIENT override it.
const COMPANY_ADDRESS = "0x106342ec570e207afda9fda63125d7a9071127f2";
// Tether USD (BEP-20, 18 decimals) on BNB Smart Chain mainnet.
const BSC_USDT = "0x55d398326f99059fF775485246999027B3197955";

async function main() {
  const [deployer] = await ethers.getSigners();
  const chainIdNow = Number((await ethers.provider.getNetwork()).chainId);
  const isMainnet = chainIdNow === 56;
  const owner = ethers.getAddress(process.env.OWNER_ADDRESS || COMPANY_ADDRESS);
  const feeRecipient = ethers.getAddress(process.env.FEE_RECIPIENT || owner);
  console.log(`Deploying on ${network.name} (chain ${chainIdNow}) from ${deployer.address}`);
  console.log(`  owner/fee recipient after deploy: ${owner} / ${feeRecipient}`);

  if (isMainnet) {
    // Real money: refuse unless every production input is explicit.
    if (process.env.CONFIRM_MAINNET !== "yes") throw new Error("Set CONFIRM_MAINNET=yes to deploy to BSC mainnet");
    if (!process.env.KEEPER_ADDRESS) throw new Error("KEEPER_ADDRESS (keeper bot wallet) is required on mainnet");
    if (!process.env.INITIAL_INDEX_FILE && !process.env.INITIAL_INDEX_JSON) {
      throw new Error("INITIAL_INDEX_FILE or INITIAL_INDEX_JSON is required on mainnet: real published index values");
    }
    process.env.COLLATERAL_ADDRESS = process.env.COLLATERAL_ADDRESS || BSC_USDT;
    // One deployment per deployer wallet: a re-run (e.g. a redeploy of a one-shot job) must not
    // create a second set of contracts and spend gas again.
    const nonce = await ethers.provider.getTransactionCount(deployer.address);
    if (nonce !== 0 && process.env.ALLOW_USED_DEPLOYER !== "yes") {
      throw new Error(`Deployer ${deployer.address} has already sent ${nonce} txs; use a fresh wallet (or ALLOW_USED_DEPLOYER=yes)`);
    }
    const bnb = await ethers.provider.getBalance(deployer.address);
    if (bnb < ethers.parseEther("0.01")) throw new Error(`Deployer needs BNB for gas (has ${ethers.formatEther(bnb)})`);
  }
  if (process.env.INITIAL_INDEX_FILE || process.env.INITIAL_INDEX_JSON) {
    // JSON object {"NYC": 331.2, ...} with the latest published value per market.
    const values = JSON.parse(
      process.env.INITIAL_INDEX_JSON || fs.readFileSync(path.resolve(process.env.INITIAL_INDEX_FILE), "utf8")
    );
    for (const m of MARKETS) {
      if (!(m.symbol in values)) throw new Error(`INITIAL_INDEX_FILE is missing ${m.symbol}`);
      m.index = Number(values[m.symbol]);
      if (!Number.isFinite(m.index) || m.index <= 0) throw new Error(`Invalid index value for ${m.symbol}`);
    }
  }
  const startBlock = await ethers.provider.getBlockNumber();

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

  // Protocol fee (10% of trading fees) goes to the company wallet; optional keeper bot.
  await (await exchange.setProtocolFee(feeRecipient, 1_000)).wait();
  console.log("  protocol fee recipient", feeRecipient);
  if (process.env.KEEPER_ADDRESS) {
    await (await oracle.setKeeper(process.env.KEEPER_ADDRESS, true)).wait();
    console.log("  keeper", process.env.KEEPER_ADDRESS);
  }

  // Local dev convenience: fund the deployer and seed the pool.
  if (!process.env.COLLATERAL_ADDRESS && (network.name === "localhost" || network.name === "hardhat")) {
    const usdt = await ethers.getContractAt("MockUSDT", usdtAddress);
    await (await usdt.mint(deployer.address, E(2_000_000))).wait();
    await (await usdt.approve(await exchange.getAddress(), ethers.MaxUint256)).wait();
    await (await exchange.deposit(E(1_000_000), 0)).wait();
    console.log("  seeded pool with 1,000,000 USDT");
  }

  // Hand admin control to the company wallet last (setup above needs the deployer as owner).
  // The deployer stays an oracle keeper only if it was the keeper bot; otherwise remove it.
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    const keeper = (process.env.KEEPER_ADDRESS || "").toLowerCase();
    if (keeper !== deployer.address.toLowerCase()) {
      await (await oracle.setKeeper(deployer.address, false)).wait();
    }
    await (await oracle.setKeeper(owner, true)).wait();
    await (await oracle.transferOwnership(owner)).wait();
    await (await exchange.transferOwnership(owner)).wait();
    console.log("  ownership transferred to", owner);
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
    owner,
    feeRecipient,
    startBlock,
    markets: MARKETS,
  };
  fs.writeFileSync(file, JSON.stringify(existing, null, 2));
  for (const name of ["MockUSDT", "HouseIndexOracle", "HousePerpExchange"]) {
    const { abi } = await artifacts.readArtifact(name);
    fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(abi, null, 2));
  }
  console.log(`Wrote ${file}`);
  // Machine-readable line so a remote deploy (e.g. a one-shot Railway job) can be copied back.
  console.log(`DEPLOYMENT_JSON ${JSON.stringify({ chainId, ...existing[chainId] })}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
