import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ledger_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tx_id INTEGER NOT NULL,
  account TEXT NOT NULL,
  amount INTEGER NOT NULL,
  ref TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_account ON ledger_entries(account);
CREATE INDEX IF NOT EXISTS ledger_tx ON ledger_entries(tx_id);
CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
CREATE TABLE IF NOT EXISTS balances (account TEXT PRIMARY KEY, balance INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS users (address TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS nonces (
  nonce TEXT PRIMARY KEY, address TEXT NOT NULL, message TEXT NOT NULL, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS markets (
  id INTEGER PRIMARY KEY, symbol TEXT UNIQUE NOT NULL, name TEXT NOT NULL, active INTEGER NOT NULL,
  skew_scale TEXT NOT NULL, max_funding TEXT NOT NULL, max_skew_bps INTEGER NOT NULL,
  skew TEXT NOT NULL, sum_size_entry TEXT NOT NULL, sum_size_funding TEXT NOT NULL,
  funding_index TEXT NOT NULL, last_funding_time INTEGER NOT NULL,
  long_size TEXT NOT NULL, short_size TEXT NOT NULL, margin_total INTEGER NOT NULL,
  from_price TEXT NOT NULL, to_price TEXT NOT NULL, updated_at INTEGER NOT NULL, period INTEGER NOT NULL,
  scheduled_print INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS positions (
  market_id INTEGER NOT NULL, address TEXT NOT NULL, size TEXT NOT NULL, margin INTEGER NOT NULL,
  entry_price TEXT NOT NULL, entry_funding TEXT NOT NULL, size_entry TEXT NOT NULL, opened_at INTEGER NOT NULL,
  PRIMARY KEY (market_id, address)
);
CREATE TABLE IF NOT EXISTS prints (
  id INTEGER PRIMARY KEY AUTOINCREMENT, market_id INTEGER NOT NULL, value TEXT NOT NULL, source TEXT, at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, market_id INTEGER NOT NULL, address TEXT NOT NULL,
  side TEXT NOT NULL, kind TEXT NOT NULL, size TEXT NOT NULL, price TEXT NOT NULL, notional INTEGER NOT NULL,
  leverage TEXT NOT NULL, fee INTEGER NOT NULL, vault_fee INTEGER NOT NULL, realized_pnl INTEGER NOT NULL, payout INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS trades_market ON trades(market_id, at);
CREATE INDEX IF NOT EXISTS trades_addr ON trades(address);
CREATE TABLE IF NOT EXISTS margin_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, market_id INTEGER NOT NULL, address TEXT NOT NULL,
  delta INTEGER NOT NULL, kind TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS vault_shares (
  address TEXT PRIMARY KEY, shares TEXT NOT NULL, pending_shares TEXT NOT NULL, pending_value INTEGER NOT NULL, unlock_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS vault_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, address TEXT NOT NULL, kind TEXT NOT NULL, amount INTEGER NOT NULL, shares TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL, from_addr TEXT NOT NULL, value_raw TEXT NOT NULL, amount INTEGER NOT NULL, status TEXT NOT NULL,
  at INTEGER NOT NULL, credited_at INTEGER, UNIQUE (tx_hash, log_index)
);
CREATE TABLE IF NOT EXISTS outgoing (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL, to_addr TEXT NOT NULL, value_raw TEXT NOT NULL, status TEXT NOT NULL,
  withdrawal_id INTEGER, at INTEGER NOT NULL, UNIQUE (tx_hash, log_index)
);
CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, address TEXT NOT NULL, amount INTEGER NOT NULL, to_addr TEXT NOT NULL,
  status TEXT NOT NULL, tx_hash TEXT, reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS withdrawals_status ON withdrawals(status, id);
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT, market_id INTEGER NOT NULL, at INTEGER NOT NULL, index_price TEXT NOT NULL,
  mark_price TEXT NOT NULL, funding_rate TEXT NOT NULL, long_oi TEXT NOT NULL, short_oi TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS snapshots_market ON snapshots(market_id, at);
`;

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.defaultSafeIntegers(true);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}
