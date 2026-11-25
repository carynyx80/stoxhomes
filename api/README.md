# HouseDEX API (indexer + REST/WebSocket)

Indexes `HousePerpExchange` and `HouseIndexOracle` events into SQLite and serves the data the web app needs.

- Node 22, ESM, ethers 6, `better-sqlite3` (falls back to Node's built-in `node:sqlite` if the native module is missing), plain `node:http` + `ws`.
- ABIs are read from `web/src/contracts/*.json` (or `ABI_DIR`) at startup. Logs the ABI can't decode, or events without a handler, are still stored in the raw `events` table and logged once, never fatal. To support a new event, add a function to `HANDLERS` in `src/indexer.js`.
- Idempotent: every row is keyed by `txHash:logIndex`. Each poll re-scans the last `REORG_DEPTH` (10) blocks: rows from those blocks are deleted and rebuilt inside one transaction, so reorged-out logs disappear. WebSocket pushes only go out for ids that weren't there before.
- Snapshots (index, mark, funding/day, long/short OI, skew, pool value, share price, TVL) are taken at the head every `SNAPSHOT_EVERY` blocks and after any poll that saw trades, prints or LP activity.

```bash
cd api
npm i --legacy-peer-deps
cp .env.example .env      # set RPC_URL etc.; addresses default to web/src/contracts/deployments.json[CHAIN_ID]
npm start                 # http://localhost:4000, ws://localhost:4000/ws
npm test                  # e2e: own hardhat node on :8547, deploy, activity, assert every endpoint
```

`scripts/deploy-local.js` deploys MockUSDT + oracle + exchange with ethers and `contracts/artifacts` (run `npx hardhat compile` in `contracts/` first). It does not write `web/src/contracts`:
`RPC_URL=http://127.0.0.1:8547 node scripts/deploy-local.js out.json`.

## Config (env)

| Var | Default |
| --- | --- |
| `RPC_URL` | `http://127.0.0.1:8545` |
| `CHAIN_ID` | `31337` |
| `EXCHANGE_ADDRESS`, `ORACLE_ADDRESS`, `COLLATERAL_ADDRESS` | from `deployments.json[CHAIN_ID]` (collateral falls back to `exchange.collateral()`) |
| `START_BLOCK` | `0` (set this to the deployment block on testnet) |
| `POLL_MS` | `3000` |
| `SNAPSHOT_EVERY` | `20` blocks |
| `REORG_DEPTH` | `10` |
| `LOG_CHUNK` | `2000` blocks per `eth_getLogs` |
| `DB_PATH` | `./data/housedex.db` |
| `PORT` | `4000` |
| `CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` |
| `ABI_DIR` | `../web/src/contracts` |

All amounts are decimal numbers (18-decimal WAD values converted with `formatUnits`). Timestamps are unix seconds of the block. "24h" and "7d" windows are measured back from the latest indexed block timestamp, so they still work on a local chain whose time has been moved forward. A market `:id` can be the numeric id or the symbol (`NYC`, `NYC-USD`).

## Endpoints

### `GET /markets`
Live values come from contract reads, cached for 1.5s. If the RPC is down they fall back to the last snapshot.
```json
[{ "id": 0, "symbol": "NYC", "name": "NYC-USD", "city": "New York", "active": true, "closeOnly": false,
   "indexPrice": 330.00008, "markPrice": 330.00008, "fundingRatePerDay": 0,
   "longOI": 0, "shortOI": 0, "skew": 0, "longOIUsd": 0, "shortOIUsd": 0,
   "volume24h": 396000.05, "trades24h": 5, "change24h": 1.5e-7,
   "lastPrint": { "price": 340, "timestamp": 1796195369 } }]
```
OI values are in index units; the `*Usd` fields are valued at the index price. `fundingRatePerDay` is a fraction (0.001 = 0.1%/day, positive means longs pay). `change24h` is also a fraction.

### `GET /markets/:id/history?range=1M|6M|1Y|5Y` (also `1D`, `1W`, `ALL`)
```json
{ "marketId": 0, "symbol": "NYC", "range": "1M", "from": 1793603376, "to": 1796195376,
  "prints": [{ "timestamp": 1795590487, "block": 4, "fromPrice": 330, "price": 340, "txHash": "0x…" }],
  "snapshots": [{ "timestamp": 1796195371, "block": 29, "indexPrice": 330.00003, "markPrice": 330.00003,
                  "fundingRatePerDay": 0, "longOI": 300, "shortOI": 300, "skew": 0, "poolValue": 1001084.6 }] }
```
`prints` holds `FeedCreated` (initial value, `fromPrice == price`) and `IndexPushed` events. Snapshots are downsampled to at most 1000 points.

### `GET /markets/:id/trades?limit=50` (max 500), newest first
```json
[{ "id": "0x…:1", "marketId": 0, "trader": "0x90f7…", "kind": "close", "side": "short", "size": -200,
   "price": 329.967, "notional": 65993.4, "margin": null, "fee": 32.99, "pnl": 16.49, "funding": 1.5e-7,
   "payout": 4930.68, "realizedPnl": -16.5, "liquidator": null, "reward": null,
   "block": 32, "timestamp": 1796195374, "txHash": "0x…" }]
```
`kind` is one of `open`, `close`, `modify` (`PositionModified`: `size` is the size delta and `margin` is the new margin) or `liquidation`. `side` is the side of the position. Per kind, `realizedPnl` is:
- open: `-fee`
- close: `pnl - funding - fee`
- modify: `realizedPnl - fundingSettled - fee`
- liquidation: `-margin`

### `GET /traders/:address/positions`
Open positions, read live from `positionInfo` for each market.
```json
[{ "marketId": 0, "symbol": "NYC", "side": "short", "size": -300, "margin": 4950.5, "entryPrice": 329.95,
   "indexPrice": 330.0, "notional": 99000, "leverage": 20.1, "unrealizedPnl": -15.1, "funding": 0.0,
   "equity": 4935.4, "liquidationPrice": 345.6, "liquidatable": false, "openedAt": 1796195370, "openTx": "0x…" }]
```

### `GET /traders/:address/history?limit=200`
```json
{ "trader": "0x…", "summary": { "realizedPnl": -69.3, "volume": 198000, "fees": 99.0, "trades": 3 },
  "trades": [ /* same shape as /trades */ ],
  "marginChanges": [{ "marketId": 0, "delta": 100, "newMargin": 1100, "timestamp": 0, "txHash": "0x…" }],
  "lp": [{ "kind": "deposit", "amount": 1000000, "shares": 1000000, "timestamp": 0, "txHash": "0x…" }] }
```

### `GET /pool?range=ALL|1M|…`
```json
{ "poolValue": 1001173.7, "totalShares": 1000000, "sharePrice": 1.00117, "totalMargin": 0, "tvl": 1001198.0,
  "fees7d": 198.0, "fees30d": 243.0, "feeApr7d": 0.0103, "feeApr30d": 0.0127,
  "lpCount": 1, "totalDeposited": 1000000, "totalWithdrawn": 0,
  "sharePriceHistory": [{ "timestamp": 1796195371, "block": 29, "sharePrice": 1.00108, "poolValue": 1001084.6 }],
  "recent": [{ "lp": "0x7099…", "kind": "deposit", "amount": 1000000, "shares": 1000000, "timestamp": 0, "txHash": "0x…" }] }
```
The fee APR is trading fees in the window divided by the average pool value, annualised. The window is shortened to the indexed history (minimum 1h). It counts gross trading fees only: the protocol fee share and trader PnL/funding are not included. LP `kind` is one of `deposit`, `withdraw`, `withdraw_request` or `withdraw_cancel`.

### `GET /stats`
```json
{ "tvl": 1001198.0, "poolValue": 1001173.7, "volume24h": 483300.05, "trades24h": 6, "totalVolume": 573309.3,
  "totalTrades": 7, "totalOI": 0, "traderCount": 3, "traders24h": 3, "markets": 5, "lastBlock": 34 }
```
`tvl` is the collateral balance of the exchange (pool plus trader margin). `totalOI` is `(long + short)` size times the index price, in USD.

### `GET /leaderboard?period=24h|7d|30d|all&limit=50`
```json
{ "period": "7d", "entries": [{ "rank": 1, "trader": "0x…", "realizedPnl": -69.3, "volume": 198000,
  "trades": 3, "winRate": 0, "liquidations": 0 }] }
```
Ranked by realized PnL after fees and funding, from trades in the period.

### `GET /health`
```json
{ "ok": true, "chainId": 31337, "lastBlock": 34, "headTs": 1796195376, "db": "better-sqlite3" }
```

### WebSocket `ws://host:4000/ws[?market=<id>]`
On connect the server sends `{"type":"hello","data":{"chainId":31337,"lastBlock":34}}`. After that:
- `{"type":"trade","data":{…same shape as /trades…}}` (filtered by `?market=` when given)
- `{"type":"snapshot","data":{"block":29,"ts":…,"markets":[{"market_id":0,"index_price":…,"mark_price":…,"funding_day":…,"long_oi":…,"short_oi":…,"skew":…,"active":true,"close_only":false}],"pool":{"pool_value":…,"total_shares":…,"share_price":…,"total_margin":…,"tvl":…}}}`
- `{"type":"indexPrint","data":{"symbol":"NYC","from_price":330,"to_price":340,"ts":…,"block":…}}`
- `{"type":"lp","data":{"lp":"0x…","kind":"deposit","amount":…,"shares":…}}`

## Storage

SQLite tables:
- `events`: every log, raw, with decoded args when the ABI knows the event
- `trades`
- `margin_changes`
- `index_prints`
- `lp_events`
- `snapshots` (per market and block)
- `pool_snapshots`
- `markets`
- `meta` (`lastBlock`, `headTs`, `lastSnapshotBlock`)
