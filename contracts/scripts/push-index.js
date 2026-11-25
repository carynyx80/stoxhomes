// Keeper script: push a newly published monthly index value.
//   SYMBOL=NYC PRICE=333.2 npx hardhat run scripts/push-index.js --network bscTestnet
const { ethers, network } = require("hardhat");
const deployments = require("../../web/src/contracts/deployments.json");

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const d = deployments[chainId];
  if (!d) throw new Error(`No deployment for chain ${chainId} (${network.name})`);
  const oracle = await ethers.getContractAt("HouseIndexOracle", d.oracle);
  const id = ethers.encodeBytes32String(process.env.SYMBOL);
  const tx = await oracle.pushIndex(id, ethers.parseEther(process.env.PRICE));
  await tx.wait();
  console.log(`Pushed ${process.env.SYMBOL} = ${process.env.PRICE} (tx ${tx.hash})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
