# HouseDEX

A perpetual futures exchange for **house price indices** on BNB Smart Chain. Traders go long or short
city-level home price indices (NYC, LA, Miami, SF, London) with up to **100x leverage**, against a
single USDT liquidity pool.

> Unaudited prototype for testnet. Do not deploy with real funds without an audit and legal review
> (perpetuals on real estate are derivatives and are regulated in most jurisdictions).

## How it works

| Piece | What it does |
| --- | --- |
| `HouseIndexOracle` | Keeper pushes each monthly index print. Each new value is **linearly phased in over 7 days**, so a print can't liquidate 100x positions in one block. Prints that move more than 10% are rejected. |
| `HousePerpExchange` | Positions, margin, funding, liquidations and the LP pool. |
| `web/` | React + ethers trading UI (markets, trade ticket with a 1–100x slider, position, pool). |

**Pricing (index + trading-driven mark)**

- **Index price** is the smoothed oracle value. PnL and liquidations are marked here, so a large trade can't push the price used to liquidate others.
- **Mark price** = `index × (1 + skew / skewScale)`, where skew = net long size. Trades fill at the average premium before and after the trade, so a trade that adds to the imbalance pays more and one that reduces it gets a better price.
- **Funding** accrues every second in proportion to skew (max 0.1%/day at full skew). When the market is net long, longs pay; when net short, shorts pay.

**Risk parameters (defaults)**

| Parameter | Value |
| --- | --- |
| Max leverage | 100x (1% initial margin, after fees) |
| Maintenance margin | 0.5% of notional |
| Trading fee | 0.05% on open and close, paid to the pool |
| Liquidation reward | 0.2% of notional, capped by remaining equity |
| Skew cap | per market, \|skew\| × price ≤ 3× pool value |
| Oracle staleness | opening disabled if no print for 45 days (closing always allowed) |

The pool is the counterparty: LPs earn fees, funding from the skewed side, and trader losses, and pay trader profits. LP share price includes traders' net unrealized PnL.

## Run locally

```bash
# 1. contracts
cd contracts
npm install --legacy-peer-deps
npm test                   # 19 tests
npm run node               # terminal A: local chain on :8545
npm run deploy:local       # terminal B: deploys, seeds a 1M USDT pool, writes web/src/contracts/

# 2. web
cd ../web
npm install --legacy-peer-deps
cp .env.example .env       # VITE_CHAIN_ID=31337
npm run dev                # http://localhost:5173
```

In MetaMask, add network `http://127.0.0.1:8545` (chain 31337) and import a Hardhat test account.
Use **Get 100k test USDT** to fund yourself.

## Deploy to BNB testnet

```bash
cd contracts
export DEPLOYER_PRIVATE_KEY=0x...   # funded with tBNB from the BNB Chain faucet
npm run deploy:testnet              # deploys MockUSDT + oracle + exchange
# or use an existing stablecoin:  COLLATERAL_ADDRESS=0x... npm run deploy:testnet
cd ../web && echo "VITE_CHAIN_ID=97" > .env && npm run build
```

Push a monthly print (keeper):

```bash
SYMBOL=NYC PRICE=333.2 npx hardhat run scripts/push-index.js --network bscTestnet
```

The starting index values in `scripts/deploy.js` are placeholders, not live data. Connect a real index
provider (and decide on licensing) before launch.

## Known limitations / next steps

- **Predictable prints.** Monthly indices are partly forecastable, so traders can position before a print lands. Mitigations to add: close-only mode for N hours before scheduled releases, higher fees near releases, wider spreads.
- **Keeper trust.** The oracle relies on a trusted keeper. Next step: multiple signers or a Chainlink Functions / API3 feed pulling the published index.
- **One position per market per trader** (no partial close or position increase yet).
- **No liquidation bot** included. Anyone can call `liquidate`; a keeper script is the next thing to add.
- **LP accounting** ignores accrued-but-unsettled funding.
- **solc download.** The Hardhat config uses the npm `solc` build because some sandboxes block the compiler download host. Set `USE_NATIVE_SOLC=1` to use the native compiler.
