import http from "node:http";
import { WebSocketServer } from "ws";

const RANGES = { "1D": 86400, "1W": 7 * 86400, "1M": 30 * 86400, "6M": 182 * 86400, "1Y": 365 * 86400, "5Y": 5 * 365 * 86400, ALL: Infinity };
const PERIODS = { "24h": 86400, "1d": 86400, "7d": 7 * 86400, "30d": 30 * 86400, all: Infinity };
const MAX_POINTS = 1000;

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

export function createServer({ cfg, db, indexer }) {
  const now = () => Number(db.getMeta("headTs") ?? Math.floor(Date.now() / 1000));
  let liveCache = { at: 0, value: null };

  async function live() {
    if (Date.now() - liveCache.at < 1500 && liveCache.value) return liveCache.value;
    try {
      const value = await indexer.readState("latest");
      liveCache = { at: Date.now(), value };
      return value;
    } catch {
      // RPC down: fall back to the latest stored snapshot.
      const block = db.get("SELECT MAX(block) b FROM pool_snapshots")?.b;
      if (block == null) return { markets: [], pool: null };
      return {
        markets: db.all("SELECT * FROM snapshots WHERE block=?", block),
        pool: db.get("SELECT * FROM pool_snapshots WHERE block=?", block),
        stale: true,
      };
    }
  }

  function resolveMarket(idOrSymbol) {
    const s = String(idOrSymbol);
    const m = /^\d+$/.test(s)
      ? db.get("SELECT * FROM markets WHERE id=?", Number(s))
      : db.get("SELECT * FROM markets WHERE upper(symbol)=upper(?) OR upper(name)=upper(?)", s, s);
    if (!m) throw new HttpError(404, `unknown market ${s}`);
    return m;
  }

  const tradeOut = (t) => ({
    id: t.id, marketId: t.market_id, trader: t.trader, kind: t.kind, side: t.side, size: t.size,
    price: t.price, notional: t.notional, margin: t.margin, fee: t.fee, pnl: t.pnl, funding: t.funding,
    payout: t.payout, realizedPnl: t.realized_pnl, liquidator: t.liquidator, reward: t.reward,
    block: t.block, timestamp: t.ts, txHash: t.tx,
  });

  function priceAt(marketId, ts) {
    return db.get("SELECT index_price FROM snapshots WHERE market_id=? AND ts<=? ORDER BY ts DESC LIMIT 1", marketId, ts)?.index_price
      ?? db.get("SELECT index_price FROM snapshots WHERE market_id=? ORDER BY ts ASC LIMIT 1", marketId)?.index_price;
  }

  const routes = [
    ["GET", /^\/health$/, async () => ({
      ok: true, chainId: cfg.chainId, lastBlock: Number(db.getMeta("lastBlock") ?? -1), headTs: now(), db: db.driver,
    })],

    ["GET", /^\/markets$/, async () => {
      const st = await live();
      const t = now();
      return db.all("SELECT * FROM markets ORDER BY id").map((m) => {
        const s = st.markets.find((x) => x.market_id === m.id) || {};
        const vol = db.get("SELECT COALESCE(SUM(notional),0) v, COUNT(*) n FROM trades WHERE market_id=? AND ts>=?", m.id, t - 86400);
        const ref = priceAt(m.id, t - 86400);
        const lastPrint = db.get("SELECT to_price, ts FROM index_prints WHERE oracle_id=? ORDER BY block DESC, log_index DESC LIMIT 1", m.oracle_id);
        return {
          id: m.id, symbol: m.symbol, name: m.name, city: m.city, active: s.active ?? true, closeOnly: s.close_only ?? false,
          indexPrice: s.index_price ?? null, markPrice: s.mark_price ?? null,
          fundingRatePerDay: s.funding_day ?? null,
          longOI: s.long_oi ?? 0, shortOI: s.short_oi ?? 0, skew: s.skew ?? 0,
          longOIUsd: (s.long_oi ?? 0) * (s.index_price ?? 0), shortOIUsd: (s.short_oi ?? 0) * (s.index_price ?? 0),
          volume24h: vol.v, trades24h: vol.n,
          change24h: ref && s.index_price ? (s.index_price - ref) / ref : 0,
          lastPrint: lastPrint ? { price: lastPrint.to_price, timestamp: lastPrint.ts } : null,
        };
      });
    }],

    ["GET", /^\/markets\/([^/]+)\/history$/, async ([id], q) => {
      const m = resolveMarket(id);
      const range = (q.get("range") || "1M").toUpperCase();
      if (!(range in RANGES)) throw new HttpError(400, `range must be one of ${Object.keys(RANGES).join("|")}`);
      const since = RANGES[range] === Infinity ? 0 : now() - RANGES[range];
      const prints = db.all(
        "SELECT ts, block, from_price, to_price, tx FROM index_prints WHERE oracle_id=? AND ts>=? ORDER BY block, log_index", m.oracle_id, since
      ).map((p) => ({ timestamp: p.ts, block: p.block, fromPrice: p.from_price, price: p.to_price, txHash: p.tx }));
      let snaps = db.all("SELECT * FROM snapshots WHERE market_id=? AND ts>=? ORDER BY block", m.id, since);
      if (snaps.length > MAX_POINTS) {
        const step = Math.ceil(snaps.length / MAX_POINTS);
        snaps = snaps.filter((_, i) => i % step === 0 || i === snaps.length - 1);
      }
      return {
        marketId: m.id, symbol: m.symbol, range, from: since, to: now(), prints,
        snapshots: snaps.map((s) => ({
          timestamp: s.ts, block: s.block, indexPrice: s.index_price, markPrice: s.mark_price,
          fundingRatePerDay: s.funding_day, longOI: s.long_oi, shortOI: s.short_oi, skew: s.skew, poolValue: s.pool_value,
        })),
      };
    }],

    ["GET", /^\/markets\/([^/]+)\/trades$/, async ([id], q) => {
      const m = resolveMarket(id);
      const limit = clampInt(q.get("limit"), 50, 1, 500);
      return db.all("SELECT * FROM trades WHERE market_id=? ORDER BY block DESC, log_index DESC LIMIT ?", m.id, limit).map(tradeOut);
    }],

    ["GET", /^\/traders\/(0x[0-9a-fA-F]{40})\/positions$/, async ([addr]) => {
      const trader = addr.toLowerCase();
      const markets = db.all("SELECT * FROM markets ORDER BY id");
      const out = [];
      await Promise.all(markets.map(async (m) => {
        let info;
        try { info = await indexer.exchange.positionInfo(m.id, trader); } catch { return; }
        if (info.size === 0n) return;
        const F = (x) => Number(x) / 1e18;
        const open = db.get(
          "SELECT * FROM trades WHERE market_id=? AND trader=? AND kind='open' ORDER BY block DESC, log_index DESC LIMIT 1", m.id, trader
        );
        const size = F(info.size);
        out.push({
          marketId: m.id, symbol: m.symbol, side: size > 0 ? "long" : "short", size, margin: F(info.margin),
          entryPrice: F(info.entryPrice), indexPrice: F(info.indexPrice), notional: Math.abs(size) * F(info.indexPrice),
          leverage: F(info.equity) > 0 ? (Math.abs(size) * F(info.indexPrice)) / F(info.equity) : null,
          unrealizedPnl: F(info.pnl), funding: F(info.funding), equity: F(info.equity),
          liquidationPrice: F(info.liquidationPrice), liquidatable: info.liquidatable,
          openedAt: open?.ts ?? null, openTx: open?.tx ?? null,
        });
      }));
      return out.sort((a, b) => a.marketId - b.marketId);
    }],

    ["GET", /^\/traders\/(0x[0-9a-fA-F]{40})\/history$/, async ([addr], q) => {
      const trader = addr.toLowerCase();
      const limit = clampInt(q.get("limit"), 200, 1, 1000);
      const trades = db.all("SELECT * FROM trades WHERE trader=? ORDER BY block DESC, log_index DESC LIMIT ?", trader, limit).map(tradeOut);
      const margin = db.all("SELECT * FROM margin_changes WHERE trader=? ORDER BY block DESC, log_index DESC LIMIT ?", trader, limit)
        .map((r) => ({ marketId: r.market_id, delta: r.delta, newMargin: r.new_margin, timestamp: r.ts, txHash: r.tx }));
      const lp = db.all("SELECT * FROM lp_events WHERE lp=? ORDER BY block DESC LIMIT ?", trader, limit)
        .map((r) => ({ kind: r.kind, amount: r.amount, shares: r.shares, timestamp: r.ts, txHash: r.tx }));
      const s = db.get(
        "SELECT COALESCE(SUM(realized_pnl),0) pnl, COALESCE(SUM(notional),0) vol, COALESCE(SUM(fee),0) fees, COUNT(*) n FROM trades WHERE trader=?", trader
      );
      return { trader, summary: { realizedPnl: s.pnl, volume: s.vol, fees: s.fees, trades: s.n }, trades, marginChanges: margin, lp };
    }],

    ["GET", /^\/pool$/, async (_, q) => {
      const st = await live();
      const t = now();
      const range = (q.get("range") || "ALL").toUpperCase();
      const since = RANGES[range] && RANGES[range] !== Infinity ? t - RANGES[range] : 0;
      const apr = (days) => {
        const from = t - days * 86400;
        const first = db.get("SELECT MIN(ts) ts FROM trades")?.ts;
        const fees = db.get("SELECT COALESCE(SUM(fee),0) v FROM trades WHERE ts>=?", from).v;
        const avg = db.get("SELECT AVG(pool_value) v FROM pool_snapshots WHERE ts>=?", from).v || st.pool?.pool_value;
        if (!avg || first == null) return 0;
        const span = Math.max(3600, Math.min(days * 86400, t - Math.max(from, first)));
        return (fees / avg) * ((365 * 86400) / span);
      };
      const fees = (d) => db.get("SELECT COALESCE(SUM(fee),0) v FROM trades WHERE ts>=?", t - d * 86400).v;
      const lp = db.get("SELECT COUNT(DISTINCT lp) n, COALESCE(SUM(CASE WHEN kind='deposit' THEN amount ELSE 0 END),0) dep, COALESCE(SUM(CASE WHEN kind='withdraw' THEN amount ELSE 0 END),0) wd FROM lp_events");
      return {
        poolValue: st.pool?.pool_value ?? null, totalShares: st.pool?.total_shares ?? null, sharePrice: st.pool?.share_price ?? null,
        totalMargin: st.pool?.total_margin ?? null, tvl: st.pool?.tvl ?? null,
        fees7d: fees(7), fees30d: fees(30), feeApr7d: apr(7), feeApr30d: apr(30),
        lpCount: lp.n, totalDeposited: lp.dep, totalWithdrawn: lp.wd,
        sharePriceHistory: downsample(db.all("SELECT ts, block, share_price, pool_value FROM pool_snapshots WHERE ts>=? ORDER BY block", since))
          .map((r) => ({ timestamp: r.ts, block: r.block, sharePrice: r.share_price, poolValue: r.pool_value })),
        recent: db.all("SELECT * FROM lp_events ORDER BY block DESC, log_index DESC LIMIT 20")
          .map((r) => ({ lp: r.lp, kind: r.kind, amount: r.amount, shares: r.shares, timestamp: r.ts, txHash: r.tx })),
      };
    }],

    ["GET", /^\/stats$/, async () => {
      const st = await live();
      const t = now();
      const totalOI = st.markets.reduce((a, m) => a + ((m.long_oi || 0) + (m.short_oi || 0)) * (m.index_price || 0), 0);
      const v = db.get("SELECT COALESCE(SUM(notional),0) v, COUNT(*) n FROM trades WHERE ts>=?", t - 86400);
      const all = db.get("SELECT COALESCE(SUM(notional),0) v, COUNT(*) n, COUNT(DISTINCT trader) traders FROM trades");
      return {
        tvl: st.pool?.tvl ?? null, poolValue: st.pool?.pool_value ?? null, volume24h: v.v, trades24h: v.n,
        totalVolume: all.v, totalTrades: all.n, totalOI, traderCount: all.traders,
        traders24h: db.get("SELECT COUNT(DISTINCT trader) n FROM trades WHERE ts>=?", t - 86400).n,
        markets: st.markets.length, lastBlock: Number(db.getMeta("lastBlock") ?? -1),
      };
    }],

    ["GET", /^\/leaderboard$/, async (_, q) => {
      const period = (q.get("period") || "7d").toLowerCase();
      if (!(period in PERIODS)) throw new HttpError(400, `period must be one of ${Object.keys(PERIODS).join("|")}`);
      const since = PERIODS[period] === Infinity ? 0 : now() - PERIODS[period];
      const limit = clampInt(q.get("limit"), 50, 1, 500);
      const rows = db.all(
        `SELECT trader, SUM(realized_pnl) pnl, SUM(notional) volume, COUNT(*) trades,
                SUM(CASE WHEN kind IN ('close','liquidation') THEN 1 ELSE 0 END) closed,
                SUM(CASE WHEN kind IN ('close','liquidation') AND realized_pnl>0 THEN 1 ELSE 0 END) wins,
                SUM(CASE WHEN kind='liquidation' THEN 1 ELSE 0 END) liquidations
         FROM trades WHERE ts>=? GROUP BY trader ORDER BY pnl DESC LIMIT ?`, since, limit
      );
      return {
        period,
        entries: rows.map((r, i) => ({
          rank: i + 1, trader: r.trader, realizedPnl: r.pnl, volume: r.volume, trades: r.trades,
          winRate: r.closed ? r.wins / r.closed : null, liquidations: r.liquidations,
        })),
      };
    }],
  ];

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin && cfg.corsOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }
    if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
    const url = new URL(req.url, "http://x");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      for (const [method, re, handler] of routes) {
        const m = path.match(re);
        if (m && req.method === method) {
          const body = await handler(m.slice(1), url.searchParams);
          return send(res, 200, body);
        }
      }
      throw new HttpError(404, "not found");
    } catch (e) {
      if (!(e instanceof HttpError)) console.error("[api]", e);
      send(res, e.status || 500, { error: e.status ? e.message : "internal error" });
    }
  });

  // WebSocket: /ws pushes {type:"trade"|"snapshot"|"indexPrint"|"lp", data}. Optional ?market=<id> filter.
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname !== "/ws") return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      const mk = url.searchParams.get("market");
      ws.market = mk == null ? null : Number(mk);
      ws.send(JSON.stringify({ type: "hello", data: { chainId: cfg.chainId, lastBlock: Number(db.getMeta("lastBlock") ?? -1) } }));
      wss.emit("connection", ws, req);
    });
  });
  const onItem = (item) => {
    const msg = JSON.stringify(item.type === "trade" ? { type: "trade", data: tradeOut(item.data) } : item);
    for (const ws of wss.clients) {
      if (ws.readyState !== 1) continue;
      if (ws.market != null && item.type === "trade" && item.data.market_id !== ws.market) continue;
      ws.send(msg);
    }
  };
  indexer.on("item", onItem);
  server.wss = wss;
  server.on("close", () => { indexer.off("item", onItem); for (const c of wss.clients) c.terminate(); });
  return server;
}

function send(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(s);
}

function clampInt(v, def, min, max) {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

function downsample(rows) {
  if (rows.length <= MAX_POINTS) return rows;
  const step = Math.ceil(rows.length / MAX_POINTS);
  return rows.filter((_, i) => i % step === 0 || i === rows.length - 1);
}
