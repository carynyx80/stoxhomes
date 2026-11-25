// Liquidation bot: tracks (marketId, trader) pairs from exchange events, checks
// positionInfo(...).liquidatable every tick and calls liquidate().
import { ethers } from "ethers";
import { mapLimit } from "./pool.js";
import { errorName, txOverrides, checkGasCap } from "./contracts.js";
import { log, warn } from "./log.js";

const TAG = "liquidator";
// Races that are expected and harmless: someone else liquidated/closed first, or price recovered.
const BENIGN = new Set(["NotLiquidatable", "NoPosition"]);

export class Liquidator {
  constructor(cfg, { provider, exchange, signer }, stats) {
    this.cfg = cfg; this.provider = provider; this.exchange = exchange; this.signer = signer;
    this.iface = exchange.interface;
    this.positions = new Map(); // key -> { marketId, trader }
    this.inflight = new Set(); // keys with an unconfirmed liquidate tx
    this.cooldown = new Map(); // key -> block until which we skip after a failed send
    this.lastBlock = cfg.startBlock - 1;
    this.stats = stats;
    Object.assign(stats, { lastProcessedBlock: null, openPositionsTracked: 0, liquidationsSent: 0,
      liquidationsConfirmed: 0, liquidationsFailed: 0, rewardsWei: "0", lastError: null });
    this.rewards = 0n;
    this.stopped = false;
    // Every exchange event that carries (marketId, trader) is a "touch": future events such as
    // PositionModified are picked up automatically from the runtime ABI.
    this.touchTopics = [];
    this.iface.forEachEvent((ev) => {
      const names = ev.inputs.map((i) => i.name);
      if (names.includes("marketId") && names.includes("trader")) this.touchTopics.push(ev.topicHash);
    });
  }

  key(m, t) { return `${m}:${t.toLowerCase()}`; }

  async syncEvents(toBlock) {
    const from = this.lastBlock + 1;
    if (toBlock < from) return;
    const addr = await this.exchange.getAddress();
    for (let a = from; a <= toBlock; a += this.cfg.logChunk) {
      const b = Math.min(toBlock, a + this.cfg.logChunk - 1);
      const logs = await this.provider.getLogs({ address: addr, fromBlock: a, toBlock: b, topics: [this.touchTopics] });
      for (const l of logs) {
        let ev; try { ev = this.iface.parseLog(l); } catch { continue; }
        if (!ev) continue;
        const marketId = ev.args.marketId, trader = ev.args.trader;
        const k = this.key(marketId, trader);
        if (ev.name === "PositionClosed" || ev.name === "Liquidated") this.positions.delete(k);
        else this.positions.set(k, { marketId, trader });
      }
      this.lastBlock = b;
    }
    this.stats.lastProcessedBlock = this.lastBlock;
    this.stats.openPositionsTracked = this.positions.size;
  }

  async checkAll(blockNumber) {
    const list = [...this.positions.entries()];
    await mapLimit(list, this.cfg.concurrency, async ([k, p]) => {
      if (this.inflight.has(k) || (this.cooldown.get(k) ?? -1) >= blockNumber) return;
      let info;
      try { info = await this.exchange.positionInfo(p.marketId, p.trader); }
      catch (e) { if (this.stopped) return; warn(TAG, `positionInfo(${k}) failed: ${errorName(e, this.iface)}`); return; }
      if (info.size === 0n) { this.positions.delete(k); return; } // closed by a path we did not see
      if (info.liquidatable) await this.liquidate(k, p, info, blockNumber);
    });
    this.stats.openPositionsTracked = this.positions.size;
  }

  async liquidate(k, p, info, blockNumber) {
    const desc = `market ${p.marketId} trader ${p.trader} size ${ethers.formatEther(info.size)} equity ${ethers.formatEther(info.equity)} index ${ethers.formatEther(info.indexPrice)}`;
    if (this.cfg.dryRun || !this.signer) { log(TAG, `[dry-run] would liquidate ${desc}`); return; }
    if (!(await checkGasCap(this.cfg, this.provider))) { warn(TAG, `gas price above MAX_GAS_PRICE_GWEI, skipping ${k}`); return; }
    this.inflight.add(k); // double-send guard: one tx per position until it settles
    try {
      // Simulate first so a lost race costs no gas.
      const expected = await this.exchange.liquidate.staticCall(p.marketId, p.trader);
      const tx = await this.exchange.liquidate(p.marketId, p.trader, txOverrides(this.cfg));
      this.stats.liquidationsSent++;
      log(TAG, `sent liquidate ${desc} tx ${tx.hash} (expected reward ${ethers.formatEther(expected)} USDT)`);
      const rc = await tx.wait();
      let reward = 0n;
      for (const l of rc.logs) {
        try { const ev = this.iface.parseLog(l); if (ev?.name === "Liquidated") reward = ev.args.reward; } catch {}
      }
      this.rewards += reward;
      this.stats.liquidationsConfirmed++;
      this.stats.rewardsWei = this.rewards.toString();
      this.positions.delete(k);
      log(TAG, `liquidated ${k} in block ${rc.blockNumber}, reward ${ethers.formatEther(reward)} USDT, gas ${rc.gasUsed}`);
    } catch (e) {
      const name = errorName(e, this.iface);
      if (BENIGN.has(name)) log(TAG, `skip ${k}: ${name} (lost race or price moved)`);
      else { this.stats.liquidationsFailed++; this.stats.lastError = name; warn(TAG, `liquidate ${k} failed: ${name}`); }
      this.cooldown.set(k, blockNumber); // retry from the next block
      if (this.signer?.reset) this.signer.reset(); // resync nonce after a failed send
    } finally {
      this.inflight.delete(k);
    }
  }

  async tick() {
    const bn = await this.provider.getBlockNumber();
    await this.syncEvents(bn);
    await this.checkAll(bn);
    return bn;
  }

  async run() {
    log(TAG, `starting from block ${this.cfg.startBlock}, poll ${this.cfg.pollMs}ms, concurrency ${this.cfg.concurrency}${this.cfg.dryRun ? ", DRY RUN" : ""}`);
    while (!this.stopped) {
      try { await this.tick(); }
      catch (e) { if (this.stopped) break; this.stats.lastError = errorName(e, this.iface); warn(TAG, `tick failed: ${this.stats.lastError}`); }
      await new Promise((r) => setTimeout(r, this.cfg.pollMs));
    }
  }
  stop() { this.stopped = true; }
}
