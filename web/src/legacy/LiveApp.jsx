import { useCallback, useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import { chain, connectWallet, contracts, deployment, fmt, friendlyError, pct, readProvider } from "../chain.js";

const WAD = 10n ** 18n;
const BPS = 10_000n;
const SLIPPAGE_BPS = 50n; // 0.5%

export default function App() {
  const [signer, setSigner] = useState(null);
  const [account, setAccount] = useState(null);
  const [markets, setMarkets] = useState([]);
  const [selected, setSelected] = useState(0);
  const [params, setParams] = useState(null);
  const [pool, setPool] = useState({});
  const [balance, setBalance] = useState(0n);
  const [position, setPosition] = useState(null);
  const [status, setStatus] = useState(null);
  const [tick, setTick] = useState(0);

  const read = useMemo(() => (deployment ? contracts(readProvider) : null), []);
  const write = useMemo(() => (signer && deployment ? contracts(signer) : null), [signer]);
  const refresh = () => setTick((t) => t + 1);

  // ---- data loading ----
  useEffect(() => {
    if (!read) return;
    let stop = false;
    (async () => {
      try {
        const { exchange, usdt } = read;
        const n = Number(await exchange.marketCount());
        const list = await Promise.all(
          [...Array(n).keys()].map(async (i) => {
            const [m, index, mark, funding] = await Promise.all([
              exchange.getMarket(i),
              exchange.indexPrice(i),
              exchange.markPrice(i),
              exchange.fundingRatePerDay(i),
            ]);
            const meta = deployment.markets.find((x) => `${x.symbol}-USD` === m.name);
            return { id: i, name: m.name, city: meta?.name || m.name, m, index, mark, funding };
          })
        );
        const [tradingFeeBps, maintenanceMarginBps, poolValue, totalShares] = await Promise.all([
          exchange.tradingFeeBps(),
          exchange.maintenanceMarginBps(),
          exchange.poolValue(),
          exchange.totalShares(),
        ]);
        let mine = {};
        if (account) {
          const [bal, shares, pos] = await Promise.all([
            usdt.balanceOf(account),
            exchange.shares(account),
            exchange.positionInfo(selected, account),
          ]);
          mine = { bal, shares, pos };
        }
        if (stop) return;
        setMarkets(list);
        setParams({ tradingFeeBps, maintenanceMarginBps });
        setPool({ poolValue, totalShares, shares: mine.shares ?? 0n });
        setBalance(mine.bal ?? 0n);
        setPosition(mine.pos && mine.pos.size !== 0n ? mine.pos : null);
      } catch (e) {
        if (!stop) setStatus({ kind: "error", text: "Could not reach the chain: " + friendlyError(e) });
      }
    })();
    return () => {
      stop = true;
    };
  }, [read, account, selected, tick]);

  useEffect(() => {
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!window.ethereum) return;
    const onAccounts = (a) => {
      setAccount(a[0] || null);
      if (!a[0]) setSigner(null);
    };
    window.ethereum.on?.("accountsChanged", onAccounts);
    return () => window.ethereum.removeListener?.("accountsChanged", onAccounts);
  }, []);

  const connect = async () => {
    try {
      const s = await connectWallet();
      setSigner(s);
      setAccount(await s.getAddress());
    } catch (e) {
      setStatus({ kind: "error", text: friendlyError(e) });
    }
  };

  const run = useCallback(async (label, fn) => {
    setStatus({ kind: "pending", text: `${label}…` });
    try {
      await fn();
      setStatus({ kind: "ok", text: `${label} confirmed` });
      refresh();
    } catch (e) {
      setStatus({ kind: "error", text: friendlyError(e) });
    }
  }, []);

  const ensureAllowance = async (amount) => {
    const allowance = await write.usdt.allowance(account, deployment.exchange);
    if (allowance < amount) await (await write.usdt.approve(deployment.exchange, ethers.MaxUint256)).wait();
  };

  if (!deployment) {
    return (
      <div className="empty">
        <h1>HouseDEX</h1>
        <p>
          No contracts deployed for chain {chain.id}. Run <code>npm run deploy:local</code> in <code>contracts/</code>, or
          set <code>VITE_CHAIN_ID</code>.
        </p>
      </div>
    );
  }

  const market = markets[selected];

  return (
    <div className="app">
      <header>
        <div className="brand">
          <span className="logo">⌂</span> HouseDEX <span className="tag">{chain.name}</span>
        </div>
        <div className="header-right">
          {account && deployment.mockUsdt && (
            <button className="ghost" onClick={() => run("Faucet", async () => {
              await (await write.usdt.mint(account, ethers.parseEther("100000"))).wait();
            })}>
              Get 100k test USDT
            </button>
          )}
          {account ? (
            <span className="account">
              {fmt(balance)} USDT · {account.slice(0, 6)}…{account.slice(-4)}
            </span>
          ) : (
            <button onClick={connect}>Connect wallet</button>
          )}
        </div>
      </header>

      {status && <div className={`status ${status.kind}`} onClick={() => setStatus(null)}>{status.text}</div>}

      <MarketStrip markets={markets} selected={selected} onSelect={setSelected} />

      <main>
        <section className="left">
          {market && <MarketDetail market={market} />}
          <PositionPanel
            position={position}
            market={market}
            account={account}
            onClose={() =>
              run("Close position", async () => {
                const fill = await read.exchange.quoteFill(selected, -position.size);
                const acceptable = position.size > 0n ? (fill * (BPS - SLIPPAGE_BPS)) / BPS : (fill * (BPS + SLIPPAGE_BPS)) / BPS;
                await (await write.exchange.closePosition(selected, acceptable)).wait();
              })
            }
            onAddMargin={(amt) =>
              run("Add margin", async () => {
                await ensureAllowance(amt);
                await (await write.exchange.addMargin(selected, amt)).wait();
              })
            }
          />
          <PoolPanel
            pool={pool}
            account={account}
            onDeposit={(amt) =>
              run("Deposit", async () => {
                await ensureAllowance(amt);
                await (await write.exchange.deposit(amt)).wait();
              })
            }
            onWithdraw={(sh) => run("Withdraw", async () => (await write.exchange.withdraw(sh)).wait())}
          />
        </section>
        <aside>
          {market && params && (
            <TradePanel
              market={market}
              params={params}
              account={account}
              hasPosition={!!position}
              readExchange={read.exchange}
              onConnect={connect}
              onOpen={({ size, margin, acceptable }) =>
                run(`Open ${size > 0n ? "long" : "short"}`, async () => {
                  await ensureAllowance(margin);
                  await (await write.exchange.openPosition(selected, size, margin, acceptable)).wait();
                })
              }
            />
          )}
        </aside>
      </main>
      <footer>
        Index prices are published monthly and smoothed over 7 days on-chain. Trades fill at a skew-adjusted mark price;
        PnL and liquidations use the index. Testnet software, unaudited.
      </footer>
    </div>
  );
}

