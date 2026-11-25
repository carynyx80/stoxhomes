import fs from "node:fs";
import path from "node:path";
import { Interface } from "ethers";

/** Loads ABIs from ABI_DIR at startup (array or {abi:[...]} artifact form). */
export function loadAbi(dir, name) {
  const file = path.join(dir, `${name}.json`);
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  return Array.isArray(json) ? json : json.abi;
}

export function loadAbis(dir) {
  const exchange = loadAbi(dir, "HousePerpExchange");
  const oracle = loadAbi(dir, "HouseIndexOracle");
  return { exchange, oracle, exchangeIface: new Interface(exchange), oracleIface: new Interface(oracle) };
}

export const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];
