// Solana chain adapter: base58 keys, ATA derivation, JSON-RPC client with fallbacks, jsonParsed
// transaction parsing, the per-mint deposit/withdrawal watcher and admin verification.
import crypto from 'node:crypto';
import bs58 from 'bs58';
import { ed25519 } from '@noble/curves/ed25519';
import { AppError, fmtUsdt, formatUnits } from './fixed.js';

export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ATA_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const MINTS = {
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Decode a base58 public key; throws BAD_INPUT unless exactly 32 bytes. */
export function decodePubkey(s, field = 'address') {
  if (typeof s !== 'string' || s.length < 32 || s.length > 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(s)) {
    throw new AppError('BAD_INPUT', `${field} must be a base58 public key`);
  }
  let b;
  try { b = bs58.decode(s); } catch { throw new AppError('BAD_INPUT', `${field} must be a base58 public key`); }
  if (b.length !== 32) throw new AppError('BAD_INPUT', `${field} must decode to 32 bytes`);
  return b;
}

export function normSolAddress(s, field = 'address') {
  const b = decodePubkey(s, field);
  const canon = bs58.encode(b);
  if (canon !== s) throw new AppError('BAD_INPUT', `${field} is not canonical base58`);
  return s;
}

export function isOnCurve(bytes) {
  try { ed25519.ExtendedPoint.fromHex(bytes); return true; } catch { return false; }
}

/** PublicKey.findProgramAddressSync equivalent. */
export function findProgramAddress(seeds, programId) {
  const prog = decodePubkey(programId, 'programId');
  for (let bump = 255; bump >= 0; bump--) {
    const h = crypto.createHash('sha256');
    for (const s of seeds) h.update(s);
    h.update(Buffer.from([bump]));
    h.update(prog);
    h.update(Buffer.from('ProgramDerivedAddress'));
    const d = h.digest();
    if (!isOnCurve(d)) return [bs58.encode(d), bump];
  }
  throw new Error('no viable bump');
}

export function deriveAta(owner, mint, tokenProgram = TOKEN_PROGRAM_ID) {
  return findProgramAddress([decodePubkey(owner), decodePubkey(tokenProgram), decodePubkey(mint)], ATA_PROGRAM_ID)[0];
}

export function verifySolSignature(message, signatureB58, address) {
  let sig;
  try { sig = bs58.decode(signatureB58); } catch { return false; }
  if (sig.length !== 64) return false;
  try { return ed25519.verify(sig, Buffer.from(message, 'utf8'), decodePubkey(address)); } catch { return false; }
}

// --------------------------------------------------------------------- RPC

const TRANSIENT_RPC_CODES = new Set([-32005, -32004, -32007, -32014, -32016, 429]);

export class SolRpc {
  constructor(urls, { retries = 4, timeoutMs = 20000, log = () => {}, baseDelayMs = 300 } = {}) {
    this.urls = urls;
    this.retries = retries;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.baseDelayMs = baseDelayMs;
    this.id = 0;
  }

  /** Tries endpoints in order (first is preferred); retries transient failures with backoff. */
  async call(method, params = []) {
    let lastErr;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      for (let i = 0; i < this.urls.length; i++) {
        try {
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
          let res;
          try {
            res = await fetch(this.urls[i], {
              method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctl.signal,
              body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
            });
          } finally { clearTimeout(timer); }
          if (res.status === 429 || res.status >= 500) throw Object.assign(new Error(`HTTP ${res.status}`), { transient: true });
          if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { transient: true });
          const body = await res.json();
          if (body.error) {
            const e = new Error(`RPC ${method}: ${body.error.message || JSON.stringify(body.error)}`);
            e.rpc = body.error;
            e.transient = TRANSIENT_RPC_CODES.has(body.error.code);
            if (!e.transient) throw e;
            throw e;
          }
          return body.result;
        } catch (e) {
          if (e.rpc && !e.transient) throw e; // deterministic error (bad params, missing account): no retry
          lastErr = e;
          this.log(`solana rpc ${method} failed on endpoint #${i}: ${e.message}`);
        }
      }
      await sleep(Math.min(this.baseDelayMs * 2 ** attempt, 5000));
    }
    throw lastErr;
  }

  getSignatures(address, { until, before, limit = 1000 } = {}) {
    const opts = { limit, commitment: 'finalized' };
    if (until) opts.until = until;
    if (before) opts.before = before;
    return this.call('getSignaturesForAddress', [address, opts]);
  }

  getTransaction(sig) {
    return this.call('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'finalized' }]);
  }

  async getTokenBalance(account) {
    try {
      const r = await this.call('getTokenAccountBalance', [account, { commitment: 'finalized' }]);
      return BigInt(r.value.amount);
    } catch (e) {
      if (e.rpc && /could not find account|Invalid param: could not find/i.test(e.rpc.message || '')) return 0n;
      throw e;
    }
  }

  async getBalance(address) {
    const r = await this.call('getBalance', [address, { commitment: 'finalized' }]);
    return BigInt(r.value);
  }

  async getLatestBlockhash() {
    const r = await this.call('getLatestBlockhash', [{ commitment: 'finalized' }]);
    return { blockhash: r.value.blockhash, lastValidBlockHeight: r.value.lastValidBlockHeight };
  }
}

