import crypto from 'node:crypto';
import { verifyMessage, getAddress } from 'ethers';
import { AppError } from './fixed.js';

const NONCE_TTL = 600; // 10 minutes
const SESSION_TTL = 7 * 86400;

export function normAddress(a) {
  if (typeof a !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(a)) throw new AppError('BAD_INPUT', 'address must be a 0x-prefixed 20-byte hex string');
  try { return getAddress(a.toLowerCase()).toLowerCase(); } catch { throw new AppError('BAD_INPUT', 'invalid address'); }
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');

export class Auth {
  constructor({ db, secret, domain, chainId, companyAddress, now }) {
    this.db = db;
    this.secret = secret;
    this.domain = domain;
    this.chainId = chainId;
    this.company = companyAddress.toLowerCase();
    this.now = now;
  }

  createNonce(address) {
    const addr = normAddress(address);
    const nonce = crypto.randomBytes(16).toString('hex');
    const now = this.now();
    const issued = new Date(now * 1000).toISOString();
    const exp = new Date((now + NONCE_TTL) * 1000).toISOString();
    const message = `${this.domain} wants you to sign in with your Ethereum account:\n${getAddress(addr)}\n\n`
      + `Sign in to Stoxhome.\n\nURI: https://${this.domain}\nVersion: 1\nChain ID: ${this.chainId}\nNonce: ${nonce}\nIssued At: ${issued}\nExpiration Time: ${exp}`;
    this.db.prepare('DELETE FROM nonces WHERE expires_at < ?').run(now - 86400);
    this.db.prepare('INSERT INTO nonces (nonce, address, message, expires_at) VALUES (?, ?, ?, ?)').run(nonce, addr, message, now + NONCE_TTL);
    return { message };
  }

  verify({ address, message, signature }) {
    const addr = normAddress(address);
    if (typeof message !== 'string' || message.length > 2000) throw new AppError('BAD_INPUT', 'message required');
    if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new AppError('BAD_INPUT', 'signature must be a 65-byte hex string');
    const m = message.match(/\nNonce: ([0-9a-f]{32})\n/);
    if (!m) throw new AppError('UNAUTHORIZED', 'Malformed sign-in message', 401);
    const now = this.now();
    const tx = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM nonces WHERE nonce = ?').get(m[1]);
      if (!row || Number(row.used) || Number(row.expires_at) < now) throw new AppError('UNAUTHORIZED', 'Nonce invalid, used or expired', 401);
      if (row.address !== addr || row.message !== message) throw new AppError('UNAUTHORIZED', 'Message does not match the issued nonce', 401);
      if (!message.startsWith(`${this.domain} wants you to sign in`) || !message.includes(`\nChain ID: ${this.chainId}\n`)) {
        throw new AppError('UNAUTHORIZED', 'Wrong domain or chain', 401);
      }
      let recovered;
      try { recovered = verifyMessage(message, signature).toLowerCase(); } catch { throw new AppError('UNAUTHORIZED', 'Bad signature', 401); }
      if (recovered !== addr) throw new AppError('UNAUTHORIZED', 'Signature does not match address', 401);
      this.db.prepare('UPDATE nonces SET used = 1 WHERE nonce = ?').run(m[1]);
      this.db.prepare('INSERT OR IGNORE INTO users (address, created_at) VALUES (?, ?)').run(addr, now);
    });
    tx.immediate();
    const expiresAt = now + SESSION_TTL;
    return { token: this.sign({ a: addr, e: expiresAt }), expiresAt, isAdmin: addr === this.company };
  }

  sign(payload) {
    const body = b64u(JSON.stringify(payload));
    const mac = crypto.createHmac('sha256', this.secret).update(body).digest('base64url');
    return `${body}.${mac}`;
  }

  /** Returns { address, isAdmin } or null. */
  check(token) {
    if (typeof token !== 'string' || token.length > 500) return null;
    const [body, mac] = token.split('.');
    if (!body || !mac) return null;
    const expect = crypto.createHmac('sha256', this.secret).update(body).digest();
    let got;
    try { got = Buffer.from(mac, 'base64url'); } catch { return null; }
    if (got.length !== expect.length || !crypto.timingSafeEqual(got, expect)) return null;
    let p;
    try { p = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
    if (!p || typeof p.a !== 'string' || typeof p.e !== 'number' || p.e < this.now()) return null;
    return { address: p.a, isAdmin: p.a === this.company };
  }
}
