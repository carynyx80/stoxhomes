import { Contract, JsonRpcProvider, formatUnits, decodeBytes32String } from "ethers";
import { EventEmitter } from "node:events";
import { loadAbis, ERC20_ABI } from "./abis.js";
import { EVENT_TABLES } from "./db.js";

const f = (x) => (x === undefined || x === null ? null : Number(formatUnits(x, 18)));
const lc = (a) => (a ? String(a).toLowerCase() : a);
const jsonArgs = (ev) => {
  const out = {};
  ev.fragment.inputs.forEach((inp, i) => {
    const v = ev.args[i];
    out[inp.name || `arg${i}`] = typeof v === "bigint" ? v.toString() : Array.isArray(v) ? v.map(String) : v;
  });
  return out;
};
/** Read a named event arg, trying several names (so ABI changes in progress don't break us). */
const arg = (ev, ...names) => {
  for (const n of names) {
    const i = ev.fragment.inputs.findIndex((x) => x.name === n);
    if (i >= 0) return ev.args[i];
  }
  return undefined;
};
const symbolOf = (oracleId) => {
  try { return decodeBytes32String(oracleId); } catch { return oracleId; }
};

/**
 * Event handlers keyed by event name. Each gets ({ ev, base, ix }) where base has
 * {id, block, ts, tx, log_index}. Add new events here; unknown events are still stored in `events`.
 */
export const HANDLERS = {
  MarketAdded({ ev, ix }) {
    const id = Number(arg(ev, "marketId"));
    const oracleId = arg(ev, "oracleId");
    ix.upsertMarket(id, arg(ev, "name"), oracleId);
  },
  PositionOpened({ ev, base, ix }) {
    const size = f(arg(ev, "size"));
    const price = f(arg(ev, "fillPrice", "price"));
    return ix.trade(base, {
      market_id: Number(arg(ev, "marketId")), trader: lc(arg(ev, "trader")), kind: "open",
      side: size >= 0 ? "long" : "short", size, price, notional: Math.abs(size) * price,
      margin: f(arg(ev, "margin")), fee: f(arg(ev, "fee")), realized_pnl: -f(arg(ev, "fee")),
    });
  },
  PositionClosed({ ev, base, ix }) {
    const size = f(arg(ev, "size"));
    const price = f(arg(ev, "fillPrice", "price"));
    const notional = Math.abs(size) * price;
    const fee = arg(ev, "fee") !== undefined ? f(arg(ev, "fee")) : (notional * ix.tradingFeeBps) / 10_000;
    const pnl = f(arg(ev, "pnl"));
    const funding = f(arg(ev, "funding")) ?? 0;
    return ix.trade(base, {
      market_id: Number(arg(ev, "marketId")), trader: lc(arg(ev, "trader")), kind: "close",
      side: size >= 0 ? "long" : "short", size, price, notional, fee, pnl, funding,
      payout: f(arg(ev, "payout")), realized_pnl: pnl - funding - fee,
    });
  },
  Liquidated({ ev, base, ix }) {
    const size = f(arg(ev, "size"));
    const price = f(arg(ev, "price", "indexPrice"));
    const marketId = Number(arg(ev, "marketId"));
    const trader = lc(arg(ev, "trader"));
    const margin = ix.currentMargin(marketId, trader, base.block, base.log_index) ?? 0;
    return ix.trade(base, {
      market_id: marketId, trader, kind: "liquidation", side: size >= 0 ? "long" : "short",
      size, price, notional: Math.abs(size) * price, margin, pnl: -margin, payout: 0,
      realized_pnl: -margin, liquidator: lc(arg(ev, "liquidator")), reward: f(arg(ev, "reward")),
    });
  },
  // Speculative: a partial close / increase event added later. Recorded as a trade if it carries size + price.
  PositionModified({ ev, base, ix }) {
    const sizeDelta = f(arg(ev, "sizeDelta", "size"));
    const price = f(arg(ev, "fillPrice", "price"));
    if (sizeDelta === null || price === null) return;
    const fee = f(arg(ev, "fee")) ?? 0;
    const pnl = f(arg(ev, "pnl", "realizedPnl")) ?? 0;
    const funding = f(arg(ev, "fundingSettled", "funding")) ?? 0;
    return ix.trade(base, {
      market_id: Number(arg(ev, "marketId")), trader: lc(arg(ev, "trader")), kind: "modify",
      side: sizeDelta >= 0 ? "long" : "short", size: sizeDelta, price, notional: Math.abs(sizeDelta) * price,
      margin: f(arg(ev, "newMargin", "margin")), fee, pnl, funding, realized_pnl: pnl - funding - fee,
    });
  },
  MarginChanged({ ev, base, ix }) {
    ix.db.insert("margin_changes", {
      ...base, market_id: Number(arg(ev, "marketId")), trader: lc(arg(ev, "trader")),
      delta: f(arg(ev, "delta")), new_margin: f(arg(ev, "newMargin")),
    });
  },
  Deposit({ ev, base, ix }) { return ix.lp(base, ev, "deposit"); },
  Withdraw({ ev, base, ix }) { return ix.lp(base, ev, "withdraw"); },
  WithdrawRequested({ ev, base, ix }) { return ix.lp(base, ev, "withdraw_request"); },
  WithdrawCancelled({ ev, base, ix }) { return ix.lp(base, ev, "withdraw_cancel"); },
  // Informational events: kept in the raw `events` table only.
  CloseOnlyScheduled() {}, MarketUpdated() {}, PoolParamsSet() {}, KeeperSet() {}, ParamsSet() {},
  OwnershipTransferred() {}, ProtocolFeeSet() {}, ProtocolFeesClaimed() {},
  FeesSet({ ev, ix }) { ix.tradingFeeBps = Number(arg(ev, "tradingFeeBps")); },
  IndexPushed({ ev, base, ix }) {
    const oracleId = arg(ev, "id");
    const row = {
      ...base, oracle_id: oracleId, symbol: symbolOf(oracleId),
      from_price: f(arg(ev, "fromPrice")), to_price: f(arg(ev, "toPrice")),
    };
    ix.db.insert("index_prints", row);
    return { type: "indexPrint", data: row };
  },
  FeedCreated({ ev, base, ix }) {
    const oracleId = arg(ev, "id");
    const p = f(arg(ev, "price"));
    ix.db.insert("index_prints", { ...base, oracle_id: oracleId, symbol: symbolOf(oracleId), from_price: p, to_price: p });
  },
};

