import { useEffect, useMemo, useRef, useState } from "react";
import { useExchange, useHistory, getFundingGrid, USE_MOCK, useNow, countdown } from "./data/useMarkets.js";
import Skyline from "./ui/Skyline.jsx";
import Chart from "./ui/Chart.jsx";

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
  if (now >= m.closeOnlyFrom) return { kind: "active", left: m.nextPrintAt - now };
  if (m.closeOnlyFrom - now < 86_400_000) return { kind: "soon", left: m.closeOnlyFrom - now };
  return { kind: "open", left: m.nextPrintAt - now };
}

export default function App() {
  const ex = useExchange();
  const now = useNow();
  const [sel, setSel] = useState(0);
  const [range, setRange] = useState("1Y");
  const m = ex.markets[sel];
  const hist = useMemo(() => useHistory(sel, range), [sel, range]);
  const oi = ex.markets.reduce((s, x) => s + (x.longSize + x.shortSize) * x.index, 0);
  const vol = ex.markets.reduce((s, x) => s + x.volume24h, 0);
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
        <div className="brand"><span className="mark">⌂</span><span>House<em>DEX</em></span></div>
        <nav><a className="on">Trade</a><a href="#vault">Vault</a><a href="#funding">Funding</a><a href="#tape">Tape</a></nav>
        <div className="top-r">
          <span className="net"><i />{USE_MOCK ? "Mock data" : "BNB Chain"}</span>
          <button className="wallet">{ex.wallet.address}</button>
        </div>
      </header>

      <Ticker markets={ex.markets} />

      <section className="hero">
        <div className="hero-sky" aria-hidden="true">{["LDN", "NYC", "SF", "MIA", "LA"].map((k, i) => <Skyline key={k} symbol={k} seed={i + 11} />)}</div>
        <div className="hero-copy">
          <p className="eyebrow">Perpetual futures · City house-price indices · Up to 100×</p>
          <h1>Own the <em>skyline</em>,<br />not the mortgage.</h1>
        </div>
        <dl className="stats">
          <div><dt>Total value locked</dt><dd><Tween value={ex.pool.poolValue} format={compact} /></dd></div>
          <div><dt>24h volume</dt><dd><Tween value={vol} format={compact} /></dd></div>
          <div><dt>Open interest</dt><dd><Tween value={oi} format={compact} /></dd></div>
          <div><dt>Vault APR</dt><dd><Tween value={ex.pool.apr * 100} format={(v) => v.toFixed(1) + "%"} /></dd></div>
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
              <span className={"cchg " + (c.change1y >= 0 ? "up" : "dn")}>{pctS(c.change1y, 1)} 1Y</span>
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
        <Ticket m={m} ex={ex} ps={printState(m, now)} />
      </main>

      <section className="row2">
        <Positions ex={ex} />
        <Tape trades={ex.trades} />
      </section>

      <section className="row3">
        <Funding markets={ex.markets} now={now} />
        <Vault pool={ex.pool} now={now} cooldown={ex.params.withdrawCooldown} />
      </section>

      <footer className="foot">
        <span>HouseDEX — prototype on BNB Smart Chain testnet. Unaudited. Derivatives on real-estate indices are regulated in most jurisdictions.</span>
        <span>Index = smoothed oracle print · Mark = index × (1 + skew / skewScale)</span>
      </footer>
    </div>
  );
}

function PrintBadge({ ps }) {
  if (ps.kind === "active") return <span className="pbadge hot"><i />Close-only · {countdown(ps.left)}</span>;
  if (ps.kind === "soon") return <span className="pbadge soon">Close-only in {countdown(ps.left)}</span>;
  return <span className="pbadge">Print in {countdown(ps.left)}</span>;
}
function PrintBanner({ ps }) {
  if (ps.kind === "open") return null;
  return (
    <div className={"pbanner " + ps.kind}>
      <span className="pb-ico">◷</span>
      {ps.kind === "active"
        ? <p><b>Close-only — next index print in {countdown(ps.left)}.</b> New positions and increases are paused until the print lands; closing and reducing are always allowed.</p>
        : <p><b>Close-only in {countdown(ps.left)} — next index print.</b> Opening pauses 6h before each scheduled print so nobody can front-run it.</p>}
    </div>
  );
}

