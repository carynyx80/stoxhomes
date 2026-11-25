import http from 'node:http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { openDb } from './db.js';
import { Engine, MARKETS } from './engine.js';
import { Rpc, Watcher } from './chain.js';
import { SolRpc, SolanaAdapter } from './solana.js';
import { Auth, normAddress } from './auth.js';
import { AppError, parseUsdt, parseWad, parseSignedWad, parseShares, fmtUsdt, fmtWad, formatUnits, abs } from './fixed.js';
import { PARAMS } from './math.js';

class RateLimiter {
  constructor(limit, windowMs = 60_000) { this.limit = limit; this.windowMs = windowMs; this.map = new Map(); }
  hit(key) {
    const now = Date.now();
    let e = this.map.get(key);
    if (!e || now - e.start >= this.windowMs) { e = { start: now, count: 0 }; this.map.set(key, e); }
    e.count++;
    if (this.map.size > 50_000) for (const [k, v] of this.map) if (now - v.start >= this.windowMs) this.map.delete(k);
    return e.count <= this.limit;
  }
}

const marketIdOf = (v) => {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1000) return v;
  if (typeof v === 'string' && /^(\d{1,3}|[A-Za-z]{2,5})$/.test(v)) return v;
  throw new AppError('BAD_INPUT', 'marketId invalid');
};
const reqStr = (v, field) => { if (typeof v !== 'string') throw new AppError('BAD_INPUT', `${field} required`); return v; };
const posInt = (v, field) => {
  if (typeof v !== 'string' || !/^\d{1,12}$/.test(v)) throw new AppError('BAD_INPUT', `${field} must be a positive integer`);
  return Number(v);
};

/** Merge historical monthly prints with the engine's own prints, filtered by range, sorted, de-duplicated by time. */
export function mergePrints(own, histPrints, range, nowSec) {
  const days = { '1M': 30, '6M': 182, '1Y': 365, '5Y': 1826, ALL: Infinity }[range];
  const since = days === Infinity ? -Infinity : nowSec - days * 86400;
  const norm = (x) => {
    if (!x) return null;
    let at = x.at ?? x.t ?? x.time;
    if (at === undefined && (x.date || x.month)) at = Math.floor(Date.parse(x.date || `${x.month}-01`) / 1000);
    const value = x.value ?? x.v ?? x.price;
    if (!Number.isFinite(Number(at)) || value === undefined || value === null) return null;
    return { at: Number(at), value: String(value), source: 'historical' };
  };
  const histOut = (Array.isArray(histPrints) ? histPrints : []).map(norm).filter(Boolean);
  const firstOwn = own.length ? Math.min(...own.map((p) => p.at)) : Infinity;
  const merged = [...histOut.filter((p) => p.at < firstOwn), ...own].filter((p) => p.at >= since);
  merged.sort((a, b) => a.at - b.at);
  return merged;
}

