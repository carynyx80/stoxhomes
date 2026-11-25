import { useEffect, useState } from "react";
import Skyline from "./Skyline.jsx";
import { LogoMark } from "./Logo.jsx";

const TREASURY = "8oYH186qjPyYwnS58fh1NH1m5iFFJe8wPnBKVp3NGtgx";
const pctS = (v, d = 2) => (v >= 0 ? "+" : "−") + Math.abs(v * 100).toFixed(d) + "%";
const compact = (v) => "$" + Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(v);
const FALLBACK = [
  { symbol: "NYC", city: "New York", name: "NYC-HPI" }, { symbol: "LA", city: "Los Angeles", name: "LA-HPI" },
  { symbol: "MIA", city: "Miami", name: "MIA-HPI" }, { symbol: "SF", city: "San Francisco", name: "SF-HPI" },
  { symbol: "LDN", city: "London", name: "LDN-HPI" },
];

function useReveal() {
  useEffect(() => {
    const els = document.querySelectorAll(".lp [data-reveal]");
    if (!("IntersectionObserver" in window)) { els.forEach((e) => e.classList.add("in")); return; }
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }), { rootMargin: "0px 0px -8% 0px" });
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, []);
}

export default function Landing({ ex, enter }) {
  useReveal();
  const markets = ex?.ready && ex.markets?.length ? ex.markets : null;
  const list = markets || FALLBACK;
  const [open, setOpen] = useState(0);
  const go = (hash) => (e) => { e.preventDefault(); enter(hash); };

  return (
    <div className="lp">
      <div className="blueprint" aria-hidden="true" />
      <header className="lp-top">
        <a className="brand" href="/" onClick={(e) => e.preventDefault()}><span className="mark"><LogoMark size={25} /></span><span>Stox<em>home</em></span></a>
        <nav className="lp-nav"><a href="#how">How it works</a><a href="#markets">Markets</a><a href="#vault">Vault</a><a href="#faq">FAQ</a></nav>
        <a className="wallet lp-enter-sm" href="/app" onClick={go("trade")}>Enter app →</a>
      </header>

      <section className="lp-hero">
        <div className="lp-hero-copy">
          <p className="eyebrow lp-rise" style={{ "--d": "0ms" }}>Perpetual futures · City house-price indices · Up to 100×</p>
          <h1 className="lp-rise" style={{ "--d": "90ms" }}>Own the <em>skyline</em>,<br />not the mortgage.</h1>
          <p className="lp-lede lp-rise" style={{ "--d": "180ms" }}>Go long or short on home prices in New York, Los Angeles, Miami, San Francisco and London. Deposit USDC or USDT from a Solana wallet and trade a whole city in one click.</p>
          <div className="lp-ctas lp-rise" style={{ "--d": "270ms" }}>
            <a className="lp-cta" href="/app" onClick={go("trade")}>Enter app <span aria-hidden="true">→</span></a>
            <a className="lp-cta2 lp-practice" href="/app" onClick={(e) => { e.preventDefault(); ex?.setMode?.("practice"); enter("trade"); }}>Try it with play money</a>
            <a className="lp-cta2" href="#how">How it works</a>
          </div>
          {markets && <dl className="lp-kpis lp-rise" style={{ "--d": "360ms" }}>
            <div><dt>Total value locked</dt><dd>{compact(ex.stats.tvl)}</dd></div>
            <div><dt>24h volume</dt><dd>{compact(ex.stats.volume24h)}</dd></div>
            <div><dt>Open interest</dt><dd>{compact(ex.stats.oi)}</dd></div>
          </dl>}
        </div>
        <div className="lp-hero-sky" aria-hidden="true">
          {["LDN", "NYC", "SF", "MIA", "LA"].map((k, i) => <div key={k} className="lp-sky" style={{ "--d": 200 + i * 120 + "ms" }}><Skyline symbol={k} seed={i + 11} /></div>)}
        </div>
      </section>

      <div className="ticker lp-ticker" aria-label="Live index prices">
        <div className="ticker-in">
          {[0, 1, 2].map((r) => list.map((c) => (
            <span key={r + c.symbol}><b>{c.symbol}</b> {c.index != null ? c.index.toFixed(2) : "-"} {c.change24h != null && <i className={c.change24h >= 0 ? "up" : "dn"}>{pctS(c.change24h, 3)}</i>} {c.funding != null && <small>F {pctS(c.funding, 4)}</small>}</span>
          )))}
        </div>
      </div>

      <section className="lp-sec" id="how">
        <div className="lp-head" data-reveal><p className="eyebrow">01 · How it works</p><h2>Three steps to a <em>city</em> position.</h2></div>
        <ol className="lp-steps">
          {[
            ["Connect a Solana wallet", "Phantom, Solflare, Backpack or any wallet-standard wallet. Sign one message to prove it is yours. No seed phrases, no forms."],
            ["Deposit USDC or USDT", "Send stablecoins to your Stoxhome account. Your balance is credited once the transfer confirms on Solana."],
            ["Long or short a city, up to 100×", "Pick a market, set margin and leverage, and open. Close any time; funding nets between longs and shorts daily."],
          ].map(([t, d], k) => (
            <li key={t} data-reveal style={{ "--d": k * 110 + "ms" }}>
              <span className="lp-n">{String(k + 1).padStart(2, "0")}</span>
              <h3>{t}</h3><p>{d}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="lp-sec" id="markets">
        <div className="lp-head" data-reveal><p className="eyebrow">02 · Markets</p><h2>Five skylines. <em>One</em> account.</h2></div>
        <div className="lp-cards">
          {list.map((c, i) => (
            <a key={c.symbol} className="lp-card" href="/app#trade" onClick={go("trade")} data-reveal style={{ "--d": i * 80 + "ms" }}>
              <Skyline symbol={c.symbol} seed={i + 1} />
              <div className="lp-card-meta">
                <span className="sym">{c.symbol}</span>
                <span className="cpx">{c.index != null ? c.index.toFixed(2) : "-"}</span>
                <span className="cname">{c.city}</span>
                {c.change1y != null ? <span className={"cchg " + (c.change1y >= 0 ? "up" : "dn")}>{pctS(c.change1y, 1)} 1Y</span>
                  : c.change24h != null ? <span className={"cchg " + (c.change24h >= 0 ? "up" : "dn")}>{pctS(c.change24h, 2)} 24h</span> : <span />}
              </div>
              <span className="lp-card-go">Trade {c.symbol} →</span>
            </a>
          ))}
        </div>
      </section>

      <section className="lp-sec lp-why" id="why">
        <div className="lp-head" data-reveal><p className="eyebrow">03 · Why house prices</p><h2>The world's biggest asset, <em>finally</em> tradable.</h2></div>
        <div className="lp-why-grid">
          {[
            ["$300T+", "Global residential real estate is larger than equities and bonds combined, yet almost impossible to trade."],
            ["Slow & sticky", "Home prices move in long cycles driven by rates, wages and supply. Trends persist; perps let you ride them."],
            ["Hedge your life", "Renting in London and worried about missing out? Own a home in Miami and want protection? Take the other side."],
            ["No closing costs", "No mortgage, no stamp duty, no tenants. Pure price exposure, opened and closed in seconds."],
          ].map(([b, t], k) => <div key={b} className="lp-why-c" data-reveal style={{ "--d": k * 90 + "ms" }}><b>{b}</b><p>{t}</p></div>)}
        </div>
      </section>

      <section className="lp-sec lp-vault" id="vault" data-reveal>
        <div className="lp-vault-l">
          <p className="eyebrow">04 · Liquidity vault</p>
          <h2>Be the <em>house</em>.</h2>
          <p>Vault depositors are the counterparty to every trade. They earn trading fees, funding paid by the crowded side, and trader losses. In return, they cover trader profits.</p>
          <a className="lp-cta lp-cta-inv" href="/app#vault" onClick={go("vault")}>Open the vault →</a>
        </div>
        <dl className="lp-vault-r">
          <div><dt>Vault APR</dt><dd>{markets && ex.pool?.apr != null ? (ex.pool.apr * 100).toFixed(1) + "%" : "-"}</dd></div>
          <div><dt>Pool value</dt><dd>{markets && ex.pool ? compact(ex.pool.poolValue) : "-"}</dd></div>
          <div><dt>Utilization</dt><dd>{markets && ex.pool ? (ex.pool.utilization * 100).toFixed(0) + "%" : "-"}</dd></div>
          <div><dt>Withdrawals</dt><dd>Cooldown</dd></div>
        </dl>
      </section>

      <section className="lp-sec" id="faq">
        <div className="lp-head" data-reveal><p className="eyebrow">05 · FAQ</p><h2>Straight <em>answers</em>.</h2></div>
        <div className="lp-faq">
          {[
            ["Is Stoxhome custodial?", "Yes. Deposits are held by Stoxhome in its treasury wallet on Solana, and balances, positions and PnL are tracked by the Stoxhome exchange engine. You are trusting Stoxhome with your funds while they are on the platform."],
            ["Where do the index prices come from?", "US markets (NYC, LA, Miami, San Francisco) track the S&P Cotality Case-Shiller home price indices. London tracks the UK House Price Index (UK HPI). Indices print monthly; between prints the mark price moves with open-interest skew."],
            ["What are the risks?", "Leverage up to 100× means a ~1% move against you can liquidate your entire margin. Index prints can gap, funding can cost you every day, and as a custodial platform there is counterparty and operational risk. Only trade what you can afford to lose."],
            ["How do withdrawals work?", "Request a withdrawal from the app. Each request is reviewed and then paid out from the Stoxhome treasury wallet to your Solana address in USDC or USDT."],
            ["Why does a market go close-only?", "Opening pauses for six hours before each scheduled index print so nobody can front-run a known number. Closing and reducing are always allowed."],
          ].map(([q, a], k) => (
            <div key={q} className={"lp-q" + (open === k ? " open" : "")}>
              <button aria-expanded={open === k} onClick={() => setOpen(open === k ? -1 : k)}><span>{q}</span><i aria-hidden="true">+</i></button>
              <div className="lp-a"><p>{a}</p></div>
            </div>
          ))}
        </div>
      </section>

      <section className="lp-final" data-reveal>
        <h2>Pick a <em>city</em>. Pick a side.</h2>
        <a className="lp-cta" href="/app" onClick={go("trade")}>Enter app <span aria-hidden="true">→</span></a>
      </section>

      <footer className="lp-foot">
        <div className="brand"><span className="mark"><LogoMark size={25} /></span><span>Stox<em>home</em></span></div>
        <p><b>Risk disclosure.</b> Perpetual futures are leveraged derivatives; you can lose all of your margin quickly. Stoxhome is a custodial service: customer deposits are held in its treasury wallet <a href={`https://solscan.io/account/${TREASURY}`} target="_blank" rel="noreferrer">{TREASURY.slice(0, 4)}…{TREASURY.slice(-4)}</a>. Derivatives on real-estate indices are regulated in most jurisdictions and may not be available where you live. Index data: S&P Cotality Case-Shiller, UK HPI. Nothing here is investment advice.</p>
        <span className="lp-copy">© {new Date().getFullYear()} Stoxhome · Solana · USDC / USDT</span>
      </footer>
    </div>
  );
}
