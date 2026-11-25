// Index publisher: pulls prints from a price source and pushes the newest per symbol via
// oracle.pushIndex when it is newer than what was last pushed. Refuses moves larger than
// the oracle's maxPrintMoveBps (which would revert anyway) before sending.
import fs from "node:fs";
import { ethers } from "ethers";
import { errorName, txOverrides } from "./contracts.js";
import { log, warn } from "./log.js";

const TAG = "publisher";

export class Publisher {
  constructor(cfg, { oracle, signer, keeperAddress, provider }, source, stats) {
    this.cfg = cfg; this.oracle = oracle; this.signer = signer; this.keeperAddress = keeperAddress;
    this.provider = provider ?? oracle.runner?.provider;
    this.source = source; this.stats = stats; this.stopped = false;
    Object.assign(stats, { lastRun: null, printsPushed: 0, printsRefused: 0, releasesScheduled: 0, lastError: null });
    this.state = this.loadState();
  }
  loadState() {
    try { return JSON.parse(fs.readFileSync(this.cfg.publisherStateFile, "utf8")); } catch { return {}; }
  }
  saveState() {
    if (this.cfg.dryRun) return;
    fs.writeFileSync(this.cfg.publisherStateFile, JSON.stringify(this.state, null, 2));
  }

  /** Release calendar [{symbol, releaseAt ISO}] or [] if the file is absent. */
  loadCalendar() {
    const f = this.cfg.releaseCalendarFile;
    if (!f || !fs.existsSync(f)) return [];
    return JSON.parse(fs.readFileSync(f, "utf8"))
      .map((r) => ({ symbol: String(r.symbol).toUpperCase(), releaseAt: r.releaseAt, ts: Math.floor(Date.parse(r.releaseAt) / 1000) }))
      .filter((r) => r.symbol && Number.isFinite(r.ts));
  }

  /**
   * For each symbol, schedule the next upcoming release on-chain (oracle.schedulePrint), which
   * puts the market into close-only mode `closeOnlyBefore` ahead of it. Only schedules when
   * nothing is scheduled on-chain (pushIndex clears it); a past-due schedule is left alone so the
   * market stays close-only until the print actually lands. Uses chain time, not wall time.
   */
  async scheduleReleases() {
    const cal = this.loadCalendar();
    if (!cal.length) return [];
    const now = Number((await this.provider.getBlock("latest")).timestamp);
    const results = [];
    for (const symbol of [...new Set(cal.map((r) => r.symbol))]) {
      const id = ethers.encodeBytes32String(symbol);
      const consumed = this.state[symbol]?.consumedRelease ?? 0;
      const next = cal.filter((r) => r.symbol === symbol && r.ts > now && r.ts > consumed).sort((a, b) => a.ts - b.ts)[0];
      const r = { symbol, kind: "schedule", releaseAt: next?.releaseAt };
      try {
        if (!next) { results.push({ ...r, action: "skip", reason: "no upcoming release" }); continue; }
        if (!(await this.oracle.feeds(id)).exists) { results.push({ ...r, action: "skip", reason: "unknown feed" }); continue; }
        const onchain = Number(await this.oracle.scheduledPrint(id));
        if (onchain !== 0) {
          results.push({ ...r, action: "skip", reason: `already scheduled for ${new Date(onchain * 1000).toISOString()}` }); continue;
        }
        if (this.cfg.dryRun || !this.signer) {
          log(TAG, `[dry-run] would schedulePrint ${symbol} @ ${next.releaseAt}`);
          results.push({ ...r, action: "dry-run" }); continue;
        }
        const tx = await this.oracle.schedulePrint(id, next.ts, txOverrides(this.cfg));
        await tx.wait();
        this.stats.releasesScheduled++;
        log(TAG, `scheduled ${symbol} print @ ${next.releaseAt} (close-only window starts before it) tx ${tx.hash}`);
        results.push({ ...r, action: "scheduled", tx: tx.hash });
      } catch (e) {
        const name = errorName(e, this.oracle.interface);
        this.stats.lastError = name;
        if (this.signer?.reset) this.signer.reset();
        warn(TAG, `schedulePrint ${symbol} failed: ${name}`);
        results.push({ ...r, action: "error", reason: name });
      }
    }
    return results;
  }

