# HouseDEX keeper

Off-chain keeper for HouseDEX. It runs two loops in one process, plus a health endpoint:

- **Liquidator.** Builds the set of open positions from exchange events. It backfills from `START_BLOCK`, then polls every `POLL_MS`. On every tick it calls `positionInfo(marketId, trader)` for each tracked position. When `liquidatable` is true it simulates `liquidate` with `staticCall`, then sends it.
- **Index publisher.** Reads index prints from a price source and pushes the newest print per symbol with `oracle.pushIndex`. It only pushes a print that is newer than the last one it pushed and that differs from the on-chain value.

- **Release calendar (optional).** `data/release-calendar.json` holds `[{symbol, releaseAt: ISO}]`. On each publisher loop, the keeper reads `oracle.scheduledPrint(id)` for each symbol. If nothing is scheduled, it calls `oracle.schedulePrint(id, ts)` for the next upcoming release. The exchange's `isCloseOnly(marketId)` is then true from `closeOnlyBefore` (6 hours) before that time until the print is pushed. `pushIndex` clears the schedule.
  - A past-due schedule is left in place, so the market stays close-only until the late print lands.
  - The release a push fulfilled is recorded in the publisher state, so it is not scheduled again.
  - The keeper uses chain time, not wall-clock time. `DRY_RUN` applies here too.
  - The shipped calendar dates are **placeholders**. Replace them with the provider's real release schedule.

ABIs are loaded at **runtime** from `../contracts/artifacts/contracts/**`, falling back to `../web/src/contracts/*.json`. Recompiling the contracts is picked up on restart; no codegen step is needed. The bot treats every exchange event that has both `marketId` and `trader` as a "touch". New events such as a future `PositionModified` are therefore tracked automatically. Each touched position is confirmed with `positionInfo(...).size` before it is used.

## Run

```bash
npm i --legacy-peer-deps
cp .env.example .env      # set RPC_URL, CHAIN_ID, KEEPER_PRIVATE_KEY, ...
npm start                 # liquidator + publisher
npm run liquidator        # liquidator only
npm run publisher         # publisher only
curl localhost:4100/health
```

Contract addresses come from `EXCHANGE_ADDRESS` / `ORACLE_ADDRESS`. If those are not set, the keeper reads `DEPLOYMENTS_FILE[CHAIN_ID]` (default `../web/src/contracts/deployments.json`). If the oracle address is still missing, it uses `exchange.oracle()`.

