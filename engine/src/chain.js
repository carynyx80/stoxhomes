// BSC RPC client (with fallbacks + retries) and the USDT deposit/withdrawal watcher.
import { AppError, fmtUsdt } from './fixed.js';

export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const padTopic = (addr) => '0x' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const topicToAddr = (t) => '0x' + t.slice(-40).toLowerCase();
const hex = (x) => '0x' + BigInt(x).toString(16);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Rpc {
  constructor(urls, { retries = 3, timeoutMs = 15000, log = () => {} } = {}) {
    this.urls = urls;
    this.retries = retries;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.id = 0;
    this.preferred = 0;
  }

  async call(method, params = []) {
    let lastErr;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      for (let k = 0; k < this.urls.length; k++) {
        const i = (this.preferred + k) % this.urls.length;
        const url = this.urls[i];
        try {
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
          let res;
          try {
            res = await fetch(url, {
              method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctl.signal,
              body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
            });
          } finally { clearTimeout(timer); }
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = await res.json();
          if (body.error) {
            const e = new Error(`RPC ${method}: ${body.error.message || JSON.stringify(body.error)}`);
            e.rpc = body.error;
            throw e;
          }
          this.preferred = i;
          return body.result;
        } catch (e) {
          lastErr = e;
          this.log(`rpc ${method} failed on endpoint #${i}: ${e.message}`);
        }
      }
      await sleep(Math.min(250 * 2 ** attempt, 4000));
    }
    throw lastErr;
  }

  async blockNumber() { return Number(BigInt(await this.call('eth_blockNumber'))); }
  async chainId() { return Number(BigInt(await this.call('eth_chainId'))); }
  getLogs(filter) { return this.call('eth_getLogs', [filter]); }
  getReceipt(txHash) { return this.call('eth_getTransactionReceipt', [txHash]); }
  async balanceOf(token, owner) {
    const data = '0x70a08231' + owner.toLowerCase().replace(/^0x/, '').padStart(64, '0');
    return BigInt(await this.call('eth_call', [{ to: token, data }, 'latest']));
  }
}

export class Watcher {
  constructor({ engine, rpc, config, log = () => {} }) {
    this.engine = engine;
    this.db = engine.db;
    this.rpc = rpc;
    this.cfg = config;
    this.log = log;
    this.company = config.companyAddress.toLowerCase();
    this.token = config.usdtAddress.toLowerCase();
    const d = BigInt(config.usdtDecimals);
    this.toMicro = d >= 6n ? (raw) => raw / 10n ** (d - 6n) : (raw) => raw * 10n ** (6n - d);
    this.fromMicro = d >= 6n ? (m) => m * 10n ** (d - 6n) : (m) => m / 10n ** (6n - d);
    this.lastError = null;
    this.running = false;
  }

