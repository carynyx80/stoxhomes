# Stoxhome engine

Off-chain, custodial exchange engine for Stoxhome: perpetual futures on city house-price indices
(NYC, LA, MIA, SF, LDN), up to 100x, with a USDT vault as the counterparty. It implements
[`docs/ENGINE_API.md`](../docs/ENGINE_API.md) and ports the economics of
`contracts/HousePerpExchange.sol` and `HouseIndexOracle.sol`, including the fixes in `SECURITY_REVIEW.md`.

Node 22, ESM, SQLite (better-sqlite3, WAL), ethers v6, express, ws.

## Run

```bash
cd engine
npm i --legacy-peer-deps
cp .env.example .env    # then edit; the engine reads process.env (use `node --env-file=.env src/index.js` or your platform's env)
npm start               # listens on PORT (default 4000)
npm test                # unit + engine + watcher + HTTP + invariant fuzz + Hardhat end-to-end
```

Local dev without a chain: `SESSION_SECRET=dev-secret-0123456789 WATCHER=0 npm start`.

`npm test` starts a Hardhat node on port 8561 from `../contracts` for the end-to-end test and kills it
afterwards. Set `INVARIANT_STEPS` to change the length of the fuzz runs (default 2500 steps × 3 seeds).

## Deploy (Railway)

