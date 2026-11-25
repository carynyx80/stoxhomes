// Historical monthly index prints for Stoxhome markets.
// Data is loaded once from engine/data/index-history.json; no network access at runtime.
// Refresh the data with: node engine/data/build-index-history.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DATA_PATH = fileURLToPath(new URL('../data/index-history.json', import.meta.url));

let cache = null;

function load() {
  if (cache) return cache;
  const raw = JSON.parse(readFileSync(DATA_PATH, 'utf8'));
  const series = {};
  for (const [symbol, rows] of Object.entries(raw.series)) {
    series[symbol] = Object.freeze(
      rows
        .map(([month, value]) => {
          const [y, m] = month.split('-').map(Number);
          return Object.freeze({ at: Date.UTC(y, m - 1, 1) / 1000, value });
        })
        .sort((a, b) => a.at - b.at),
    );
  }
  cache = { source: raw.source, fetchedAt: raw.fetchedAt, series };
  return cache;
}

function seriesFor(symbol) {
  const s = load().series[String(symbol).toUpperCase()];
  if (!s) throw new Error(`historical: unknown symbol ${symbol}`);
  return s;
}

export const symbols = () => Object.keys(load().series);

/** All monthly prints, oldest first: [{ at: unix seconds (1st of month UTC), value }]. */
export function getMonthlyPrints(symbol) {
  return seriesFor(symbol);
}

/** Most recent print { at, value }, or null if the series is empty. */
export function latest(symbol) {
  const s = seriesFor(symbol);
  return s.length ? s[s.length - 1] : null;
}

/**
 * Fractional change from the print N calendar months before the latest print
 * to the latest print (e.g. 0.058 = +5.8%). Null if that month is missing.
 */
export function changeOver(symbol, months) {
  const s = seriesFor(symbol);
  if (!s.length || !Number.isInteger(months) || months < 0) return null;
  const last = s[s.length - 1];
  const d = new Date(last.at * 1000);
  const target = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - months, 1) / 1000;
  const base = s.find((p) => p.at === target);
  if (!base || !base.value) return null;
  return last.value / base.value - 1;
}

export function metadata() {
  const { source, fetchedAt } = load();
  return { source, fetchedAt };
}
