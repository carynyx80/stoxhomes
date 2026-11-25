# Stoxhome off-chain exchange — engine API (v1)

Custodial model. **Company wallet** `0x106342ec570e207afda9fda63125d7a9071127f2` on BNB Smart Chain
(chain 56) is the deposit address. Collateral: BSC USDT `0x55d398326f99059fF775485246999027B3197955`
(18 decimals on chain; the engine stores **integer micro-USDT, 1e-6**).

- Deposits: a user sends USDT to the company wallet **from the wallet they log in with**. The engine
  watches USDT `Transfer(from, to=company, value)` logs and credits `from` after `CONFIRMATIONS` blocks.
  Idempotent by `txHash:logIndex`.
- Trading, funding, liquidation and the vault run in the engine (no gas for users).
- Withdrawals: user requests an amount to **their own address**; funds are locked. The company pays from
  its own wallet (admin page signs a USDT `transfer` in the browser wallet). The engine sees the outgoing
  `Transfer(company → user, amount)` on chain and marks the withdrawal paid. The company private key is
  never on the server.
- The house (vault) is the counterparty to every position, as in the original contracts.

All amounts in JSON are **decimal strings in USDT** (e.g. `"1250.5"`); prices are decimal strings;
sizes are decimal strings in index units; timestamps are unix seconds. Errors: HTTP 4xx with
`{ "error": "CODE", "message": "human text" }`.

## Auth (sign-in with wallet)

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| POST | `/auth/nonce` | `{ address }` | `{ message }` — text to sign: domain, address, nonce, issued-at, chain 56 |
| POST | `/auth/verify` | `{ address, message, signature }` | `{ token, expiresAt, isAdmin }` |

`signature` is EIP-191 `personal_sign` over `message`. Auth'd routes take `Authorization: Bearer <token>`.
Tokens expire after 7 days. `isAdmin` is true only for the company address.

