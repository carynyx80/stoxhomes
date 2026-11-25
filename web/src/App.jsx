import { useEffect, useMemo, useRef, useState } from "react";
import { useExchange, useHistorySeries, getFundingGrid, USE_MOCK, BACKEND, fetchFundingSnapshots, useNow, countdown } from "./data/useMarkets.js";
import { FundsSheet } from "./ui/Funds.jsx";
import AdminPage from "./ui/Admin.jsx";
const ENGINE_MODE = BACKEND === "engine";
const TREASURY = "0x106342ec570e207afda9fda63125d7a9071127f2";
import { chain, deployment, CHAIN_ID } from "./chain.js";
const shortAddr = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");
const Custody = () => (ENGINE_MODE ? <span className="custody"><i />Custodial · funds held by Stoxhome</span> : null);
const isAdminRoute = () => typeof window !== "undefined" && window.location.pathname.replace(/\/+$/, "") === "/admin";
import { Sheet, Toasts, WalletPicker } from "./ui/Overlays.jsx";
import { targetChainName } from "./data/wallet.js";
import { API } from "./data/live.js";
import Skyline from "./ui/Skyline.jsx";
import Chart from "./ui/Chart.jsx";
import { LogoMark } from "./ui/Logo.jsx";

const usd = (v, d = 0) => "$" + v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const compact = (v) => "$" + Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(v);
const sgn = (v, d = 2) => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(d);
const pctS = (v, d = 2) => sgn(v * 100, d) + "%";

