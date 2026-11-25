import { EventEmitter } from 'node:events';
import {
  WAD, BPS, AppError, abs, min, floorDiv, WAD_PER_MICRO, notionalMicro, fmtUsdt, fmtWad, formatUnits,
} from './fixed.js';
import * as M from './math.js';

const P = M.PARAMS;

export const MARKETS = [
  { id: 0, symbol: 'NYC', name: 'New York', start: '351.78' },
  { id: 1, symbol: 'LA', name: 'Los Angeles', start: '446.20' },
  { id: 2, symbol: 'MIA', name: 'Miami', start: '454.64' },
  { id: 3, symbol: 'SF', name: 'San Francisco', start: '367.95' },
  { id: 4, symbol: 'LDN', name: 'London', start: '95.6' },
];

const n = (x) => (x === null || x === undefined ? null : Number(x));
const B = (x) => BigInt(x);
const isExternal = (acct) => acct.startsWith('external:') || acct.startsWith('company:');

export const acct = {
  available: (a) => `user:${a}:available`,
  margin: (a) => `user:${a}:margin`,
  locked: (a) => `user:${a}:withdraw_locked`,
  vault: 'vault',
  fees: 'protocol_fees',
  deposits: 'external:deposits',
  withdrawals: 'external:withdrawals',
  equity: 'company:equity',
};

function wadFromDecimal(s) {
  const [i, f = ''] = s.split('.');
  return BigInt(i) * WAD + BigInt((f + '0'.repeat(18)).slice(0, 18));
}

function ratioStr(num, den, decimals = 6) {
  if (den === 0n) return '0';
  return formatUnits((num * 10n ** BigInt(decimals)) / den, decimals);
}

export class Engine extends EventEmitter {
  constructor({ db, companyAddress, now }) {
    super();
    this.db = db;
    this.company = companyAddress; // already normalized by the chain config (EVM lowercase, Solana base58)
    this.now = now || (() => Math.floor(Date.now() / 1000));
    this._events = [];
    this._txId = 0n;
    this._prepare();
  }

