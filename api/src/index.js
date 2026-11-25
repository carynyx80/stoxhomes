import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { Indexer } from "./indexer.js";
import { createServer } from "./server.js";

/** Starts indexer + HTTP/WS server. Returns handles for tests. */
export async function start(overrides = {}) {
  const cfg = loadConfig(overrides);
  const db = openDb(cfg.dbPath);
  const indexer = new Indexer(cfg, db);
  const server = createServer({ cfg, db, indexer });
  await new Promise((r) => server.listen(cfg.port, cfg.host, r));
  const port = server.address().port;
  console.log(`[api] listening on :${port} (db ${cfg.dbPath} via ${db.driver}, rpc ${cfg.rpcUrl})`);
  await indexer.start();
  return {
    cfg, db, indexer, server, port,
    async stop() {
      indexer.stop();
      for (const c of server.wss.clients) c.terminate();
      await new Promise((r) => server.close(r));
      server.closeAllConnections?.();
      db.close();
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await start();
  const shutdown = async () => { await app.stop(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
