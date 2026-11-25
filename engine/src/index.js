import { loadConfig } from './config.js';
import { createApp } from './server.js';

const log = (...a) => console.log(new Date().toISOString(), ...a);

async function main() {
  const config = loadConfig();
  const svc = createApp(config, { log });
  if (config.watcherEnabled) {
    try {
      const id = await svc.rpc.chainId();
      if (id !== config.chainId) throw new Error(`RPC chainId ${id} != CHAIN_ID ${config.chainId}`);
    } catch (e) {
      if (/chainId/.test(e.message)) throw e;
      log(`warning: could not verify chain id: ${e.message}`);
    }
  }
  const port = await svc.start(config.port);
  log(`stoxhome engine listening on :${port} (db ${config.dbPath}, chain ${config.chainId})`);
  const shutdown = async (sig) => {
    log(`${sig}: shutting down`);
    try { await svc.stop(); } finally { process.exit(0); }
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => {
  console.error('fatal:', e.message);
  process.exit(1);
});