Publishing needs the keeper EOA to be an oracle keeper: the owner calls `oracle.setKeeper(addr, true)`. Liquidation is permissionless. Rewards (0.2% of notional, capped by the position's remaining equity) are paid to the keeper's address in collateral.

### Config (env)

| Var | Default | Notes |
| --- | --- | --- |
| `RPC_URL` | `http://127.0.0.1:8545` | |
| `CHAIN_ID` | `31337` | Checked against the RPC at startup. Use 97 for BSC testnet and 56 for mainnet. |
| `KEEPER_PRIVATE_KEY` | – | Required unless `DRY_RUN=true`. It is never logged: it is non-enumerable in the config and scrubbed from all log output. |
| `POLL_MS` | `3000` | Liquidator tick |
| `START_BLOCK` | `0` | Backfill start. Set this to the exchange deploy block. |
| `DRY_RUN` | `false` | Logs "would liquidate" and "would push" and sends nothing. It also skips writing publisher state. |
| `LOG_CHUNK` | `5000` | `eth_getLogs` block range per request. Public BSC RPCs often need a smaller value. |
| `LIQ_CONCURRENCY` | `4` | Number of `positionInfo` checks and liquidations in flight at once |
| `GAS_PRICE_GWEI` / `MAX_GAS_PRICE_GWEI` / `GAS_LIMIT` | – | Legacy gas-price override, a cap above which sends are skipped, and a fixed gas limit |
| `PRICE_SOURCE` | `file` | `file` or `http` |
| `PRICES_FILE` | `data/index-prints.json` | A `.json` file containing `[{symbol,date,value}]`, or a `.csv` file with the header `symbol,date,value` |
| `PRICE_HTTP_URL` / `PRICE_HTTP_TOKEN` | – | Stub adapter, see `src/sources/http.js` |
| `RELEASE_CALENDAR_FILE` | `data/release-calendar.json` | Optional. Scheduling is skipped if the file is missing. |
| `PUBLISH_EVERY_MS` | `60000` | |
| `PUBLISHER_STATE_FILE` | `data/.publisher-state.json` | Last pushed `{date,value,tx}` per symbol |
| `HEALTH_PORT` | `4100` | `GET /health` returns `lastProcessedBlock`, `openPositionsTracked`, `liquidationsSent`, plus liquidator and publisher stats |

## Safety behaviour

- **Double-send guard.** Each position has at most one `liquidate` transaction in flight. After a failed send, the position is skipped until the next block. The `NonceManager` nonce is reset after any failure.
- **Races.** `staticCall` runs before every send. A `NotLiquidatable` or `NoPosition` result (another keeper won, or the price recovered) is logged as a skip, not counted as an error, and costs no gas.
- **Publisher bounds.** The publisher reads `oracle.maxPrintMoveBps()` and checks the move against the *current smoothed* `price(id)`, which is the same check the contract makes. It refuses an oversized print locally, logs `REFUSED`, and sends nothing. The publisher also checks `oracle.keepers(keeper)` before sending.
- Prints apply linearly over the oracle's 7-day smoothing window. Liquidations therefore build up over days after a print rather than happening at the moment it is pushed.

## Price sources

`src/sources/file.js` provides `FilePriceSource`. `src/sources/http.js` provides `HttpPriceSource`, a stub for a licensed provider. Any object with `name` and `async fetchPrints() -> [{symbol, date: "YYYY-MM-DD", value}]` works as a source. Pass it with `startKeeper(cfg, { source })`.

## Test (end-to-end on a local chain)

```bash
npm test
```

The test does the following, in order:

1. Starts its own Hardhat node on **:8546** and fails if the port is already in use.
2. Deploys with `scripts/deploy-local.js`, which uses ethers and the compiled artifacts. It does not touch `web/`.
3. Opens a ~98.7x NYC long and a low-leverage short.
4. Checks the publisher in dry-run mode: no print or schedule is sent, and the +13.6% LA print is refused.
5. Checks the calendar:
   - NYC is scheduled at now + 3h, so `isCloseOnly(NYC)` is true and a new open reverts.
   - MIA is scheduled at now + 30 days, so it stays open.
   - The LA release is in the past and is ignored.
   - A second pass does not schedule anything again.
6. Starts the keeper, which pushes a −3% NYC print and refuses LA again. The push clears NYC's schedule and `isCloseOnly` becomes false. The fulfilled release is not scheduled again.
7. Checks that a direct liquidation attempt on the healthy short is handled as `NotLiquidatable`.
8. Advances time in 2-hour steps (`evm_increaseTime` + `evm_mine`) and asserts the following:
   - the keeper liquidates the long in the first block where it becomes liquidatable;
   - there is exactly one `Liquidated` event;
   - the short survives;
   - the keeper received a reward greater than 0;
   - `/health` reports the expected numbers.
9. Kills the node.

To deploy to a local node manually: `RPC_URL=http://127.0.0.1:8546 npm run deploy:local`. This writes `deployments.local.json`; use it with `DEPLOYMENTS_FILE=deployments.local.json`.

## Gaps / next steps

- A calendar time that is changed after it has been scheduled is not rescheduled automatically. Cancel it on-chain with `schedulePrint(id, 0)` and the keeper will pick up the new time.
- Events are tracked by polling (`eth_getLogs`), not by websocket subscription. There is no reorg handling beyond re-confirming positions with `positionInfo`.
- Publisher state is a local JSON file. Run a single publisher instance per oracle.
- Prices are converted to WAD with JavaScript `Number`, so values with more than about 15 significant digits lose precision.
- The HTTP source is a stub; the provider's response mapping and licensing are still to do.