1. New service from this repo, root directory `engine`. Build: `npm i --legacy-peer-deps`. Start: `npm start`.
2. Add a volume mounted at `/data` and set `DB_PATH=/data/engine.db`.
3. Set `NODE_ENV=production`, `SESSION_SECRET` (32+ random bytes), `START_BLOCK` (a block shortly before the
   company wallet's first deposit; the engine refuses to start in production without it), `RPC_URL`
   (several comma-separated endpoints), `CORS_ORIGINS`, `ALLOWED_DOMAIN`.
4. Health check path: `/health`. Run a single replica: the engine is a single writer on one SQLite file.
5. Back up `/data/engine.db` (SQLite online backup or volume snapshots). The ledger is append-only.

The company private key is never on the server. Payouts are signed in the admin's browser wallet; the
engine only watches the chain.

## Environment variables

| Var | Default | Meaning |
| --- | --- | --- |
| `SESSION_SECRET` | required | HMAC key for session tokens (≥16 chars) |
| `START_BLOCK` | required in prod | First block scanned; in dev, defaults to the current head |
| `NODE_ENV` | | `production` enables the START_BLOCK requirement and `/data/engine.db` default |
| `PORT` | `4000` | HTTP + WebSocket port |
| `DB_PATH` | `./engine.db` (prod `/data/engine.db`) | SQLite file |
| `RPC_URL` | `https://bsc-dataseed.bnbchain.org` | Comma-separated RPC fallbacks |
| `CHAIN_ID` | `56` | Chain id (sign-in message and RPC check at boot) |
| `USDT_ADDRESS` | BSC USDT | Collateral token |
| `USDT_DECIMALS` | `18` | Token decimals (engine stores micro-USDT) |
| `COMPANY_ADDRESS` | `0x1063…27f2` | Deposit wallet and the only admin |
| `CONFIRMATIONS` | `15` | Blocks before a deposit / payout counts |
| `LOG_CHUNK` | `2000` | eth_getLogs block range per request (auto-split on provider errors) |
| `POLL_MS` | `5000` | Watcher poll interval |
| `WATCHER` | `1` | `0` disables the chain watcher |
| `MIN_DEPOSIT` | `10` | USDT; smaller deposits are recorded as `below_minimum` and not credited |
| `MIN_WITHDRAW` | `10` | USDT |
| `ALLOWED_DOMAIN` | `www.stoxhome.xyz` | Domain in the sign-in message |
| `CORS_ORIGINS` | `https://www.stoxhome.xyz,https://stoxhome.xyz` | Allowed browser origins (HTTP and WS) |
| `RATE_LIMIT_PER_MIN` | `120` | Requests per IP per minute |
| `RATE_LIMIT_ADDR_PER_MIN` | `60` | Authenticated requests per address per minute |
| `TRUST_PROXY` | `1` | Trust one proxy hop for client IPs (`0` to disable) |
| `LOOP_MS` | `2000` | Background loop: funding accrual, liquidations, minute snapshots, WS `markets` |

## Money model

- Money is integer **micro-USDT** (`BigInt`, 1e-6); prices, sizes and the funding index are 1e18 fixed point.
  No floats in any money path. JSON uses decimal strings; inputs are parsed strictly (no exponents, max 6 decimals for USDT).
- **Double-entry ledger** (`ledger_entries`, append-only, enforced by triggers). Every posting balances to zero.
  Accounts: `user:<addr>:available`, `user:<addr>:margin`, `user:<addr>:withdraw_locked`, `vault`, `protocol_fees`,
  `external:deposits`, `external:withdrawals`, `company:equity`. `balances` is a cache updated in the same transaction;
  `Engine.checkLedger()` (and `GET /admin/ledger-check`) verifies: sum = 0, balances = sums of entries, no negative
  internal account, margin accounts = position margins, locked = pending withdrawals.
  Any posting that would make an internal account negative aborts the whole transaction
  (`INSUFFICIENT_BALANCE`, or `INSUFFICIENT_LIQUIDITY` for the vault).
- Every state change runs in one `BEGIN IMMEDIATE` SQLite transaction (WAL, `synchronous=FULL`).
- Liabilities = all `user:*` balances + `vault` + `protocol_fees` (= −(external + company equity)).
  `/admin/overview` compares them with the company's on-chain `balanceOf`.

### Flows

| Operation | Postings |
| --- | --- |
| Deposit credited | `external:deposits −x`, `available +x` |
| Open | `available −margin`, `margin +(margin−fee)`, `vault +(fee−cut)`, `protocol_fees +cut` (cut = 10% of fee) |
| Close | `margin −m`, `available +payout`, `protocol_fees +cut`, `vault +(m−payout−cut)` |
| Modify | `margin ±Δ` (realized PnL − funding − fee), `protocol_fees +cut`, `vault −Δ−cut` |
| Liquidation | `margin −m`, `protocol_fees +reward`, `vault +(m−reward)` |
| Vault deposit / withdraw | `available ↔ vault` (company seed/withdraw: `company:equity ↔ vault`) |
| Withdrawal request / cancel / reject / paid | `available → withdraw_locked → available` or `→ external:withdrawals` |

### Economics (ported from the contracts)

- Index: each print is smoothed linearly over 7 days from the current smoothed price; prints are capped at ±10%.
- Opens/increases fill at the worse (for the trader) of smoothed and target index, plus the average skew premium
  before/after the trade; closes/reductions use smoothed index plus premium. Mark = index·(1+skew/skewScale),
  skewScale = 1,000,000 units.
- Funding accrues per second, rate = clamp(skew/skewScale, ±1) × 0.1%/day × index; settled on every touch.
- Fee 0.05% on open and close (10% to protocol). Maintenance 0.5% of notional at index. Max 100x after fees;
  opens that would be liquidatable immediately are rejected; removing margin is limited to 100x on equity.
- Liquidation (by the engine's loop) when equity < maintenance; reward 0.2% of notional, capped at equity, to
  `protocol_fees`; the rest of the margin goes to the vault, which absorbs bad debt.
- Skew caps: per market |skew|·index ≤ 3× vault value; all markets ≤ 5×. Vault withdrawals are refused if they
  would breach a market's cap.
- Vault value = vault cash − Σ traders' PnL marked at the close-out price (index·(1+skew/2·skewScale)), including
  accrued unsettled funding, with each market's trader losses capped at that market's margin.
  Shares use a virtual offset (1e6 shares / 1 micro). Requests escrow shares, 24h cooldown, payout = min(value at
  request, value now). Profits (close or partial reduce) must be backed by vault cash.
- Close-only from 6h before a scheduled print until the print, ending 24h after the scheduled time if it never
  arrives. Opens are also refused if a market has had no print for 45 days (`STALE_INDEX`).
- One position per market per user; modify = increase or partial reduce, flips rejected.

## Deposit / withdrawal watcher

- Polls `eth_getLogs` for USDT `Transfer` with `topic2 = company` (deposits) and `topic1 = company` (payouts) from
  the stored cursor (initialised from `START_BLOCK`) in `LOG_CHUNK` ranges, **only up to `head − CONFIRMATIONS + 1`**.
  Logs in that range are credited in the same transaction that advances the cursor; idempotent by `txHash:logIndex`.
- The unconfirmed tail is also read so users see `confirming` deposits with a confirmation count. A `confirming`
  row that is not present when its block becomes confirmed is marked `dropped` (reorg).
- RPC: each call retries with backoff across all `RPC_URL` endpoints; ranges rejected by a provider are split.
- Outgoing transfers auto-mark the **oldest pending withdrawal of that user with exactly that amount** as paid.
- `POST /admin/withdrawals/:id/paid {txHash}` fetches the receipt and requires status 1 and an unused USDT
  `Transfer` log from the company to the withdrawal's address with value ≥ the requested amount.

## Endpoint map

| Spec endpoint | Implementation |
| --- | --- |
| `POST /auth/nonce`, `/auth/verify` | `src/auth.js` (SIWE text, nonce single-use 10 min, `ethers.verifyMessage`, HMAC token 7d, admin = company) |
| `GET /config`, `/markets`, `/markets/:id/history`, `/markets/:id/trades`, `/quote`, `/vault`, `/stats`, `/health` | `src/server.js` → `Engine.marketsView/history/trades/quote/vaultView/stats` |
| `GET /me`, `/me/deposits`, `/me/withdrawals`, `/me/positions`, `/me/history` | `Engine.me`, `Watcher.depositsFor`, `withdrawals` table, `Engine.positions`, `Engine.userHistory` |
| `POST /positions/open` `/modify` `/close` `/margin` | `Engine.openPosition/modifyPosition/closePosition/changeMargin` |
| `POST /vault/deposit` `/request-withdraw` `/cancel-withdraw` `/withdraw` | `Engine.vaultDeposit/vaultRequestWithdraw/vaultCancelWithdraw/vaultWithdraw` |
| `POST /withdrawals`, `/withdrawals/:id/cancel` | `Engine.requestWithdrawal/cancelWithdrawal` |
| `GET /admin/overview` | on-chain `balanceOf(company)` vs `Engine.liabilities()` |
| `GET /admin/withdrawals?status=` | withdrawals table (`pending` default, also `paid/rejected/cancelled/all`) |
| `POST /admin/withdrawals/:id/paid` / `reject` | `Watcher.verifyAndMarkPaid` / `Engine.rejectWithdrawal` |
| `POST /admin/index`, `/admin/schedule-print`, `/admin/markets/:id`, `/admin/vault/seed` | `Engine.pushIndex/schedulePrint/setActive/seedVault` |
| `WS /ws?token=` | `markets` every loop tick, `trade`, and per-user `me` / `deposit` / `withdrawal` |

Extras: `GET /admin/ledger-check`. Market ids are `0..4` (NYC, LA, MIA, SF, LDN); symbols are accepted too.
Vault shares are shown with 12 decimals (1 share ≈ 1 USDT at the start). `fundingRatePerDay`, `change24h`,
`feeApr7d` and `utilization` are decimal fractions (0.001 = 0.1%). Additional error codes:
`BAD_INPUT`, `BAD_MARKET`, `INSUFFICIENT_LIQUIDITY`, `INSUFFICIENT_MARGIN`, `STALE_INDEX`, `MOVE_TOO_LARGE`,
`WITHDRAW_PENDING`, `NO_PENDING`, `NOT_PENDING`, `NOT_FOUND`, `POOL_INSOLVENT`, `TX_NOT_FOUND`, `TX_FAILED`, `TX_MISMATCH`.

## Known limitations

- Single process / single replica (SQLite single writer). Rate limits are in memory.
- Auto-matching of payouts uses amount + recipient only; a company transfer to a user that is unrelated to a
  withdrawal but has the same exact amount would mark that withdrawal paid (it was still paid on chain).
- Deposits below `MIN_DEPOSIT` are recorded (`below_minimum`) but must be handled manually.
- Vault withdrawal requests do not expire (the contract's 3-day execution window was not ported).
