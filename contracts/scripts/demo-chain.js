// Public demo chain for HouseDEX (used on Railway).
//
// Runs a private Hardhat node on 127.0.0.1:8545, deploys the contracts from DEPLOYER_PRIVATE_KEY
// (deterministic addresses for a given key on a fresh chain), then exposes a filtered JSON-RPC
// gateway on $PORT:
//   - only read methods + eth_sendRawTransaction are forwarded (no unlocked accounts, no
//     hardhat_* / evm_* methods), so nobody can impersonate accounts or time-travel the chain;
//   - POST /faucet {address} sends test gas + mints test USDT (rate-limited per address and IP);
//   - GET /deployments returns the deployed addresses; GET /health for Railway.
//
// The chain is in-memory: a restart resets it and redeploys to the same addresses.
// Env: PORT, DEPLOYER_PRIVATE_KEY (required), DEMO_CHAIN_ID (default 31338),
//      FAUCET_ETH (default 0.5), FAUCET_USDT (default 100000), FAUCET_COOLDOWN_MIN (default 60)
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { ethers } = require("ethers");

const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.PORT || 8080);
const NODE_PORT = Number(process.env.NODE_PORT || 8545);
const NODE_RPC = `http://127.0.0.1:${NODE_PORT}`;
const CHAIN_ID = Number(process.env.DEMO_CHAIN_ID || 31338);
const DEPLOYER_PK = process.env.DEPLOYER_PRIVATE_KEY;
const FAUCET_ETH = process.env.FAUCET_ETH || "0.5";
const FAUCET_USDT = process.env.FAUCET_USDT || "100000";
const COOLDOWN_MS = Number(process.env.FAUCET_COOLDOWN_MIN || 60) * 60_000;
// Hardhat's well-known dev account #1 funds the faucet. It holds no protocol privileges.
const FAUNDER_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

if (!DEPLOYER_PK) {
  console.error("DEPLOYER_PRIVATE_KEY is required");
  process.exit(1);
}

const ALLOWED = new Set([
  "eth_chainId", "net_version", "net_listening", "web3_clientVersion", "eth_syncing",
  "eth_blockNumber", "eth_call", "eth_estimateGas", "eth_gasPrice", "eth_feeHistory",
  "eth_maxPriorityFeePerGas", "eth_getBalance", "eth_getCode", "eth_getStorageAt",
  "eth_getTransactionCount", "eth_getTransactionByHash", "eth_getTransactionReceipt",
  "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getLogs", "eth_sendRawTransaction",
  "eth_getBlockTransactionCountByNumber", "eth_getBlockTransactionCountByHash", "eth_accounts",
]);

let deployments = null;
let ready = false;
const lastDrip = new Map();

function run(cmd, args, env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...env } });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`))));
  });
}

async function waitForNode() {
  const provider = new ethers.JsonRpcProvider(NODE_RPC, CHAIN_ID, { staticNetwork: true });
  for (let i = 0; i < 120; i++) {
    try {
      await provider.getBlockNumber();
      return provider;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("hardhat node did not start");
}

async function boot() {
  const node = spawn("npx", ["hardhat", "node", "--hostname", "127.0.0.1", "--port", String(NODE_PORT)], {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, HARDHAT_CHAIN_ID: String(CHAIN_ID) },
  });
  node.on("exit", (code) => {
    console.error(`hardhat node exited (${code}); exiting so Railway restarts the service`);
    process.exit(1);
  });

  const provider = await waitForNode();
  const funder = new ethers.Wallet(FAUNDER_PK, provider);
  const deployer = new ethers.Wallet(DEPLOYER_PK, provider);
  // Fund the deployer from a dev account so the deployer's own nonce stays at 0 (deterministic addresses).
  if ((await provider.getBalance(deployer.address)) < ethers.parseEther("100")) {
    await (await funder.sendTransaction({ to: deployer.address, value: ethers.parseEther("1000") })).wait();
  }
  await run("npx", ["hardhat", "run", "scripts/deploy.js", "--network", "localhost"], {
    HARDHAT_CHAIN_ID: String(CHAIN_ID),
    LOCALHOST_RPC: NODE_RPC,
  });
  const file = path.join(ROOT, "..", "web", "src", "contracts", "deployments.json");
  deployments = JSON.parse(fs.readFileSync(file, "utf8"))[CHAIN_ID];
  ready = true;
  console.log(`demo chain ${CHAIN_ID} ready; exchange ${deployments.exchange}; gateway on :${PORT}`);
}

async function forward(body) {
  const r = await fetch(NODE_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}

async function handleRpc(msg) {
  if (!msg || typeof msg.method !== "string") {
    return { jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32600, message: "invalid request" } };
  }
  if (msg.method === "eth_accounts") return { jsonrpc: "2.0", id: msg.id, result: [] };
  if (!ALLOWED.has(msg.method)) {
    return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method ${msg.method} not allowed on the demo gateway` } };
  }
  return forward(msg);
}

async function faucet(address, ip) {
  if (!ethers.isAddress(address)) throw Object.assign(new Error("invalid address"), { status: 400 });
  const key = address.toLowerCase();
  const now = Date.now();
  for (const k of [key, ip]) {
    if (lastDrip.has(k) && now - lastDrip.get(k) < COOLDOWN_MS) {
      const mins = Math.ceil((COOLDOWN_MS - (now - lastDrip.get(k))) / 60_000);
      throw Object.assign(new Error(`faucet cooldown: try again in ${mins} min`), { status: 429 });
    }
  }
  lastDrip.set(key, now);
  lastDrip.set(ip, now);
  const provider = new ethers.JsonRpcProvider(NODE_RPC, CHAIN_ID, { staticNetwork: true });
  const funder = new ethers.NonceManager(new ethers.Wallet(FAUNDER_PK, provider));
  const usdt = new ethers.Contract(deployments.usdt, ["function mint(address,uint256)"], funder);
  const gasTx = await funder.sendTransaction({ to: address, value: ethers.parseEther(FAUCET_ETH) });
  const mintTx = await usdt.mint(address, ethers.parseEther(FAUCET_USDT));
  await Promise.all([gasTx.wait(), mintTx.wait()]);
  return { gas: FAUCET_ETH, usdt: FAUCET_USDT, txs: [gasTx.hash, mintTx.hash] };
}

const server = http.createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  const send = (status, obj) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  const url = new URL(req.url, "http://x");
  if (req.method === "GET" && url.pathname === "/health") return send(ready ? 200 : 503, { ok: ready, chainId: CHAIN_ID });
  if (req.method === "GET" && url.pathname === "/deployments") return send(ready ? 200 : 503, { chainId: CHAIN_ID, ...deployments });
  if (req.method !== "POST") return send(404, { error: "not found" });
  if (!ready) return send(503, { error: "chain is starting" });

  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) return send(413, { error: "too large" });
  }
  let body;
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    return send(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
  }
  try {
    if (url.pathname === "/faucet") {
      const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
      return send(200, await faucet(body.address, ip));
    }
    if (Array.isArray(body)) {
      if (body.length > 50) return send(400, { error: "batch too large" });
      return send(200, await Promise.all(body.map(handleRpc)));
    }
    return send(200, await handleRpc(body));
  } catch (e) {
    return send(e.status || 500, { error: e.message });
  }
});

server.listen(PORT, "0.0.0.0", () => console.log(`gateway listening on :${PORT} (starting chain...)`));
boot().catch((e) => {
  console.error(e);
  process.exit(1);
});
