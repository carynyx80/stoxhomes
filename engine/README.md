# Stoxhome engine

Off-chain, custodial exchange engine for Stoxhome: perpetual futures on city house-price indices
(NYC, LA, MIA, SF, LDN), up to 100x, with a USDT vault as the counterparty. It implements
[`docs/ENGINE_API.md`](../docs/ENGINE_API.md) and ports the economics of
`contracts/HousePerpExchange.sol` and `HouseIndexOracle.sol`, including the fixes in `SECURITY_REVIEW.md`.

Node 22, ESM, SQLite (better-sqlite3, WAL), express, ws; @noble/curves + bs58 (Solana), ethers v6 (EVM).

**Chain adapters.** `CHAIN=solana` (default, Solana mainnet-beta, USDC + USDT, spec section "v2: Solana") or
`CHAIN=evm` (the original BNB Chain USDT adapter). Trading, ledger, vault and economics are identical; ledger
accounts are keyed by base58 address on Solana and lowercase hex on EVM.

## Practice mode

A second, fully separate `Engine` runs in the same process with its own SQLite file (`PRACTICE_DB_PATH`, default
`/data/practice.db` in production) and no chain watcher. It serves the same REST API under `/practice/*`
(`/practice/markets`, `/practice/positions/open`, `/practice/me`, ...) and its own WebSocket at `/practice/ws`.

- The same session token works on both (same secret and chain claim).
- Index prices mirror the real engine exactly: the practice feeds (from/to price, phase-in start, period, scheduled
  print) and print history are copied from the real engine at boot and after every `/admin/index` and
  `/admin/schedule-print`.
- On first boot the practice vault is seeded with 10,000,000 practice USD from `company:equity`.
- `POST /practice/faucet` (auth) credits 10,000 practice USD, at most once per 24 h per address:
  `{ amount, nextAt }`, or `429 FAUCET_COOLDOWN` with `nextAt`.
- Deposits, withdrawals and admin routes under `/practice` return `PRACTICE_ONLY`. Practice balances live only in
  the practice database; the real ledger is never touched (tested).
- `/practice/config` includes `practice: true`; the real `/config` includes `practiceAvailable: true`.

## Markets, history and closed state

- `SKEW_SCALE` (index units, default 150,000): mark = index·(1 + skew/SKEW_SCALE), so a ~$50k position moves the mark
  by about 0.1% and funding follows. Existing market rows are migrated to the configured value on boot.
