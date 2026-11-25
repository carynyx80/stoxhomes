# Historical index data

`index-history.json` holds monthly house-price index prints for Stoxhome markets.
`src/historical.js` reads it once at startup. It makes no network calls at runtime.

```
{ "source": { <symbol>: {provider, id, url, basis, ...} },
  "fetchedAt": "<ISO timestamp>",
  "series": { "NYC": [["2000-01", 100.34], ...], "LA": [...], "MIA": [...], "SF": [...], "LDN": [...] } }
```

Each row is `[YYYY-MM, value]`, oldest first, rounded to 2 decimals. The month is the reference month of the print, not its publication date.

## Sources

| Symbol | Series | Basis |
|---|---|---|
| NYC | S&P Cotality Case-Shiller New York Home Price Index, FRED `NYXRSA` | Jan 2000 = 100, seasonally adjusted |
| LA  | S&P Cotality Case-Shiller Los Angeles, FRED `LXXRSA` | Jan 2000 = 100, SA |
| MIA | S&P Cotality Case-Shiller Miami, FRED `MIXRSA` | Jan 2000 = 100, SA |
| SF  | S&P Cotality Case-Shiller San Francisco, FRED `SFXRSA` | Jan 2000 = 100, SA |
| LDN | HM Land Registry UK HPI, region London, "House price index All property types" | Jan 2023 = 100, not seasonally adjusted |

- FRED CSV: `https://fred.stlouisfed.org/graph/fredgraph.csv?id=<ID>`
- UK HPI CSV: `https://landregistry.data.gov.uk/app/ukhpi/download/new.csv?from=YYYY-MM-01&to=YYYY-MM-01&location=http%3A%2F%2Flandregistry.data.gov.uk%2Fid%2Fregion%2Flondon&thm%5B%5D=property_type&in%5B%5D=hpi`. The build script fetches this in 10-year chunks.

Case-Shiller prints lag by about two months. UK HPI prints lag by about two months, and the latest months are revised as more sales are registered.

## Licensing notes

- **Case-Shiller (S&P Dow Jones Indices / Cotality):** this data is copyrighted. FRED redistributes it with permission, and its terms of use for third-party series apply. The S&P/Case-Shiller marks belong to S&P Dow Jones Indices LLC. Using the data internally for research and reference is fine. Commercial use, such as settling a traded product on the index or redistributing it, likely needs a licence from S&P DJI. Check this before using the data in production.
- **UK HPI (HM Land Registry, ONS, Registers of Scotland, LPS):** released under the Open Government Licence v3.0. You must attribute it: "Contains HM Land Registry data © Crown copyright and database right <year>. This data is licensed under the Open Government Licence v3.0."

## Refresh

```
node engine/data/build-index-history.mjs
node --test engine/test/historical.test.js
```

The build script needs `curl` and network access to `fred.stlouisfed.org` and `landregistry.data.gov.uk`. It overwrites `index-history.json` and prints each series' length and latest print.

`test/historical.test.js` pins the Sep 2026 latest values. After a refresh that adds a new month, or after the source revises a value, update `EXPECTED_LATEST` and `SEP_2026`.