function useTween(value, ms = 900) {
  const [v, setV] = useState(value * 0.6);
  const from = useRef(value * 0.6);
  useEffect(() => {
    const start = performance.now(), a = from.current, b = value;
    let raf;
    const step = (now) => {
      const k = Math.min(1, (now - start) / ms), e = 1 - Math.pow(1 - k, 3);
      const cur = a + (b - a) * e; setV(cur); from.current = cur;
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return v;
}
const Tween = ({ value, format }) => <>{format(useTween(value))}</>;

function heat(t) { // 0..1 -> blueprint blue -> amber -> vermilion -> crimson
  const stops = [[35, 64, 230], [240, 162, 2], [229, 72, 43], [168, 16, 40]];
  const p = Math.min(0.999, Math.max(0, t)) * (stops.length - 1), i = Math.floor(p), f = p - i;
  const c = stops[i].map((s, k) => Math.round(s + (stops[i + 1][k] - s) * f));
  return `rgb(${c.join(",")})`;
}

// Close-only state: inside window = "active", within 24h before it = "soon"
function printState(m, now) {
  if (!m.nextPrintAt) return m.closeOnly ? { kind: "active", left: 0 } : { kind: "none", left: 0 };
  if (m.closeOnly || now >= m.closeOnlyFrom) return { kind: "active", left: m.nextPrintAt - now };
  if (m.closeOnlyFrom - now < 86_400_000) return { kind: "soon", left: m.closeOnlyFrom - now };
  return { kind: "open", left: m.nextPrintAt - now };
}

export default function App() {
  const ex = useExchange();
  if (!ex.ready) return <Boot error={ex.error} />;
  return <Desk ex={ex} admin={isAdminRoute()} />;
}

function Boot({ error }) {
  return (
    <div className="app">
      <div className="blueprint" aria-hidden="true" />
      <div className="boot">
        <div className="brand"><span className="mark"><LogoMark size={25} /></span><span>Stox<em>home</em></span></div>
        <p className="eyebrow">{error ? "Connection problem" : ENGINE_MODE ? "Connecting to the exchange…" : `Reading ${chain.name || "chain"}…`}</p>
        {error && <p className="boot-err">{error}</p>}
      </div>
    </div>
  );
}

function Desk({ ex, admin }) {
  const now = useNow() + (ex.clockOffset || 0);
  const [funds, setFunds] = useState(null);
  const [sel, setSel] = useState(0);
  const [range, setRange] = useState("1Y");
  const [sheet, setSheet] = useState(null);
  const m = ex.markets[sel] || ex.markets[0];
  const histRaw = useHistorySeries(m, range, now, Math.floor(now / 30000) + ":" + ex.trades.length);
  const hist = histRaw && histRaw.length > 1 ? histRaw : [{ t: now - 86400000, index: m.index, mark: m.mark }, { t: now, index: m.index, mark: m.mark }];
  const oi = ex.stats.oi;
  const vol = ex.stats.volume24h;
  const rangeChg = hist[hist.length - 1].index / hist[0].index - 1;
  const pos = ex.positions.find((p) => p.marketId === sel);
  const posKey = pos ? pos.entryPrice.toFixed(2) + pos.liquidationPrice.toFixed(1) : "";
  const lines = useMemo(() => pos ? [
    { kind: "entry", v: pos.entryPrice, label: `ENTRY ${pos.side.toUpperCase()} ${pos.entryPrice.toFixed(2)}` },
    { kind: "liq", v: pos.liquidationPrice, label: `LIQ ${pos.liquidationPrice.toFixed(2)}` },
  ] : [], [sel, posKey]);

  return (
    <div className="app">
      <div className="blueprint" aria-hidden="true" />
      <header className="top">
        <div className="brand"><span className="mark"><LogoMark size={25} /></span><span>Stox<em>home</em></span></div>
        {admin
          ? <nav><a href="/">Trade</a><a className="on" href="/admin">Admin</a></nav>
          : <nav><a className="on">Trade</a><a href="#vault">Vault</a><a href="#funding">Funding</a><a href="#tape">Tape</a>{ex.isAdmin && <a href="/admin">Admin</a>}</nav>}
        <div className="top-r">
          <span className={"net" + (ex.live && !ex.error ? " ok" : "")}><i />{USE_MOCK ? "Mock data" : ENGINE_MODE ? (ex.error ? "Offline" : "Live") : chain.name}</span>
          {!ENGINE_MODE && ex.faucet && ex.wallet.connected && <button className="faucet" disabled={!!ex.busy} onClick={() => ex.actions.faucet()}>{ex.busy === "faucet" ? "Funding…" : "Get test USDT"}</button>}
          {ex.wc?.wrongChain && <button className="wallet warn" disabled={ex.wc.pending === "switch"} onClick={() => ex.wc.switchChain()}>{ex.wc.pending === "switch" ? "Switching…" : "Wrong network"}</button>}
          {ENGINE_MODE && ex.wallet.connected && !ex.wallet.signedIn
            ? <>
                <button className="faucet" title={ex.wallet.full} onClick={() => ex.wc?.openPicker()}>{ex.wallet.address}</button>
                <button className="wallet" disabled={ex.signing} onClick={() => ex.actions.signIn()}>{ex.signing ? "Check your wallet…" : "Sign in"}</button>
              </>
            : ENGINE_MODE && ex.wallet.connected
              ? <>
                  <button className="faucet balbtn" onClick={() => setFunds("deposit")} title="Deposit or withdraw">{usd(ex.wallet.balance, 2)} <small>available</small></button>
                  <button className="wallet" title={ex.wallet.full} onClick={() => ex.wc?.openPicker()}>{ex.wallet.address}</button>
                </>
              : ex.wallet.connected
                ? <button className="wallet" title={ex.wallet.full} onClick={() => ex.wc?.openPicker()}>{usd(ex.wallet.balance)} · {ex.wallet.address}</button>
                : <button className="wallet" disabled={ex.wc?.pending === "connect"} onClick={() => ex.actions.connect()}>{ex.wc?.pending === "connect" ? "Connecting…" : "Connect wallet"}</button>}
        </div>
      </header>

      {ex.error && <div className="errbar">{ex.error}</div>}
      <Ticker markets={ex.markets} />
      {admin ? <AdminPage ex={ex} /> : <>

      <section className="hero">
        <div className="hero-sky" aria-hidden="true">{["LDN", "NYC", "SF", "MIA", "LA"].map((k, i) => <Skyline key={k} symbol={k} seed={i + 11} />)}</div>
        <div className="hero-copy">
          <p className="eyebrow">Perpetual futures · City house-price indices · Up to 100×</p>
          <h1>Own the <em>skyline</em>,<br />not the mortgage.</h1>
        </div>
        <dl className="stats">
          <div><dt>Total value locked</dt><dd><Tween value={ex.stats.tvl} format={compact} /></dd></div>
          <div><dt>24h volume</dt><dd><Tween value={vol} format={compact} /></dd></div>
          <div><dt>Open interest</dt><dd><Tween value={oi} format={compact} /></dd></div>
          <div><dt>Vault APR</dt><dd>{ex.pool.apr == null ? "—" : <Tween value={ex.pool.apr * 100} format={(v) => v.toFixed(1) + "%"} />}</dd></div>
        </dl>
      </section>

      <section className="cities" aria-label="Markets">
        {ex.markets.map((c, i) => (
          <button key={c.symbol} className={"city" + (i === sel ? " on" : "")} onClick={() => setSel(i)}>
            <Skyline symbol={c.symbol} seed={i + 1} />
            <PrintBadge ps={printState(c, now)} />
            <div className="city-meta">
              <span className="sym">{c.symbol}</span>
              <span className="cpx">{c.index.toFixed(2)}</span>
              <span className="cname">{c.city}</span>
              {c.change1y != null
                ? <span className={"cchg " + (c.change1y >= 0 ? "up" : "dn")}>{pctS(c.change1y, 1)} 1Y</span>
                : <span className={"cchg " + (c.change24h >= 0 ? "up" : "dn")}>{pctS(c.change24h, 2)} 24h</span>}
            </div>
          </button>
        ))}
      </section>

      <main className="desk">
        <section className="panel chartpanel">
          <div className="ch-head">
            <div>
              <p className="eyebrow">{m.coords} · {m.name}</p>
              <h2>{m.city} <span>Home Price Index</span></h2>
              <div className="px">
                <b>{m.index.toFixed(2)}</b>
                <span className={rangeChg >= 0 ? "up" : "dn"}>{pctS(rangeChg)} <small>{range}</small></span>
              </div>
            </div>
            <div className="ch-side">
              <div className="tabs">{["1M", "6M", "1Y", "5Y"].map((r) => <button key={r} className={r === range ? "on" : ""} onClick={() => setRange(r)}>{r}</button>)}</div>
              <div className="legend"><span><i className="lg-i" />Index</span><span><i className="lg-m" />Mark</span></div>
            </div>
          </div>
          <PrintBanner ps={printState(m, now)} />
          <Chart data={hist} range={range} symbol={m.symbol} lines={lines} />
          <div className="facts">
            <Fact k="Mark" v={m.mark.toFixed(2)} />
            <Fact k="Premium" v={pctS(m.mark / m.index - 1, 3)} />
            <Fact k="Funding / day" v={pctS(m.funding, 4)} cls={m.funding >= 0 ? "dn" : "up"} />
            <Fact k="24h volume" v={compact(m.volume24h)} />
            <SkewBar m={m} />
          </div>
        </section>
        <Ticket m={m} ex={ex} ps={printState(m, now)} openFunds={setFunds} />
      </main>

      <section className="row2">
        <Positions ex={ex} setSheet={setSheet} />
        <Tape trades={ex.trades} />
      </section>

      <section className="row3">
        <Funding markets={ex.markets} now={now} live={ex.live} />
        <Vault ex={ex} pool={ex.pool} now={now} cooldown={ex.params.withdrawCooldown} setSheet={setSheet} />
      </section>

      </>}
      {sheet && <Sheet sheet={sheet} ex={ex} onClose={() => setSheet(null)} />}
      {funds && ex.wallet.signedIn && <FundsSheet ex={ex} tab={funds} onClose={() => setFunds(null)} />}
      {ex.wc?.pickerOpen && <WalletPicker wc={ex.wc} />}
      <Toasts toasts={ex.toasts} dismiss={ex.dismiss} explorer={ENGINE_MODE ? ex.explorer : chain.explorer} />
      <footer className="foot">
        {ENGINE_MODE
          ? <span>Stoxhome holds customer deposits in its treasury wallet <a href={`https://bscscan.com/address/${TREASURY}`} target="_blank" rel="noreferrer">{shortAddr("0x106342ec570E207afDa9fDA63125d7a9071127f2")}</a>. Derivatives on real-estate indices are regulated in most jurisdictions.</span>
          : <span>Stoxhome — {CHAIN_ID === 56 ? "BNB Smart Chain" : CHAIN_ID === 97 ? "BNB Smart Chain testnet" : "demo network, test funds only"}. Unaudited. Derivatives on real-estate indices are regulated in most jurisdictions.</span>}
        <span>Index = smoothed oracle print · Mark = index × (1 + skew / skewScale)</span>
        {!USE_MOCK && !ENGINE_MODE && deployment?.feeRecipient && (
          <span>Protocol fees: {chain.explorer
            ? <a href={`${chain.explorer}/address/${deployment.feeRecipient}`} target="_blank" rel="noreferrer">{shortAddr(deployment.feeRecipient)}</a>
            : shortAddr(deployment.feeRecipient)}</span>
        )}
      </footer>
    </div>
  );
}

function PrintBadge({ ps }) {
  if (ps.kind === "active") return <span className="pbadge hot"><i />Close-only · {countdown(ps.left)}</span>;
  if (ps.kind === "soon") return <span className="pbadge soon">Close-only in {countdown(ps.left)}</span>;
  if (ps.kind === "none") return <span className="pbadge">No print scheduled</span>;
  return <span className="pbadge">Print in {countdown(ps.left)}</span>;
}
function PrintBanner({ ps }) {
  if (ps.kind === "open" || ps.kind === "none") return null;
  return (
    <div className={"pbanner " + ps.kind}>
      <span className="pb-ico">◷</span>
      {ps.kind === "active"
        ? <p><b>Close-only{ps.left > 0 ? ` — next index print in ${countdown(ps.left)}` : " — index print pending"}.</b> New positions and increases are paused until the print lands; closing and reducing are always allowed.</p>
        : <p><b>Close-only in {countdown(ps.left)} — next index print.</b> Opening pauses 6h before each scheduled print so nobody can front-run it.</p>}
    </div>
  );
}

const Fact = ({ k, v, cls = "" }) => <div className="fact"><span>{k}</span><b className={cls}>{v}</b></div>;

function SkewBar({ m }) {
  const tot = m.longSize + m.shortSize, l = tot > 0 ? m.longSize / tot : 0.5;
  return (
    <div className="fact skew">
      <span>Open interest · L/S</span>
      <div className="skewbar"><i style={{ width: l * 100 + "%" }} /><em style={{ width: (1 - l) * 100 + "%" }} /></div>
      <small><b className="up">{(l * 100).toFixed(0)}% L</b><b className="dn">{((1 - l) * 100).toFixed(0)}% S</b></small>
    </div>
  );
}

function Ticker({ markets }) {
  const row = markets.map((c) => (
    <span key={c.symbol}><b>{c.symbol}</b> {c.index.toFixed(2)} <i className={c.change24h >= 0 ? "up" : "dn"}>{pctS(c.change24h, 3)}</i> <small>F {pctS(c.funding, 4)}</small></span>
  ));
  return <div className="ticker"><div className="ticker-in">{row}{row}{row}</div></div>;
}

function Ticket({ m, ex, ps, openFunds }) {
  const [side, setSide] = useState("long");
  const [marginStr, setMargin] = useState("1000");
  const margin = Math.max(0, Number(marginStr) || 0);
  const [lev, setLev] = useState(20);
  const t = (lev - 1) / 99;
  const color = heat(t);
  const feeRate = ex.params.tradingFeeBps / 10_000;
  const notional = (margin * lev) / (1 + lev * feeRate) * 0.999; // fee comes out of margin; same sizing the contract call uses
  const fee = notional * feeRate;
  const entry = m.mark * (side === "long" ? 1.0004 : 0.9996);
  const hasPos = ex.positions.some((p) => p.marketId === m.id);
  const mm = ex.params.maintenanceMarginBps / 10_000;
  const move = Math.max(0, (margin - fee) / notional - mm); // fraction price can move against you
  const liq = side === "long" ? entry * (1 - move) : entry * (1 + move);
  const presets = [1, 5, 10, 25, 50, 100];
  return (
    <aside className="panel ticket" style={{ "--heat": color }}>
      <div className="tk-head">
        <span className="eyebrow">Order ticket <Custody /></span>
        <span className="tk-mkt">{m.name}</span>
      </div>
      <div className={"sides " + side}>
        <button className={side === "long" ? "on" : ""} onClick={() => setSide("long")}>Long <small>price rises</small></button>
        <button className={side === "short" ? "on" : ""} onClick={() => setSide("short")}>Short <small>price falls</small></button>
      </div>
      <label className="field">
        <span>Margin <small>{ENGINE_MODE && ex.wallet.signedIn ? <>Available {usd(ex.wallet.balance, 2)}<button type="button" className="tk-faucet" onClick={() => openFunds("deposit")}>Deposit</button></> : ENGINE_MODE && ex.wallet.connected ? "Sign in to see your balance" : ex.wallet.connected ? <>Balance {usd(ex.wallet.balance)}{ex.faucet && ex.live && <button type="button" className="tk-faucet" onClick={() => ex.actions.faucet()}>+ test USDT</button>}</> : "Wallet not connected"}</small></span>
        <div className="inp"><input type="number" min="0" inputMode="decimal" value={marginStr} onChange={(e) => setMargin(e.target.value)} aria-label="Margin" /><b>USDT</b></div>
      </label>

      <div className="lev">
        <div className="lev-top">
          <span>Leverage</span>
          <div className="lev-num" style={{ color }}><Tween value={lev} format={(v) => Math.round(v)} /><i>×</i></div>
        </div>
        <div className="dial">
          <div className="ticks">{Array.from({ length: 40 }, (_, i) => <i key={i} style={{ height: 6 + (i / 39) * 22 + "px", background: i / 39 <= t ? heat(i / 39) : undefined }} />)}</div>
          <input type="range" min="1" max="100" value={lev} onChange={(e) => setLev(+e.target.value)} style={{ "--p": t * 100 + "%" }} aria-label="Leverage" />
        </div>
        <div className="presets">{presets.map((p) => <button key={p} className={p === lev ? "on" : ""} onClick={() => setLev(p)}>{p}×</button>)}</div>
        {lev >= 75 && <p className="warn">A {(move * 100).toFixed(2)}% move against you liquidates this position.</p>}
      </div>

      <div className="liq">
        <div className="liq-top"><span>Distance to liquidation</span><b style={{ color }}>{(move * 100).toFixed(2)}%</b></div>
        <div className="liqbar"><i style={{ width: Math.min(100, move * 100 * 2) + "%", background: color }} /><em>50%</em></div>
      </div>

      <dl className="sum">
        <div><dt>Position size</dt><dd>{usd(notional)}</dd></div>
        <div><dt>Units</dt><dd>{(notional / entry).toFixed(2)} {m.symbol}</dd></div>
        <div><dt>Est. entry</dt><dd>{entry.toFixed(2)}</dd></div>
        <div><dt>Liq. price</dt><dd style={{ color }}>{liq.toFixed(2)}</dd></div>
        <div><dt>Fee 0.05%</dt><dd>{usd(fee, 2)}</dd></div>
        <div><dt>Funding / day</dt><dd>{pctS((side === "long" ? -1 : 1) * m.funding, 4)}</dd></div>
      </dl>
      {ps.kind === "active"
        ? <button className="go locked" disabled>Close-only{ps.left > 0 ? ` · opens in ${countdown(ps.left)}` : " · awaiting print"}</button>
        : !ex.wallet.connected
          ? <button className="go long" disabled={ex.wc?.pending === "connect"} onClick={() => ex.actions.connect()}>{ex.wc?.pending === "connect" ? "Connecting…" : "Connect wallet to trade"}</button>
          : ENGINE_MODE && !ex.wallet.signedIn
            ? <button className="go long" disabled={ex.signing} onClick={() => ex.actions.signIn()}>{ex.signing ? "Check your wallet…" : "Sign in to trade"}</button>
          : ex.wc?.wrongChain
            ? <button className="go switch" disabled={ex.wc.pending === "switch"} onClick={() => ex.wc.switchChain()}>{ex.wc.pending === "switch" ? "Confirm in wallet…" : `Switch to ${targetChainName()}`}</button>
          : hasPos
            ? <button className="go locked" disabled>Position open — manage it below</button>
            : <button className={"go " + side} disabled={!!ex.busy || margin <= 0} onClick={() => ex.actions.open({ marketId: m.id, side, margin: marginStr, leverage: lev })}>
                {ex.busy === "open" ? "Submitting…" : `${side === "long" ? "Long" : "Short"} ${m.symbol} · ${lev}×`}
              </button>}
      <p className="fine">Fills at average premium across the trade. Max slippage 0.5%.</p>
    </aside>
  );
}

function Positions({ ex, setSheet }) {
  const [tab, setTab] = useState("pos");
  return (
    <section className="panel positions">
      <div className="sec-head ptabs">
        {[["pos", "Positions", ex.positions.length], ["ord", "Orders", 0], ["his", "History", ex.history.length]].map(([k, l, n]) => (
          <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}<span className="count">{n}</span></button>
        ))}
      </div>
      {tab === "ord" && <div className="empty"><b>No resting orders.</b><span>Stoxhome fills against the pool at mark — there is no order book to wait on.</span></div>}
      {tab === "his" && (ex.history.length ? <History rows={ex.history} /> : <div className="empty"><b>No trades yet.</b><span>{ex.wallet.connected ? "Your opens, modifies and closes appear here." : "Connect a wallet to see your history."}</span></div>)}
      {tab === "pos" && ex.positions.length === 0 && <div className="empty"><b>No open positions.</b><span>{ex.wallet.connected ? "Pick a city above and open one from the order ticket." : "Connect a wallet to see your positions."}</span></div>}
      {tab === "pos" && ex.positions.length > 0 && <div className="tbl">
        <div className="tr th"><span>Market</span><span>Size</span><span>Entry / Index</span><span>Margin</span><span>PnL</span><span>Funding</span><span>Liq. price</span><span /></div>
        {ex.positions.map((p) => {
          const toLiq = Math.abs(p.indexPrice - p.liquidationPrice) / p.indexPrice;
          return (
            <div className="tr" key={p.market}>
              <span data-k="Market"><b>{p.market}</b> <em className={"tag " + (p.side === "long" ? "up" : "dn")}>{p.side === "long" ? "Long" : "Short"} {p.leverage}×</em></span>
              <span data-k="Size">{p.size.toLocaleString()} u · {compact(p.size * p.indexPrice)}</span>
              <span data-k="Entry / Index">{p.entryPrice.toFixed(2)} / {p.indexPrice.toFixed(2)}</span>
              <span data-k="Margin">{usd(p.margin)}</span>
              <span data-k="PnL" className={p.pnl >= 0 ? "up" : "dn"}><b>{(p.pnl >= 0 ? "+" : "−") + usd(Math.abs(p.pnl))}</b> <small>{pctS(p.pnl / p.margin, 1)}</small></span>
              <span data-k="Funding" className={p.funding >= 0 ? "up" : "dn"}>{(p.funding >= 0 ? "+" : "−") + usd(Math.abs(p.funding), 2)}</span>
              <span data-k="Liq. price">{p.liquidationPrice.toFixed(2)} <small>{(toLiq * 100).toFixed(1)}% away</small></span>
              <span className="acts">
                <button className="mini" disabled={!!ex.busy} onClick={() => setSheet({ type: "increase", pos: p })}>+ Increase</button>
                <button className="mini" disabled={!!ex.busy} onClick={() => setSheet({ type: "reduce", pos: p })}>− Reduce</button>
                <button className="mini" disabled={!!ex.busy} onClick={() => setSheet({ type: "addMargin", pos: p })}>+ Margin</button>
                {ENGINE_MODE && <button className="mini" disabled={!!ex.busy} onClick={() => setSheet({ type: "removeMargin", pos: p })}>− Margin</button>}
                <button className="ghost" disabled={!!ex.busy} onClick={() => ex.actions.close({ marketId: p.marketId })}>{ex.busy === "close" ? "Closing…" : "Close"}</button>
              </span>
            </div>
          );
        })}
      </div>}
      {tab === "pos" && ex.positions.length > 0 && <div className="pos-foot"><span>Account equity <b>{usd(ex.positions.reduce((a, p) => a + p.equity, 0))}</b></span><span>Unrealised PnL <b className="up">{(ex.positions.reduce((a, p) => a + p.pnl, 0) >= 0 ? "+" : "−") + usd(Math.abs(ex.positions.reduce((a, p) => a + p.pnl, 0)))}</b></span><span>Free collateral <b>{usd(ex.wallet.balance)}</b></span></div>}
    </section>
  );
}

function History({ rows }) {
  return (
    <div className="tbl hist">
      <div className="tr th"><span>Time</span><span>Market</span><span>Action</span><span>Size</span><span>Price</span><span>Realised</span></div>
      {rows.map((r, i) => (
        <div className="tr" key={i}>
          <span data-k="Time">{new Date(r.ts).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
          <span data-k="Market"><b>{r.market}</b> <em className={"tag " + (r.side === "long" ? "up" : "dn")}>{r.side}</em></span>
          <span data-k="Action">{r.action}</span>
          <span data-k="Size">{r.size.toLocaleString()} u</span>
          <span data-k="Price">{r.price.toFixed(2)}</span>
          <span data-k="Realised" className={r.pnl == null ? "" : r.pnl >= 0 ? "up" : "dn"}>{r.pnl == null ? "—" : (r.pnl >= 0 ? "+" : "−") + usd(Math.abs(r.pnl), 2)}</span>
        </div>
      ))}
    </div>
  );
}

function Tape({ trades }) {
  return (
    <section className="panel tape" id="tape">
      <div className="sec-head"><h3>Live tape</h3><span className="live"><i />Streaming</span></div>
      <ol>
        {trades.length === 0 && <li className="tape-empty">{USE_MOCK ? "" : "No trades indexed yet — or the indexer is offline."}</li>}
        {trades.slice(0, 9).map((t) => (
          <li key={t.id} className={t.side}>
            <span className="tt">{new Date(t.ts).toLocaleTimeString("en-GB")}</span>
            <b>{t.market}</b>
            <span className="ts">{t.side === "long" ? "▲ Long" : "▼ Short"} {t.leverage ? t.leverage + "×" : t.kind}</span>
            <span className="tp">{t.price.toFixed(2)}</span>
            <span className="tn">{compact(t.notional)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Funding({ markets, now, live }) {
  const grid = useFundingGrid(markets, live, now);
  const cell = (v) => {
    const a = Math.min(1, Math.abs(v) / 0.001);
    return v >= 0 ? `rgba(229,72,43,${0.1 + a * 0.85})` : `rgba(35,64,230,${0.1 + a * 0.85})`;
  };
  return (
    <section className="panel funding" id="funding">
      <div className="sec-head"><h3>Funding heatmap</h3><span className="sub">14 days · %/day</span></div>
      <div className="hm">
        {markets.map((c, r) => (
          <div className="hm-row" key={c.symbol}>
            <b>{c.symbol}</b>
            <div className="hm-cells">{grid[r].map((v, d) => <i key={d} style={{ background: v == null ? "rgba(18,17,16,.05)" : cell(v), animationDelay: (r * 14 + d) * 12 + "ms" }} title={v == null ? "no data" : `${(v * 100).toFixed(4)}%/day`} />)}</div>
            <span className={c.funding >= 0 ? "dn" : "up"}>{pctS(c.funding, 3)}</span>
          </div>
        ))}
        <div className="hm-legend"><span>Shorts pay longs</span><i /><span>Longs pay shorts</span></div>
      </div>
      <div className="cal">
        <p className="eyebrow">Index print calendar · close-only opens 6h before</p>
        {markets.every((c) => !c.nextPrintAt) && <p className="cal-none">No index prints scheduled. The keeper schedules each monthly print ahead of time.</p>}
        {[...markets].filter((c) => c.nextPrintAt).sort((a, b) => a.nextPrintAt - b.nextPrintAt).map((c) => {
          const ps = now >= c.closeOnlyFrom ? "active" : c.closeOnlyFrom - now < 86_400_000 ? "soon" : "open";
          const span = 9 * 86_400_000, x = Math.min(1, (c.nextPrintAt - now) / span), w = Math.min(x, 6 * 3_600_000 / span);
          return (
            <div className={"cal-row " + ps} key={c.symbol}>
              <b>{c.symbol}</b>
              <div className="cal-track"><em style={{ left: (x - w) * 100 + "%", width: w * 100 + "%" }} /><i style={{ left: x * 100 + "%" }} /></div>
              <span>{countdown(c.nextPrintAt - now)}</span>
            </div>
          );
        })}
        <div className="cal-ax"><span>Now</span><span>+3d</span><span>+6d</span><span>+9d</span></div>
      </div>
    </section>
  );
}

function Vault({ ex, pool, now, cooldown, setSheet }) {
  const w = pool.pendingWithdrawal, total = cooldown * 1000, done = w ? Math.max(0, Math.min(1, (now - w.requestedAt) / total)) : 0;
  const unlocked = w && now >= w.unlockAt, expired = w && w.expiresAt && now > w.expiresAt;
  let acc = 0;
  const colors = ["#ffffff", "#0b1680", "#9fb0ff", "#f0a202", "#e5482b", "#121110"];
  return (
    <section className="panel vault" id="vault">
      <div className="vault-l">
        <p className="eyebrow">Liquidity vault · USDT <Custody /></p>
        <h3>Be the house.</h3>
        <p className="lede">LPs are the counterparty to every trade — earning fees, funding from the crowded side and trader losses.</p>
        <div className="apr"><b>{pool.apr == null ? "—" : <Tween value={pool.apr * 100} format={(v) => v.toFixed(1)} />}<i>%</i></b><span>{ex.live ? "Fee APR, trailing 30d" : "APR, trailing 30d"}</span></div>
        <div className="apr-split">
          {pool.feesApr != null && <span><i style={{ background: "#fff" }} />Fees {(pool.feesApr * 100).toFixed(1)}%</span>}
          {pool.fundingApr != null && <span><i style={{ background: "#9fb0ff" }} />Funding {(pool.fundingApr * 100).toFixed(1)}%</span>}
          {pool.pnlApr != null && <span><i style={{ background: "#f0a202" }} />Trader PnL {(pool.pnlApr * 100).toFixed(1)}%</span>}
          {ex.live && <span>Funding and trader PnL accrue to share price</span>}
        </div>
      </div>
      <div className="vault-r">
        <div className="vstats">
          <Fact k="Pool value" v={compact(pool.poolValue)} />
          <Fact k="Share price" v={"$" + pool.sharePrice.toFixed(4)} />
          <Fact k="Your shares" v={pool.shares.toLocaleString(undefined, { maximumFractionDigits: 2 })} />
          <Fact k="Utilization" v={(pool.utilization * 100).toFixed(0) + "%"} />
        </div>
        <div className="comp">
          <div className="comp-bar">{pool.composition.map((c, i) => <i key={c.label} style={{ width: c.value * 100 + "%", background: colors[i] }} />)}</div>
          <ul>{pool.composition.map((c, i) => { acc += c.value; return <li key={c.label}><i style={{ background: colors[i] }} />{c.label}<b>{(c.value * 100).toFixed(0)}%</b></li>; })}</ul>
        </div>
        {w && <div className="pending">
          <div className="pend-top"><span>Pending withdrawal · {w.shares.toLocaleString(undefined, { maximumFractionDigits: 2 })} shares ≈ {usd(w.estimatedAmount ?? w.shares * pool.sharePrice)}</span><b>{expired ? "Expired — cancel & re-request" : unlocked ? "Unlocked" : "Unlocks in " + countdown(w.unlockAt - now)}</b></div>
          <div className="pend-bar"><i style={{ width: done * 100 + "%" }} />{[0.25, 0.5, 0.75].map((q) => <em key={q} style={{ left: q * 100 + "%" }} />)}</div>
          <div className="pend-ax"><span>Requested</span><span>{Math.round(cooldown / 3600)}h cooldown</span><span>Withdrawable</span></div>
          <div className="pend-btns">
            <button className="ghost" disabled={!!ex.busy} onClick={() => ex.actions.cancelWithdraw()}>{ex.busy === "cancelWithdraw" ? "Cancelling…" : "Cancel"}</button>
            <button className="go long" disabled={!unlocked || expired || !!ex.busy} onClick={() => ex.actions.withdraw()}>{ex.busy === "withdraw" ? "Withdrawing…" : unlocked ? "Withdraw now" : "Withdraw · " + countdown(w.unlockAt - now)}</button>
          </div>
        </div>}
        <div className="vbtns">
          <button className="go long" disabled={!!ex.busy} onClick={() => (!ex.wallet.connected ? ex.actions.connect() : ENGINE_MODE && !ex.wallet.signedIn ? ex.actions.signIn() : setSheet({ type: "deposit" }))}>{ex.busy === "deposit" ? "Depositing…" : "Deposit USDT"}</button>
          <button className="ghost" disabled={!!ex.busy || !!w || (ex.wallet.connected && pool.shares <= 0)} onClick={() => setSheet({ type: "requestWithdraw" })}>Request withdraw</button>
        </div>
      </div>
    </section>
  );
}

function useFundingGrid(markets, live, now) {
  const [grid, setGrid] = useState(() => (live ? markets.map(() => Array(14).fill(null)) : getFundingGrid()));
  const day = Math.floor(now / 86_400_000);
  useEffect(() => {
    if (!live) return;
    let stop = false;
    const get = (id) => (ENGINE_MODE
      ? fetchFundingSnapshots(id)
      : fetch(`${API}/markets/${id}/history?range=1M`).then((r) => r.json()).then((h) => (h.snapshots || []).map((s) => ({ t: s.timestamp * 1000, f: s.fundingRatePerDay })))
    ).catch(() => []);
    Promise.all(markets.map((m) => get(m.id))).then((hs) => {
      if (stop) return;
      setGrid(hs.map((h, i) => Array.from({ length: 14 }, (_, d) => {
        const end = (day - 13 + d + 1) * 86_400_000, start = end - 86_400_000;
        const xs = h.filter((s) => s.t >= start && s.t < end).map((s) => s.f);
        if (d === 13 && !xs.length) return markets[i].funding;
        return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
      })));
    });
    return () => { stop = true; };
  }, [live, day, markets.length, Math.floor(now / 60000)]); // eslint-disable-line react-hooks/exhaustive-deps
  return grid;
}