// ------------------------------------------------------------------ parsing

function accountKeys(tx) {
  return (tx.transaction?.message?.accountKeys || []).map((k) => (typeof k === 'string' ? k : k.pubkey));
}

/**
 * Per-token-account balance changes for one mint (SPL Token program only).
 * Returns [{ account, owner, pre, post, delta }].
 */
export function tokenDeltas(tx, mint) {
  const keys = accountKeys(tx);
  const rows = new Map();
  const take = (list, field) => {
    for (const b of list || []) {
      if (b.mint !== mint) continue;
      if (b.programId && b.programId !== TOKEN_PROGRAM_ID) continue; // Token-2022 look-alikes are not our mint
      const r = rows.get(b.accountIndex) || { account: keys[b.accountIndex], owner: null, pre: 0n, post: 0n };
      r[field] = BigInt(b.uiTokenAmount.amount);
      if (b.owner) r.owner = b.owner;
      rows.set(b.accountIndex, r);
    }
  };
  take(tx.meta?.preTokenBalances, 'pre');
  take(tx.meta?.postTokenBalances, 'post');
  return [...rows.values()].map((r) => ({ ...r, delta: r.post - r.pre })).filter((r) => r.delta !== 0n);
}

/**
 * Classify a finalized transaction touching the company ATA for `mint`.
 * Amounts are raw token units (both USDC and USDT have 6 decimals = micro-USD).
 */
export function parseCompanyTransfer(tx, { mint, companyAta, company }) {
  if (!tx || !tx.meta) return { kind: 'none' };
  const failed = tx.meta.err !== null && tx.meta.err !== undefined;
  const deltas = tokenDeltas(tx, mint);
  const mine = deltas.find((d) => d.account === companyAta);
  if (!mine) return { kind: 'none', failed };
  if (mine.delta > 0n) {
    const senders = [...new Set(deltas.filter((d) => d.delta < 0n).map((d) => d.owner))];
    let sender = null;
    let reason = null;
    if (failed) reason = 'failed';
    else if (senders.length === 0) reason = 'unknown_sender';
    else if (senders.length > 1) reason = 'multiple_senders';
    else if (!senders[0]) reason = 'unknown_sender';
    else if (senders[0] === company) return { kind: 'internal', amount: mine.delta };
    else sender = senders[0];
    return { kind: 'deposit', amount: mine.delta, sender, reason, senders };
  }
  if (failed) return { kind: 'none', failed };
  const recipients = deltas.filter((d) => d.delta > 0n && d.owner && d.owner !== company)
    .map((d) => ({ owner: d.owner, account: d.account, amount: d.delta }));
  return { kind: 'outgoing', amount: -mine.delta, recipients };
}

