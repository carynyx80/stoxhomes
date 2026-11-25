# HouseDEX Security Review (adversarial, POC-backed)

Scope: `contracts/contracts/HouseIndexOracle.sol` and `HousePerpExchange.sol`, reviewed against the current code, which includes modifyPosition, close-only windows, the withdrawal cooldown, protocol fees and the close-payout cash check.
POCs: `contracts/test/Security.test.js`. Each "POC:" test asserts that the bad outcome happens. Each "defence:" test shows a protection that works.
Test run: `npx hardhat test` gives **51 passing, 0 failing** (34 existing + 17 security).

## Status of earlier findings after the concurrent contract changes
- **Fixed:** close payouts were taken from other traders' margin. `_close` now checks `payout > _freeBalance()` (line 655). The insolvency POC asserts that `closePosition` reverts `InsufficientLiquidity`. The same drain is still possible another way: see H1.
- **Fixed:** the liquidation reward is now capped by pool cash.
- **Not fixed:** the withdrawal cooldown does not stop the LP sandwich (H2). The close-only window does not stop print front-running (C1).

## Findings, ranked by severity

### C1 - Critical: after a print is pushed, its 7-day phase-in is a public, risk-free bet against the pool
- **What happens:** `pushIndex` makes the next 7 days of the index fully deterministic (oracle line 100, linear interpolation). The close-only window (`_isCloseOnly`, line 631) only blocks trading *before* the push. Opening is allowed again the moment the print lands.
- **POC** (`POC: deterministic 7-day phase-in...`):
  - The keeper schedules a print, and opening reverts `CloseOnly` as intended.
  - After the +10% push, Alice opens a 9,000-unit long (~90x, 30k margin) and closes it 7 days later.
  - Her profit is **+268,180 USDT on 30k margin**, with no risk.
  - Pool NAV falls from **1,000,000 to 731,536 (-27%)**.
  - This repeats for every print and every market. The skew cap is 3x pool per market.
