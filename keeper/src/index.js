#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { startKeeper } from "./keeper.js";

const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;
const cfg = loadConfig();
if (!cfg.privateKey && !cfg.dryRun) {
  console.error("KEEPER_PRIVATE_KEY is required unless DRY_RUN=true");
  process.exit(1);
}
const k = await startKeeper(cfg, { only });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => { await k.stop(); process.exit(0); });
