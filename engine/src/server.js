import http from 'node:http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { openDb } from './db.js';
import { Engine, MARKETS } from './engine.js';
import { Rpc, Watcher } from './chain.js';
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

export function createApp(config, { now, rpc, log = console.log } = {}) {
  const nowFn = now || (() => Math.floor(Date.now() / 1000));
  const db = openDb(config.dbPath);
  const engine = new Engine({ db, companyAddress: config.companyAddress, now: nowFn }).init();
  rpc = rpc || new Rpc(config.rpcUrls, { log });
  const watcher = new Watcher({ engine, rpc, config, log });
  const auth = new Auth({ db, secret: config.sessionSecret, domain: config.allowedDomain, chainId: config.chainId, companyAddress: config.companyAddress, now: nowFn });
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

  // ---------------------------------------------------------------- auth
  app.post('/auth/nonce', h((req) => auth.createNonce(body(req).address)));
  app.post('/auth/verify', h((req) => auth.verify(body(req))));

  // -------------------------------------------------------------- public
  app.get('/config', h(() => ({
    chainId: config.chainId, companyAddress: config.companyAddress, usdt: { address: config.usdtAddress, decimals: config.usdtDecimals },
    confirmations: config.confirmations, minDeposit: fmtUsdt(config.minDeposit), minWithdraw: fmtUsdt(config.minWithdraw),
    fees: {
      tradingBps: Number(PARAMS.tradingFeeBps), maintenanceBps: Number(PARAMS.maintenanceMarginBps),
      liquidationFeeBps: Number(PARAMS.liquidationFeeBps), maxLeverage: Number(PARAMS.maxLeverage),
    },
    markets: MARKETS.map(({ id, symbol, name }) => ({ id, symbol, name })),
  })));
  app.get('/markets', h(() => engine.marketsView()));
  app.get('/markets/:id/history', h((req) => engine.history(marketIdOf(req.params.id), String(req.query.range || '1M'))));
  app.get('/markets/:id/trades', h((req) => {
    const limit = req.query.limit === undefined ? 50 : posInt(String(req.query.limit), 'limit');
    return engine.trades(marketIdOf(req.params.id), Math.min(Math.max(limit, 1), 500));
  }));
  app.get('/quote', h((req) => {
    const size = parseSignedWad(String(req.query.size ?? ''), 'size');
    if (size === 0n) throw new AppError('BAD_INPUT', 'size must be non-zero');
    const q = engine.quote(marketIdOf(String(req.query.marketId ?? '')), size);
    return { fillPrice: fmtWad(q.fillPrice), fee: fmtUsdt(q.fee), closeFillPrice: fmtWad(q.closeFillPrice) };
  }));
  app.get('/vault', h(() => engine.vaultView()));
  app.get('/stats', h(() => engine.stats()));
  app.get('/health', (req, res) => res.json({ ok: true, lastBlock: watcher.cursor(), chainId: config.chainId, watcherError: watcher.lastError }));

  // ------------------------------------------------------------- account
  app.get('/me', authed, h((req) => engine.me(req.user.address)));
  app.get('/me/deposits', authed, h((req) => watcher.depositsFor(req.user.address)));
  app.get('/me/withdrawals', authed, h((req) => db.prepare('SELECT * FROM withdrawals WHERE address = ? ORDER BY id DESC LIMIT 200').all(req.user.address).map((w) => engine.withdrawalView(w))));
  app.get('/me/positions', authed, h((req) => engine.positions(req.user.address)));
  app.get('/me/history', authed, h((req) => engine.userHistory(req.user.address)));

  app.post('/positions/open', authed, h((req) => {
    const b = body(req);
    return engine.openPosition(req.user.address, {
      marketId: marketIdOf(b.marketId), size: parseSignedWad(reqStr(b.size, 'size'), 'size'),
      margin: parseUsdt(reqStr(b.margin, 'margin'), 'margin'), acceptablePrice: parseWad(reqStr(b.acceptablePrice, 'acceptablePrice'), 'acceptablePrice'),
    });
  }));
  app.post('/positions/modify', authed, h((req) => {
    const b = body(req);
    const r = engine.modifyPosition(req.user.address, {
      marketId: marketIdOf(b.marketId), sizeDelta: parseSignedWad(reqStr(b.sizeDelta, 'sizeDelta'), 'sizeDelta'),
      acceptablePrice: parseWad(reqStr(b.acceptablePrice, 'acceptablePrice'), 'acceptablePrice'),
    });
    return r || { closed: true };
  }));
  app.post('/positions/close', authed, h((req) => {
    const b = body(req);
    const r = engine.closePosition(req.user.address, { marketId: marketIdOf(b.marketId), acceptablePrice: parseWad(reqStr(b.acceptablePrice, 'acceptablePrice'), 'acceptablePrice') });
    return { realizedPnl: fmtUsdt(r.realizedPnl), payout: fmtUsdt(r.payout) };
  }));
  app.post('/positions/margin', authed, h((req) => {
    const b = body(req);
    const s = reqStr(b.delta, 'delta');
    const neg = s.startsWith('-');
    const d = parseUsdt(neg ? s.slice(1) : s, 'delta');
    return engine.changeMargin(req.user.address, { marketId: marketIdOf(b.marketId), delta: neg ? -d : d });
  }));
  app.post('/vault/deposit', authed, h((req) => {
    const r = engine.vaultDeposit(req.user.address, parseUsdt(reqStr(body(req).amount, 'amount')));
    return { shares: formatUnits(r.shares, 12) };
  }));
  app.post('/vault/request-withdraw', authed, h((req) => engine.vaultRequestWithdraw(req.user.address, parseShares(reqStr(body(req).shares, 'shares')))));
  app.post('/vault/cancel-withdraw', authed, h((req) => engine.vaultCancelWithdraw(req.user.address)));
  app.post('/vault/withdraw', authed, h((req) => ({ amount: fmtUsdt(engine.vaultWithdraw(req.user.address).amount) })));
  app.post('/withdrawals', authed, h((req) => engine.requestWithdrawal(req.user.address, parseUsdt(reqStr(body(req).amount, 'amount')), config.minWithdraw)));
  app.post('/withdrawals/:id/cancel', authed, h((req) => engine.cancelWithdrawal(req.user.address, posInt(req.params.id, 'id'))));

  // --------------------------------------------------------------- admin
  app.get('/admin/overview', admin, h(async () => {
    const raw = await rpc.balanceOf(config.usdtAddress, config.companyAddress);
    const onchain = watcher.toMicro(raw);
    const l = engine.liabilities();
    const p = db.prepare("SELECT COUNT(*) AS c, COALESCE(SUM(amount), 0) AS s FROM withdrawals WHERE status = 'pending'").get();
    const ledger = engine.checkLedger();
    return {
      companyUsdtOnChain: fmtUsdt(onchain),
      liabilities: { users: fmtUsdt(l.users), vault: fmtUsdt(l.vault), protocolFees: fmtUsdt(l.protocolFees), total: fmtUsdt(l.total) },
      surplus: fmtUsdt(onchain - l.total),
      pendingWithdrawals: { count: Number(p.c), amount: fmtUsdt(BigInt(p.s)) },
      ledgerOk: ledger.ok,
    };
  }));
  app.get('/admin/withdrawals', admin, h((req) => {
    const status = String(req.query.status || 'pending');
    if (!['pending', 'paid', 'rejected', 'cancelled', 'all'].includes(status)) throw new AppError('BAD_INPUT', 'bad status');
    const rows = status === 'all' ? db.prepare('SELECT * FROM withdrawals ORDER BY id DESC LIMIT 500').all()
      : db.prepare('SELECT * FROM withdrawals WHERE status = ? ORDER BY id LIMIT 500').all(status);
    return rows.map((w) => ({ ...engine.withdrawalView(w), address: w.address }));
  }));
  app.post('/admin/withdrawals/:id/paid', admin, h((req) => watcher.verifyAndMarkPaid(posInt(req.params.id, 'id'), body(req).txHash)));
  app.post('/admin/withdrawals/:id/reject', admin, h((req) => {
    const reason = body(req).reason;
    if (reason !== undefined && (typeof reason !== 'string' || reason.length > 500)) throw new AppError('BAD_INPUT', 'reason must be a string');
    return engine.rejectWithdrawal(posInt(req.params.id, 'id'), reason);
  }));
  app.post('/admin/index', admin, h((req) => {
    const b = body(req);
    if (b.source !== undefined && (typeof b.source !== 'string' || b.source.length > 200)) throw new AppError('BAD_INPUT', 'source must be a string');
    return engine.pushIndex(marketIdOf(reqStr(b.symbol, 'symbol')), parseWad(reqStr(b.value, 'value'), 'value'), b.source || 'admin');
  }));
  app.post('/admin/schedule-print', admin, h((req) => {
    const b = body(req);
    if (!Number.isInteger(b.at) || b.at < 0) throw new AppError('BAD_INPUT', 'at must be a unix timestamp (0 cancels)');
    return engine.schedulePrint(marketIdOf(reqStr(b.symbol, 'symbol')), b.at);
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
  app.get('/admin/ledger-check', admin, h(() => { const c = engine.checkLedger(); return { ok: c.ok, total: c.total.toString(), errors: c.errors }; }));

  app.use((req, res) => res.status(404).json({ error: 'NOT_FOUND', message: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof AppError) return res.status(err.status).json({ error: err.code, message: err.message });
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'BAD_INPUT', message: 'Invalid JSON' });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'BAD_INPUT', message: 'Body too large' });
    log(`internal error ${req.method} ${req.path}: ${err && err.stack}`);
    res.status(500).json({ error: 'INTERNAL', message: 'Internal error' });
  });

  // ------------------------------------------------------------ server/ws
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const sockets = new Set();
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ws') return socket.destroy();
    const origin = req.headers.origin;
    if (origin && !config.corsOrigins.includes(origin)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      const s = url.searchParams.get('token') ? auth.check(url.searchParams.get('token')) : null;
      ws.address = s ? s.address : null;
      sockets.add(ws);
      ws.on('close', () => sockets.delete(ws));
      ws.on('error', () => sockets.delete(ws));
      try { ws.send(JSON.stringify({ type: 'markets', data: engine.marketsView() })); } catch { /* ignore */ }
    });
  });
  const send = (ws, type, data) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type, data })); };
  const broadcast = (type, data) => { for (const ws of sockets) send(ws, type, data); };
  const toUser = (address, type, data) => { for (const ws of sockets) if (ws.address === address) send(ws, type, data); };

  engine.on('trade', (t) => broadcast('trade', t));
  const meDirty = new Set();
  engine.on('me', (a) => meDirty.add(a));
  engine.on('deposit', (d) => toUser(d.address, 'deposit', d));
  engine.on('withdrawal', (w) => toUser(w.address, 'withdrawal', w));
  const flushMe = () => {
    for (const a of meDirty) {
      if ([...sockets].some((ws) => ws.address === a)) {
        try { toUser(a, 'me', { ...engine.me(a), positions: engine.positions(a) }); } catch (e) { log(`ws me error ${e.message}`); }
      }
    }
    meDirty.clear();
  };

  let loopTimer = null;
  const tick = () => {
    try {
      const liq = engine.tick();
      for (const l of liq) log(`liquidated ${l.address} market ${l.marketId}`);
      if (sockets.size) broadcast('markets', engine.marketsView());
      flushMe();
    } catch (e) { log(`loop error: ${e.stack}`); }
  };

  return {
    app, server, engine, watcher, auth, db, rpc, tick,
    async start(port = config.port) {
      await new Promise((r) => server.listen(port, r));
      loopTimer = setInterval(tick, config.loopMs);
      if (config.watcherEnabled) watcher.start();
      return server.address().port;
    },
    async stop() {
      clearInterval(loopTimer);
      watcher.stop();
      for (const ws of sockets) ws.terminate();
      await new Promise((r) => server.close(() => r()));
      db.close();
    },
  };
}

export { normAddress, abs };
