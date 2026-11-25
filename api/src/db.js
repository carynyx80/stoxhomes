import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, block INTEGER, ts INTEGER, tx TEXT, log_index INTEGER,
  address TEXT, name TEXT, args TEXT);
CREATE INDEX IF NOT EXISTS events_block ON events(block);
CREATE TABLE IF NOT EXISTS markets (
  id INTEGER PRIMARY KEY, name TEXT, symbol TEXT, oracle_id TEXT, city TEXT);
CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY, block INTEGER, ts INTEGER, tx TEXT, log_index INTEGER,
  market_id INTEGER, trader TEXT, kind TEXT, side TEXT, size REAL, price REAL, notional REAL,
  margin REAL, fee REAL, pnl REAL, funding REAL, payout REAL, realized_pnl REAL,
  liquidator TEXT, reward REAL);
CREATE INDEX IF NOT EXISTS trades_market ON trades(market_id, block);
CREATE INDEX IF NOT EXISTS trades_trader ON trades(trader, block);
CREATE INDEX IF NOT EXISTS trades_ts ON trades(ts);
CREATE TABLE IF NOT EXISTS margin_changes (
  id TEXT PRIMARY KEY, block INTEGER, ts INTEGER, tx TEXT, log_index INTEGER,
  market_id INTEGER, trader TEXT, delta REAL, new_margin REAL);
CREATE TABLE IF NOT EXISTS index_prints (
  id TEXT PRIMARY KEY, block INTEGER, ts INTEGER, tx TEXT, log_index INTEGER, oracle_id TEXT, symbol TEXT,
  from_price REAL, to_price REAL);
CREATE INDEX IF NOT EXISTS prints_symbol ON index_prints(symbol, ts);
CREATE TABLE IF NOT EXISTS lp_events (
  id TEXT PRIMARY KEY, block INTEGER, ts INTEGER, tx TEXT, log_index INTEGER, lp TEXT, kind TEXT, amount REAL, shares REAL);
CREATE TABLE IF NOT EXISTS snapshots (
  market_id INTEGER, block INTEGER, ts INTEGER, index_price REAL, mark_price REAL,
  funding_day REAL, long_oi REAL, short_oi REAL, skew REAL, pool_value REAL,
  PRIMARY KEY (market_id, block));
CREATE INDEX IF NOT EXISTS snapshots_ts ON snapshots(market_id, ts);
CREATE TABLE IF NOT EXISTS pool_snapshots (
  block INTEGER PRIMARY KEY, ts INTEGER, pool_value REAL, total_shares REAL, share_price REAL,
  total_margin REAL, tvl REAL);
`;

// Tables holding chain-derived rows that must be rolled back on re-scan.
export const EVENT_TABLES = ["events", "trades", "margin_changes", "index_prints", "lp_events"];

/** Opens SQLite via better-sqlite3, falling back to Node's built-in node:sqlite. */
export function openDb(file) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  let db, driver;
  try {
    const Database = require("better-sqlite3");
    db = new Database(file);
    db.pragma("journal_mode = WAL");
    driver = "better-sqlite3";
  } catch (e) {
    const { DatabaseSync } = require("node:sqlite");
    db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL");
    driver = "node:sqlite";
  }
  db.exec(SCHEMA);
  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = db.prepare(sql)));
    return s;
  };
  const api = {
    driver,
    raw: db,
    all: (sql, ...p) => stmt(sql).all(...p),
    get: (sql, ...p) => stmt(sql).get(...p),
    run: (sql, ...p) => stmt(sql).run(...p),
    tx(fn) {
      db.exec("BEGIN");
      try { const r = fn(); db.exec("COMMIT"); return r; }
      catch (e) { db.exec("ROLLBACK"); throw e; }
    },
    getMeta(k) { return api.get("SELECT value FROM meta WHERE key=?", k)?.value; },
    setMeta(k, v) { api.run("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)", k, String(v)); },
    /** Insert a row object into a table; OR IGNORE keeps inserts idempotent on the primary key. */
    insert(table, row, mode = "OR IGNORE") {
      const keys = Object.keys(row);
      const sql = `INSERT ${mode} INTO ${table}(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`;
      return stmt(sql).run(...keys.map((k) => normalize(row[k])));
    },
    close() { db.close(); },
  };
  return api;
}

function normalize(v) {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "bigint") return v.toString();
  return v;
}
