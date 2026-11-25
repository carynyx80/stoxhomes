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
  try {
    const pub = decodePubkey(address);
    // Small-order keys (e.g. the identity point) admit universal forgeries: nobody controls them.
    if (ed25519.ExtendedPoint.fromHex(pub).isSmallOrder()) return false;
    // Strict RFC 8032 verification (rejects non-canonical S / malleated signatures).
    return ed25519.verify(sig, Buffer.from(message, 'utf8'), pub, { zip215: false });
  } catch { return false; }
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
      let blocked = 0;
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
          if (res.status === 401 || res.status === 403) {
            // e.g. publicnode refuses "indexed" methods: this endpoint cannot serve it, try the next one now
            let msg = '';
            try { msg = (await res.json()).error?.message || ''; } catch { /* ignore */ }
            throw Object.assign(new Error(`HTTP ${res.status} ${msg}`), { blocked: true });
          }
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
          if (e.rpc && !e.transient && e.rpc.code !== -32601) throw e; // deterministic error (bad params, missing account): no retry
          if (e.blocked || (e.rpc && e.rpc.code === -32601)) blocked++;
          lastErr = e;
          this.log(`solana rpc ${method} failed on endpoint #${i}: ${e.message}`);
        }
      }
      if (blocked === this.urls.length) throw lastErr; // no endpoint offers this method
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

  /** Token account balance (raw units); a missing account is 0. */
  async getTokenBalance(account, mint) {
    try {
      const r = await this.call('getTokenAccountBalance', [account, { commitment: 'finalized' }]);
      return BigInt(r.value.amount);
    } catch (e) {
      if (e.rpc && /could not find account/i.test(e.rpc.message || '')) return 0n;
      // Some endpoints (publicnode) refuse getTokenAccountBalance: read the parsed account instead.
      const r = await this.call('getAccountInfo', [account, { encoding: 'jsonParsed', commitment: 'finalized' }]);
      if (!r.value) return 0n;
      const info = r.value.data?.parsed?.info;
      if (!info || (mint && info.mint !== mint)) throw new Error(`account ${account} is not a token account of ${mint}`);
      return BigInt(info.tokenAmount.amount);
    }
  }

  async getBalance(address) {
    const r = await this.call('getBalance', [address, { commitment: 'finalized' }]);
    return BigInt(r.value);
  }

  /** Balance of a token account via getAccountInfo(jsonParsed); missing account = 0. */
  async getTokenAccountInfoBalance(account, mint) {
    const r = await this.call('getAccountInfo', [account, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    if (!r || !r.value) return 0n;
    const info = r.value.data?.parsed?.info;
    if (!info || (mint && info.mint !== mint)) return 0n;
    return BigInt(info.tokenAmount.amount);
  }

  sendTransaction(b64) {
    return this.callOnce('sendTransaction', [b64, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 5 }]);
  }

  /** Single attempt per endpoint, no retry rounds (used for non-idempotent-looking calls). */
  async callOnce(method, params) {
    const saved = this.retries;
    this.retries = 0;
    try { return await this.call(method, params); } finally { this.retries = saved; }
  }

  async getBlockHeight() {
    return Number(await this.call('getBlockHeight', [{ commitment: 'finalized' }]));
  }

  async getLatestBlockhash() {
    const r = await this.call('getLatestBlockhash', [{ commitment: 'finalized' }]);
    return { blockhash: r.value.blockhash, lastValidBlockHeight: r.value.lastValidBlockHeight };
  }
}

// ------------------------------------------------------------------ parsing