// ------------------------------------------------------------------ adapter

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sol_deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT, signature TEXT NOT NULL, mint TEXT NOT NULL, token TEXT NOT NULL,
  amount INTEGER NOT NULL, sender TEXT, status TEXT NOT NULL, reason TEXT, slot INTEGER, block_time INTEGER,
  at INTEGER NOT NULL, credited_to TEXT, credited_at INTEGER, note TEXT, UNIQUE (signature, mint)
);
CREATE INDEX IF NOT EXISTS sol_deposits_sender ON sol_deposits(sender);
CREATE INDEX IF NOT EXISTS sol_deposits_status ON sol_deposits(status);
CREATE TABLE IF NOT EXISTS sol_outgoing (
  id INTEGER PRIMARY KEY AUTOINCREMENT, signature TEXT NOT NULL, mint TEXT NOT NULL, recipient TEXT,
  amount INTEGER NOT NULL, status TEXT NOT NULL, withdrawal_id INTEGER, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sol_outgoing_sig ON sol_outgoing(signature);
CREATE TABLE IF NOT EXISTS sol_seen (signature TEXT NOT NULL, mint TEXT NOT NULL, PRIMARY KEY (signature, mint));
`;

export class SolanaAdapter {
  constructor({ engine, rpc, config, log = () => {} }) {
    this.engine = engine;
    this.db = engine.db;
    this.rpc = rpc;
    this.cfg = config;
    this.log = log;
    this.company = config.companyAddress;
    this.tokens = config.tokens.map((t) => ({ ...t, ata: deriveAta(this.company, t.mint) }));
    this.bySymbol = new Map(this.tokens.map((t) => [t.symbol, t]));
    this.byMint = new Map(this.tokens.map((t) => [t.mint, t]));
    this.db.exec(SCHEMA);
    this.lastError = null;
    this.running = false;
    this._bh = null;
  }

  meta(key) { const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key); return r ? r.value : null; }
  setMeta(key, v) { this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(v)); }

  cursor() {
    const out = {};
    for (const t of this.tokens) out[t.symbol] = this.meta(`sol_until:${t.mint}`);
    return out;
  }

  configView() {
    return {
      chain: 'solana', cluster: this.cfg.cluster, companyAddress: this.company,
      tokens: this.tokens.map((t) => ({ symbol: t.symbol, mint: t.mint, decimals: t.decimals, companyTokenAccount: t.ata })),
      withdrawTokens: this.tokens.map((t) => t.symbol), commitment: 'finalized',
    };
  }

  health() {
    return { chain: 'solana', lastSignature: this.cursor(), lastSlot: this.meta('sol_last_slot') ? Number(this.meta('sol_last_slot')) : null };
  }

  withdrawToken(v) {
    const sym = v === undefined || v === null ? 'USDC' : v;
    if (typeof sym !== 'string' || !this.bySymbol.has(sym)) throw new AppError('BAD_INPUT', `token must be one of ${this.tokens.map((t) => t.symbol).join(', ')}`);
    return sym;
  }

  // ------------------------------------------------------------- watcher

  async _initCursor(t) {
    const key = `sol_until:${t.mint}`;
    if (this.meta(key) !== null) return;
    const start = this.cfg.startSignatures?.[t.symbol] || this.cfg.startSignature;
    if (start) { this.setMeta(key, start); return; }
    // No start signature: begin from "now" and never scan older history.
    const latest = await this.rpc.getSignatures(t.ata, { limit: 1 });
    this.setMeta(key, latest.length ? latest[0].signature : '');
  }

  async poll() {
    if (this._polling) return this._polling;
    this._polling = this._poll().finally(() => { this._polling = null; });
    return this._polling;
  }

  async _poll() {
    for (const t of this.tokens) await this._pollToken(t);
    this.lastError = null;
  }

  async _pollToken(t) {
    await this._initCursor(t);
    const key = `sol_until:${t.mint}`;
    const until = this.meta(key) || undefined;
    // Page newest -> oldest back to `until`.
    const sigs = [];
    let before;
    for (let page = 0; page < 20; page++) {
      const batch = await this.rpc.getSignatures(t.ata, { until, before, limit: 1000 });
      sigs.push(...batch);
      if (batch.length < 1000) break;
      before = batch[batch.length - 1].signature;
    }
    sigs.reverse(); // oldest first
    let processed = 0;
    for (const s of sigs) {
      if (processed >= (this.cfg.maxTxPerPoll || 200)) break;
      const seen = this.db.prepare('SELECT 1 FROM sol_seen WHERE signature = ? AND mint = ?').get(s.signature, t.mint);
      if (!seen) {
        const tx = await this.rpc.getTransaction(s.signature);
        if (!tx) break; // not retrievable yet: retry next poll without advancing the cursor
        this.engine.tx(() => {
          this._record(t, s.signature, tx);
          this.db.prepare('INSERT OR IGNORE INTO sol_seen (signature, mint) VALUES (?, ?)').run(s.signature, t.mint);
          this.setMeta(key, s.signature);
          if (tx.slot) this.setMeta('sol_last_slot', tx.slot);
        });
        processed++;
      } else {
        this.setMeta(key, s.signature);
      }
    }
  }

  _record(t, signature, tx) {
    const p = parseCompanyTransfer(tx, { mint: t.mint, companyAta: t.ata, company: this.company });
    const now = this.engine.now();
    if (p.kind === 'deposit') {
      let status = 'credited';
      if (p.reason) status = 'unattributed';
      else if (p.amount < this.cfg.minDeposit) status = 'below_minimum';
      const r = this.db.prepare(`INSERT INTO sol_deposits (signature, mint, token, amount, sender, status, reason, slot, block_time, at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(signature, mint) DO NOTHING`)
        .run(signature, t.mint, t.symbol, p.amount, p.sender, status === 'credited' ? 'confirming' : status, p.reason, tx.slot || null, tx.blockTime || null, now);
      if (!r.changes) return;
      if (status === 'credited') this._credit(signature, t.mint, p.sender);
      else this.log(`solana deposit ${signature} ${t.symbol} ${fmtUsdt(p.amount)} -> ${status}${p.reason ? ` (${p.reason})` : ''}`);
    } else if (p.kind === 'outgoing') {
      for (const rc of p.recipients) {
        const exists = this.db.prepare('SELECT 1 FROM sol_outgoing WHERE signature = ? AND mint = ? AND recipient = ?').get(signature, t.mint, rc.owner);
        if (exists) continue;
        const pending = this.db.prepare("SELECT * FROM withdrawals WHERE status = 'pending' AND address = ? AND token = ? ORDER BY id").all(rc.owner, t.symbol);
        const w = pending.find((x) => BigInt(x.amount) === rc.amount);
        this.db.prepare('INSERT INTO sol_outgoing (signature, mint, recipient, amount, status, withdrawal_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(signature, t.mint, rc.owner, rc.amount, w ? 'matched' : 'unmatched', w ? w.id : null, now);
        if (w) this.engine.markWithdrawalPaid(Number(w.id), signature);
      }
    }
  }

  _credit(signature, mint, address) {
    const d = this.db.prepare('SELECT * FROM sol_deposits WHERE signature = ? AND mint = ?').get(signature, mint);
    this.engine.creditExternal(address, BigInt(d.amount), `deposit:${signature}:${mint}`, { signature, token: d.token });
    this.db.prepare("UPDATE sol_deposits SET status = 'credited', credited_to = ?, credited_at = ? WHERE id = ?").run(address, this.engine.now(), d.id);
  }

  depositsFor(address) {
    return this.db.prepare('SELECT * FROM sol_deposits WHERE sender = ? OR credited_to = ? ORDER BY id DESC LIMIT 200').all(address, address).map((d) => this._depView(d));
  }

  _depView(d) {
    return {
      signature: d.signature, token: d.token, amount: fmtUsdt(BigInt(d.amount)), status: d.status, at: Number(d.block_time || d.at),
      ...(d.reason ? { reason: d.reason } : {}), ...(d.sender ? { sender: d.sender } : {}), ...(d.credited_to ? { creditedTo: d.credited_to } : {}),
    };
  }

  unattributed(status = 'unattributed') {
    const rows = status === 'all' ? this.db.prepare('SELECT * FROM sol_deposits ORDER BY id DESC LIMIT 500').all()
      : this.db.prepare('SELECT * FROM sol_deposits WHERE status = ? ORDER BY id LIMIT 500').all(status);
    return rows.map((d) => ({ ...this._depView(d), note: d.note || null }));
  }

  _findDeposit(signature, token) {
    if (typeof signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature)) throw new AppError('BAD_INPUT', 'signature must be base58');
    const rows = this.db.prepare('SELECT * FROM sol_deposits WHERE signature = ?').all(signature).filter((r) => !token || r.token === token);
    if (!rows.length) throw new AppError('NOT_FOUND', 'Deposit not found', 404);
    if (rows.length > 1) throw new AppError('BAD_INPUT', 'Several tokens in this tx; pass token');
    return rows[0];
  }

  /** Admin: credit an unattributed (or below-minimum) deposit to a user. */
  adminCredit(signature, { address, token }) {
    const addr = normSolAddress(address);
    return this.engine.tx(() => {
      const d = this._findDeposit(signature, token);
      if (!['unattributed', 'below_minimum'].includes(d.status)) throw new AppError('NOT_PENDING', `Deposit is ${d.status}`);
      this.engine.ensureUser(addr);
      this._credit(d.signature, d.mint, addr);
      this.db.prepare("UPDATE sol_deposits SET note = COALESCE(note, 'manual credit') WHERE id = ?").run(d.id);
      return this._depView(this.db.prepare('SELECT * FROM sol_deposits WHERE id = ?').get(d.id));
    });
  }

  /** Admin: record that an unattributed deposit was / will be refunded on chain (no ledger movement). */
  adminRefundNote(signature, { note, token }) {
    if (note !== undefined && (typeof note !== 'string' || note.length > 500)) throw new AppError('BAD_INPUT', 'note must be a string');
    return this.engine.tx(() => {
      const d = this._findDeposit(signature, token);
      if (!['unattributed', 'below_minimum'].includes(d.status)) throw new AppError('NOT_PENDING', `Deposit is ${d.status}`);
      this.db.prepare("UPDATE sol_deposits SET status = 'refund_noted', note = ? WHERE id = ?").run(note || 'refund', d.id);
      return this._depView(this.db.prepare('SELECT * FROM sol_deposits WHERE id = ?').get(d.id));
    });
  }

  /** Admin: verify a finalized payout tx and mark the withdrawal paid. */
  async markPaid(id, body) {
    const signature = body.signature;
    if (typeof signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature)) throw new AppError('BAD_INPUT', 'signature must be a base58 transaction signature');
    const w = this.db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);
    if (!w) throw new AppError('NOT_FOUND', 'Withdrawal not found', 404);
    if (w.status !== 'pending') throw new AppError('NOT_PENDING', 'Withdrawal is not pending');
    const t = this.bySymbol.get(w.token || 'USDC');
    const tx = await this.rpc.getTransaction(signature);
    if (!tx) throw new AppError('TX_NOT_FOUND', 'Transaction not found or not finalized');
    if (tx.meta?.err !== null && tx.meta?.err !== undefined) throw new AppError('TX_FAILED', 'Transaction failed');
    const p = parseCompanyTransfer(tx, { mint: t.mint, companyAta: t.ata, company: this.company });
    if (p.kind !== 'outgoing') throw new AppError('TX_MISMATCH', `No ${t.symbol} transfer out of the company token account in this tx`);
    const need = BigInt(w.amount);
    const rc = p.recipients.find((r) => r.owner === w.address && r.amount >= need);
    if (!rc) throw new AppError('TX_MISMATCH', 'Destination owner or amount does not match the withdrawal');
    return this.engine.tx(() => {
      const w2 = this.db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);
      if (w2.status !== 'pending') throw new AppError('NOT_PENDING', 'Withdrawal is not pending');
      const used = this.db.prepare("SELECT 1 FROM sol_outgoing WHERE signature = ? AND status = 'matched'").get(signature)
        || this.db.prepare("SELECT 1 FROM withdrawals WHERE tx_hash = ? AND status = 'paid'").get(signature);
      if (used) throw new AppError('TX_MISMATCH', 'Signature already used for another withdrawal');
      const ex = this.db.prepare('SELECT id FROM sol_outgoing WHERE signature = ? AND mint = ? AND recipient = ?').get(signature, t.mint, rc.owner);
      if (ex) this.db.prepare("UPDATE sol_outgoing SET status = 'matched', withdrawal_id = ? WHERE id = ?").run(id, ex.id);
      else {
        this.db.prepare("INSERT INTO sol_outgoing (signature, mint, recipient, amount, status, withdrawal_id, at) VALUES (?, ?, ?, ?, 'matched', ?, ?)")
          .run(signature, t.mint, rc.owner, rc.amount, id, this.engine.now());
      }
      return this.engine.markWithdrawalPaid(id, signature);
    });
  }

  async blockhash() {
    const now = Date.now();
    if (this._bh && now - this._bh.at < (this.cfg.blockhashCacheMs ?? 5000)) return this._bh.value;
    if (!this._bhInflight) {
      this._bhInflight = this.rpc.getLatestBlockhash().then((v) => { this._bh = { at: Date.now(), value: v }; return v; }).finally(() => { this._bhInflight = null; });
    }
    return this._bhInflight;
  }

  async overview(engine) {
    const balances = {};
    let total = 0n;
    for (const t of this.tokens) {
      const b = await this.rpc.getTokenBalance(t.ata);
      balances[t.symbol] = fmtUsdt(b); // both mints have 6 decimals = micro-USD
      total += b;
    }
    const lamports = await this.rpc.getBalance(this.company);
    const l = engine.liabilities();
    return {
      onchain: total,
      fields: {
        companyOnChain: fmtUsdt(total), companyTokens: balances, companySol: formatUnits(lamports, 9),
        unattributedDeposits: this.unattributed('unattributed'),
      },
      liabilities: l,
    };
  }

  extraRoutes(app, { admin, h, body }) {
    app.get('/chain/blockhash', h(() => this.blockhash()));
    app.get('/admin/deposits', admin, h((req) => {
      const status = String(req.query.status || 'unattributed');
      if (!['unattributed', 'below_minimum', 'credited', 'refund_noted', 'all'].includes(status)) throw new AppError('BAD_INPUT', 'bad status');
      return this.unattributed(status);
    }));
    app.post('/admin/deposits/:signature/credit', admin, h((req) => {
      const b = body(req);
      return this.adminCredit(req.params.signature, { address: b.address, token: b.token });
    }));
    app.post('/admin/deposits/:signature/refund-note', admin, h((req) => {
      const b = body(req);
      return this.adminRefundNote(req.params.signature, { note: b.note, token: b.token });
    }));
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      try { await this.poll(); } catch (e) { this.lastError = e.message; this.log(`solana watcher error: ${e.message}`); }
      if (this.running) this.timer = setTimeout(loop, this.cfg.pollMs);
    };
    loop();
  }

  stop() { this.running = false; clearTimeout(this.timer); }
}