const Fact = ({ k, v, cls = "" }) => <div className="fact"><span>{k}</span><b className={cls}>{v}</b></div>;

function SkewBar({ m }) {
  const tot = m.longSize + m.shortSize, l = m.longSize / tot;
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

function Ticket({ m, ex, ps }) {
  const [side, setSide] = useState("long");
  const [margin, setMargin] = useState(1000);
  const [lev, setLev] = useState(20);
  const t = (lev - 1) / 99;
  const color = heat(t);
  const notional = margin * lev;
  const fee = notional * ex.params.tradingFeeBps / 10_000;
  const entry = m.mark * (side === "long" ? 1.0004 : 0.9996);
  const mm = ex.params.maintenanceMarginBps / 10_000;
  const move = Math.max(0, (margin - fee) / notional - mm); // fraction price can move against you
  const liq = side === "long" ? entry * (1 - move) : entry * (1 + move);
  const presets = [1, 5, 10, 25, 50, 100];
  return (
    <aside className="panel ticket" style={{ "--heat": color }}>
      <div className="tk-head">
        <span className="eyebrow">Order ticket</span>
        <span className="tk-mkt">{m.name}</span>
      </div>
      <div className={"sides " + side}>
        <button className={side === "long" ? "on" : ""} onClick={() => setSide("long")}>Long <small>price rises</small></button>
        <button className={side === "short" ? "on" : ""} onClick={() => setSide("short")}>Short <small>price falls</small></button>
      </div>
      <label className="field">
        <span>Margin <small>Balance {usd(ex.wallet.balance)}</small></span>
        <div className="inp"><input type="number" min="1" value={margin} onChange={(e) => setMargin(Math.max(0, +e.target.value))} /><b>USDT</b></div>
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
        ? <button className="go locked" disabled>Close-only · opens in {countdown(ps.left)}</button>
        : <button className={"go " + side}>{side === "long" ? "Long" : "Short"} {m.symbol} · {lev}×</button>}
      <p className="fine">Fills at average premium across the trade. Max slippage 0.5%.</p>
    </aside>
  );
}