## Public

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/config` | `{ chainId, companyAddress, usdt: { address, decimals }, confirmations, minDeposit, minWithdraw, fees: { tradingBps, maintenanceBps, liquidationFeeBps, maxLeverage }, markets: [{ id, symbol, name }] }` |
| GET | `/markets` | `[{ id, symbol, name, indexPrice, targetPrice, markPrice, fundingRatePerDay, longOI, shortOI, skew, longOIUsd, shortOIUsd, closeOnly, nextPrintAt, lastPrint: { value, at }, change24h, volume24h, active }]` |
| GET | `/markets/:id/history?range=1M\|6M\|1Y\|5Y` | `{ prints: [{ at, value }], snapshots: [{ at, indexPrice, markPrice, fundingRatePerDay, longOI, shortOI }] }` |
| GET | `/markets/:id/trades?limit=50` | public tape `[{ id, at, marketId, side, kind, size, price, notional, leverage }]` (no addresses) |
| GET | `/quote?marketId&size` | `{ fillPrice, fee, closeFillPrice }` — size signed (+long / −short) |
| GET | `/vault` | `{ poolValue, totalShares, sharePrice, feeApr7d, utilization }` |
| GET | `/stats` | `{ tvl, volume24h, openInterest, traders }` |
| GET | `/health` | `{ ok, lastBlock, chainId }` |

## Account (auth)

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| GET | `/me` | | `{ address, balance: { available, margin, pendingWithdrawals, vaultValue, equity }, vault: { shares, pendingShares, unlockAt } }` |
| GET | `/me/deposits` | | `[{ txHash, amount, status: "confirming"\|"credited", confirmations, at }]` |
| GET | `/me/withdrawals` | | `[{ id, amount, to, status: "pending"\|"paid"\|"rejected"\|"cancelled", txHash, at }]` |
| GET | `/me/positions` | | `[{ marketId, symbol, side, size, entryPrice, indexPrice, margin, pnl, funding, equity, leverage, liquidationPrice, liquidatable }]` |
| GET | `/me/history` | | `{ trades: [...], margin: [...], vault: [...] }` |
| POST | `/positions/open` | `{ marketId, size, margin, acceptablePrice }` | position |
| POST | `/positions/modify` | `{ marketId, sizeDelta, acceptablePrice }` | position (increase / partial reduce; flips rejected) |
| POST | `/positions/close` | `{ marketId, acceptablePrice }` | `{ realizedPnl, payout }` |
| POST | `/positions/margin` | `{ marketId, delta }` | position (delta < 0 removes margin, leverage ≤ 100x after) |
| POST | `/vault/deposit` | `{ amount }` | `{ shares }` |
| POST | `/vault/request-withdraw` | `{ shares }` | `{ unlockAt }` (24h cooldown) |
| POST | `/vault/cancel-withdraw` | | |
| POST | `/vault/withdraw` | | `{ amount }` |
| POST | `/withdrawals` | `{ amount }` | withdrawal (to = caller's address only) |
| POST | `/withdrawals/:id/cancel` | | withdrawal (only while pending) |

Error codes include: `UNAUTHORIZED`, `INSUFFICIENT_BALANCE`, `LEVERAGE_TOO_HIGH`, `WOULD_BE_LIQUIDATABLE`,
`SLIPPAGE`, `CLOSE_ONLY`, `MARKET_INACTIVE`, `SKEW_CAP`, `POSITION_EXISTS`, `NO_POSITION`, `FLIP_NOT_ALLOWED`,
`WITHDRAW_LOCKED`, `MIN_AMOUNT`, `RATE_LIMITED`.

## Admin (company address only)

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| GET | `/admin/overview` | | `{ companyUsdtOnChain, liabilities: { users, vault, protocolFees }, surplus, pendingWithdrawals: { count, amount } }` |
| GET | `/admin/withdrawals?status=pending` | | list |
| POST | `/admin/withdrawals/:id/paid` | `{ txHash }` | verified on chain, marks paid |
| POST | `/admin/withdrawals/:id/reject` | `{ reason }` | unlocks the funds back to the user |
| POST | `/admin/index` | `{ symbol, value, source }` | new print (smoothed over 7 days, ±10% cap) |
| POST | `/admin/schedule-print` | `{ symbol, at }` | close-only window 6h before |
| POST | `/admin/markets/:id` | `{ active }` | pause / resume |
| POST | `/admin/vault/seed` | `{ amount }` | company capital into the vault (from company equity) |

## WebSocket `/ws?token=<optional>`

Messages `{ type, data }`: `markets` (every few seconds), `trade` (public tape), and for an auth'd
socket `me` (balance/positions changed), `deposit`, `withdrawal`.

---

# v2: Solana (supersedes the BNB Chain money layer above)

Stoxhome moves to **Solana mainnet-beta**. Trading, positions, funding, liquidation, vault and the
ledger are unchanged. Only the chain layer, addresses and sign-in change.

- **Company wallet (deposit address, admin):** `8oYH186qjPyYwnS58fh1NH1m5iFFJe8wPnBKVp3NGtgx`
- **Collateral (both credited 1:1 as USD, ledger stays integer micro-USD 1e-6):**
  - USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (6 decimals, SPL Token program)
  - USDT `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` (6 decimals, SPL Token program)
- Addresses are base58 public keys everywhere (users, company, tx signatures).

## Config
`GET /config` → `{ chain: "solana", cluster: "mainnet-beta", companyAddress, tokens: [{ symbol, mint, decimals, companyTokenAccount }], withdrawTokens: ["USDC","USDT"], commitment: "finalized", minDeposit, minWithdraw, fees, markets }`
`companyTokenAccount` is the company's associated token account (ATA) per mint, derived deterministically.

`GET /chain/blockhash` → `{ blockhash, lastValidBlockHeight }` (engine proxies the RPC so browsers never hit rate limits/CORS).

## Sign-in (Sign-In With Solana style)
- `POST /auth/nonce { address }` → `{ message }` (domain, base58 address, nonce, issued-at, "Solana mainnet").
- `POST /auth/verify { address, message, signature }` where `signature` is **base58** of the 64-byte ed25519
  signature from the wallet's `signMessage(utf8(message))`. Verified with ed25519 against the address bytes.
- `isAdmin` true only for the company address.

## Deposits
A user sends USDC or USDT **from the wallet they sign in with** to the company (the wallet creates the
company ATA if it does not exist yet). The engine polls `getSignaturesForAddress(companyATA)` for each mint
(commitment finalized, paging with `until`), fetches each with
`getTransaction(sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "finalized" })`,
and computes the company ATA balance increase from `meta.pre/postTokenBalances`. The credited user is the
**owner** of the token account(s) whose balance of that mint decreased in the same transaction. If the
transaction failed, has several distinct sending owners, or the sender is unknown/ambiguous, it is recorded
as `unattributed` for the admin to resolve and never auto-credited. Idempotent by `signature:mint`.
`GET /me/deposits` items: `{ signature, token, amount, status: "confirming"|"credited"|"below_minimum", at }`.

## Withdrawals
`POST /withdrawals { amount, token }` (token `USDC` default or `USDT`; destination is always the caller's
own address; paid to the caller's ATA for that mint). Admin "Pay" builds, in the browser wallet of the company:
`createAssociatedTokenAccountIdempotent(user ATA)` + `transferChecked(companyATA → userATA, amount)`, then
`POST /admin/withdrawals/:id/paid { signature }`. The engine verifies the finalized transaction: success, the
mint matches, the source is the company ATA, the destination token account's owner is the user, the amount is
≥ requested, and the signature has not been used before. Outgoing transfers from the company ATAs found by
the watcher auto-mark the oldest exact-amount pending withdrawal of that user and token.
The company wallet needs a little SOL for fees and ATA rent (~0.002 SOL per new recipient account).

## Admin overview
`companyOnChain` = USDC + USDT balances of the company ATAs (via `getTokenAccountBalance`), plus
`companySol` so the admin sees whether fees can be paid. `unattributedDeposits` lists deposits that need a
manual decision (`POST /admin/deposits/:signature/credit { address }` or `/refund-note`).
