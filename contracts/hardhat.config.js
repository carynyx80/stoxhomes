require("@nomicfoundation/hardhat-chai-matchers");
require("@nomicfoundation/hardhat-ethers");

const PK = process.env.DEPLOYER_PRIVATE_KEY;

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true },
  },
  networks: {
    hardhat: { chainId: Number(process.env.HARDHAT_CHAIN_ID || 31337) },
    localhost: {
      url: process.env.LOCALHOST_RPC || "http://127.0.0.1:8545",
      chainId: Number(process.env.HARDHAT_CHAIN_ID || 31337),
      ...(PK ? { accounts: [PK] } : {}),
    },
    bscTestnet: {
      url: process.env.BSC_TESTNET_RPC || "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
      chainId: 97,
      accounts: PK ? [PK] : [],
    },
    bsc: {
      url: process.env.BSC_RPC || "https://bsc-dataseed.bnbchain.org",
      chainId: 56,
      accounts: PK ? [PK] : [],
    },
  },
};

// Use the npm `solc` (solcjs) build when the binaries host is unreachable (e.g. sandboxed CI).
// Set USE_NATIVE_SOLC=1 to let Hardhat download the native compiler as usual.
if (!process.env.USE_NATIVE_SOLC) {
  const { subtask } = require("hardhat/config");
  const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");
  subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
    if (args.solcVersion === "0.8.24") {
      return {
        compilerPath: require.resolve("solc/soljson.js"),
        isSolcJs: true,
        version: args.solcVersion,
        longVersion: require("solc/package.json").version,
      };
    }
    return runSuper();
  });
}