function Positions({ ex }) {
  const [tab, setTab] = useState("pos");
  return (
    <section className="panel positions">
      <div className="sec-head ptabs">
        {[["pos", "Positions", ex.positions.length], ["ord", "Orders", 0], ["his", "History", ex.history.length]].map(([k, l, n]) => (
          <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}<span className="count">{n}</span></button>
        ))}
      </div>
      {tab === "ord" && <div className="empty"><b>No resting orders.</b><span>HouseDEX fills against the pool at mark — there is no order book to wait on.</span></div>}
      {tab === "his" && <History rows={ex.history} />}
      {tab === "pos" && <div className="tbl">
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
              <span className="acts"><button className="mini">+ Increase</button><button className="mini">− Reduce</button><button className="ghost">Close</button></span>
            </div>
          );
        })}
      </div>}
      {tab === "pos" && <div className="pos-foot"><span>Account equity <b>{usd(ex.positions.reduce((a, p) => a + p.equity, 0))}</b></span><span>Unrealised PnL <b className="up">{(ex.positions.reduce((a, p) => a + p.pnl, 0) >= 0 ? "+" : "−") + usd(Math.abs(ex.positions.reduce((a, p) => a + p.pnl, 0)))}</b></span><span>Free collateral <b>{usd(ex.wallet.balance)}</b></span></div>}
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
        {trades.slice(0, 9).map((t) => (
          <li key={t.id} className={t.side}>
            <span className="tt">{new Date(t.ts).toLocaleTimeString("en-GB")}</span>
            <b>{t.market}</b>
            <span className="ts">{t.side === "long" ? "▲ Long" : "▼ Short"} {t.leverage}×</span>
            <span className="tp">{t.price.toFixed(2)}</span>
            <span className="tn">{compact(t.notional)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Funding({ markets, now }) {
  const grid = useMemo(() => getFundingGrid(), []);
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
            <div className="hm-cells">{grid[r].map((v, d) => <i key={d} style={{ background: cell(v), animationDelay: (r * 14 + d) * 12 + "ms" }} title={`${(v * 100).toFixed(4)}%/day`} />)}</div>
            <span className={c.funding >= 0 ? "dn" : "up"}>{pctS(c.funding, 3)}</span>
          </div>
        ))}
        <div className="hm-legend"><span>Shorts pay longs</span><i /><span>Longs pay shorts</span></div>
      </div>
      <div className="cal">
        <p className="eyebrow">Index print calendar · close-only opens 6h before</p>
        {[...markets].sort((a, b) => a.nextPrintAt - b.nextPrintAt).map((c) => {
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

function Vault({ pool, now, cooldown }) {
  const w = pool.pendingWithdrawal, total = cooldown * 1000, done = Math.min(1, (now - w.requestedAt) / total);
  let acc = 0;
  const colors = ["#ffffff", "#0b1680", "#9fb0ff", "#f0a202", "#e5482b", "#121110"];
  return (
    <section className="panel vault" id="vault">
      <div className="vault-l">
        <p className="eyebrow">Liquidity vault · hUSDT</p>
        <h3>Be the house.</h3>
        <p className="lede">LPs are the counterparty to every trade — earning fees, funding from the crowded side and trader losses.</p>
        <div className="apr"><b><Tween value={pool.apr * 100} format={(v) => v.toFixed(1)} /><i>%</i></b><span>APR, trailing 30d</span></div>
        <div className="apr-split">
          <span><i style={{ background: "#fff" }} />Fees {(pool.feesApr * 100).toFixed(1)}%</span>
          <span><i style={{ background: "#9fb0ff" }} />Funding {(pool.fundingApr * 100).toFixed(1)}%</span>
          <span><i style={{ background: "#f0a202" }} />Trader PnL {(pool.pnlApr * 100).toFixed(1)}%</span>
        </div>
      </div>
      <div className="vault-r">
        <div className="vstats">
          <Fact k="Pool value" v={compact(pool.poolValue)} />
          <Fact k="Share price" v={"$" + pool.sharePrice.toFixed(4)} />
          <Fact k="Your shares" v={pool.shares.toLocaleString()} />
          <Fact k="Utilization" v={(pool.utilization * 100).toFixed(0) + "%"} />
        </div>
        <div className="comp">
          <div className="comp-bar">{pool.composition.map((c, i) => <i key={c.label} style={{ width: c.value * 100 + "%", background: colors[i] }} />)}</div>
          <ul>{pool.composition.map((c, i) => { acc += c.value; return <li key={c.label}><i style={{ background: colors[i] }} />{c.label}<b>{(c.value * 100).toFixed(0)}%</b></li>; })}</ul>
        </div>
        <div className="pending">
          <div className="pend-top"><span>Pending withdrawal · {w.shares.toLocaleString()} shares ≈ {usd(w.shares * pool.sharePrice)}</span><b>{now >= w.unlockAt ? "Unlocked" : "Unlocks in " + countdown(w.unlockAt - now)}</b></div>
          <div className="pend-bar"><i style={{ width: done * 100 + "%" }} />{[0.25, 0.5, 0.75].map((q) => <em key={q} style={{ left: q * 100 + "%" }} />)}</div>
          <div className="pend-ax"><span>Requested</span><span>24h cooldown</span><span>Withdrawable</span></div>
        </div>
        <div className="vbtns"><button className="go long">Deposit USDT</button><button className="ghost">Request withdraw</button></div>
      </div>
    </section>
  );
}
