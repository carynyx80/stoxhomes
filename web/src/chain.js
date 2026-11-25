import { ethers } from "ethers";
import deployments from "./contracts/deployments.json";
import exchangeAbi from "./contracts/HousePerpExchange.json";
import usdtAbi from "./contracts/MockUSDT.json";

export const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID || 31337);

const CHAINS = {
  31337: { name: "Hardhat local", rpc: "http://127.0.0.1:8545", explorer: null, currency: "ETH" },
  97: {
    name: "BNB Smart Chain Testnet",
    rpc: "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
    explorer: "https://testnet.bscscan.com",
    currency: "tBNB",
  },
  56: { name: "BNB Smart Chain", rpc: "https://bsc-dataseed.bnbchain.org", explorer: "https://bscscan.com", currency: "BNB" },
};

// Any other chain id is a custom/demo chain: name from VITE_CHAIN_NAME, RPC taken as given.
const CUSTOM = {
  name: import.meta.env.VITE_CHAIN_NAME || "Stoxhome Demo",
  rpc: import.meta.env.VITE_RPC_URL,
  explorer: import.meta.env.VITE_EXPLORER_URL || null,
  currency: "ETH",
};
export const chain = { id: CHAIN_ID, ...(CHAINS[CHAIN_ID] || CUSTOM), rpc: import.meta.env.VITE_RPC_URL || CHAINS[CHAIN_ID]?.rpc };
export const deployment = deployments[CHAIN_ID];

export const readProvider = new ethers.JsonRpcProvider(chain.rpc, CHAIN_ID, { staticNetwork: true });

export function contracts(runner) {
  return {
    exchange: new ethers.Contract(deployment.exchange, exchangeAbi, runner),
    usdt: new ethers.Contract(deployment.usdt, usdtAbi, runner),
  };
}

export async function connectWallet() {
  if (!window.ethereum) throw new Error("No wallet found. Install MetaMask or another EVM wallet.");
  const provider = new ethers.BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);
  const hex = "0x" + CHAIN_ID.toString(16);
  try {
    await provider.send("wallet_switchEthereumChain", [{ chainId: hex }]);
  } catch (e) {
    if (e?.error?.code === 4902 || e?.code === 4902) {
      await provider.send("wallet_addEthereumChain", [
        {
          chainId: hex,
          chainName: chain.name,
          rpcUrls: [chain.rpc],
          nativeCurrency: { name: chain.currency, symbol: chain.currency, decimals: 18 },
          blockExplorerUrls: chain.explorer ? [chain.explorer] : [],
        },
      ]);
    } else throw e;
  }
  const fresh = new ethers.BrowserProvider(window.ethereum);
  return fresh.getSigner();
}

export const fmt = (v, d = 2) =>
  v === undefined || v === null
    ? "-"
    : Number(ethers.formatEther(v)).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });

export const pct = (wad, d = 4) => (Number(ethers.formatEther(wad)) * 100).toFixed(d) + "%";

export function friendlyError(e) {
  const msg = e?.shortMessage || e?.reason || e?.message || String(e);
  const m = msg.match(/custom error '(\w+)/) || msg.match(/reverted with custom error '(\w+)/);
  const hints = {
    LeverageTooHigh: "Leverage above 100x. Add margin or reduce size.",
    WouldBeLiquidatable: "That position would be instantly liquidatable. Lower leverage.",
    SkewCapExceeded: "The pool can't take that much one-sided exposure right now.",
    StaleOracle: "The index hasn't been updated recently, so opening is paused.",
    SlippageExceeded: "Price moved past your slippage limit. Try again.",
    InsufficientLiquidity: "Not enough free liquidity in the pool.",
    PositionExists: "You already have a position in this market. Close it first.",
  };
  if (m && hints[m[1]]) return hints[m[1]];
  if (e?.data && e?.revert?.name && hints[e.revert.name]) return hints[e.revert.name];
  return msg.length > 160 ? msg.slice(0, 160) + "…" : msg;
}
