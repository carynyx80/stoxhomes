// Crafted jsonParsed transactions and a mock Solana JSON-RPC server for tests.
import http from 'node:http';
import crypto from 'node:crypto';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, deriveAta } from '../src/solana.js';

export const keypair = () => {
  const kp = nacl.sign.keyPair();
  return { address: bs58.encode(kp.publicKey), sign: (msg) => bs58.encode(nacl.sign.detached(Buffer.from(msg, 'utf8'), kp.secretKey)) };
};
export const randomSig = () => bs58.encode(crypto.randomBytes(64));
export const randomKey = () => bs58.encode(crypto.randomBytes(32));

/**
 * moves: [{ owner, mint, pre, post, program? , account? }] (amounts raw, null = account absent)
 */
export function craftTx({ signature = randomSig(), slot = 1000, blockTime = 1_790_000_000, err = null, payer, moves }) {
  const keys = [];
  const idx = (k) => { let i = keys.indexOf(k); if (i < 0) { keys.push(k); i = keys.length - 1; } return i; };
  idx(payer || moves[0].owner);
  const pre = [];
  const post = [];
  for (const m of moves) {
    const program = m.program || TOKEN_PROGRAM_ID;
    const account = m.account || deriveAta(m.owner, m.mint, program === TOKEN_PROGRAM_ID ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID);
    const i = idx(account);
    const entry = (amt) => ({ accountIndex: i, mint: m.mint, owner: m.owner, programId: program, uiTokenAmount: { amount: String(amt), decimals: 6, uiAmount: Number(amt) / 1e6, uiAmountString: String(Number(amt) / 1e6) } });
    if (m.pre !== null && m.pre !== undefined) pre.push(entry(m.pre));
    if (m.post !== null && m.post !== undefined) post.push(entry(m.post));
  }
  idx(TOKEN_PROGRAM_ID);
  return {
    blockTime, slot, version: 0,
    meta: { err, fee: 5000, preBalances: keys.map(() => 1), postBalances: keys.map(() => 1), preTokenBalances: pre, postTokenBalances: post, logMessages: [], status: err ? { Err: err } : { Ok: null } },
    transaction: {
      signatures: [signature],
      message: { accountKeys: keys.map((k, i) => ({ pubkey: k, signer: i === 0, writable: true, source: 'transaction' })), instructions: [], recentBlockhash: randomKey() },
    },
  };
}

export class MockSolanaRpc {
  constructor() {
    this.sigs = new Map(); // address -> [{signature, slot, err, blockTime}] newest first
    this.txs = new Map();
    this.tokenBalances = new Map();
    this.lamports = new Map();
    this.calls = {};
    this.fail429 = 0;
    this.slot = 1000;
  }

  /** Make a tx visible (finalized) in the history of the given addresses. */
  publish(tx, addresses) {
    const signature = tx.transaction.signatures[0];
    this.txs.set(signature, tx);
    for (const a of addresses) {
      const list = this.sigs.get(a) || [];
      list.unshift({ signature, slot: tx.slot, err: tx.meta.err, blockTime: tx.blockTime, confirmationStatus: 'finalized' });
      this.sigs.set(a, list);
    }
    return signature;
  }

  handle(method, params) {
    this.calls[method] = (this.calls[method] || 0) + 1;
    switch (method) {
      case 'getSignaturesForAddress': {
        const [addr, o = {}] = params;
        if (o.commitment !== 'finalized') throw { code: -32602, message: 'expected finalized' };
        let list = this.sigs.get(addr) || [];
        if (o.before) { const i = list.findIndex((s) => s.signature === o.before); list = i < 0 ? [] : list.slice(i + 1); }
        if (o.until) { const i = list.findIndex((s) => s.signature === o.until); if (i >= 0) list = list.slice(0, i); }
        return list.slice(0, o.limit || 1000);
      }
      case 'getTransaction': {
        const [sig, o = {}] = params;
        if (o.maxSupportedTransactionVersion !== 1 && o.maxSupportedTransactionVersion !== 0) {
          throw { code: -32015, message: 'Transaction version (0) is not supported by the requesting client' };
        }
        if (o.encoding !== 'jsonParsed') throw { code: -32602, message: 'expected jsonParsed' };
        return this.txs.get(sig) || null;
      }
      case 'getTokenAccountBalance': {
        const b = this.tokenBalances.get(params[0]);
        if (b === undefined) throw { code: -32602, message: 'Invalid param: could not find account' };
        return { context: { slot: this.slot }, value: { amount: String(b), decimals: 6, uiAmount: Number(b) / 1e6, uiAmountString: String(Number(b) / 1e6) } };
      }
      case 'getAccountInfo': {
        const b = this.tokenBalances.get(params[0]);
        if (b === undefined) return { context: { slot: this.slot }, value: null };
        return { context: { slot: this.slot }, value: { data: { parsed: { info: { mint: this.mintOf?.get(params[0]), tokenAmount: { amount: String(b), decimals: 6 } }, type: 'account' }, program: 'spl-token' } } };
      }
      case 'sendTransaction': {
        const buf = Buffer.from(params[0], 'base64');
        if (params[1]?.encoding !== 'base64') throw { code: -32602, message: 'expected base64' };
        if (this.rejectSend) throw { code: -32002, message: 'Transaction simulation failed: insufficient funds' };
        this.sent = (this.sent || []).concat([params[0]]);
        return bs58.encode(buf.subarray(1, 65));
      }
      case 'getBlockHeight': return this.blockHeight ?? this.slot;
      case 'getBalance': return { context: { slot: this.slot }, value: Number(this.lamports.get(params[0]) || 0) };
      case 'getLatestBlockhash': return { context: { slot: this.slot }, value: { blockhash: randomKey(), lastValidBlockHeight: this.slot + 150 } };
      case 'getTokenAccountsByOwner': throw { code: -32601, message: 'Method blocked' };
      default: throw { code: -32601, message: `Method not found: ${method}` };
    }
  }

  listen() {
    this.server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (c) => { data += c; });
      req.on('end', () => {
        if (this.fail429 > 0) { this.fail429--; res.writeHead(429); return res.end('rate limited'); }
        const body = JSON.parse(data);
        if (this.blockIndexed && body.method === 'getTokenAccountBalance') {
          res.writeHead(403, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'Indexed requests require a personal token' } }));
        }
        let out;
        try { out = { jsonrpc: '2.0', id: body.id, result: this.handle(body.method, body.params) }; } catch (e) { out = { jsonrpc: '2.0', id: body.id, error: e }; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out));
      });
    });
    return new Promise((r) => this.server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${this.server.address().port}`)));
  }

  close() { return new Promise((r) => this.server.close(() => r())); }
}