  /** Newest print per symbol. */
  static latest(prints) {
    const by = new Map();
    for (const p of prints) {
      const cur = by.get(p.symbol);
      if (!cur || p.date > cur.date) by.set(p.symbol, p);
    }
    return [...by.values()];
  }

  /** One pass. Returns a list of {symbol, action, reason?, tx?}. */
  async runOnce() {
    const results = await this.scheduleReleases();
    const prints = Publisher.latest(await this.source.fetchPrints());
    const maxBps = await this.oracle.maxPrintMoveBps();
    if (!this.cfg.dryRun && this.keeperAddress && !(await this.oracle.keepers(this.keeperAddress))) {
      throw new Error(`keeper ${this.keeperAddress} is not an authorised oracle keeper`);
    }
    for (const p of prints) {
      const id = ethers.encodeBytes32String(p.symbol);
      const r = { symbol: p.symbol, date: p.date, value: p.value };
      try {
        const feed = await this.oracle.feeds(id);
        if (!feed.exists) { results.push({ ...r, action: "skip", reason: "unknown feed" }); continue; }
        const newWad = ethers.parseEther(p.value.toFixed(18).replace(/\.?0+$/, "") || "0");
        const last = this.state[p.symbol];
        if (last && p.date <= last.date) { results.push({ ...r, action: "skip", reason: `not newer than last pushed ${last.date}` }); continue; }
        if (feed.toPrice === newWad) {
          this.state[p.symbol] = { ...this.state[p.symbol], date: p.date, value: p.value, tx: null };
          results.push({ ...r, action: "skip", reason: "already on-chain" }); continue;
        }
        const current = await this.oracle.price(id);
        const diff = newWad > current ? newWad - current : current - newWad;
        const moveBps = Number((diff * 10_000n * 100n) / current) / 100;
        if (diff * 10_000n > current * maxBps) {
          this.stats.printsRefused++;
          warn(TAG, `REFUSED ${p.symbol} ${p.date}: ${ethers.formatEther(current)} -> ${p.value} is ${moveBps} bps > max ${maxBps} bps`);
          results.push({ ...r, action: "refused", reason: `move ${moveBps} bps > ${maxBps} bps` }); continue;
        }
        if (this.cfg.dryRun || !this.signer) {
          log(TAG, `[dry-run] would push ${p.symbol} ${p.date}: ${ethers.formatEther(current)} -> ${p.value} (${moveBps} bps)`);
          results.push({ ...r, action: "dry-run" }); continue;
        }
        const scheduled = this.oracle.scheduledPrint ? Number(await this.oracle.scheduledPrint(id)) : 0;
        const tx = await this.oracle.pushIndex(id, newWad, txOverrides(this.cfg));
        const rc = await tx.wait();
        // pushIndex clears the schedule; remember which release this print fulfilled so it is not re-scheduled.
        const consumedRelease = scheduled || this.state[p.symbol]?.consumedRelease || 0;
        this.state[p.symbol] = { date: p.date, value: p.value, tx: tx.hash, consumedRelease };
        this.saveState();
        this.stats.printsPushed++;
        log(TAG, `pushed ${p.symbol} ${p.date}: ${ethers.formatEther(current)} -> ${p.value} (${moveBps} bps) tx ${tx.hash} block ${rc.blockNumber}`);
        results.push({ ...r, action: "pushed", tx: tx.hash });
      } catch (e) {
        const name = errorName(e, this.oracle.interface);
        this.stats.lastError = name;
        if (this.signer?.reset) this.signer.reset();
        warn(TAG, `push ${p.symbol} failed: ${name}`);
        results.push({ ...r, action: "error", reason: name });
      }
    }
    this.saveState();
    this.stats.lastRun = new Date().toISOString();
    return results;
  }

  async run() {
    log(TAG, `source ${this.source.name}, every ${this.cfg.publishEveryMs}ms${this.cfg.dryRun ? ", DRY RUN" : ""}`);
    while (!this.stopped) {
      try { await this.runOnce(); } catch (e) { if (this.stopped) break; this.stats.lastError = e.message; warn(TAG, e.message); }
      await new Promise((r) => setTimeout(r, this.cfg.publishEveryMs));
    }
  }
  stop() { this.stopped = true; }
}