function signers(tx) {
  return new Set((tx.transaction?.message?.accountKeys || []).filter((k) => typeof k === 'object' && k.signer).map((k) => k.pubkey));
}

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
    else if (!isOnCurve(decodePubkey(senders[0])) && !signers(tx).has(senders[0])) reason = 'program_owned_sender'; // PDA (e.g. AMM vault via CPI): the real payer is someone else
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
    this._balCache = new Map();
    this.balLimiter = new SimpleLimiter(config.balancesPerMin || 60);
    this.sendLimiter = new SimpleLimiter(config.sendPerMin || 10);
  }

  async chainBalances(owner) {
    normSolAddress(owner, 'owner');
    const hit = this._balCache.get(owner);
    if (hit && Date.now() - hit.at < (this.cfg.balancesCacheMs ?? 5000)) return hit.value;
    const [lamports, ...toks] = await Promise.all([
      this.rpc.getBalance(owner),
      ...this.tokens.map((t) => this.rpc.getTokenAccountInfoBalance(deriveAta(owner, t.mint), t.mint)),
    ]);
    const value = { sol: formatUnits(lamports, 9), tokens: Object.fromEntries(this.tokens.map((t, i) => [t.symbol, formatUnits(toks[i], t.decimals)])) };
    this._balCache.set(owner, { at: Date.now(), value });
    if (this._balCache.size > 5000) this._balCache.clear();
    return value;
  }

  async relay(b64) {
    const v = validateRelayTx(b64, { company: this.company, tokens: this.tokens });
    let sig;
    try { sig = await this.rpc.sendTransaction(b64); } catch (e) {
      if (e.rpc) throw new AppError('TX_REJECTED', `RPC rejected the transaction: ${String(e.rpc.message || '').slice(0, 300)}`);
      throw e;
    }
    if (sig !== v.signature) this.log(`sendTransaction returned ${sig}, expected ${v.signature}`);
    return { signature: v.signature };
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
      features: ['chain/balances', 'chain/send'],
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
    // Finalized block height BEFORE listing signatures: once a mint's scan completes, every finalized tx at or
    // below this height that touched its ATA has been processed.
    let height = null;
    if (typeof this.rpc.getBlockHeight === 'function') {
      try { height = await this.rpc.getBlockHeight(); } catch (e) { this.log(`solana getBlockHeight failed: ${e.message}`); }
    }
    for (const t of this.tokens) {
      const complete = await this._pollToken(t);
      if (complete && height !== null) this.setMeta(`sol_scanned_height:${t.mint}`, height);
    }
    this.lastError = null;
  }

  /** Returns true when every new signature was processed (no backlog left). */
  async _pollToken(t) {
    await this._initCursor(t);
    const key = `sol_until:${t.mint}`;
    const until = this.meta(key) || undefined;
    // Page newest -> oldest back to `until`.
    // Never advance past signatures we have not fetched: page all the way back to `until`.
    const sigs = [];
    let before;
    const maxPages = this.cfg.maxSignaturePages || 1000;
    for (let page = 0; ; page++) {
      if (page >= maxPages) throw new Error(`${t.symbol}: more than ${maxPages} pages of new signatures; refusing to skip history`);
      const batch = await this.rpc.getSignatures(t.ata, { until, before, limit: 1000 });
      if (batch.length === 0 && page > 0) {
        // A full page followed by nothing: make sure we really reached `until` (a lagging fallback node can return []).
        const probe = await this.rpc.getSignatures(t.ata, { before, limit: 1 });
        const reached = until ? probe.length === 1 && probe[0].signature === until : probe.length === 0;
        if (!reached) throw new Error(`${t.symbol}: inconsistent signature paging (lagging RPC?); retrying next poll`);
      }
      sigs.push(...batch);
      if (batch.length < 1000) break;
      before = batch[batch.length - 1].signature;
    }
    sigs.reverse(); // oldest first
    let processed = 0;
    const maxTx = this.cfg.maxTxPerPoll || 200;
    for (const s of sigs) {
      if (processed >= maxTx) {
        this.log(`WARNING solana ${t.symbol}: ${sigs.length} new signatures, processed ${maxTx} this poll (limit hit; possible spam). Backlog continues next poll.`);
        return false;
      }
      const seen = this.db.prepare('SELECT 1 FROM sol_seen WHERE signature = ? AND mint = ?').get(s.signature, t.mint);
      if (!seen && s.err !== null && s.err !== undefined) {
        // Failed transactions move no tokens: skip the getTransaction call (cheap spam stays cheap for us).
        this.engine.tx(() => {
          this.db.prepare('INSERT OR IGNORE INTO sol_seen (signature, mint) VALUES (?, ?)').run(s.signature, t.mint);
          this.setMeta(key, s.signature);
        });
      } else if (!seen) {
        const tx = await this.rpc.getTransaction(s.signature);
        if (!tx) return false; // not retrievable yet: retry next poll without advancing the cursor
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
    return true;
  }

  /**
   * A locked withdrawal may only be unlocked (rejected) when its payout can no longer land: the chain is past the
   * stored lastValidBlockHeight and the watcher has fully scanned past it without a payout to that user/token.
   */
  async verifyUnlock(w) {
    if (!w.processing_at) return true;
    const t = this.bySymbol.get(w.token || 'USDC');
    const lvbh = w.lock_lvbh === null || w.lock_lvbh === undefined ? null : Number(w.lock_lvbh);
    if (!lvbh) throw new AppError('PAYOUT_MAY_LAND', 'Locked without a payout blockhash/lastValidBlockHeight; cannot prove the payout will not land');
    const height = await this.rpc.getBlockHeight();
    const scanned = Number(this.meta(`sol_scanned_height:${t.mint}`) || 0);
    if (height <= lvbh || scanned <= lvbh) {
      throw new AppError('PAYOUT_MAY_LAND', `Payout blockhash valid until block height ${lvbh}; chain is at ${height}, watcher scanned to ${scanned}. Try again once both are past ${lvbh}.`);
    }
    // An unmatched payout to this user/token since the lock may be this withdrawal's payout (matched ones belong to others).
    const landed = this.db.prepare("SELECT 1 FROM sol_outgoing WHERE recipient = ? AND mint = ? AND status = 'unmatched' AND at >= ?").get(w.address, t.mint, w.processing_at);
    if (landed) throw new AppError('PAYOUT_MAY_LAND', 'A payout to this user in this token was seen after the lock; mark it paid instead');
    return true;
  }

  lockInfo(body) {
    const { blockhash, lastValidBlockHeight } = body || {};
    decodePubkey(blockhash, 'blockhash');
    if (!Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight <= 0) throw new AppError('BAD_INPUT', 'lastValidBlockHeight must be a positive integer');
    return { blockhash, lastValidBlockHeight };
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
        else {
          // Backstop: payout for a withdrawal that was cancelled/rejected in the last 72h -> claw back into a hold.
          const prior = this.db.prepare(`SELECT * FROM withdrawals WHERE address = ? AND token = ? AND amount = ? AND status IN ('cancelled', 'rejected')
            AND updated_at >= ? AND id NOT IN (SELECT withdrawal_id FROM alerts WHERE withdrawal_id IS NOT NULL) ORDER BY id LIMIT 1`)
            .get(rc.owner, t.symbol, rc.amount, now - 72 * 3600);
          if (prior) {
            const r = this.engine.recoveryHold({ address: rc.owner, token: t.symbol, amount: rc.amount, signature, withdrawalId: Number(prior.id) });
            this.log(`ALERT payout ${signature} to ${rc.owner} matches ${prior.status} withdrawal #${prior.id}: held ${fmtUsdt(r.held)}, shortfall ${fmtUsdt(r.shortfall)}`);
          }
        }
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
      const b = await this.rpc.getTokenBalance(t.ata, t.mint);
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
        alerts: engine.alerts('open'),
        // payouts seen on chain that matched no pending withdrawal (e.g. paid after a cancel): reconcile manually
        unmatchedPayouts: this.db.prepare("SELECT signature, mint, recipient, amount, at FROM sol_outgoing WHERE status = 'unmatched' ORDER BY id DESC LIMIT 200").all()
          .map((o) => ({ signature: o.signature, token: this.byMint.get(o.mint)?.symbol, recipient: o.recipient, amount: fmtUsdt(BigInt(o.amount)), at: Number(o.at) })),
      },
      liabilities: l,
    };
  }

  extraRoutes(app, { admin, h, body }) {
    app.get('/chain/blockhash', h(() => this.blockhash()));
    app.get('/chain/balances', h((req) => {
      if (!this.balLimiter.hit(req.ip || 'unknown')) throw new AppError('RATE_LIMITED', 'Too many requests', 429);
      return this.chainBalances(String(req.query.owner ?? ''));
    }));
    app.post('/chain/send', h((req) => {
      if (!this.sendLimiter.hit(req.ip || 'unknown')) throw new AppError('RATE_LIMITED', 'Too many requests', 429);
      return this.relay(body(req).tx);
    }));
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

// ------------------------------------------------------- tx relay (POST /chain/send)

export const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
export const MAX_TX_BYTES = 1232;

function readShortVec(buf, o) {
  let len = 0;
  let size = 0;
  for (;;) {
    if (o.i >= buf.length) throw new Error('truncated');
    const b = buf[o.i++];
    len |= (b & 0x7f) << (size * 7);
    size++;
    if ((b & 0x80) === 0) break;
    if (size > 3) throw new Error('bad shortvec');
  }
  return len;
}

function take(buf, o, n) {
  if (o.i + n > buf.length) throw new Error('truncated');
  const out = buf.subarray(o.i, o.i + n);
  o.i += n;
  return out;
}

/** Deserialize a signed wire transaction (legacy or v0). */
export function deserializeTx(buf) {
  const o = { i: 0 };
  const nSig = readShortVec(buf, o);
  const signatures = [];
  for (let k = 0; k < nSig; k++) signatures.push(take(buf, o, 64));
  const msgStart = o.i;
  let version = 'legacy';
  if (buf[o.i] & 0x80) {
    version = buf[o.i] & 0x7f;
    o.i++;
    if (version !== 0) throw new Error(`unsupported tx version ${version}`);
  }
  const [numRequired, numRoSigned, numRoUnsigned] = take(buf, o, 3);
  const nKeys = readShortVec(buf, o);
  const keys = [];
  for (let k = 0; k < nKeys; k++) keys.push(bs58.encode(take(buf, o, 32)));
  const recentBlockhash = bs58.encode(take(buf, o, 32));
  const nIx = readShortVec(buf, o);
  const instructions = [];
  for (let k = 0; k < nIx; k++) {
    const programIdIndex = take(buf, o, 1)[0];
    const nAcc = readShortVec(buf, o);
    const accounts = [...take(buf, o, nAcc)];
    const dLen = readShortVec(buf, o);
    instructions.push({ programIdIndex, accounts, data: Buffer.from(take(buf, o, dLen)) });
  }
  let lookups = [];
  if (version === 0) {
    const nL = readShortVec(buf, o);
    for (let k = 0; k < nL; k++) {
      const key = bs58.encode(take(buf, o, 32));
      const w = take(buf, o, readShortVec(buf, o));
      const r = take(buf, o, readShortVec(buf, o));
      lookups.push({ key, writable: [...w], readonly: [...r] });
    }
  }
  if (o.i !== buf.length) throw new Error('trailing bytes');
  return { signatures, message: buf.subarray(msgStart), version, header: { numRequired, numRoSigned, numRoUnsigned }, keys, recentBlockhash, instructions, lookups };
}

const notAllowed = (msg) => new AppError('TX_NOT_ALLOWED', msg);

/**
 * Validate a user's signed deposit transaction before relaying it. Only compute-budget, company-ATA
 * create/createIdempotent and SPL transferChecked into a company ATA are allowed; fee payer must have signed.
 * Returns { signature (base58), transfers: [{ mint, amount }] }.
 */
export function validateRelayTx(b64, { company, tokens }) {
  if (typeof b64 !== 'string' || b64.length > 2000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new AppError('BAD_INPUT', 'tx must be base64');
  const buf = Buffer.from(b64, 'base64');
  if (buf.toString('base64') !== b64) throw new AppError('BAD_INPUT', 'tx must be canonical base64');
  if (buf.length > MAX_TX_BYTES) throw notAllowed(`transaction larger than ${MAX_TX_BYTES} bytes`);
  let tx;
  try { tx = deserializeTx(buf); } catch (e) { throw notAllowed(`cannot deserialize transaction: ${e.message}`); }
  if (tx.lookups.length) throw notAllowed('address lookup tables are not allowed');
  if (tx.signatures.length === 0 || tx.signatures.length !== tx.header.numRequired) throw notAllowed('signature count mismatch');
  const payer = tx.keys[0];
  if (!payer || !ed25519.verify(tx.signatures[0], tx.message, decodePubkey(payer), { zip215: false })) throw notAllowed('missing or invalid fee payer signature');
  const ataByMint = new Map(tokens.map((t) => [t.mint, t.ata]));
  const companyAtas = new Set(ataByMint.values());
  const key = (ix, k) => {
    const idx = ix.accounts[k];
    if (idx === undefined || idx >= tx.keys.length) throw notAllowed('instruction account out of range');
    return tx.keys[idx];
  };
  const transfers = [];
  for (const ix of tx.instructions) {
    if (ix.programIdIndex >= tx.keys.length) throw notAllowed('program index out of range');
    const program = tx.keys[ix.programIdIndex];
    if (program === COMPUTE_BUDGET_PROGRAM_ID) {
      if (![2, 3].includes(ix.data[0]) || ix.accounts.length) throw notAllowed('only SetComputeUnitLimit / SetComputeUnitPrice are allowed');
    } else if (program === ATA_PROGRAM_ID) {
      if (!(ix.data.length === 0 || (ix.data.length === 1 && (ix.data[0] === 0 || ix.data[0] === 1)))) throw notAllowed('only ATA create / createIdempotent are allowed');
      const ata = key(ix, 1); const owner = key(ix, 2); const mint = key(ix, 3);
      if (owner !== company || ataByMint.get(mint) !== ata) throw notAllowed('ATA creation is only allowed for the company token accounts');
      if (key(ix, 4) !== '11111111111111111111111111111111' || key(ix, 5) !== TOKEN_PROGRAM_ID) throw notAllowed('ATA must use the System and SPL Token programs');
    } else if (program === TOKEN_PROGRAM_ID) {
      if (ix.data[0] !== 12 || ix.data.length !== 10) throw notAllowed('only SPL transferChecked is allowed');
      const mint = key(ix, 1); const dest = key(ix, 2);
      if (!ataByMint.has(mint)) throw notAllowed('mint is not an accepted collateral');
      if (dest !== ataByMint.get(mint) || !companyAtas.has(dest)) throw notAllowed('transfer destination is not the company token account');
      const decimals = ix.data[9];
      const t = tokens.find((x) => x.mint === mint);
      if (decimals !== t.decimals) throw notAllowed('decimals mismatch');
      const amount = ix.data.readBigUInt64LE(1);
      if (amount === 0n) throw notAllowed('zero amount');
      transfers.push({ mint, amount });
    } else {
      throw notAllowed(`program ${program} is not allowed`);
    }
  }
  if (!transfers.length) throw notAllowed('transaction must contain a transferChecked to the company');
  return { signature: bs58.encode(tx.signatures[0]), transfers, payer };
}

export class SimpleLimiter {
  constructor(limit, windowMs = 60_000) { this.limit = limit; this.windowMs = windowMs; this.map = new Map(); }
  hit(key) {
    const now = Date.now();
    let e = this.map.get(key);
    if (!e || now - e.start >= this.windowMs) { e = { start: now, count: 0 }; this.map.set(key, e); }
    e.count++;
    if (this.map.size > 20_000) for (const [k, v] of this.map) if (now - v.start >= this.windowMs) this.map.delete(k);
    return e.count <= this.limit;
  }
}