function MarketStrip({ markets, selected, onSelect }) {
  return (
    <nav className="strip">
      {markets.map((mk) => {
        const prem = mk.index ? Number(((mk.mark - mk.index) * 1_000_000n) / mk.index) / 10_000 : 0;
        return (
          <button key={mk.id} className={`chip ${mk.id === selected ? "active" : ""}`} onClick={() => onSelect(mk.id)}>
            <span className="chip-name">{mk.name}</span>
            <span className="chip-price">{fmt(mk.mark)}</span>
            <span className={prem >= 0 ? "up" : "down"}>{prem >= 0 ? "+" : ""}{prem.toFixed(2)}%</span>
          </button>
        );
      })}
    </nav>
  );
}

function MarketDetail({ market }) {
  const { m } = market;
  const stats = [
    ["Index price", fmt(market.index)],
    ["Mark price", fmt(market.mark)],
    ["Funding / day", pct(market.funding, 4), market.funding > 0n ? "Longs pay" : market.funding < 0n ? "Shorts pay" : "Balanced"],
    ["Long open interest", fmt(m.longSize, 0) + " units"],
    ["Short open interest", fmt(m.shortSize, 0) + " units"],
    ["Net skew", fmt(m.skew, 0) + " units"],
  ];
  return (
    <div className="card">
      <div className="card-head">
        <h2>{market.city} home price index</h2>
        <span className="muted">{market.name} · max 100x</span>
      </div>
      <div className="stats">
        {stats.map(([k, v, sub]) => (
          <div key={k}>
            <div className="muted small">{k}</div>
            <div className="stat">{v}</div>
            {sub && <div className="muted small">{sub}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

function TradePanel({ market, params, account, hasPosition, readExchange, onConnect, onOpen }) {
  const [side, setSide] = useState("long");
  const [marginStr, setMarginStr] = useState("1000");
  const [leverage, setLeverage] = useState(50);
  const [quote, setQuote] = useState(null);

  const margin = useMemo(() => {
    try {
      return ethers.parseEther(marginStr || "0");
    } catch {
      return 0n;
    }
  }, [marginStr]);

  // size so that notional / (margin - fee) <= leverage, with a small buffer for rounding
  useEffect(() => {
    let stop = false;
    (async () => {
      if (margin === 0n || !market.index) return setQuote(null);
      const lev = BigInt(leverage);
      const sizeAt = (price) => {
        // margin = notional/lev + notional*fee  →  notional = margin / (1/lev + fee)
        const denom = WAD / lev + (WAD * params.tradingFeeBps) / BPS;
        const notional = (margin * WAD) / denom;
        return (((notional * WAD) / price) * 998n) / 1000n;
      };
      let size = sizeAt(market.mark);
      const signed = side === "long" ? size : -size;
      try {
        const fill = await readExchange.quoteFill(market.id, signed);
        size = sizeAt(fill);
        const finalSigned = side === "long" ? size : -size;
        const fill2 = await readExchange.quoteFill(market.id, finalSigned);
        const notional = (size * fill2) / WAD;
        const fee = (notional * params.tradingFeeBps) / BPS;
        const net = margin - fee;
        // liquidation estimate: margin + s(p - e) = k|s|p
        const k = (params.maintenanceMarginBps * WAD) / BPS;
        const liq =
          side === "long"
            ? ((size * fill2) / WAD - net) * WAD / ((size * (WAD - k)) / WAD)
            : ((size * fill2) / WAD + net) * WAD / ((size * (WAD + k)) / WAD);
        const acceptable = side === "long" ? (fill2 * (BPS + SLIPPAGE_BPS)) / BPS : (fill2 * (BPS - SLIPPAGE_BPS)) / BPS;
        const move = market.index ? Number(((liq - market.index) * 1_000_000n) / market.index) / 10_000 : 0;
        if (!stop) setQuote({ size: finalSigned, fill: fill2, notional, fee, liq, acceptable, move });
      } catch {
        if (!stop) setQuote(null);
      }
    })();
    return () => {
      stop = true;
    };
  }, [margin, leverage, side, market, params, readExchange]);

  return (
    <div className="card trade">
      <div className="tabs">
        <button className={side === "long" ? "long active" : ""} onClick={() => setSide("long")}>Long</button>
        <button className={side === "short" ? "short active" : ""} onClick={() => setSide("short")}>Short</button>
      </div>

      <label>
        Margin (USDT)
        <input inputMode="decimal" value={marginStr} onChange={(e) => setMarginStr(e.target.value.replace(/[^0-9.]/g, ""))} />
      </label>

      <label>
        <span className="row">
          Leverage <strong>{leverage}x</strong>
        </span>
        <input type="range" min="1" max="100" value={leverage} onChange={(e) => setLeverage(Number(e.target.value))} />
        <span className="row muted small">
          {[1, 10, 25, 50, 100].map((l) => (
            <a key={l} onClick={() => setLeverage(l)}>{l}x</a>
          ))}
        </span>
      </label>

      <dl>
        <dt>Position size</dt>
        <dd>{quote ? fmt(quote.size < 0n ? -quote.size : quote.size, 2) : "—"} units</dd>
        <dt>Notional</dt>
        <dd>{quote ? fmt(quote.notional) : "—"} USDT</dd>
        <dt>Est. fill price</dt>
        <dd>{quote ? fmt(quote.fill) : "—"}</dd>
        <dt>Opening fee</dt>
        <dd>{quote ? fmt(quote.fee) : "—"} USDT</dd>
        <dt>Est. liquidation price</dt>
        <dd className={side === "long" ? "down" : "up"}>
          {quote ? `${fmt(quote.liq)} (${quote.move >= 0 ? "+" : ""}${quote.move.toFixed(2)}%)` : "—"}
        </dd>
      </dl>

      {leverage >= 75 && (
        <p className="warn small">
          At {leverage}x, a {(100 / leverage).toFixed(2)}% move against you wipes out your margin. Funding and fees reduce it further.
        </p>
      )}

      {!account ? (
        <button className="wide" onClick={onConnect}>Connect wallet</button>
      ) : hasPosition ? (
        <button className="wide" disabled>Close your {market.name} position first</button>
      ) : (
        <button
          className={`wide ${side}`}
          disabled={!quote}
          onClick={() => onOpen({ size: quote.size, margin, acceptable: quote.acceptable })}
        >
          {side === "long" ? "Long" : "Short"} {market.name} {leverage}x
        </button>
      )}
    </div>
  );
}

function PositionPanel({ position, market, account, onClose, onAddMargin }) {
  const [addStr, setAddStr] = useState("");
  if (!account || !market) return null;
  if (!position)
    return (
      <div className="card">
        <h3>Your position</h3>
        <p className="muted">No open position in {market.name}.</p>
      </div>
    );
  const long = position.size > 0n;
  const abs = long ? position.size : -position.size;
  const notional = (abs * position.indexPrice) / WAD;
  const lev = position.equity > 0n ? Number((notional * 100n) / position.equity) / 100 : Infinity;
  const pnl = position.pnl - position.funding;
  return (
    <div className="card">
      <div className="card-head">
        <h3>
          Your position <span className={long ? "pill long" : "pill short"}>{long ? "LONG" : "SHORT"}</span>
        </h3>
        {position.liquidatable && <span className="pill short">Liquidatable</span>}
      </div>
      <div className="stats">
        <div><div className="muted small">Size</div><div className="stat">{fmt(abs)}</div></div>
        <div><div className="muted small">Entry</div><div className="stat">{fmt(position.entryPrice)}</div></div>
        <div><div className="muted small">Index</div><div className="stat">{fmt(position.indexPrice)}</div></div>
        <div><div className="muted small">Margin</div><div className="stat">{fmt(position.margin)}</div></div>
        <div>
          <div className="muted small">PnL (after funding)</div>
          <div className={`stat ${pnl >= 0n ? "up" : "down"}`}>{fmt(pnl)}</div>
        </div>
        <div><div className="muted small">Leverage</div><div className="stat">{isFinite(lev) ? lev.toFixed(1) + "x" : "—"}</div></div>
        <div><div className="muted small">Liquidation price</div><div className="stat down">{fmt(position.liquidationPrice)}</div></div>
        <div><div className="muted small">Funding paid</div><div className="stat">{fmt(position.funding)}</div></div>
      </div>
      <div className="actions">
        <input placeholder="USDT" inputMode="decimal" value={addStr} onChange={(e) => setAddStr(e.target.value.replace(/[^0-9.]/g, ""))} />
        <button className="ghost" disabled={!addStr} onClick={() => onAddMargin(ethers.parseEther(addStr))}>Add margin</button>
        <button onClick={onClose}>Close position</button>
      </div>
    </div>
  );
}

function PoolPanel({ pool, account, onDeposit, onWithdraw }) {
  const [amt, setAmt] = useState("");
  const myValue = pool.totalShares ? (pool.shares * pool.poolValue) / pool.totalShares : 0n;
  return (
    <div className="card">
      <div className="card-head">
        <h3>Liquidity pool</h3>
        <span className="muted small">LPs take the other side of every trade and earn fees, funding and trader losses</span>
      </div>
      <div className="stats">
        <div><div className="muted small">Pool value</div><div className="stat">{fmt(pool.poolValue)} USDT</div></div>
        <div><div className="muted small">Your share</div><div className="stat">{fmt(myValue)} USDT</div></div>
      </div>
      {account && (
        <div className="actions">
          <input placeholder="USDT" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ""))} />
          <button className="ghost" disabled={!amt} onClick={() => onDeposit(ethers.parseEther(amt))}>Deposit</button>
          <button className="ghost" disabled={!pool.shares} onClick={() => onWithdraw(pool.shares)}>Withdraw all</button>
        </div>
      )}
    </div>
  );
}