  meta(key) { const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key); return r ? r.value : null; }
  setMeta(key, v) { this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(v)); }

  /** Last fully scanned (confirmed) block. */
  cursor() { const v = this.meta('last_block'); return v === null ? null : Number(v); }
  head() { const v = this.meta('head'); return v === null ? null : Number(v); }

  async initCursor() {
    if (this.cursor() !== null) return;
    let start = this.cfg.startBlock;
    if (start === null) {
      if (this.cfg.prod) throw new Error('START_BLOCK is required in production');
      start = await this.rpc.blockNumber();
      this.log(`START_BLOCK not set; starting from current head ${start} (dev only)`);
    }
    this.setMeta('last_block', Math.max(start - 1, 0));
  }

  async poll() {
    await this.initCursor();
    const head = await this.rpc.blockNumber();
    this.setMeta('head', head);
    const safe = head - this.cfg.confirmations + 1;
    let cursor = this.cursor();
    let chunks = 0;
    while (cursor < safe && chunks < 50) {
      const from = cursor + 1;
      const to = Math.min(safe, from + this.cfg.logChunk - 1);
      const [inLogs, outLogs] = await this._fetchRange(from, to);
      this.engine.tx(() => {
        for (const l of inLogs) this._recordIncoming(l, true);
        for (const l of outLogs) this._recordOutgoing(l);
        // anything still "confirming" at or below the confirmed cursor was reorged out
        this.db.prepare("UPDATE deposits SET status = 'dropped' WHERE status = 'confirming' AND block_number <= ?").run(to);
        this.setMeta('last_block', to);
      });
      cursor = to;
      chunks++;
    }
    // Peek at the unconfirmed tail so users can see "confirming" deposits.
    if (head > cursor && head - cursor <= this.cfg.logChunk) {
      const logs = await this.rpc.getLogs({ address: this.token, fromBlock: hex(cursor + 1), toBlock: hex(head), topics: [TRANSFER_TOPIC, null, padTopic(this.company)] });
      this.engine.tx(() => { for (const l of logs) this._recordIncoming(l, false); });
    }
    this.lastError = null;
    return { head, cursor };
  }

  async _fetchRange(from, to) {
    const base = { address: this.token, fromBlock: hex(from), toBlock: hex(to) };
    try {
      return await Promise.all([
        this.rpc.getLogs({ ...base, topics: [TRANSFER_TOPIC, null, padTopic(this.company)] }),
        this.rpc.getLogs({ ...base, topics: [TRANSFER_TOPIC, padTopic(this.company)] }),
      ]);
    } catch (e) {
      // Some providers cap the range/results: split and retry.
      if (to > from) {
        const mid = Math.floor((from + to) / 2);
        const a = await this._fetchRange(from, mid);
        const b = await this._fetchRange(mid + 1, to);
        return [a[0].concat(b[0]), a[1].concat(b[1])];
      }
      throw e;
    }
  }

  _validLog(l) {
    return l && !l.removed && l.address && l.address.toLowerCase() === this.token && l.topics && l.topics.length === 3 && l.topics[0] === TRANSFER_TOPIC;
  }

  _recordIncoming(l, confirmed) {
    if (!this._validLog(l)) return;
    const from = topicToAddr(l.topics[1]);
    const to = topicToAddr(l.topics[2]);
    if (to !== this.company || from === this.company) return;
    const raw = BigInt(l.data);
    const amount = this.toMicro(raw);
    const logIndex = Number(BigInt(l.logIndex));
    const block = Number(BigInt(l.blockNumber));
    const now = this.engine.now();
    this.db.prepare(`INSERT INTO deposits (tx_hash, log_index, block_number, block_hash, from_addr, value_raw, amount, status, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'confirming', ?) ON CONFLICT(tx_hash, log_index) DO UPDATE SET block_number = excluded.block_number,
      block_hash = excluded.block_hash, status = CASE WHEN deposits.status = 'dropped' THEN 'confirming' ELSE deposits.status END`)
      .run(l.transactionHash.toLowerCase(), logIndex, block, l.blockHash, from, raw.toString(), amount, now);
    if (!confirmed) return;
    const d = this.db.prepare('SELECT * FROM deposits WHERE tx_hash = ? AND log_index = ?').get(l.transactionHash.toLowerCase(), logIndex);
    if (d.status !== 'confirming') return;
    if (amount < this.cfg.minDeposit) {
      this.db.prepare("UPDATE deposits SET status = 'below_minimum' WHERE id = ?").run(d.id);
      this.log(`deposit ${d.tx_hash} below minimum (${fmtUsdt(amount)})`);
      return;
    }
    this.engine.creditDeposit(d.id);
  }

  _recordOutgoing(l) {
    if (!this._validLog(l)) return;
    const from = topicToAddr(l.topics[1]);
    const to = topicToAddr(l.topics[2]);
    if (from !== this.company) return;
    const raw = BigInt(l.data);
    const txHash = l.transactionHash.toLowerCase();
    const logIndex = Number(BigInt(l.logIndex));
    const r = this.db.prepare(`INSERT INTO outgoing (tx_hash, log_index, block_number, block_hash, to_addr, value_raw, status, at)
      VALUES (?, ?, ?, ?, ?, ?, 'seen', ?) ON CONFLICT(tx_hash, log_index) DO NOTHING`)
      .run(txHash, logIndex, Number(BigInt(l.blockNumber)), l.blockHash, to, raw.toString(), this.engine.now());
    if (!r.changes) return; // already processed (e.g. via admin /paid)
    // Exact-amount match, oldest pending withdrawal first.
    const pending = this.db.prepare("SELECT * FROM withdrawals WHERE status = 'pending' AND address = ? ORDER BY id").all(to);
    const w = pending.find((x) => this.fromMicro(BigInt(x.amount)) === raw);
    if (!w) {
      this.db.prepare("UPDATE outgoing SET status = 'unmatched' WHERE tx_hash = ? AND log_index = ?").run(txHash, logIndex);
      return;
    }
    this.engine.markWithdrawalPaid(Number(w.id), txHash);
    this.db.prepare("UPDATE outgoing SET status = 'matched', withdrawal_id = ? WHERE tx_hash = ? AND log_index = ?").run(w.id, txHash, logIndex);
  }

  /** Admin: verify a payout tx on chain, then mark the withdrawal paid. */
  async verifyAndMarkPaid(id, txHash) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash || '')) throw new AppError('BAD_INPUT', 'txHash must be a 32-byte hex string');
    txHash = txHash.toLowerCase();
    const w = this.db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);
    if (!w) throw new AppError('NOT_FOUND', 'Withdrawal not found', 404);
    if (w.status !== 'pending') throw new AppError('NOT_PENDING', 'Withdrawal is not pending');
    const rc = await this.rpc.getReceipt(txHash);
    if (!rc) throw new AppError('TX_NOT_FOUND', 'Transaction receipt not found');
    if (BigInt(rc.status) !== 1n) throw new AppError('TX_FAILED', 'Transaction reverted');
    const need = this.fromMicro(BigInt(w.amount));
    const candidates = (rc.logs || []).filter((l) => this._validLog(l)
      && topicToAddr(l.topics[1]) === this.company && topicToAddr(l.topics[2]) === w.address && BigInt(l.data) >= need);
    return this.engine.tx(() => {
      const w2 = this.db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);
      if (w2.status !== 'pending') throw new AppError('NOT_PENDING', 'Withdrawal is not pending');
      for (const l of candidates) {
        const logIndex = Number(BigInt(l.logIndex));
        const used = this.db.prepare("SELECT * FROM outgoing WHERE tx_hash = ? AND log_index = ? AND status = 'matched'").get(txHash, logIndex);
        if (used) continue;
        this.db.prepare(`INSERT INTO outgoing (tx_hash, log_index, block_number, block_hash, to_addr, value_raw, status, withdrawal_id, at)
          VALUES (?, ?, ?, ?, ?, ?, 'matched', ?, ?) ON CONFLICT(tx_hash, log_index) DO UPDATE SET status = 'matched', withdrawal_id = excluded.withdrawal_id`)
          .run(txHash, logIndex, Number(BigInt(l.blockNumber)), l.blockHash, w.address, BigInt(l.data).toString(), id, this.engine.now());
        return this.engine.markWithdrawalPaid(id, txHash);
      }
      throw new AppError('TX_MISMATCH', 'No unused USDT transfer from the company to the user for at least the requested amount in this tx');
    });
  }

  depositsFor(address) {
    const head = this.head();
    return this.db.prepare('SELECT * FROM deposits WHERE from_addr = ? ORDER BY id DESC LIMIT 200').all(address).map((d) => ({
      txHash: d.tx_hash, amount: fmtUsdt(BigInt(d.amount)), status: d.status,
      confirmations: head === null ? 0 : Math.max(0, head - Number(d.block_number) + 1), at: Number(d.at),
    }));
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      try { await this.poll(); } catch (e) { this.lastError = e.message; this.log(`watcher error: ${e.message}`); }
      if (this.running) this.timer = setTimeout(loop, this.cfg.pollMs);
    };
    loop();
  }

  stop() { this.running = false; clearTimeout(this.timer); }
}
