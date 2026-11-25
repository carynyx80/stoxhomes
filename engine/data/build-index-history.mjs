// Rebuilds engine/data/index-history.json from FRED (Case-Shiller SA) and
// HM Land Registry (UK HPI, London). Requires network; uses curl.
// Usage: node engine/data/build-index-history.mjs
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FROM = '2000-01';
const FRED = { NYC: 'NYXRSA', LA: 'LXXRSA', MIA: 'MIXRSA', SF: 'SFXRSA' };

const curl = (url) => execFileSync('curl', ['-sSfL', '--retry', '3', url], { encoding: 'utf8', maxBuffer: 64 << 20 });
const r2 = (x) => Math.round(x * 100) / 100;

function parseCsvLine(line) {
  const out = []; let cur = ''; let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === ',' && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function fred(id) {
  const rows = curl(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`).trim().split(/\r?\n/).slice(1);
  return rows.map((l) => l.split(','))
    .filter(([d, v]) => d.slice(0, 7) >= FROM && v !== '' && v !== '.' && Number.isFinite(+v))
    .map(([d, v]) => [d.slice(0, 7), r2(+v)]);
}

function london() {
  const chunks = [['2000-01-01', '2009-12-01'], ['2010-01-01', '2019-12-01'], [`2020-01-01`, `${new Date().getUTCFullYear()}-12-01`]];
  const byMonth = new Map();
  for (const [from, to] of chunks) {
    const url = 'https://landregistry.data.gov.uk/app/ukhpi/download/new.csv'
      + `?from=${from}&to=${to}&location=${encodeURIComponent('http://landregistry.data.gov.uk/id/region/london')}`
      + '&thm%5B%5D=property_type&in%5B%5D=hpi';
    const lines = curl(url).trim().split(/\r?\n/);
    const header = parseCsvLine(lines[0]);
    const iP = header.indexOf('Period');
    const iV = header.indexOf('House price index All property types');
    if (iP < 0 || iV < 0) throw new Error('UK HPI CSV: expected columns missing');
    for (const l of lines.slice(1)) {
      const c = parseCsvLine(l);
      const v = +c[iV];
      if (c[iV] !== '' && Number.isFinite(v)) byMonth.set(c[iP], r2(v));
    }
  }
  return [...byMonth].filter(([m]) => m >= FROM).sort(([a], [b]) => (a < b ? -1 : 1));
}

const series = {};
for (const [sym, id] of Object.entries(FRED)) series[sym] = fred(id);
series.LDN = london();

const out = {
  source: {
    NYC: { provider: 'S&P Cotality Case-Shiller via FRED', id: FRED.NYC, url: 'https://fred.stlouisfed.org/series/NYXRSA', basis: 'Jan 2000 = 100, seasonally adjusted' },
    LA: { provider: 'S&P Cotality Case-Shiller via FRED', id: FRED.LA, url: 'https://fred.stlouisfed.org/series/LXXRSA', basis: 'Jan 2000 = 100, seasonally adjusted' },
    MIA: { provider: 'S&P Cotality Case-Shiller via FRED', id: FRED.MIA, url: 'https://fred.stlouisfed.org/series/MIXRSA', basis: 'Jan 2000 = 100, seasonally adjusted' },
    SF: { provider: 'S&P Cotality Case-Shiller via FRED', id: FRED.SF, url: 'https://fred.stlouisfed.org/series/SFXRSA', basis: 'Jan 2000 = 100, seasonally adjusted' },
    LDN: { provider: 'HM Land Registry UK House Price Index', id: 'region/london', column: 'House price index All property types', url: 'https://landregistry.data.gov.uk/app/ukhpi', basis: 'Jan 2023 = 100, not seasonally adjusted', license: 'Open Government Licence v3.0' },
  },
  fetchedAt: new Date().toISOString(),
  series,
};
writeFileSync(join(HERE, 'index-history.json'), JSON.stringify(out) + '\n');
for (const [s, a] of Object.entries(series)) console.log(s, a.length, a[0][0], '->', a.at(-1).join(' '));
