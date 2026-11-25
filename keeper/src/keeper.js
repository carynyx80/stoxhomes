import { connect } from "./contracts.js";
import { Liquidator } from "./liquidator.js";
import { Publisher } from "./publisher.js";
import { makeSource } from "./sources/index.js";
import { startHealth } from "./health.js";
import { log } from "./log.js";

/** Build and start the keeper. `only` = "liquidator" | "publisher" | undefined (both). */
export async function startKeeper(cfg, { only, source } = {}) {
  const ctx = await connect(cfg);
  const started = Date.now();
  const stats = { liquidator: {}, publisher: {} };
  const liq = only !== "publisher" ? new Liquidator(cfg, ctx, stats.liquidator) : null;
  const pub = only !== "liquidator" ? new Publisher(cfg, ctx, source ?? makeSource(cfg), stats.publisher) : null;
  const status = () => ({
    ok: true, chainId: cfg.chainId, dryRun: cfg.dryRun, keeper: ctx.keeperAddress,
    uptimeSec: Math.round((Date.now() - started) / 1000),
    lastProcessedBlock: stats.liquidator.lastProcessedBlock ?? null,
    openPositionsTracked: stats.liquidator.openPositionsTracked ?? 0,
    liquidationsSent: stats.liquidator.liquidationsSent ?? 0,
    liquidator: liq ? stats.liquidator : null, publisher: pub ? stats.publisher : null,
  });
  const server = cfg.healthPort ? await startHealth(cfg.healthPort, status) : null;
  log("keeper", `chain ${cfg.chainId} via ${cfg.rpcUrl}, keeper ${ctx.keeperAddress ?? "(read-only)"}, exchange ${await ctx.exchange.getAddress()}, health :${cfg.healthPort}`);
  const loops = [liq?.run(), pub?.run()].filter(Boolean);
  return {
    ctx, liq, pub, status,
    async stop() { liq?.stop(); pub?.stop(); server?.close(); ctx.provider.destroy(); await Promise.race([Promise.all(loops), new Promise((r) => setTimeout(r, Math.max(cfg.pollMs, 100) + 50))]); },
  };
}