export class Indexer extends EventEmitter {
  constructor(cfg, db) {
    super();
    this.cfg = cfg;
    this.db = db;
    this.provider = new JsonRpcProvider(cfg.rpcUrl, cfg.chainId, { staticNetwork: true, batchMaxCount: 20 });
    this.provider.pollingInterval = 1000;
    this.abis = loadAbis(cfg.abiDir);
    if (!cfg.exchange || !cfg.oracle) throw new Error("EXCHANGE_ADDRESS / ORACLE_ADDRESS not configured");
    this.exchange = new Contract(cfg.exchange, this.abis.exchange, this.provider);
    this.oracle = new Contract(cfg.oracle, this.abis.oracle, this.provider);
    this.tradingFeeBps = 5;
    this.blockTs = new Map();
    this.unknownWarned = new Set();
    this.timer = null;
    this.running = false;
  }

  async init() {
    try { this.tradingFeeBps = Number(await this.exchange.tradingFeeBps()); } catch {}
    if (!this.cfg.collateral) {
      try { this.cfg.collateral = await this.exchange.collateral(); } catch {}
    }
    this.usdt = this.cfg.collateral ? new Contract(this.cfg.collateral, ERC20_ABI, this.provider) : null;
    // Markets may predate START_BLOCK, so read them from chain too.
    try {
      const n = Number(await this.exchange.marketCount());
      for (let i = 0; i < n; i++) {
        const m = await this.exchange.getMarket(i);
        this.upsertMarket(i, m.name, m.oracleId);
      }
    } catch (e) {
      console.warn("[indexer] could not read markets:", e.shortMessage || e.message);
    }
  }

  upsertMarket(id, name, oracleId) {
    const symbol = String(name || "").replace(/-USD$/, "") || symbolOf(oracleId);
    const city = this.cfg.marketsMeta.find((m) => m.symbol === symbol)?.name || symbol;
    this.db.insert("markets", { id, name, symbol, oracle_id: oracleId, city }, "OR REPLACE");
  }

