import { useEffect, useState } from "react";
import { INSTALL, deepLinks, isMobile, targetChainName } from "../data/wallet.js";

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
          <span className="t-ico">{t.kind === "pending" ? <i className="spin" /> : t.kind === "ok" ? "✓" : t.kind === "info" ? "i" : "!"}</span>
          <div>
            <p>{t.text}</p>
            {t.hash && (explorer ? <a href={`${explorer}/tx/${t.hash}`} target="_blank" rel="noreferrer">{t.hash.slice(0, 10)}…</a> : <small>{t.hash.slice(0, 10)}…{t.hash.slice(-6)}</small>)}
          </div>
        </div>
      ))}
    </div>
  );
}

// Wallet picker: EIP-6963 wallets with icons, install links on desktop, deep links on mobile.
export function WalletPicker({ wc }) {
  const [list, setList] = useState(!wc.connected);
  useEffect(() => { const k = (e) => e.key === "Escape" && wc.closePicker(); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [wc]);
  const busy = wc.pending === "connect";
  const none = wc.wallets.length === 0;
  const mobile = isMobile();
  return (
    <div className="sheet-bg" onClick={wc.closePicker}>
      <div className="sheet wpick" role="dialog" aria-label="Connect a wallet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head"><h3>{wc.connected && !list ? "Wallet" : "Connect a wallet"}</h3><button className="x" onClick={wc.closePicker} aria-label="Close">×</button></div>
        {wc.connected && !list && (
          <>
            <div className="wacct">
              <WIcon w={wc.entry} />
              <div><b>{wc.entry.name}</b><small>{wc.account}</small></div>
            </div>
            {wc.wrongChain && <button className="go switch" disabled={wc.pending === "switch"} onClick={wc.switchChain}>{wc.pending === "switch" ? "Confirm in wallet…" : `Switch to ${targetChainName()}`}</button>}
            <div className="wrow"><button className="ghost" onClick={() => setList(true)}>Change wallet</button><button className="ghost" onClick={wc.disconnect}>Disconnect</button></div>
          </>
        )}
        {list && !none && (
          <ul className="wlist">
            {wc.wallets.map((w) => (
              <li key={w.id}>
                <button disabled={busy} onClick={() => wc.connect(w)}>
                  <WIcon w={w} /><span>{w.name}</span><em>{busy ? "…" : wc.entry?.id === w.id && wc.connected ? "Connected" : "Detected"}</em>
                </button>
              </li>
            ))}
          </ul>
        )}
        {list && none && !mobile && (
          <>
            <p className="sheet-note">No browser wallet detected. Install one, then reload this page.</p>
            <ul className="wlist">{INSTALL.map((w) => <li key={w.name}><a href={w.url} target="_blank" rel="noreferrer"><WIcon w={w} /><span>{w.name}</span><em>Install ↗</em></a></li>)}</ul>
          </>
        )}
        {list && none && mobile && (
          <>
            <p className="sheet-note">Open Stoxhome inside your wallet app's browser to connect.</p>
            <ul className="wlist">{deepLinks().map((w) => <li key={w.name}><a href={w.url}><WIcon w={w} /><span>Open in {w.name}</span><em>↗</em></a></li>)}</ul>
          </>
        )}
        {busy && <p className="sheet-note">Approve the connection in your wallet…</p>}
      </div>
    </div>
  );
}

function WIcon({ w }) {
  if (w?.icon) return <img className="wicon" src={w.icon} alt="" width="28" height="28" />;
  return <span className="wicon mono" aria-hidden="true">{(w?.name || "?").replace(/ wallet/i, "").slice(0, 2)}</span>;
}