- **Fix:**
  - Do not price trades at a smoothed value that lags a known target. Either open and close at `max/min(current, toPrice)` against the trader (trades in the move's direction get `toPrice`), or price new opens at `toPrice` immediately while still marking liquidations on the smoothed value.
  - At a minimum, extend close-only (or a large dynamic fee) to cover the whole smoothing period after a push.

### H1 - High: pool insolvency. Profits can exceed pool cash, and modifyPosition plus removeMargin pay them out of other traders' margin
- **What happens:**
  - The skew cap is only checked when a position is opened or increased (lines 370 and 452). Open positions keep compounding across prints.
  - A partial close in `modifyPosition` books realized PnL into `pos.margin` and `totalMargin` (lines 444-455) without checking pool cash.
  - `removeMargin` (lines 489-502) then transfers that amount from the contract balance, which is other traders' margin.
- **POC** (`POC: pool insolvency...`). Setup: a 100k pool, Alice long 950 units, Bob long 10 units with 300k margin, then five +10% prints.
  - `poolValue() == 0`, and Alice's `closePosition` correctly reverts.
  - Alice instead calls `modifyPosition(-940)` and then `removeMargin`, and withdraws **188,843 USDT**.
  - The contract is left holding **231,157 USDT against 300,998 of `totalMargin`**, so trader margin is no longer fully backed.
  - Bob is healthy and in profit, but his close reverts `InsufficientLiquidity`.
  - Carol deposits 100k while NAV is 0. `deposit` mints her shares 1:1 (line 254). Her shares are immediately worth **13,253**.
- **Fix:**
  - In `modifyPosition`, when `realized > 0`, require `realized <= _freeBalance()` (or cap it the way `_close` does) before crediting it to margin.
  - Re-check the skew cap / ADL when pool NAV falls (auto-deleverage or close-only when `|skew|*p > cap`).
  - In `deposit`, revert when `nav == 0 && totalShares > 0` instead of minting 1:1.
  - Consider a global open-interest cap across all markets (each market currently gets 3x pool on its own).

### H2 - High: LP share price can be manipulated with the skew premium (sandwich). The cooldown does not prevent it
- **What happens:**
  - Entries fill at a premium, but `poolValue` marks traders' PnL at the index (line 332).
  - Opening a skewed position therefore adds `size * premium` to NAV straight away. That value disappears when the position closes at the same premium.
  - `requestWithdraw` (line 264) does not lock shares. An LP can keep a request armed at all times (re-request every window, or alternate two addresses).
- **POC** (`POC: LP sandwich...`). Carol is a 50% LP with an armed request, and Dave is her second account.
  - Dave opens a 10k-unit long, and NAV goes from 2,000,000 to 2,016,357.
  - Carol withdraws, then Dave closes.
  - The attacker nets **+5,163 USDT after fees**. The honest LP drops from 1,000,000 to 994,535.
  - The gain scales with pool size and skewScale.
- **Fix:**
  - Mark pool PnL at the close-out value, not the index: `traderPnl = skew*p*(1 + skew/(2*skewScale)) - sumSizeEntry`, which matches what `_fillPrice` would pay out.
  - Price withdrawals at `min(NAV now, NAV at request)`.
  - Lock (escrow) the shares that have a pending request.

### M1 - Medium: first-depositor share inflation
- **What happens:** `deposit` (line 254) prices shares from `_freeBalance()`, and a direct token transfer raises it.
- **POC** (`POC: first-depositor share inflation`):
  - The attacker deposits 1 wei and donates 1,000 USDT.
  - The victim deposits 1,999 and receives 1 share.
  - The attacker withdraws **1,499.50**, a **+499.5** profit. The victim's 1,999 is now worth 1,499.50.
- **Fix:**
  - Use virtual shares/assets (an OZ ERC4626-style offset), or burn a minimum first deposit to a dead address.
  - Track pool cash internally instead of using `balanceOf`.
  - Add `minShares` / `minAmount` slippage parameters to deposit and withdraw.
- The deploy script's 1M seed mitigates this only if it runs atomically with deployment.

### M2 - Medium: underwater positions overstate NAV, and the liquidator reward is 0 exactly when bad debt exists
- **What happens:**
  - `poolValue` counts a trader's full loss as a pool gain, even when it exceeds the margin the pool can actually collect.
  - `liquidate` sets the reward to 0 when `equity <= 0` (line 519), so nobody is paid to clear these positions.
- **POC:** a ~94x long reaches equity **-5,672**. `poolValue` drops by **5,672** when it is finally liquidated, and the liquidator receives 0. Any LP who withdrew in the meantime was overpaid.
- **Fix:**
  - Clamp each position's loss at its margin when valuing the pool. Aggregate alternative: track bad debt separately, or keep an insurance fund.
  - Pay liquidators a minimum (gas-covering) reward from pool cash even when equity is 0 or below.

### M3 - Medium (admin): `setParams` changes smoothingPeriod retroactively, which jumps the price
- **What happens:** oracle `setParams` (line 56) changes `smoothingPeriod`, and `price()` (line 100) applies it to the print that is already phasing in.
- **POC:**
  - One day into a +10% phase-in, `setParams(0, ...)` moves the index from **304.29 to 330.00 in a single tx**.
  - A ~90x short becomes liquidatable in the same block with negative equity (bad debt).
  - Raising the period to 60 days moves the price back down.
  - With `maxPrintMoveBps` up to 50% and smoothing 0, the owner and keeper can produce arbitrary cliffs.
- **Fix:**
  - Store `smoothingPeriod` per feed when each print is pushed, so later changes apply only to the next print.
  - Enforce a minimum smoothing period greater than 0.
  - Put `setParams` behind a timelock.

### L1 - Low: accrued funding is not included in poolValue
- **POC:** 30 days of funding (**90,000 owed**, with maxFunding raised to 10%/day) is absent from NAV. NAV jumps **76,357** at settlement, which an LP can time (deposit just before a large close).
- **Fix:** add the pending net funding (`skew * pendingFundingIndexDelta` plus settled-unpaid funding) to `poolValue`.

### L2 - Low: a scheduled print that is never pushed freezes the market in close-only
- **What happens:** `_isCloseOnly` (line 633) stays true forever once `t` has passed without a push.
- **POC:** the market is still close-only 30 days after the scheduled time.
- **Fix:** expire close-only at `t + grace` (for example 24h).

### Informational
- Oracle `uint128` casts in `createFeed` and `pushIndex` (lines 85-86) truncate silently. Use SafeCast.
- `withdraw` and `deposit` have no slippage protection.
- In `openPosition`, a skew-reducing trade can be blocked by `SkewCapExceeded` when the pool has shrunk below the existing skew. This blocks rebalancing.
- `positionInfo.liquidationPrice` ignores the close fee and premium, so the UI shows an estimate.

## Defences verified (passing tests)
- **Consecutive pushes cannot accelerate a move.** The 10% cap is measured from the current smoothed price, and a re-push restarts the phase-in from the current price with no jump.
- **Liquidations are marked at the index.** A 9,000-unit opposing trade leaves another trader's equity and liquidatable status unchanged.
- **Round trips and self-trading lose money.** An open-then-close round trip, and a long+short self-trade from two accounts, both lose money (fees, plus the premium nets to zero).
- **Splitting a trade does not help.** It gives the same average fill as one trade (linear premium) to within 10 wei.
- **No position can be liquidatable right after opening.** Opening one reverts `WouldBeLiquidatable`.
- **removeMargin limits hold.** It cannot exceed 100x or the margin itself. Unrealized profit cannot be withdrawn through it alone (the margin subtraction underflows), but see H1 for the modifyPosition path.
- **No rounding drift.** `sumSizeEntry`, skew and `totalMargin` return to exactly 0 after round trips with odd sizes.
- **Stale oracle handling is correct.** It blocks opens, while closes still work.
- **Access control holds.** setFees, addMarket, updateMarket, setParams and setKeeper are owner-only, and pushIndex is keeper-only.
- **Liquidation reward is bounded.** It is at most the position's equity, and `totalMargin` is cleaned up.
- **Reentrancy:** every state-changing exchange function is `nonReentrant`, and the collateral is a standard ERC20 transferred with SafeERC20.
- **Close payouts are capped by pool cash** (the new fix, verified in the H1 POC).

## Test run summary
`cd contracts && npx hardhat test` gives **51 passing** (34 existing tests + 17 in `Security.test.js`: 8 POCs, 9 defence tests). Run at about 07:05 UTC against the current contract code.