  trade(base, row) {
    const full = { ...base, ...row };
    this.db.insert("trades", full);
    return { type: "trade", data: full };
  }

  lp(base, ev, kind) {
    const row = {
      ...base, lp: lc(arg(ev, "lp", "account", "owner")), kind,
      amount: f(arg(ev, "amount")), shares: f(arg(ev, "sharesMinted", "sharesBurned", "shares", "shareAmount")),
    };
    this.db.insert("lp_events", row);
    return { type: "lp", data: row };
  }

  /** Margin of the open position at (block, logIndex), from the latest open/modify/margin change. */
  currentMargin(marketId, trader, block, logIndex) {
    const r = this.db.get(
      `SELECT margin FROM (
         SELECT block, log_index, margin FROM trades WHERE market_id=? AND trader=? AND kind IN ('open','modify') AND margin IS NOT NULL
         UNION ALL SELECT block, log_index, new_margin AS margin FROM margin_changes WHERE market_id=? AND trader=?)
       WHERE block < ? OR (block = ? AND log_index < ?) ORDER BY block DESC, log_index DESC LIMIT 1`,
      marketId, trader, marketId, trader, block, block, logIndex
    );
    return r?.margin;
  }

  async ts(block) {
    if (!this.blockTs.has(block)) {
      const b = await this.provider.getBlock(block);
      this.blockTs.set(block, b.timestamp);
      if (this.blockTs.size > 5000) this.blockTs.delete(this.blockTs.keys().next().value);
    }
    return this.blockTs.get(block);
  }

  decode(log) {
    const isEx = lc(log.address) === lc(this.cfg.exchange);
    const iface = isEx ? this.abis.exchangeIface : this.abis.oracleIface;
    try { return iface.parseLog(log); } catch { return null; }
  }

  /** One sync pass: re-scan the last REORG_DEPTH blocks, then index up to head. Returns new items. */
  syncOnce() {
    const run = (this._sync || Promise.resolve()).catch(() => {}).then(() => this._syncOnce());
    this._sync = run;
    return run;
  }

