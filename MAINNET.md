# BSC mainnet launch runbook

Company wallet (contract owner, oracle keeper, protocol-fee recipient):
`0x106342ec570e207afda9fda63125d7a9071127f2`

Collateral: Tether USD (BEP-20, 18 decimals) `0x55d398326f99059fF775485246999027B3197955`.

> The contracts have had an internal review (see `SECURITY_REVIEW.md`) but **no external audit**.
> Perpetual futures on real-estate indices are regulated derivatives in most jurisdictions.
> Get both an audit and legal sign-off before accepting user funds on mainnet.

## What the company wallet controls after deployment

| Power | Function |
| --- | --- |
| Pause or re-parameterise markets | `exchange.updateMarket`, `setFees`, `setPoolParams`, `setMaxTotalSkew` |
| Change who can post index prices | `oracle.setKeeper` |
| Post or schedule index prints itself | `oracle.pushIndex`, `oracle.schedulePrint` |
| Collect the 10% protocol share of trading fees | `exchange.claimProtocolFees()` (anyone can call; funds go to the company wallet) |
| Transfer ownership | `transferOwnership` on both contracts (immediate — double-check the address) |

The company wallet does **not** hold user margin or LP funds; those stay in the exchange contract.
Use a hardware wallet or multisig (e.g. Safe on BNB Chain) for it.

## Wallets you need

1. **Deployer** — a fresh wallet with ~0.05 BNB for gas. It owns nothing after deployment.
2. **Keeper bot** — a separate wallet with ~0.05 BNB. It posts monthly prints and liquidates.
   Its private key goes in the Railway `keeper` service as `KEEPER_PRIVATE_KEY`.
3. **Company wallet** — above. Seeds the first LP liquidity (the pool must be funded before anyone can trade).

Never paste private keys into chat, commits or issues. Set them as environment variables only.

## Steps

```bash
cd contracts
npm ci

# 1. Real starting values (latest published index level per market)
cat > initial-index.json <<'EOF'
{ "NYC": 0, "LA": 0, "MIA": 0, "SF": 0, "LDN": 0 }
EOF

# 2. Deploy (owner + fee recipient default to the company wallet)
export DEPLOYER_PRIVATE_KEY=...            # deployer wallet, in your shell only
export KEEPER_ADDRESS=0x...                # keeper bot wallet address
export INITIAL_INDEX_FILE=initial-index.json
export CONFIRM_MAINNET=yes
npx hardhat run scripts/deploy.js --network bsc
```

The script refuses to run on chain 56 without `CONFIRM_MAINNET=yes`, `KEEPER_ADDRESS` and
`INITIAL_INDEX_FILE`, uses BSC USDT as collateral, sets the company wallet as protocol-fee
recipient, grants the keeper bot the keeper role, removes the deployer's keeper role and transfers
ownership of both contracts to the company wallet. It writes `web/src/contracts/deployments.json["56"]`
(including `startBlock`) — commit that file.

3. **Seed liquidity** from the company wallet: approve USDT to the exchange, then
   `exchange.deposit(amount, minSharesOut)`.
4. **Railway**: point `api` and `keeper` at mainnet:
   `RPC_URL=https://bsc-dataseed.bnbchain.org`, `CHAIN_ID=56`, `START_BLOCK=<startBlock>`,
   `LOG_CHUNK=1000`; keeper `KEEPER_PRIVATE_KEY=<keeper key>`, `DRY_RUN=false`, and a real
   `PRICES_FILE` / `PRICE_SOURCE=http` feed plus a real `RELEASE_CALENDAR_FILE`.
5. **Vercel**: `VITE_CHAIN_ID=56`, `VITE_RPC_URL=https://bsc-dataseed.bnbchain.org`,
   `VITE_API_URL=<api url>`, remove `VITE_FAUCET_URL`, then redeploy.
6. Verify the contracts on BscScan (`npx hardhat verify --network bsc <address> <constructor args>`
   after adding `@nomicfoundation/hardhat-verify` and a BscScan API key).

## Rehearse first

Run the exact same steps on BSC testnet (`--network bscTestnet`, chain 97) with a test USDT
(`COLLATERAL_ADDRESS`) before mainnet. The demo deployment on Railway (chain 31338) uses the same
ownership setup: the company wallet owns the demo contracts too.