export function createApp(config, { now, rpc, log = console.log } = {}) {
  const nowFn = now || (() => Math.floor(Date.now() / 1000));
  const db = openDb(config.dbPath);
  const engine = new Engine({ db, companyAddress: config.companyAddress, now: nowFn, skewScale: config.skewScale }).init();
  // Practice mode: a fully separate engine + SQLite file. No watcher, no deposits/withdrawals; prices mirror the real engine.
  let practice = null;
  let practiceDb = null;
  if (config.practiceEnabled) {
    practiceDb = openDb(config.practiceDbPath);
    practice = new Engine({ db: practiceDb, companyAddress: config.companyAddress, now: nowFn, skewScale: config.skewScale, practice: true }).init();
    practice.mirrorFeedsFrom(engine);
    if (practice.totalShares() === 0n && practice.balance('vault') === 0n) practice.seedVault(config.practiceSeed);
  }
  const mirror = () => { if (practice) practice.mirrorFeedsFrom(engine); };
  const solana = config.chain === 'solana';
  // engine/src/historical.js is maintained separately; load it lazily and retry until it exists.
  let historical = null;
  let historicalTriedAt = 0;
  const loadHistorical = async () => {
    if (historical) return historical;
    if (Date.now() - historicalTriedAt < 30_000) return null;
    historicalTriedAt = Date.now();
    try { historical = await import('./historical.js'); } catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') log(`historical.js failed to load: ${e.message}`); }
    return historical;
  };
  rpc = rpc || (solana ? new SolRpc(config.rpcUrls, { log }) : new Rpc(config.rpcUrls, { log }));
  const watcher = solana ? new SolanaAdapter({ engine, rpc, config, log }) : new Watcher({ engine, rpc, config, log });
  const auth = new Auth({ db, secret: config.sessionSecret, domain: config.allowedDomain, chainId: config.chainId, companyAddress: config.companyAddress, now: nowFn, chain: solana ? 'solana' : 'evm' });
  const ipLimiter = new RateLimiter(config.rateLimitPerMin);
  const addrLimiter = new RateLimiter(config.rateLimitAddrPerMin);

  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && config.corsOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return res.status(origin && config.corsOrigins.includes(origin) ? 204 : 403).end();
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    if (req.path !== '/health' && !ipLimiter.hit(req.ip || 'unknown')) return next(new AppError('RATE_LIMITED', 'Too many requests', 429));
    next();
  });
  app.use(express.json({ limit: '16kb', strict: true }));

  const authed = (req, res, next) => {
    const h = req.headers.authorization || '';
    const s = h.startsWith('Bearer ') ? auth.check(h.slice(7)) : null;
    if (!s) return next(new AppError('UNAUTHORIZED', 'Sign in required', 401));
    if (!addrLimiter.hit(s.address)) return next(new AppError('RATE_LIMITED', 'Too many requests', 429));
    req.user = s;
    next();
  };
  const admin = (req, res, next) => authed(req, res, (err) => {
    if (err) return next(err);
    if (!req.user.isAdmin) return next(new AppError('UNAUTHORIZED', 'Admin only', 403));
    next();
  });
  const h = (fn) => (req, res, next) => {
    Promise.resolve().then(() => fn(req, res)).then((out) => { if (!res.headersSent) res.json(out ?? {}); }).catch(next);
  };
  const body = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

  const safe = (fn) => { try { return fn(); } catch (e) { log(`historical: ${e.message}`); return null; } };
  const numStr = (v) => (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v)) ? null : String(v));
  const tradingState = (eng) => (eng.poolValue() > 0n ? { tradingOpen: true } : { tradingOpen: false, reason: 'liquidity' });

  /** Engine-generic REST routes, mounted for the real engine at / and the practice engine at /practice. */
  const engineRoutes = (r, eng) => {
    r.get('/markets', h(async () => {
      const hist = await loadHistorical();
      const open = tradingState(eng);
      return eng.marketsView().map((m) => ({ ...m, change1y: hist ? numStr(safe(() => hist.changeOver(m.symbol, 12))) : null, ...open }));
    }));
    r.get('/markets/:id/history', h(async (req) => {
      const range = String(req.query.range || '1M');
      const out = eng.history(marketIdOf(req.params.id), range);
      const hist = await loadHistorical();
      if (hist) out.prints = mergePrints(out.prints, safe(() => hist.getMonthlyPrints(eng.resolveMarket(marketIdOf(req.params.id)).symbol)), range, eng.now());
      return out;
    }));
    r.get('/markets/:id/trades', h((req) => {
      const limit = req.query.limit === undefined ? 50 : posInt(String(req.query.limit), 'limit');
      return eng.trades(marketIdOf(req.params.id), Math.min(Math.max(limit, 1), 500));
    }));
    r.get('/quote', h((req) => {
      const size = parseSignedWad(String(req.query.size ?? ''), 'size');
      if (size === 0n) throw new AppError('BAD_INPUT', 'size must be non-zero');
      const q = eng.quote(marketIdOf(String(req.query.marketId ?? '')), size);
      return { fillPrice: fmtWad(q.fillPrice), fee: fmtUsdt(q.fee), closeFillPrice: fmtWad(q.closeFillPrice) };
    }));
    r.get('/vault', h(() => eng.vaultView()));
    r.get('/stats', h(() => eng.stats()));
    r.get('/me', authed, h((req) => eng.me(req.user.address)));
    r.get('/me/positions', authed, h((req) => eng.positions(req.user.address)));
    r.get('/me/history', authed, h((req) => eng.userHistory(req.user.address)));
    r.post('/positions/open', authed, h((req) => {
      const b = body(req);
      return eng.openPosition(req.user.address, {
        marketId: marketIdOf(b.marketId), size: parseSignedWad(reqStr(b.size, 'size'), 'size'),
        margin: parseUsdt(reqStr(b.margin, 'margin'), 'margin'), acceptablePrice: parseWad(reqStr(b.acceptablePrice, 'acceptablePrice'), 'acceptablePrice'),
      });
    }));
    r.post('/positions/modify', authed, h((req) => {
      const b = body(req);
      const r = eng.modifyPosition(req.user.address, {
        marketId: marketIdOf(b.marketId), sizeDelta: parseSignedWad(reqStr(b.sizeDelta, 'sizeDelta'), 'sizeDelta'),
        acceptablePrice: parseWad(reqStr(b.acceptablePrice, 'acceptablePrice'), 'acceptablePrice'),
      });
      return r || { closed: true };
    }));
    r.post('/positions/close', authed, h((req) => {
      const b = body(req);
      const r = eng.closePosition(req.user.address, { marketId: marketIdOf(b.marketId), acceptablePrice: parseWad(reqStr(b.acceptablePrice, 'acceptablePrice'), 'acceptablePrice') });
      return { realizedPnl: fmtUsdt(r.realizedPnl), payout: fmtUsdt(r.payout) };
    }));
    r.post('/positions/margin', authed, h((req) => {
      const b = body(req);
      const s = reqStr(b.delta, 'delta');
      const neg = s.startsWith('-');
      const d = parseUsdt(neg ? s.slice(1) : s, 'delta');
      return eng.changeMargin(req.user.address, { marketId: marketIdOf(b.marketId), delta: neg ? -d : d });
    }));
    r.post('/vault/deposit', authed, h((req) => {
      const r = eng.vaultDeposit(req.user.address, parseUsdt(reqStr(body(req).amount, 'amount')));
      return { shares: formatUnits(r.shares, 12) };
    }));
    r.post('/vault/request-withdraw', authed, h((req) => eng.vaultRequestWithdraw(req.user.address, parseShares(reqStr(body(req).shares, 'shares')))));
    r.post('/vault/cancel-withdraw', authed, h((req) => eng.vaultCancelWithdraw(req.user.address)));
    r.post('/vault/withdraw', authed, h((req) => ({ amount: fmtUsdt(eng.vaultWithdraw(req.user.address).amount) })));
  };

  // ---------------------------------------------------------------- auth
  app.post('/auth/nonce', h((req) => auth.createNonce(body(req).address)));
  app.post('/auth/verify', h((req) => auth.verify(body(req))));

  // -------------------------------------------------------------- public
  app.get('/config', h(() => ({
    ...watcher.configView(), minDeposit: fmtUsdt(config.minDeposit), minWithdraw: fmtUsdt(config.minWithdraw),
    fees: {
      tradingBps: Number(PARAMS.tradingFeeBps), maintenanceBps: Number(PARAMS.maintenanceMarginBps),
      liquidationFeeBps: Number(PARAMS.liquidationFeeBps), maxLeverage: Number(PARAMS.maxLeverage),
    },
    markets: MARKETS.map(({ id, symbol, name }) => ({ id, symbol, name })),
    practiceAvailable: !!practice,
    ...tradingState(engine),
  })));
  engineRoutes(app, engine);
  app.get('/health', (req, res) => res.json({ ok: true, ...watcher.health(), watcherError: watcher.lastError }));

  // ------------------------------------------------------------- account
  app.get('/me/deposits', authed, h((req) => watcher.depositsFor(req.user.address)));
  app.get('/me/withdrawals', authed, h((req) => db.prepare('SELECT * FROM withdrawals WHERE address = ? ORDER BY id DESC LIMIT 200').all(req.user.address).map((w) => engine.withdrawalView(w))));

  app.post('/withdrawals', authed, h((req) => engine.requestWithdrawal(req.user.address, parseUsdt(reqStr(body(req).amount, 'amount')), config.minWithdraw, watcher.withdrawToken(body(req).token))));
  app.post('/withdrawals/:id/cancel', authed, h((req) => engine.cancelWithdrawal(req.user.address, posInt(req.params.id, 'id'))));

  // --------------------------------------------------------------- admin
  app.get('/admin/overview', admin, h(async () => {
    const { onchain, fields, liabilities: l } = await watcher.overview(engine);
    const p = db.prepare("SELECT COUNT(*) AS c, COALESCE(SUM(amount), 0) AS s FROM withdrawals WHERE status = 'pending'").get();
    const ledger = engine.checkLedger();
    return {
      ...fields,
      liabilities: { users: fmtUsdt(l.users), vault: fmtUsdt(l.vault), protocolFees: fmtUsdt(l.protocolFees), total: fmtUsdt(l.total) },
      surplus: fmtUsdt(onchain - l.total),
      pendingWithdrawals: { count: Number(p.c), amount: fmtUsdt(BigInt(p.s)) },
      ledgerOk: ledger.ok,
      setup: setupChecklist(fields, onchain, l),
    };
  }));
  /** What the company still has to do before real trading can open. */
  const setupChecklist = (fields, onchain, l) => {
    const vaultValue = engine.poolValue();
    const minSol = 0.05;
    const sol = fields.companySol !== undefined ? fields.companySol : null;
    return {
      solOk: sol === null ? null : Number(sol) >= minSol, sol, minSol: String(minSol),
      capitalOk: onchain > 0n && onchain >= l.total, companyOnChain: fmtUsdt(onchain), liabilities: fmtUsdt(l.total),
      vaultSeeded: vaultValue > 0n, vaultValue: fmtUsdt(vaultValue),
    };
  };
  app.get('/admin/withdrawals', admin, h((req) => {
    const status = String(req.query.status || 'pending');
    if (!['pending', 'paid', 'rejected', 'cancelled', 'all'].includes(status)) throw new AppError('BAD_INPUT', 'bad status');
    const rows = status === 'all' ? db.prepare('SELECT * FROM withdrawals ORDER BY id DESC LIMIT 500').all()
      : db.prepare('SELECT * FROM withdrawals WHERE status = ? ORDER BY id LIMIT 500').all(status);
    return rows.map((w) => ({ ...engine.withdrawalView(w), address: w.address }));
  }));
  app.post('/admin/withdrawals/:id/paid', admin, h((req) => watcher.markPaid(posInt(req.params.id, 'id'), body(req))));
  app.post('/admin/withdrawals/:id/lock', admin, h((req) => engine.lockWithdrawal(posInt(req.params.id, 'id'), watcher.lockInfo(body(req)))));
  app.get('/admin/alerts', admin, h((req) => engine.alerts(req.query.status === 'all' ? 'all' : 'open')));
  app.post('/admin/alerts/:id/resolve', admin, h((req) => engine.resolveAlert(posInt(req.params.id, 'id'), body(req).action)));
  app.post('/admin/withdrawals/:id/reject', admin, h((req) => {
    const reason = body(req).reason;
    if (reason !== undefined && (typeof reason !== 'string' || reason.length > 500)) throw new AppError('BAD_INPUT', 'reason must be a string');
    const id = posInt(req.params.id, 'id');
    const w = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);
    if (w && w.status === 'pending' && w.processing_at) {
      return watcher.verifyUnlock(w).then(() => engine.rejectWithdrawal(id, reason, { unlockVerified: true }));
    }
    return engine.rejectWithdrawal(id, reason);
  }));
  app.post('/admin/index', admin, h((req) => {
    const b = body(req);
    if (b.source !== undefined && (typeof b.source !== 'string' || b.source.length > 200)) throw new AppError('BAD_INPUT', 'source must be a string');
    const r = engine.pushIndex(marketIdOf(reqStr(b.symbol, 'symbol')), parseWad(reqStr(b.value, 'value'), 'value'), b.source || 'admin');
    mirror();
    return r;
  }));
  app.post('/admin/schedule-print', admin, h((req) => {
    const b = body(req);
    if (!Number.isInteger(b.at) || b.at < 0) throw new AppError('BAD_INPUT', 'at must be a unix timestamp (0 cancels)');
    const r = engine.schedulePrint(marketIdOf(reqStr(b.symbol, 'symbol')), b.at);
    mirror();
    return r;
  }));
  app.post('/admin/markets/:id', admin, h((req) => {
    const b = body(req);
    if (typeof b.active !== 'boolean') throw new AppError('BAD_INPUT', 'active must be boolean');
    return engine.setActive(marketIdOf(req.params.id), b.active);
  }));
  app.post('/admin/vault/seed', admin, h((req) => {
    const r = engine.seedVault(parseUsdt(reqStr(body(req).amount, 'amount')));
    return { shares: formatUnits(r.shares, 12) };
  }));
  watcher.extraRoutes(app, { authed, admin, h, body });
  app.get('/admin/ledger-check', admin, h(() => { const c = engine.checkLedger(); return { ok: c.ok, total: c.total.toString(), errors: c.errors }; }));

  if (practice) {
    const pr = express.Router();
    const practiceOnly = () => { throw new AppError('PRACTICE_ONLY', 'Practice mode uses play money: deposits and withdrawals are disabled'); };
    pr.get('/config', h(() => ({
      practice: true, chain: config.chain, faucetAmount: fmtUsdt(config.faucetAmount), faucetCooldown: 86400,
      fees: {
        tradingBps: Number(PARAMS.tradingFeeBps), maintenanceBps: Number(PARAMS.maintenanceMarginBps),
        liquidationFeeBps: Number(PARAMS.liquidationFeeBps), maxLeverage: Number(PARAMS.maxLeverage),
      },
      markets: MARKETS.map(({ id, symbol, name }) => ({ id, symbol, name })),
      ...tradingState(practice),
    })));
    pr.get('/health', (req, res) => res.json({ ok: true, practice: true }));
    pr.post('/faucet', authed, h((req) => {
      const r = practice.faucet(req.user.address, config.faucetAmount);
      return { amount: fmtUsdt(r.amount), nextAt: r.nextAt };
    }));
    for (const p of ['/me/deposits', '/me/withdrawals']) pr.get(p, authed, h(practiceOnly));
    for (const p of ['/withdrawals', '/withdrawals/:id/cancel', '/deposits']) pr.post(p, authed, h(practiceOnly));
    pr.all(/^\/admin\//, h(practiceOnly));
    engineRoutes(pr, practice);
    app.use('/practice', pr);
  }

  app.use((req, res) => res.status(404).json({ error: 'NOT_FOUND', message: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof AppError) return res.status(err.status).json({ error: err.code, message: err.message, ...(err.extra || {}) });
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'BAD_INPUT', message: 'Invalid JSON' });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'BAD_INPUT', message: 'Body too large' });
    log(`internal error ${req.method} ${req.path}: ${err && err.stack}`);
    res.status(500).json({ error: 'INTERNAL', message: 'Internal error' });
  });

  // ------------------------------------------------------------ server/ws
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const channels = new Map(); // ws path -> { engine, sockets, meDirty }
  const send = (ws, type, data) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type, data })); };
  const addChannel = (path, eng) => {
    const ch = { engine: eng, sockets: new Set(), meDirty: new Set() };
    const broadcast = (type, data) => { for (const ws of ch.sockets) send(ws, type, data); };
    ch.toUser = (address, type, data) => { for (const ws of ch.sockets) if (ws.address === address) send(ws, type, data); };
    ch.broadcast = broadcast;
    eng.on('trade', (t) => broadcast('trade', t));
    eng.on('me', (a) => ch.meDirty.add(a));
    eng.on('deposit', (d) => ch.toUser(d.address, 'deposit', d));
    eng.on('withdrawal', (w) => ch.toUser(w.address, 'withdrawal', w));
    channels.set(path, ch);
  };
  addChannel('/ws', engine);
  if (practice) addChannel('/practice/ws', practice);
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    const ch = channels.get(url.pathname);
    if (!ch) return socket.destroy();
    const origin = req.headers.origin;
    if (origin && !config.corsOrigins.includes(origin)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      const s = url.searchParams.get('token') ? auth.check(url.searchParams.get('token')) : null;
      ws.address = s ? s.address : null;
      ch.sockets.add(ws);
      ws.on('close', () => ch.sockets.delete(ws));
      ws.on('error', () => ch.sockets.delete(ws));
      try { ws.send(JSON.stringify({ type: 'markets', data: ch.engine.marketsView() })); } catch { /* ignore */ }
    });
  });
  const flushMe = (ch) => {
    for (const a of ch.meDirty) {
      if ([...ch.sockets].some((ws) => ws.address === a)) {
        try { ch.toUser(a, 'me', { ...ch.engine.me(a), positions: ch.engine.positions(a) }); } catch (e) { log(`ws me error ${e.message}`); }
      }
    }
    ch.meDirty.clear();
  };

  let loopTimer = null;
  const tick = () => {
    for (const [path, ch] of channels) {
      try {
        const liq = ch.engine.tick();
        for (const l of liq) log(`${path === '/ws' ? '' : 'practice: '}liquidated ${l.address} market ${l.marketId}`);
        if (ch.sockets.size) ch.broadcast('markets', ch.engine.marketsView());
        flushMe(ch);
      } catch (e) { log(`loop error (${path}): ${e.stack}`); }
    }
  };

  return {
    app, server, engine, practice, watcher, auth, db, rpc, tick,
    async start(port = config.port) {
      await new Promise((r) => server.listen(port, r));
      loopTimer = setInterval(tick, config.loopMs);
      if (config.watcherEnabled) watcher.start();
      return server.address().port;
    },
    async stop() {
      clearInterval(loopTimer);
      watcher.stop();
      for (const ch of channels.values()) for (const ws of ch.sockets) ws.terminate();
      await new Promise((r) => server.close(() => r()));
      db.close();
      if (practiceDb) practiceDb.close();
    },
  };
}

export { normAddress, abs };
