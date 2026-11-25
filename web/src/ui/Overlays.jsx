import { useEffect, useState } from "react";

const usd = (v, d = 2) => (v < 0 ? "−$" : "$") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

// Action sheet for Increase / Reduce / Add margin / Deposit / Request withdraw.
export function Sheet({ sheet, ex, onClose }) {
  const { type, pos } = sheet;
  const m = pos ? ex.markets.find((x) => x.id === pos.marketId) : null;
  const [val, setVal] = useState(() => (type === "requestWithdraw" ? "100" : type === "deposit" ? "1000" : type === "addMargin" ? "100" : pos ? String(+(pos.size * 0.25).toFixed(2)) : ""));
  const v = Math.max(0, Number(val) || 0);
  useEffect(() => { const k = (e) => e.key === "Escape" && onClose(); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);

  const fee = ex.params.tradingFeeBps / 10_000;
  // Increase keeps leverage at most at the current level: top up margin for the added notional + fee.
  const lev = pos ? Math.max(1, (pos.size * pos.indexPrice) / Math.max(pos.margin, 1e-9)) : 1;
  const addNotional = pos ? v * (m?.mark ?? pos.indexPrice) : 0;
  const extra = type === "increase" ? Math.ceil((addNotional / Math.min(lev, 95) + addNotional * fee) * 1.02 * 100) / 100 : 0;

  const cfg = {
    increase: { title: `Increase ${pos?.market}`, unit: "units", chips: [0.1, 0.25, 0.5, 1].map((f) => [`${f * 100}%`, +((pos?.size ?? 0) * f).toFixed(2)]),
      rows: [["Added notional", usd(addNotional)], ["Margin top-up", usd(extra)], ["Fee 0.05%", usd(addNotional * fee)]],
      cta: "Increase", run: () => ex.actions.increase({ marketId: pos.marketId, units: val, extraMargin: extra.toFixed(2) }) },
    reduce: { title: `Reduce ${pos?.market}`, unit: "units", chips: [0.25, 0.5, 0.75].map((f) => [`${f * 100}%`, +((pos?.size ?? 0) * f).toFixed(4)]),
      rows: [["Remaining size", `${Math.max(0, pos?.size - v).toFixed(2)} u`], ["Est. realised", usd(pos ? (pos.pnl * Math.min(v, pos.size)) / pos.size : 0)]],
      note: "Reducing the full size closes the position. Flipping through zero is not allowed.",
      cta: "Reduce", run: () => ex.actions.reduce({ marketId: pos.marketId, units: val }) },
    addMargin: { title: `Add margin · ${pos?.market}`, unit: "USDT", chips: [100, 500, 1000].map((x) => [usd(x, 0), x]),
      rows: [["New margin", usd((pos?.margin ?? 0) + v)], ["New leverage", `${pos ? ((pos.size * pos.indexPrice) / (pos.margin + v)).toFixed(1) : "—"}×`]],
      cta: "Add margin", run: () => ex.actions.addMargin({ marketId: pos.marketId, amount: val }) },
    deposit: { title: "Deposit to vault", unit: "USDT", chips: [1000, 5000, 10000].map((x) => [usd(x, 0), x]),
      rows: [["Wallet balance", usd(ex.wallet.balance)], ["Est. shares", (v / ex.pool.sharePrice).toLocaleString(undefined, { maximumFractionDigits: 2 })], ["Share price", "$" + ex.pool.sharePrice.toFixed(4)]],
      note: `Withdrawals need a request and a ${Math.round(ex.params.withdrawCooldown / 3600)}h cooldown.`,
      cta: "Deposit", run: () => ex.actions.deposit({ amount: val }) },
    requestWithdraw: { title: "Request withdrawal", unit: "% of shares", chips: [25, 50, 100].map((x) => [`${x}%`, x]),
      rows: [["Shares", ((ex.pool.shares * Math.min(v, 100)) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })], ["≈ Value now", usd((ex.pool.shares * Math.min(v, 100) / 100) * ex.pool.sharePrice)]],
      note: `Shares are escrowed and stay exposed to pool PnL. Withdraw after ${Math.round(ex.params.withdrawCooldown / 3600)}h; you pay out the lower of the value at request and at withdrawal.`,
      cta: "Start cooldown", run: () => ex.actions.requestWithdraw({ pct: Math.min(100, v) }) },
  }[type];

  const go = async () => { const ok = await cfg.run(); if (ok !== false) onClose(); };
  return (
    <div className="sheet-bg" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label={cfg.title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head"><h3>{cfg.title}</h3><button className="x" onClick={onClose} aria-label="Close">×</button></div>
        <label className="field">
          <span>Amount <small>{cfg.unit}</small></span>
          <div className="inp"><input autoFocus type="number" min="0" inputMode="decimal" value={val} onChange={(e) => setVal(e.target.value)} /><b>{cfg.unit}</b></div>
        </label>
        <div className="chips">{cfg.chips.map(([l, x]) => <button key={l} className={Number(val) === x ? "on" : ""} onClick={() => setVal(String(x))}>{l}</button>)}</div>
        <dl className="sheet-sum">{cfg.rows.map(([k, x]) => <div key={k}><dt>{k}</dt><dd>{x}</dd></div>)}</dl>
        {cfg.note && <p className="sheet-note">{cfg.note}</p>}
        <button className="go long" disabled={!!ex.busy || v <= 0} onClick={go}>{ex.busy ? "Waiting for wallet…" : cfg.cta}</button>
      </div>
    </div>
  );
}

export function Toasts({ toasts, dismiss, explorer }) {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={"toast " + t.kind} onClick={() => dismiss(t.id)}>
          <span className="t-ico">{t.kind === "pending" ? <i className="spin" /> : t.kind === "ok" ? "✓" : "!"}</span>
          <div>
            <p>{t.text}</p>
            {t.hash && (explorer ? <a href={`${explorer}/tx/${t.hash}`} target="_blank" rel="noreferrer">{t.hash.slice(0, 10)}…</a> : <small>{t.hash.slice(0, 10)}…{t.hash.slice(-6)}</small>)}
          </div>
        </div>
      ))}
    </div>
  );
}