  _prepare() {
    const db = this.db;
    this.s = {
      insEntry: db.prepare('INSERT INTO ledger_entries (tx_id, account, amount, ref, at) VALUES (?, ?, ?, ?, ?)'),
      getBal: db.prepare('SELECT balance FROM balances WHERE account = ?'),
      upBal: db.prepare('INSERT INTO balances (account, balance) VALUES (?, ?) ON CONFLICT(account) DO UPDATE SET balance = balance + excluded.balance'),
      getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
      setMeta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
      market: db.prepare('SELECT * FROM markets WHERE id = ?'),
      marketBySymbol: db.prepare('SELECT * FROM markets WHERE symbol = ?'),
      markets: db.prepare('SELECT * FROM markets ORDER BY id'),
      saveMarket: db.prepare(`UPDATE markets SET active=@active, skew=@skew, sum_size_entry=@sumSizeEntry, sum_size_funding=@sumSizeFunding,
        funding_index=@fundingIndex, last_funding_time=@lastFundingTime, long_size=@longSize, short_size=@shortSize, margin_total=@marginTotal,
        from_price=@fromPrice, to_price=@toPrice, updated_at=@updatedAt, period=@period, scheduled_print=@scheduledPrint WHERE id=@id`),
      pos: db.prepare('SELECT * FROM positions WHERE market_id = ? AND address = ?'),
      posByAddr: db.prepare('SELECT * FROM positions WHERE address = ? ORDER BY market_id'),
      allPos: db.prepare('SELECT * FROM positions'),
      upsertPos: db.prepare(`INSERT INTO positions (market_id, address, size, margin, entry_price, entry_funding, size_entry, opened_at)
        VALUES (@marketId, @address, @size, @margin, @entryPrice, @entryFunding, @sizeEntry, @openedAt)
        ON CONFLICT(market_id, address) DO UPDATE SET size=excluded.size, margin=excluded.margin, entry_price=excluded.entry_price,
        entry_funding=excluded.entry_funding, size_entry=excluded.size_entry`),
      delPos: db.prepare('DELETE FROM positions WHERE market_id = ? AND address = ?'),
      insTrade: db.prepare(`INSERT INTO trades (at, market_id, address, side, kind, size, price, notional, leverage, fee, vault_fee, realized_pnl, payout)
        VALUES (@at, @marketId, @address, @side, @kind, @size, @price, @notional, @leverage, @fee, @vaultFee, @realizedPnl, @payout)`),
      insMarginEv: db.prepare('INSERT INTO margin_events (at, market_id, address, delta, kind) VALUES (?, ?, ?, ?, ?)'),
      vs: db.prepare('SELECT * FROM vault_shares WHERE address = ?'),
      upsertVs: db.prepare(`INSERT INTO vault_shares (address, shares, pending_shares, pending_value, unlock_at) VALUES (@address, @shares, @pendingShares, @pendingValue, @unlockAt)
        ON CONFLICT(address) DO UPDATE SET shares=excluded.shares, pending_shares=excluded.pending_shares, pending_value=excluded.pending_value, unlock_at=excluded.unlock_at`),
      insVaultEv: db.prepare('INSERT INTO vault_events (at, address, kind, amount, shares) VALUES (?, ?, ?, ?, ?)'),
      insUser: db.prepare('INSERT OR IGNORE INTO users (address, created_at) VALUES (?, ?)'),
      insPrint: db.prepare('INSERT INTO prints (market_id, value, source, at) VALUES (?, ?, ?, ?)'),
      insSnap: db.prepare('INSERT INTO snapshots (market_id, at, index_price, mark_price, funding_rate, long_oi, short_oi) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      wd: db.prepare('SELECT * FROM withdrawals WHERE id = ?'),
      insWd: db.prepare('INSERT INTO withdrawals (address, amount, to_addr, status, created_at, updated_at, token) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      setWd: db.prepare('UPDATE withdrawals SET status = ?, tx_hash = COALESCE(?, tx_hash), reason = COALESCE(?, reason), updated_at = ? WHERE id = ?'),
    };
  }

  // ------------------------------------------------------------------ infra

  init() {
    this.tx(() => {
      const now = this.now();
      if (!this.s.getMeta.get('total_shares')) this.s.setMeta.run('total_shares', '0');
      const ins = this.db.prepare(`INSERT OR IGNORE INTO markets (id, symbol, name, active, skew_scale, max_funding, max_skew_bps, skew, sum_size_entry, sum_size_funding,
        funding_index, last_funding_time, long_size, short_size, margin_total, from_price, to_price, updated_at, period, scheduled_print)
        VALUES (?, ?, ?, 1, ?, ?, ?, '0', '0', '0', '0', ?, '0', '0', 0, ?, ?, ?, ?, 0)`);
      for (const mk of MARKETS) {
        const p = wadFromDecimal(mk.start).toString();
        const r = ins.run(mk.id, mk.symbol, mk.name, P.skewScale.toString(), P.maxFundingRatePerDay.toString(), P.maxSkewToPoolBps, now, p, p, now, P.smoothingPeriod);
        if (r.changes) this.s.insPrint.run(mk.id, p, 'genesis', now);
      }
    });
    return this;
  }

  /** Run fn in one IMMEDIATE transaction; events emitted only after commit. */
  tx(fn) {
    if (this.db.inTransaction) return fn();
    const events = [];
    this._events = events;
    let result;
    try {
      result = this.db.transaction(fn).immediate();
    } finally {
      this._events = [];
    }
    for (const [name, data] of events) this.emit(name, data);
    return result;
  }

  _emit(name, data) {
    this._events.push([name, data]);
  }

  /** Append balanced double-entry postings. entries: [[account, bigint], ...] */
  post(entries, ref) {
    const at = this.now();
    const merged = new Map();
    for (const [a, v] of entries) {
      if (typeof v !== 'bigint') throw new Error('ledger amounts must be bigint');
      merged.set(a, (merged.get(a) || 0n) + v);
    }
    let sum = 0n;
    for (const v of merged.values()) sum += v;
    if (sum !== 0n) throw new Error(`unbalanced ledger posting (${sum}) for ${ref}`);
    const txId = this._nextTxId();
    for (const [a, v] of merged) {
      if (v === 0n) continue;
      this.s.insEntry.run(txId, a, v, ref, at);
      this.s.upBal.run(a, v);
      if (!isExternal(a)) {
        const bal = this.balance(a);
        if (bal < 0n) {
          if (a === acct.vault) throw new AppError('INSUFFICIENT_LIQUIDITY', 'Vault cash is insufficient for this operation');
          throw new AppError('INSUFFICIENT_BALANCE', 'Insufficient balance');
        }
      }
    }
  }

  _nextTxId() {
    const r = this.db.prepare('SELECT COALESCE(MAX(tx_id), 0) AS m FROM ledger_entries').get();
    return B(r.m) + 1n;
  }

  balance(account) {
    const r = this.s.getBal.get(account);
    return r ? B(r.balance) : 0n;
  }

  /** Full ledger check: entries sum to zero, cached balances match, no negative internal account. */
  checkLedger() {
    const total = B(this.db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM ledger_entries').get().s);
    const sums = this.db.prepare('SELECT account, SUM(amount) AS s FROM ledger_entries GROUP BY account').all();
    const errors = [];
    if (total !== 0n) errors.push(`ledger sum ${total} != 0`);
    const bal = new Map(this.db.prepare('SELECT account, balance FROM balances').all().map((r) => [r.account, B(r.balance)]));
    for (const r of sums) {
      const s = B(r.s);
      if ((bal.get(r.account) || 0n) !== s) errors.push(`balance mismatch ${r.account}: ${bal.get(r.account)} vs ${s}`);
      if (!isExternal(r.account) && s < 0n) errors.push(`negative balance ${r.account}: ${s}`);
      bal.delete(r.account);
    }
    for (const [a, v] of bal) if (v !== 0n) errors.push(`balance without entries ${a}`);
    // Position margins must equal the margin accounts and market totals.
    const posMargin = new Map();
    const mktMargin = new Map();
    for (const p of this.s.allPos.all()) {
      posMargin.set(p.address, (posMargin.get(p.address) || 0n) + B(p.margin));
      mktMargin.set(n(p.market_id), (mktMargin.get(n(p.market_id)) || 0n) + B(p.margin));
    }
    for (const r of this.db.prepare("SELECT account, balance FROM balances WHERE account LIKE 'user:%:margin'").all()) {
      const addr = r.account.split(':')[1];
      if (B(r.balance) !== (posMargin.get(addr) || 0n)) errors.push(`margin account mismatch ${addr}`);
    }
    for (const m of this.s.markets.all()) {
      if (B(m.margin_total) !== (mktMargin.get(n(m.id)) || 0n)) errors.push(`market margin_total mismatch ${m.id}`);
    }
    // Locked withdrawal accounts equal pending withdrawals.
    const pend = new Map();
    for (const w of this.db.prepare("SELECT address, amount FROM withdrawals WHERE status = 'pending'").all()) {
      pend.set(w.address, (pend.get(w.address) || 0n) + B(w.amount));
    }
    for (const r of this.db.prepare("SELECT account, balance FROM balances WHERE account LIKE 'user:%:withdraw_locked'").all()) {
      const addr = r.account.split(':')[1];
      if (B(r.balance) !== (pend.get(addr) || 0n)) errors.push(`withdraw_locked mismatch ${addr}`);
    }
    return { ok: errors.length === 0, total, errors };
  }

  liabilities() {
    const users = B(this.db.prepare("SELECT COALESCE(SUM(balance), 0) AS s FROM balances WHERE account LIKE 'user:%'").get().s);
    const locked = B(this.db.prepare("SELECT COALESCE(SUM(balance), 0) AS s FROM balances WHERE account LIKE 'user:%:withdraw_locked'").get().s);
    const vault = this.balance(acct.vault);
    const protocolFees = this.balance(acct.fees);
    const external = B(this.db.prepare("SELECT COALESCE(SUM(balance), 0) AS s FROM balances WHERE account LIKE 'external:%' OR account LIKE 'company:%'").get().s);
    return { users, lockedWithdrawals: locked, vault, protocolFees, total: users + vault + protocolFees, external };
  }

  ensureUser(address) {
    this.s.insUser.run(address, this.now());
  }

  // ---------------------------------------------------------------- markets

  _rowToMarket(r) {
    return {
      id: n(r.id), symbol: r.symbol, name: r.name, active: !!n(r.active),
      skewScale: B(r.skew_scale), maxFunding: B(r.max_funding), maxSkewBps: B(r.max_skew_bps),
      skew: B(r.skew), sumSizeEntry: B(r.sum_size_entry), sumSizeFunding: B(r.sum_size_funding),
      fundingIndex: B(r.funding_index), lastFundingTime: B(r.last_funding_time),
      longSize: B(r.long_size), shortSize: B(r.short_size), marginTotal: B(r.margin_total),
      fromPrice: B(r.from_price), toPrice: B(r.to_price), updatedAt: B(r.updated_at), period: B(r.period),
      scheduledPrint: B(r.scheduled_print),
    };
  }

  _saveMarket(m) {
    this.s.saveMarket.run({
      id: m.id, active: m.active ? 1 : 0, skew: m.skew.toString(), sumSizeEntry: m.sumSizeEntry.toString(),
      sumSizeFunding: m.sumSizeFunding.toString(), fundingIndex: m.fundingIndex.toString(), lastFundingTime: m.lastFundingTime,
      longSize: m.longSize.toString(), shortSize: m.shortSize.toString(), marginTotal: m.marginTotal,
      fromPrice: m.fromPrice.toString(), toPrice: m.toPrice.toString(), updatedAt: m.updatedAt, period: m.period,
      scheduledPrint: m.scheduledPrint,
    });
  }

  resolveMarket(idOrSymbol) {
    let r;
    if (typeof idOrSymbol === 'number' || /^\d+$/.test(String(idOrSymbol))) r = this.s.market.get(Number(idOrSymbol));
    else if (typeof idOrSymbol === 'string') r = this.s.marketBySymbol.get(idOrSymbol.toUpperCase());
    if (!r) throw new AppError('BAD_MARKET', 'Unknown market', 404);
    return this._rowToMarket(r);
  }

  loadMarkets() {
    return this.s.markets.all().map((r) => this._rowToMarket(r));
  }

  indexOf(m, now = this.now()) {
    return M.smoothedPrice({ fromPrice: m.fromPrice, toPrice: m.toPrice, updatedAt: m.updatedAt, period: m.period }, now);
  }

  /** Funding index including pending (not persisted). */
  liveFundingIndex(m, now = this.now()) {
    return m.fundingIndex + M.pendingFunding(m.skew, this.indexOf(m, now), B(now) - m.lastFundingTime, m.skewScale, m.maxFunding);
  }

  _accrue(m, now) {
    m.fundingIndex = this.liveFundingIndex(m, now);
    m.lastFundingTime = B(now);
  }

  /** Accrue funding on every market and persist. Returns the accrued markets. */
  accrueAll() {
    return this.tx(() => {
      const now = this.now();
      const ms = this.loadMarkets();
      for (const m of ms) {
        this._accrue(m, now);
        this._saveMarket(m);
      }
      return ms;
    });
  }

  /** Pool value (micro): vault cash minus traders' clamped PnL at close-out, incl. accrued funding. */
  poolValue(markets = this.loadMarkets(), now = this.now()) {
    let v = this.balance(acct.vault);
    for (const m of markets) {
      v -= M.marketTraderPnlMicro(m, this.indexOf(m, now), this.liveFundingIndex(m, now));
    }
    return v > 0n ? v : 0n;
  }

  _exposure(m, skew, now) {
    return notionalMicro(skew, this.indexOf(m, now));
  }

  _checkSkewCaps(markets, m, newSkew, nav, now) {
    if (newSkew !== 0n && this._exposure(m, newSkew, now) * BPS > nav * m.maxSkewBps) {
      throw new AppError('SKEW_CAP', 'Market open-interest cap reached');
    }
    let total = 0n;
    for (const mi of markets) total += this._exposure(mi, mi.id === m.id ? newSkew : mi.skew, now);
    if (total * BPS > nav * P.maxTotalSkewToPoolBps) throw new AppError('SKEW_CAP', 'Global open-interest cap reached');
  }

  _isFresh(m, now) {
    return B(now) - m.updatedAt <= P.maxOracleAge;
  }

  // -------------------------------------------------------------- positions

  _loadPos(marketId, address) {
    const r = this.s.pos.get(marketId, address);
    if (!r) return null;
    return {
      marketId: n(r.market_id), address: r.address, size: B(r.size), margin: B(r.margin), entryPrice: B(r.entry_price),
      entryFunding: B(r.entry_funding), sizeEntry: B(r.size_entry), openedAt: n(r.opened_at),
    };
  }

  _savePos(p) {
    this.s.upsertPos.run({
      marketId: p.marketId, address: p.address, size: p.size.toString(), margin: p.margin, entryPrice: p.entryPrice.toString(),
      entryFunding: p.entryFunding.toString(), sizeEntry: p.sizeEntry.toString(), openedAt: p.openedAt,
    });
  }

  _trade(t) {
    const lev = t.margin > 0n ? formatUnits((t.notional * 100n) / t.margin, 2) : '0';
    const row = {
      at: this.now(), marketId: t.marketId, address: t.address, side: t.size > 0n ? 'long' : 'short', kind: t.kind,
      size: abs(t.size).toString(), price: t.price.toString(), notional: t.notional, leverage: lev, fee: t.fee || 0n,
      vaultFee: t.vaultFee || 0n, realizedPnl: t.realizedPnl || 0n, payout: t.payout || 0n,
    };
    const r = this.s.insTrade.run(row);
    const pub = {
      id: n(r.lastInsertRowid), at: row.at, marketId: t.marketId, side: row.side, kind: t.kind, size: fmtWad(abs(t.size)),
      price: fmtWad(t.price), notional: fmtUsdt(t.notional), leverage: lev,
    };
    this._emit('trade', pub);
    this._emit('me', t.address);
  }

  _addPosToMarket(m, size, sizeEntry, sizeFunding) {
    m.skew += size;
    m.sumSizeEntry += sizeEntry;
    m.sumSizeFunding += sizeFunding;
    if (size > 0n) m.longSize += size;
    else m.shortSize += -size;
  }

  quote(marketId, size) {
    const m = this.resolveMarket(marketId);
    const now = this.now();
    const idx = this.indexOf(m, now);
    const fill = M.fillPrice(M.openBasePrice(idx, m.toPrice, size), m.skew, size, m.skewScale);
    const closeFill = M.fillPrice(idx, m.skew, size, m.skewScale);
    return { fillPrice: fill, fee: M.tradingFee(size, fill), closeFillPrice: closeFill };
  }

  openPosition(address, { marketId, size, margin, acceptablePrice }) {
    if (size === 0n || margin <= 0n) throw new AppError('BAD_INPUT', 'size and margin must be non-zero');
    return this.tx(() => {
      const now = this.now();
      const markets = this.accrueAll();
      const m = markets.find((x) => x.id === this.resolveMarket(marketId).id);
      if (!m.active) throw new AppError('MARKET_INACTIVE', 'Market is paused');
      if (this._loadPos(m.id, address)) throw new AppError('POSITION_EXISTS', 'Position already open in this market; use modify');
      if (M.isCloseOnly(m.scheduledPrint, now)) throw new AppError('CLOSE_ONLY', 'Market is close-only ahead of an index print');
      if (!this._isFresh(m, now)) throw new AppError('STALE_INDEX', 'Index is stale');
      const idx = this.indexOf(m, now);
      const fill = M.fillPrice(M.openBasePrice(idx, m.toPrice, size), m.skew, size, m.skewScale);
      if (size > 0n ? fill > acceptablePrice : fill < acceptablePrice) throw new AppError('SLIPPAGE', 'Fill price worse than acceptablePrice');
      const notional = notionalMicro(size, fill);
      const fee = M.tradingFee(size, fill);
      if (margin <= fee) throw new AppError('INSUFFICIENT_MARGIN', 'Margin does not cover the fee');
      const net = margin - fee;
      if (notional > net * P.maxLeverage) throw new AppError('LEVERAGE_TOO_HIGH', 'Leverage above 100x after fees');
      const cut = M.protocolCut(fee);
      const nav = this.poolValue(markets, now);
      this._checkSkewCaps(markets, m, m.skew + size, nav + fee - cut, now);

      const se = (size * fill) / WAD;
      const sf = (size * m.fundingIndex) / WAD;
      const pos = { marketId: m.id, address, size, margin: net, entryPrice: fill, entryFunding: m.fundingIndex, sizeEntry: se, openedAt: now };
      if (M.isLiquidatable(pos, idx, m.fundingIndex)) throw new AppError('WOULD_BE_LIQUIDATABLE', 'Position would be liquidatable at open');
      this._addPosToMarket(m, size, se, sf);
      m.marginTotal += net;
      this.post([
        [acct.available(address), -margin],
        [acct.margin(address), net],
        [acct.vault, fee - cut],
        [acct.fees, cut],
      ], `open:${m.id}:${address}`);
      this._savePos(pos);
      this._saveMarket(m);
      this._trade({ marketId: m.id, address, size, kind: 'open', price: fill, notional, margin: net, fee, vaultFee: fee - cut });
      return this.positionView(m, pos, now);
    });
  }

  closePosition(address, { marketId, acceptablePrice }, kind = 'close') {
    return this.tx(() => {
      const now = this.now();
      const markets = this.accrueAll();
      const m = markets.find((x) => x.id === this.resolveMarket(marketId).id);
      const pos = this._loadPos(m.id, address);
      if (!pos) throw new AppError('NO_POSITION', 'No open position');
      return this._close(m, pos, acceptablePrice, now, kind);
    });
  }

  _close(m, pos, acceptablePrice, now, kind) {
    const idx = this.indexOf(m, now);
    const fill = M.fillPrice(idx, m.skew, -pos.size, m.skewScale);
    if (acceptablePrice !== undefined && acceptablePrice !== null) {
      if (pos.size > 0n ? fill < acceptablePrice : fill > acceptablePrice) throw new AppError('SLIPPAGE', 'Fill price worse than acceptablePrice');
    }
    const pnlW = (pos.size * fill) / WAD - pos.sizeEntry;
    const fundW = M.fundingOwedWad(pos.size, m.fundingIndex, pos.entryFunding);
    const fee = M.tradingFee(pos.size, fill);
    const preFee = pos.margin + floorDiv(pnlW - fundW, WAD_PER_MICRO);
    const feePaid = preFee <= 0n ? 0n : min(preFee, fee);
    const payout = preFee > 0n ? preFee - feePaid : 0n;
    const cut = M.protocolCut(feePaid);
    this._removePos(m, pos);
    this.post([
      [acct.margin(pos.address), -pos.margin],
      [acct.available(pos.address), payout],
      [acct.fees, cut],
      [acct.vault, pos.margin - payout - cut],
    ], `${kind}:${m.id}:${pos.address}`);
    this._saveMarket(m);
    const realizedPnl = payout - pos.margin;
    this._trade({
      marketId: m.id, address: pos.address, size: -pos.size, kind, price: fill, notional: notionalMicro(pos.size, fill),
      margin: pos.margin, fee: feePaid, vaultFee: feePaid - cut, realizedPnl, payout,
    });
    return { realizedPnl, payout };
  }

  _removePos(m, pos) {
    m.skew -= pos.size;
    m.sumSizeEntry -= pos.sizeEntry;
    m.sumSizeFunding -= (pos.size * pos.entryFunding) / WAD;
    if (pos.size > 0n) m.longSize -= pos.size;
    else m.shortSize -= -pos.size;
    m.marginTotal -= pos.margin;
    this.s.delPos.run(m.id, pos.address);
  }

  modifyPosition(address, { marketId, sizeDelta, acceptablePrice }) {
    if (sizeDelta === 0n) throw new AppError('BAD_INPUT', 'sizeDelta must be non-zero');
    return this.tx(() => {
      const now = this.now();
      const markets = this.accrueAll();
      const m = markets.find((x) => x.id === this.resolveMarket(marketId).id);
      const pos = this._loadPos(m.id, address);
      if (!pos) throw new AppError('NO_POSITION', 'No open position');
      const size = pos.size;
      const increase = (size > 0n) === (sizeDelta > 0n);
      if (!increase) {
        if (abs(sizeDelta) > abs(size)) throw new AppError('FLIP_NOT_ALLOWED', 'Reduce cannot flip the position; close first');
        if (abs(sizeDelta) === abs(size)) {
          this._close(m, pos, acceptablePrice, now, 'close');
          return null;
        }
      } else {
        if (!m.active) throw new AppError('MARKET_INACTIVE', 'Market is paused');
        if (M.isCloseOnly(m.scheduledPrint, now)) throw new AppError('CLOSE_ONLY', 'Market is close-only ahead of an index print');
        if (!this._isFresh(m, now)) throw new AppError('STALE_INDEX', 'Index is stale');
      }
      const idx = this.indexOf(m, now);
      const fill = M.fillPrice(increase ? M.openBasePrice(idx, m.toPrice, sizeDelta) : idx, m.skew, sizeDelta, m.skewScale);
      if (sizeDelta > 0n ? fill > acceptablePrice : fill < acceptablePrice) throw new AppError('SLIPPAGE', 'Fill price worse than acceptablePrice');
      const fee = M.tradingFee(sizeDelta, fill);
      const fundW = M.fundingOwedWad(pos.size, m.fundingIndex, pos.entryFunding);
      let realizedW = 0n;
      let seDelta;
      if (increase) seDelta = (sizeDelta * fill) / WAD;
      else {
        seDelta = -((pos.sizeEntry * abs(sizeDelta)) / abs(size));
        realizedW = (-sizeDelta * fill) / WAD + seDelta;
      }
      const rf = floorDiv(realizedW - fundW, WAD_PER_MICRO);
      const newMargin = pos.margin + rf - fee;
      if (newMargin <= 0n) throw new AppError('WOULD_BE_LIQUIDATABLE', 'Position would be liquidatable');
      const newSize = size + sizeDelta;
      const cut = M.protocolCut(fee);
      if (increase) {
        if (notionalMicro(newSize, fill) > newMargin * P.maxLeverage) throw new AppError('LEVERAGE_TOO_HIGH', 'Leverage above 100x after fees');
        this._checkSkewCaps(markets, m, m.skew + sizeDelta, this.poolValue(markets, now) + fee - cut, now);
      }
      // Remove old aggregate contribution, add the new one.
      const oldSf = (pos.size * pos.entryFunding) / WAD;
      const marginDelta = newMargin - pos.margin;
      m.marginTotal += marginDelta;
      m.skew += sizeDelta;
      m.sumSizeEntry += seDelta;
      if (sizeDelta > 0n) { if (increase) m.longSize += sizeDelta; else m.shortSize -= sizeDelta; }
      else { if (increase) m.shortSize += -sizeDelta; else m.longSize -= -sizeDelta; }
      pos.margin = newMargin;
      pos.size = newSize;
      pos.sizeEntry += seDelta;
      pos.entryPrice = (pos.sizeEntry * WAD) / newSize;
      pos.entryFunding = m.fundingIndex;
      m.sumSizeFunding += (newSize * m.fundingIndex) / WAD - oldSf;
      if (M.isLiquidatable(pos, idx, m.fundingIndex)) throw new AppError('WOULD_BE_LIQUIDATABLE', 'Position would be liquidatable');
      this.post([
        [acct.margin(address), marginDelta],
        [acct.fees, cut],
        [acct.vault, -marginDelta - cut],
      ], `modify:${m.id}:${address}`);
      this._savePos(pos);
      this._saveMarket(m);
      this._trade({
        marketId: m.id, address, size: sizeDelta, kind: increase ? 'increase' : 'reduce', price: fill,
        notional: notionalMicro(sizeDelta, fill), margin: newMargin, fee, vaultFee: fee - cut, realizedPnl: rf,
      });
      return this.positionView(m, pos, now);
    });
  }

  changeMargin(address, { marketId, delta }) {
    if (delta === 0n) throw new AppError('BAD_INPUT', 'delta must be non-zero');
    return this.tx(() => {
      const now = this.now();
      const markets = this.accrueAll();
      const m = markets.find((x) => x.id === this.resolveMarket(marketId).id);
      const pos = this._loadPos(m.id, address);
      if (!pos) throw new AppError('NO_POSITION', 'No open position');
      pos.margin += delta;
      m.marginTotal += delta;
      if (delta < 0n) {
        if (pos.margin <= 0n) throw new AppError('LEVERAGE_TOO_HIGH', 'Cannot remove all margin');
        const idx = this.indexOf(m, now);
        const eq = M.equityMicro(pos, idx, m.fundingIndex);
        if (eq <= 0n || notionalMicro(pos.size, idx) > eq * P.maxLeverage) throw new AppError('LEVERAGE_TOO_HIGH', 'Leverage would exceed 100x');
        if (M.isLiquidatable(pos, idx, m.fundingIndex)) throw new AppError('WOULD_BE_LIQUIDATABLE', 'Position would be liquidatable');
      }
      this.post([[acct.available(address), -delta], [acct.margin(address), delta]], `margin:${m.id}:${address}`);
      this._savePos(pos);
      this._saveMarket(m);
      this.s.insMarginEv.run(now, m.id, address, delta, delta > 0n ? 'add' : 'remove');
      this._emit('me', address);
      return this.positionView(m, pos, now);
    });
  }

  /** Liquidate if below maintenance. Reward 0.2% of notional (capped by equity) to protocol fees. */
  liquidate(marketId, address) {
    return this.tx(() => {
      const now = this.now();
      const markets = this.accrueAll();
      const m = markets.find((x) => x.id === marketId);
      const pos = this._loadPos(m.id, address);
      if (!pos) return null;
      const idx = this.indexOf(m, now);
      if (!M.isLiquidatable(pos, idx, m.fundingIndex)) return null;
      const eq = M.equityMicro(pos, idx, m.fundingIndex);
      let reward = (notionalMicro(pos.size, idx) * P.liquidationFeeBps) / BPS;
      if (eq <= 0n) reward = 0n;
      else if (reward > eq) reward = eq;
      if (reward > pos.margin) reward = pos.margin;
      this._removePos(m, pos);
      this.post([
        [acct.margin(address), -pos.margin],
        [acct.fees, reward],
        [acct.vault, pos.margin - reward],
      ], `liquidate:${m.id}:${address}`);
      this._saveMarket(m);
      this._trade({
        marketId: m.id, address, size: -pos.size, kind: 'liquidation', price: idx, notional: notionalMicro(pos.size, idx),
        margin: pos.margin, fee: reward, realizedPnl: -pos.margin,
      });
      return { marketId: m.id, address, reward, equity: eq };
    });
  }

  liquidateAll() {
    const out = [];
    const now = this.now();
    const markets = new Map(this.loadMarkets().map((m) => [m.id, m]));
    for (const r of this.s.allPos.all()) {
      const m = markets.get(n(r.market_id));
      const pos = this._loadPos(n(r.market_id), r.address);
      if (pos && M.isLiquidatable(pos, this.indexOf(m, now), this.liveFundingIndex(m, now))) {
        const res = this.liquidate(m.id, r.address);
        if (res) out.push(res);
      }
    }
    return out;
  }

  positionView(m, pos, now = this.now()) {
    const idx = this.indexOf(m, now);
    const fi = this.liveFundingIndex(m, now);
    const pnlW = M.pnlWad(pos.size, pos.sizeEntry, idx);
    const fundW = M.fundingOwedWad(pos.size, fi, pos.entryFunding);
    const eq = M.equityMicro(pos, idx, fi);
    const notional = notionalMicro(pos.size, idx);
    return {
      marketId: m.id, symbol: m.symbol, side: pos.size > 0n ? 'long' : 'short', size: fmtWad(abs(pos.size)),
      entryPrice: fmtWad(pos.entryPrice), indexPrice: fmtWad(idx), margin: fmtUsdt(pos.margin),
      pnl: fmtUsdt(floorDiv(pnlW, WAD_PER_MICRO)), funding: fmtUsdt(floorDiv(fundW, WAD_PER_MICRO)), equity: fmtUsdt(eq),
      leverage: eq > 0n ? formatUnits((notional * 100n) / eq, 2) : '0',
      liquidationPrice: fmtWad(M.liquidationPrice(pos.size, pos.entryPrice, pos.margin, fundW)),
      liquidatable: M.isLiquidatable(pos, idx, fi),
    };
  }

  positions(address) {
    const now = this.now();
    const ms = new Map(this.loadMarkets().map((m) => [m.id, m]));
    return this.s.posByAddr.all(address).map((r) => {
      const pos = this._loadPos(n(r.market_id), address);
      return this.positionView(ms.get(pos.marketId), pos, now);
    });
  }

  // ------------------------------------------------------------------ oracle

  pushIndex(symbol, value, source = 'admin') {
    if (value <= 0n) throw new AppError('BAD_INPUT', 'value must be positive');
    return this.tx(() => {
      const now = this.now();
      const markets = this.accrueAll();
      const m = markets.find((x) => x.id === this.resolveMarket(symbol).id);
      const current = this.indexOf(m, now);
      if (!M.printWithinCap(current, value)) throw new AppError('MOVE_TOO_LARGE', 'Print moves more than 10% from the current index');
      m.fromPrice = current;
      m.toPrice = value;
      m.updatedAt = B(now);
      m.period = P.smoothingPeriod;
      m.scheduledPrint = 0n;
      this._saveMarket(m);
      this.s.insPrint.run(m.id, value.toString(), String(source || 'admin').slice(0, 200), now);
      return { marketId: m.id, from: fmtWad(current), to: fmtWad(value), at: now };
    });
  }

  schedulePrint(symbol, at) {
    return this.tx(() => {
      const now = this.now();
      const m = this.resolveMarket(symbol);
      if (at !== 0 && at <= now) throw new AppError('BAD_INPUT', 'at must be in the future (or 0 to cancel)');
      m.scheduledPrint = B(at);
      this._saveMarket(m);
      return { marketId: m.id, scheduledPrint: at };
    });
  }

  setActive(id, active) {
    return this.tx(() => {
      const markets = this.accrueAll();
      const m = markets.find((x) => x.id === this.resolveMarket(id).id);
      m.active = !!active;
      this._saveMarket(m);
      return { id: m.id, active: m.active };
    });
  }

  // ------------------------------------------------------------------- vault

  totalShares() {
    return B(this.s.getMeta.get('total_shares').value);
  }

  _vs(address) {
    const r = this.s.vs.get(address);
    if (!r) return { address, shares: 0n, pendingShares: 0n, pendingValue: 0n, unlockAt: 0 };
    return { address, shares: B(r.shares), pendingShares: B(r.pending_shares), pendingValue: B(r.pending_value), unlockAt: n(r.unlock_at) };
  }

  _saveVs(v) {
    this.s.upsertVs.run({ address: v.address, shares: v.shares.toString(), pendingShares: v.pendingShares.toString(), pendingValue: v.pendingValue, unlockAt: v.unlockAt });
  }

  _mintShares(address, amount, fromAccount, kind) {
    const markets = this.accrueAll();
    const nav = this.poolValue(markets);
    const ts = this.totalShares();
    if (nav === 0n && ts > 0n) throw new AppError('POOL_INSOLVENT', 'Vault value is zero');
    const minted = M.assetsToShares(amount, nav, ts);
    if (minted === 0n) throw new AppError('MIN_AMOUNT', 'Amount too small');
    this.post([[fromAccount, -amount], [acct.vault, amount]], `vault_${kind}:${address}`);
    const v = this._vs(address);
    v.shares += minted;
    this._saveVs(v);
    this.s.setMeta.run('total_shares', (ts + minted).toString());
    this.s.insVaultEv.run(this.now(), address, kind, amount, minted.toString());
    this._emit('me', address);
    return minted;
  }

  vaultDeposit(address, amount) {
    if (amount <= 0n) throw new AppError('MIN_AMOUNT', 'Amount must be positive');
    return this.tx(() => ({ shares: this._mintShares(address, amount, acct.available(address), 'deposit') }));
  }

  seedVault(amount) {
    if (amount <= 0n) throw new AppError('MIN_AMOUNT', 'Amount must be positive');
    return this.tx(() => ({ shares: this._mintShares(this.company, amount, acct.equity, 'seed') }));
  }

  vaultRequestWithdraw(address, shares) {
    if (shares <= 0n) throw new AppError('MIN_AMOUNT', 'Shares must be positive');
    return this.tx(() => {
      const v = this._vs(address);
      if (v.pendingShares !== 0n) throw new AppError('WITHDRAW_PENDING', 'A withdrawal request is already pending');
      if (shares > v.shares) throw new AppError('INSUFFICIENT_BALANCE', 'Not enough shares');
      const markets = this.accrueAll();
      const nav = this.poolValue(markets);
      v.shares -= shares;
      v.pendingShares = shares;
      v.pendingValue = M.sharesToAssets(shares, nav, this.totalShares());
      v.unlockAt = this.now() + Number(P.withdrawCooldown);
      this._saveVs(v);
      this.s.insVaultEv.run(this.now(), address, 'request', v.pendingValue, shares.toString());
      this._emit('me', address);
      return { unlockAt: v.unlockAt };
    });
  }

  vaultCancelWithdraw(address) {
    return this.tx(() => {
      const v = this._vs(address);
      if (v.pendingShares === 0n) throw new AppError('NO_PENDING', 'No pending withdrawal');
      this.s.insVaultEv.run(this.now(), address, 'cancel', 0n, v.pendingShares.toString());
      v.shares += v.pendingShares;
      v.pendingShares = 0n;
      v.pendingValue = 0n;
      v.unlockAt = 0;
      this._saveVs(v);
      this._emit('me', address);
      return {};
    });
  }

  vaultWithdraw(address) {
    return this.tx(() => {
      const now = this.now();
      const v = this._vs(address);
      if (v.pendingShares === 0n) throw new AppError('NO_PENDING', 'No pending withdrawal');
      if (now < v.unlockAt) throw new AppError('WITHDRAW_LOCKED', 'Cooldown has not passed');
      const markets = this.accrueAll();
      const nav = this.poolValue(markets, now);
      const ts = this.totalShares();
      const amount = min(M.sharesToAssets(v.pendingShares, nav, ts), v.pendingValue);
      const navAfter = nav - amount;
      for (const m of markets) {
        if (m.skew !== 0n && this._exposure(m, m.skew, now) * BPS > navAfter * m.maxSkewBps) {
          throw new AppError('INSUFFICIENT_LIQUIDITY', 'Withdrawal would breach the open-interest cap; try later');
        }
      }
      this.s.setMeta.run('total_shares', (ts - v.pendingShares).toString());
      this.s.insVaultEv.run(now, address, 'withdraw', amount, v.pendingShares.toString());
      v.pendingShares = 0n;
      v.pendingValue = 0n;
      v.unlockAt = 0;
      this._saveVs(v);
      // Company capital returns to company equity; LP money to the LP's available balance.
      const to = address === this.company ? acct.equity : acct.available(address);
      this.post([[acct.vault, -amount], [to, amount]], `vault_withdraw:${address}`);
      this._emit('me', address);
      return { amount };
    });
  }

  vaultView() {
    const markets = this.loadMarkets();
    const now = this.now();
    const nav = this.poolValue(markets, now);
    const ts = this.totalShares();
    const sharePrice = M.sharesToAssets(10n ** 12n, nav, ts); // micro-USDT per whole share (shares have 12 decimals)
    const since = now - 7 * 86400;
    const fees = B(this.db.prepare('SELECT COALESCE(SUM(vault_fee), 0) AS s FROM trades WHERE at >= ?').get(since).s);
    let exposure = 0n;
    for (const m of markets) exposure += this._exposure(m, m.skew, now);
    return {
      poolValue: fmtUsdt(nav),
      totalShares: formatUnits(ts, 12),
      sharePrice: fmtUsdt(sharePrice),
      feeApr7d: nav > 0n ? ratioStr(fees * 365n, nav * 7n) : '0',
      utilization: nav > 0n ? ratioStr(exposure, nav * (P.maxTotalSkewToPoolBps / BPS)) : '0',
      cash: fmtUsdt(this.balance(acct.vault)),
    };
  }

  // ------------------------------------------------------------- cash flows

  creditDeposit(depositId) {
    return this.tx(() => {
      const d = this.db.prepare('SELECT * FROM deposits WHERE id = ?').get(depositId);
      if (!d || d.status !== 'confirming') return false;
      const amount = B(d.amount);
      this.ensureUser(d.from_addr);
      this.post([[acct.deposits, -amount], [acct.available(d.from_addr), amount]], `deposit:${d.tx_hash}:${d.log_index}`);
      this.db.prepare("UPDATE deposits SET status = 'credited', credited_at = ? WHERE id = ?").run(this.now(), depositId);
      this._emit('deposit', { address: d.from_addr, txHash: d.tx_hash, amount: fmtUsdt(amount) });
      this._emit('me', d.from_addr);
      return true;
    });
  }

  /** Credit an external deposit (chain adapters call this inside their own transaction). */
  creditExternal(address, amount, ref, info = {}) {
    return this.tx(() => {
      if (amount <= 0n) throw new AppError('MIN_AMOUNT', 'Amount must be positive');
      this.ensureUser(address);
      this.post([[acct.deposits, -amount], [acct.available(address), amount]], ref);
      this._emit('deposit', { address, amount: fmtUsdt(amount), ...info });
      this._emit('me', address);
      return true;
    });
  }

  requestWithdrawal(address, amount, minWithdraw, token = null) {
    if (amount < minWithdraw) throw new AppError('MIN_AMOUNT', `Minimum withdrawal is ${fmtUsdt(minWithdraw)} USDT`);
    return this.tx(() => {
      const now = this.now();
      if (this.balance(acct.available(address)) < amount) throw new AppError('INSUFFICIENT_BALANCE', 'Insufficient available balance');
      const r = this.s.insWd.run(address, amount, address, 'pending', now, now, token);
      this.post([[acct.available(address), -amount], [acct.locked(address), amount]], `withdraw_request:${r.lastInsertRowid}`);
      const w = this.withdrawalView(this.s.wd.get(r.lastInsertRowid));
      this._emit('withdrawal', { address, ...w });
      this._emit('me', address);
      return w;
    });
  }

  _unlockWithdrawal(id, status, reason, byAddress) {
    return this.tx(() => {
      const w = this.s.wd.get(id);
      if (!w) throw new AppError('NOT_FOUND', 'Withdrawal not found', 404);
      if (byAddress && w.address !== byAddress) throw new AppError('NOT_FOUND', 'Withdrawal not found', 404);
      if (w.status !== 'pending') throw new AppError('NOT_PENDING', 'Withdrawal is not pending');
      // Once the admin has started paying, the user can no longer cancel (the payout may already be on chain).
      if (byAddress && w.processing_at) throw new AppError('WITHDRAW_LOCKED', 'Withdrawal is being paid and can no longer be cancelled');
      const amount = B(w.amount);
      this.post([[acct.locked(w.address), -amount], [acct.available(w.address), amount]], `withdraw_${status}:${id}`);
      this.s.setWd.run(status, null, reason ? String(reason).slice(0, 500) : null, this.now(), id);
      const v = this.withdrawalView(this.s.wd.get(id));
      this._emit('withdrawal', { address: w.address, ...v });
      this._emit('me', w.address);
      return v;
    });
  }

  cancelWithdrawal(address, id) { return this._unlockWithdrawal(id, 'cancelled', null, address); }
  rejectWithdrawal(id, reason) { return this._unlockWithdrawal(id, 'rejected', reason || 'rejected', null); }

  /** Admin: mark a pending withdrawal as being paid (call before signing the payout). */
  lockWithdrawal(id) {
    return this.tx(() => {
      const w = this.s.wd.get(id);
      if (!w) throw new AppError('NOT_FOUND', 'Withdrawal not found', 404);
      if (w.status !== 'pending') throw new AppError('NOT_PENDING', 'Withdrawal is not pending');
      this.db.prepare('UPDATE withdrawals SET processing_at = COALESCE(processing_at, ?), updated_at = ? WHERE id = ?').run(this.now(), this.now(), id);
      return this.withdrawalView(this.s.wd.get(id));
    });
  }

  markWithdrawalPaid(id, txHash) {
    return this.tx(() => {
      const w = this.s.wd.get(id);
      if (!w) throw new AppError('NOT_FOUND', 'Withdrawal not found', 404);
      if (w.status !== 'pending') throw new AppError('NOT_PENDING', 'Withdrawal is not pending');
      const amount = B(w.amount);
      this.post([[acct.locked(w.address), -amount], [acct.withdrawals, amount]], `withdraw_paid:${id}:${txHash}`);
      this.s.setWd.run('paid', txHash, null, this.now(), id);
      const v = this.withdrawalView(this.s.wd.get(id));
      this._emit('withdrawal', { address: w.address, ...v });
      this._emit('me', w.address);
      return v;
    });
  }

  withdrawalView(w) {
    return {
      id: n(w.id), amount: fmtUsdt(B(w.amount)), to: w.to_addr, status: w.status, txHash: w.tx_hash || null,
      ...(w.token ? { token: w.token, signature: w.tx_hash || null } : {}), at: n(w.created_at), reason: w.reason || null,
      processing: !!w.processing_at,
    };
  }

  // ------------------------------------------------------------------- views

  me(address) {
    const available = this.balance(acct.available(address));
    const margin = this.balance(acct.margin(address));
    const pending = this.balance(acct.locked(address));
    const v = this._vs(address);
    const markets = this.loadMarkets();
    const nav = this.poolValue(markets);
    const ts = this.totalShares();
    const vaultValue = M.sharesToAssets(v.shares, nav, ts) + min(M.sharesToAssets(v.pendingShares, nav, ts), v.pendingValue);
    let posEquity = 0n;
    const now = this.now();
    for (const r of this.s.posByAddr.all(address)) {
      const m = markets.find((x) => x.id === n(r.market_id));
      const pos = this._loadPos(m.id, address);
      const eq = M.equityMicro(pos, this.indexOf(m, now), this.liveFundingIndex(m, now));
      posEquity += eq > 0n ? eq : 0n;
    }
    return {
      address,
      balance: {
        available: fmtUsdt(available), margin: fmtUsdt(margin), pendingWithdrawals: fmtUsdt(pending),
        vaultValue: fmtUsdt(vaultValue), equity: fmtUsdt(available + pending + posEquity + vaultValue),
      },
      vault: { shares: formatUnits(v.shares, 12), pendingShares: formatUnits(v.pendingShares, 12), unlockAt: v.unlockAt || null },
    };
  }

  marketsView() {
    const now = this.now();
    const markets = this.loadMarkets();
    return markets.map((m) => {
      const idx = this.indexOf(m, now);
      const lp = this.db.prepare('SELECT value, at FROM prints WHERE market_id = ? ORDER BY id DESC LIMIT 1').get(m.id);
      const old = this.db.prepare('SELECT index_price FROM snapshots WHERE market_id = ? AND at <= ? ORDER BY at DESC LIMIT 1').get(m.id, now - 86400)
        || this.db.prepare('SELECT index_price FROM snapshots WHERE market_id = ? ORDER BY at ASC LIMIT 1').get(m.id);
      const oldP = old ? B(old.index_price) : idx;
      const vol = B(this.db.prepare('SELECT COALESCE(SUM(notional), 0) AS s FROM trades WHERE market_id = ? AND at >= ?').get(m.id, now - 86400).s);
      return {
        id: m.id, symbol: m.symbol, name: m.name, indexPrice: fmtWad(idx), targetPrice: fmtWad(m.toPrice),
        markPrice: fmtWad(M.markPrice(idx, m.skew, m.skewScale)),
        fundingRatePerDay: fmtWad(M.fundingRatePerDay(m.skew, m.skewScale, m.maxFunding)),
        longOI: fmtWad(m.longSize), shortOI: fmtWad(m.shortSize), skew: fmtWad(m.skew),
        longOIUsd: fmtUsdt(notionalMicro(m.longSize, idx)), shortOIUsd: fmtUsdt(notionalMicro(m.shortSize, idx)),
        closeOnly: M.isCloseOnly(m.scheduledPrint, now), nextPrintAt: m.scheduledPrint ? Number(m.scheduledPrint) : null,
        lastPrint: lp ? { value: fmtWad(B(lp.value)), at: n(lp.at) } : null,
        change24h: oldP > 0n ? ratioStr(idx - oldP, oldP) : '0', volume24h: fmtUsdt(vol), active: m.active,
      };
    });
  }

  history(marketId, range = '1M') {
    const m = this.resolveMarket(marketId);
    const days = { '1M': 30, '6M': 182, '1Y': 365, '5Y': 1826 }[range];
    if (!days) throw new AppError('BAD_INPUT', 'range must be 1M, 6M, 1Y or 5Y');
    const since = this.now() - days * 86400;
    const prints = this.db.prepare('SELECT value, at FROM prints WHERE market_id = ? AND at >= ? ORDER BY at').all(m.id, since)
      .map((r) => ({ at: n(r.at), value: fmtWad(B(r.value)) }));
    let snaps = this.db.prepare('SELECT * FROM snapshots WHERE market_id = ? AND at >= ? ORDER BY at').all(m.id, since);
    if (snaps.length > 2000) { const step = Math.ceil(snaps.length / 2000); snaps = snaps.filter((_, i) => i % step === 0); }
    return {
      prints,
      snapshots: snaps.map((s) => ({
        at: n(s.at), indexPrice: fmtWad(B(s.index_price)), markPrice: fmtWad(B(s.mark_price)), fundingRatePerDay: fmtWad(B(s.funding_rate)),
        longOI: fmtWad(B(s.long_oi)), shortOI: fmtWad(B(s.short_oi)),
      })),
    };
  }

  _tradeView(t, withPrivate = false) {
    const v = {
      id: n(t.id), at: n(t.at), marketId: n(t.market_id), side: t.side, kind: t.kind, size: fmtWad(B(t.size)),
      price: fmtWad(B(t.price)), notional: fmtUsdt(B(t.notional)), leverage: t.leverage,
    };
    if (withPrivate) Object.assign(v, { fee: fmtUsdt(B(t.fee)), realizedPnl: fmtUsdt(B(t.realized_pnl)), payout: fmtUsdt(B(t.payout)) });
    return v;
  }

  trades(marketId, limit = 50) {
    const m = this.resolveMarket(marketId);
    return this.db.prepare('SELECT * FROM trades WHERE market_id = ? ORDER BY id DESC LIMIT ?').all(m.id, limit).map((t) => this._tradeView(t));
  }

  userHistory(address) {
    return {
      trades: this.db.prepare('SELECT * FROM trades WHERE address = ? ORDER BY id DESC LIMIT 500').all(address).map((t) => this._tradeView(t, true)),
      margin: this.db.prepare('SELECT * FROM margin_events WHERE address = ? ORDER BY id DESC LIMIT 500').all(address)
        .map((e) => ({ id: n(e.id), at: n(e.at), marketId: n(e.market_id), delta: fmtUsdt(B(e.delta)), kind: e.kind })),
      vault: this.db.prepare('SELECT * FROM vault_events WHERE address = ? ORDER BY id DESC LIMIT 500').all(address)
        .map((e) => ({ id: n(e.id), at: n(e.at), kind: e.kind, amount: fmtUsdt(B(e.amount)), shares: formatUnits(B(e.shares), 12) })),
    };
  }

  stats() {
    const now = this.now();
    const l = this.liabilities();
    const vol = B(this.db.prepare('SELECT COALESCE(SUM(notional), 0) AS s FROM trades WHERE at >= ?').get(now - 86400).s);
    let oi = 0n;
    for (const m of this.loadMarkets()) oi += notionalMicro(m.longSize + m.shortSize, this.indexOf(m, now));
    const traders = n(this.db.prepare('SELECT COUNT(DISTINCT address) AS c FROM trades').get().c);
    return { tvl: fmtUsdt(l.total), volume24h: fmtUsdt(vol), openInterest: fmtUsdt(oi), traders };
  }

  snapshot() {
    return this.tx(() => {
      const now = this.now();
      for (const m of this.loadMarkets()) {
        const idx = this.indexOf(m, now);
        this.s.insSnap.run(m.id, now, idx.toString(), M.markPrice(idx, m.skew, m.skewScale).toString(),
          M.fundingRatePerDay(m.skew, m.skewScale, m.maxFunding).toString(), m.longSize.toString(), m.shortSize.toString());
      }
    });
  }

  /** One background tick: accrue funding, liquidate, snapshot each minute. */
  tick() {
    this.accrueAll();
    const liq = this.liquidateAll();
    const now = this.now();
    const minute = Math.floor(now / 60);
    if (this._lastSnapMinute !== minute) {
      this._lastSnapMinute = minute;
      this.snapshot();
    }
    return liq;
  }
}