- `/markets/:id/history?range=1M|6M|1Y|5Y|ALL` merges the monthly prints from `src/historical.js`
  (`data/index-history.json`, older than the engine's first print) with the engine's own prints.
  `/markets` adds `change1y` (12-month change, a fraction); `change24h` is unchanged.
- When the real vault value is 0, `/config` and every `/markets` row carry `tradingOpen: false, reason: "liquidity"`.
  `/admin/overview.setup` is a checklist: `{ solOk, sol, minSol, capitalOk, companyOnChain, liabilities, vaultSeeded, vaultValue }`.

## Solana adapter (`src/solana.js`)

- **Company ATAs** are derived, never looked up (publicnode blocks `getTokenAccountsByOwner`):
  PDA of `[owner, TOKEN_PROGRAM_ID, mint]` under the ATA program. For `8oYH186qjPyYwnS58fh1NH1m5iFFJe8wPnBKVp3NGtgx`:
  USDC ATA `FqfMexmmUhqTWGwTNjz56pY7wB9ucg8LQjXH4njiWzQH`, USDT ATA `7KDPNodKa18Vn7Hd53NQ8D6ePpknjcuS83UBy9U9JrXK`.
- **RPC:** `RPC_URL` endpoints in order; HTTP 429/5xx and transient RPC codes retry with backoff; 401/403 (e.g.
  publicnode's "indexed requests require a personal token" for `getTokenAccountBalance`) moves to the next endpoint
  at once, and token balances then fall back to `getAccountInfo` jsonParsed. `getTransaction` always sends
  `maxSupportedTransactionVersion: 1`, `encoding: jsonParsed`, `commitment: finalized`.
- **Deposits:** per mint, `getSignaturesForAddress(companyATA, { until: <stored last signature>, commitment: finalized })`,
  paged with `before` all the way back to `until` (it never skips history; a lagging node that returns an empty
  page is detected with a probe and the poll is retried). Transactions are processed oldest first; each one is
  recorded, credited and the cursor advanced in one SQLite transaction; idempotent by `signature:mint`.
  The amount is the company ATA's `post - pre` token balance (SPL Token program rows only; Token-2022 look-alikes
  ignored). The credited user is the owner whose balance of that mint decreased. **Unattributed** (never
  auto-credited): failed tx, several sending owners, no/unknown sender, or a sender that is an off-curve program
  address that did not sign (e.g. an AMM vault paying out in a swap routed to the company). Below `MIN_DEPOSIT`:
  `below_minimum`. Both can be resolved with `POST /admin/deposits/:signature/credit { address, token? }` or
  `/refund-note { note }`; list with `GET /admin/deposits?status=unattributed|below_minimum|credited|refund_noted|all`.
  Without `START_SIGNATURE` the first poll stores the newest existing signature (or nothing if the ATA does not exist
  yet) and old history is never scanned.
- **Withdrawals:** `POST /withdrawals { amount, token: "USDC"|"USDT" }` (USDC default), paid to the caller's own
  address. `POST /admin/withdrawals/:id/lock` marks it as being paid (the admin page should call it before signing;
  user cancels are then refused with `WITHDRAW_LOCKED`). `POST /admin/withdrawals/:id/paid { signature }` fetches the
  finalized tx and requires success, the right mint, a debit of the company ATA, a credit of ≥ the amount to a token
  account owned by the user, and an unused signature. The watcher auto-matches outgoing transfers from the company
  ATAs to the oldest exact-amount pending withdrawal of that user and token; unmatched payouts are listed in
  `/admin/overview.unmatchedPayouts`.
- **Sign-in (SIWS style):** the message names the domain, base58 address, nonce, issued-at and "Solana mainnet";
  the signature is base58 of the 64-byte ed25519 `signMessage` output, verified strictly (RFC 8032, small-order
  keys rejected). Addresses are validated as canonical base58 of 32 bytes everywhere.
- `GET /chain/blockhash` proxies `getLatestBlockhash` (finalized) with a 5 s cache.
- `GET /chain/balances?owner=` → `{ sol, tokens: { USDC, USDT } }` (getBalance + getAccountInfo jsonParsed of the
  derived ATAs, missing = "0"), cached 5 s per owner, 60 req/min per IP.
- `POST /chain/send { tx }` relays a signed deposit transaction (base64, ≤ 1232 bytes, legacy or v0 without lookup
  tables). Only ComputeBudget SetComputeUnitLimit/Price, ATA create/createIdempotent of a company ATA, and SPL
  `transferChecked` into the company ATA of that mint (6 decimals, non-zero) are allowed, and the fee payer's ed25519
  signature must verify; anything else is `TX_NOT_ALLOWED`. `sendTransaction` runs with preflight;
  RPC rejections return `TX_REJECTED`. 10 req/min per IP. `/config.features` lists both endpoints.
- **Withdrawal locks (H1):** `POST /admin/withdrawals/:id/lock { blockhash, lastValidBlockHeight }` with the payout
  tx's blockhash. A locked withdrawal cannot be cancelled by the user (`WITHDRAW_LOCKED`) and cannot be rejected
  (`PAYOUT_MAY_LAND`) until the finalized block height is past `lastValidBlockHeight` **and** the watcher has fully
  scanned to a height past it with no unmatched payout to that user/token. Backstop: an unmatched payout that equals
  a withdrawal of that user/token cancelled or rejected in the last 72 h moves that amount from `available` into a
  `withdraw_locked` recovery hold (never below zero; any shortfall is recorded) and raises an alert, listed in
  `/admin/overview.alerts` and `GET /admin/alerts`; resolve with `POST /admin/alerts/:id/resolve { action: "paid"|"release" }`.
- Sessions carry a chain claim (`c`), and the address must be canonical for the chain: EVM-era tokens are refused
  even with the same `SESSION_SECRET`.
- Signatures reported failed by `getSignaturesForAddress` are skipped without `getTransaction`; hitting
  `MAX_TX_PER_POLL` logs a warning and the backlog continues next poll.
- `GET /admin/overview`: `companyOnChain` (USDC + USDT ATA balances, missing account = 0), `companyTokens`,
  `companySol`, liabilities, `surplus`, pending withdrawals, `unattributedDeposits`, `unmatchedPayouts`.

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
3. Set `NODE_ENV=production`, `SESSION_SECRET` (32+ random bytes), `CORS_ORIGINS`, `ALLOWED_DOMAIN`. Solana
   (default): optionally `RPC_URL` (a paid endpoint first is recommended) and `START_SIGNATURE`. EVM
   (`CHAIN=evm`): `START_BLOCK` is required in production, plus `RPC_URL`.
4. Health check path: `/health`. Run a single replica: the engine is a single writer on one SQLite file.
5. Back up `/data/engine.db` (SQLite online backup or volume snapshots). The ledger is append-only.

The company private key is never on the server. Payouts are signed in the admin's browser wallet; the
engine only watches the chain.

## Environment variables

| Var | Default | Meaning |
| --- | --- | --- |
| `CHAIN` | `solana` | `solana` or `evm` |
| `SKEW_SCALE` | `150000` | Skew (index units) at which the mark premium reaches 100% |
| `PRACTICE` | `1` | `0` disables practice mode |
| `PRACTICE_DB_PATH` | `/data/practice.db` (dev: next to `DB_PATH`) | Practice SQLite file |
| `PRACTICE_VAULT_SEED` | `10000000` | Practice vault seed on first boot |
| `PRACTICE_FAUCET` | `10000` | Practice faucet amount (once per 24 h) |
| `SESSION_SECRET` | required | HMAC key for session tokens (≥16 chars) |
| `RPC_URL` (solana) | `https://solana-rpc.publicnode.com,https://api.mainnet-beta.solana.com` | Solana endpoints in order |
| `COMPANY_ADDRESS` (solana) | `8oYH186qjPyYwnS58fh1NH1m5iFFJe8wPnBKVp3NGtgx` | Deposit wallet and the only admin |
| `USDC_MINT` / `USDT_MINT` | mainnet mints | Collateral mints (6 decimals, credited 1:1 as micro-USD) |
| `START_SIGNATURE` | none | Scan company ATA history newer than this; none = start from now |
| `START_SIGNATURE_USDC` / `_USDT` | none | Per-mint override |
| `SOLANA_CLUSTER` | `mainnet-beta` | Reported in `/config` |
| `POLL_MS` (solana) | `10000` | Watcher interval |
| `MAX_TX_PER_POLL` | `200` | getTransaction calls per mint per poll |
| `BLOCKHASH_CACHE_MS` | `5000` | `/chain/blockhash` cache |
| `START_BLOCK` (evm) | required in prod | First block scanned; in dev, defaults to the current head |
| `NODE_ENV` | | `production` enables the START_BLOCK requirement and `/data/engine.db` default |
| `PORT` | `4000` | HTTP + WebSocket port |
| `DB_PATH` | `./engine.db` (prod `/data/engine.db`) | SQLite file |
| `RPC_URL` (evm) | `https://bsc-dataseed.bnbchain.org` | Comma-separated RPC fallbacks |
| `CHAIN_ID` | `56` | Chain id (sign-in message and RPC check at boot) |
| `USDT_ADDRESS` | BSC USDT | Collateral token |
| `USDT_DECIMALS` | `18` | Token decimals (engine stores micro-USDT) |
| `COMPANY_ADDRESS` (evm) | `0x1063…27f2` | Deposit wallet and the only admin |
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
  skewScale = `SKEW_SCALE` (default 150,000 units; the contract used 1,000,000, which the engine unit tests still use).
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
- Solana: only finalized transactions are read, so `/me/deposits` shows a deposit once it is finalized
  (the `confirming` state is not used). Withdrawal auto-matching is by recipient owner + exact amount + token.
- Solana: the admin page must call `/admin/withdrawals/:id/lock` (with the payout blockhash) before signing; an
  unlocked withdrawal can still be cancelled, in which case a late payout is caught by the recovery-hold backstop.
- `/chain/send` rejects wallet-injected extra instructions (e.g. Lighthouse assertions); such wallets should send
  the transaction themselves (the watcher credits it either way).