  /** Wipe all indexed data if the chain was reset (new genesis, e.g. a restarted demo chain). */
  async _checkChainReset(head) {
    const genesis = (await this.provider.send("eth_getBlockByNumber", ["0x0", false]))?.hash;
    const stored = this.db.getMeta("genesisHash");
    const lastBlock = Number(this.db.getMeta("lastBlock") ?? -1);
    const reset = (stored && genesis && stored !== genesis) || lastBlock - head > this.cfg.reorgDepth;
    if (reset) {
      console.warn(`[indexer] chain reset detected (genesis ${stored} -> ${genesis}, last ${lastBlock}, head ${head}); clearing data`);
      const tables = this.db.all("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name);
      this.db.tx(() => { for (const t of tables) this.db.run(`DELETE FROM ${t}`); });
      this.blockTs.clear();
    }
    if (genesis && (reset || !stored)) this.db.setMeta("genesisHash", genesis);
  }

  async _syncOnce() {
    const head = Number(await this.provider.send("eth_blockNumber", [])); // uncached
    await this._checkChainReset(head);
    const last = Number(this.db.getMeta("lastBlock") ?? this.cfg.startBlock - 1);
    const from = Math.max(this.cfg.startBlock, Math.min(last, head) - this.cfg.reorgDepth + 1);
    if (from > head) return [];
    const logs = [];
    for (let a = from; a <= head; a += this.cfg.logChunk) {
      const b = Math.min(head, a + this.cfg.logChunk - 1);
      logs.push(...(await this.provider.getLogs({ address: [this.cfg.exchange, this.cfg.oracle], fromBlock: a, toBlock: b })));
    }
    logs.sort((x, y) => x.blockNumber - y.blockNumber || x.index - y.index);
    for (let bn = from; bn <= Math.min(head, last); bn++) this.blockTs.delete(bn); // reorged blocks may change ts
    for (const bn of new Set(logs.map((l) => l.blockNumber))) await this.ts(bn);

    const fresh = [];
    this.db.tx(() => {
      const known = new Set(this.db.all("SELECT id FROM events WHERE block >= ?", from).map((r) => r.id));
      for (const t of EVENT_TABLES) this.db.run(`DELETE FROM ${t} WHERE block >= ?`, from);
      for (const log of logs) {
        const base = {
          id: `${log.transactionHash}:${log.index}`, block: log.blockNumber, ts: this.blockTs.get(log.blockNumber),
          tx: log.transactionHash, log_index: log.index,
        };
        const ev = this.decode(log);
        this.db.insert("events", {
          ...base, address: lc(log.address), name: ev?.name ?? null,
          args: JSON.stringify(ev ? jsonArgs(ev) : { topics: log.topics, data: log.data }),
        });
        if (!ev) { this.warnOnce(log.topics[0], `undecodable log ${log.topics[0]} at ${log.address}`); continue; }
        const h = HANDLERS[ev.name];
        if (!h) { this.warnOnce(ev.name, `no handler for event ${ev.name} (stored raw)`); continue; }
        let out;
        try { out = h({ ev, base, ix: this }); }
        catch (e) { console.warn(`[indexer] handler ${ev.name} failed at ${base.id}:`, e.message); }
        if (out && !known.has(base.id)) fresh.push(out);
      }
      this.db.setMeta("lastBlock", head);
    });

    const headTs = await this.ts(head);
    this.db.setMeta("headTs", headTs);
    const lastSnap = Number(this.db.getMeta("lastSnapshotBlock") ?? -Infinity);
    const hadTrades = fresh.some((x) => x.type === "trade" || x.type === "indexPrint" || x.type === "lp");
    if (hadTrades || head - lastSnap >= this.cfg.snapshotEvery) {
      try { fresh.push(await this.snapshot(head, headTs)); }
      catch (e) { console.warn("[indexer] snapshot failed:", e.shortMessage || e.message); }
    }
    for (const item of fresh) this.emit("item", item);
    return fresh;
  }

  /** Reads live market + pool state at `blockTag`. */
  async readState(blockTag = "latest") {
    const o = { blockTag };
    const n = Number(await this.exchange.marketCount(o));
    const [pv, shares, margin, bal] = await Promise.all([
      this.exchange.poolValue(o), this.exchange.totalShares(o), this.exchange.totalMargin(o),
      this.usdt ? this.usdt.balanceOf(this.cfg.exchange, o) : Promise.resolve(0n),
    ]);
    const markets = await Promise.all(
      Array.from({ length: n }, async (_, i) => {
        const [m, idx, mark, fund] = await Promise.all([
          this.exchange.getMarket(i, o), this.exchange.indexPrice(i, o), this.exchange.markPrice(i, o),
          this.exchange.fundingRatePerDay(i, o),
        ]);
        let closeOnly = false;
        try { closeOnly = await this.exchange.isCloseOnly(i, o); } catch {}
        return {
          market_id: i, active: m.active, close_only: closeOnly, index_price: f(idx), mark_price: f(mark), funding_day: f(fund),
          long_oi: f(m.longSize), short_oi: f(m.shortSize), skew: f(m.skew),
        };
      })
    );
    const poolValue = f(pv), totalShares = f(shares);
    return {
      markets,
      pool: {
        pool_value: poolValue, total_shares: totalShares,
        share_price: totalShares > 0 ? poolValue / totalShares : 1, total_margin: f(margin), tvl: f(bal),
      },
    };
  }

  async snapshot(block, ts) {
    const st = await this.readState(block);
    this.db.tx(() => {
      for (const m of st.markets) {
        const { active, close_only, ...row } = m;
        this.db.insert("snapshots", { ...row, block, ts, pool_value: st.pool.pool_value }, "OR REPLACE");
      }
      this.db.insert("pool_snapshots", { block, ts, ...st.pool }, "OR REPLACE");
      this.db.setMeta("lastSnapshotBlock", block);
    });
    return { type: "snapshot", data: { block, ts, ...st } };
  }

  warnOnce(key, msg) {
    if (this.unknownWarned.has(key)) return;
    this.unknownWarned.add(key);
    console.warn("[indexer]", msg);
  }

  async start() {
    await this.init();
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      try { await this.syncOnce(); }
      catch (e) { if (this.running) console.warn("[indexer] sync error:", e.shortMessage || e.message); }
      if (this.running) this.timer = setTimeout(loop, this.cfg.pollMs);
    };
    await loop();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.provider.destroy();
  }
}
