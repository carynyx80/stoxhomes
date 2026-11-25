import { useEffect, useMemo, useState } from "react";
import qrcode from "qrcode-generator";

const usd = (v, d = 2) => (v < 0 ? "−$" : "$") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");
const when = (s) => new Date(Number(s) * 1000).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

export function QR({ value, size = 168 }) {
  const { d, n } = useMemo(() => {
    const q = qrcode(0, "M");
    q.addData(value);
    q.make();
    const n = q.getModuleCount();
    let d = "";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
    return { d, n };
  }, [value]);
  return (
    <svg className="qr" viewBox={`-2 -2 ${n + 4} ${n + 4}`} width={size} height={size} role="img" aria-label="Deposit address QR code" shapeRendering="crispEdges">
      <rect x="-2" y="-2" width={n + 4} height={n + 4} fill="#fff" />
      <path d={d} fill="#121110" />
    </svg>
  );
}

function Copy({ text }) {
  const [ok, setOk] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); } catch {
      const t = document.createElement("textarea"); t.value = text; document.body.appendChild(t); t.select();
      try { document.execCommand("copy"); } catch { /* ignore */ } t.remove();
    }
    setOk(true); setTimeout(() => setOk(false), 1600);
  };
  return <button className="mini copy" onClick={copy}>{ok ? "Copied ✓" : "Copy"}</button>;
}

const TxLink = ({ hash, explorer }) => (hash ? (explorer ? <a href={`${explorer}/tx/${hash}`} target="_blank" rel="noreferrer">{short(hash)} ↗</a> : <span>{short(hash)}</span>) : null);

// Deposit / Withdraw modal (custodial exchange balance)
export function FundsSheet({ ex, tab: tab0 = "deposit", onClose }) {
  const [tab, setTab] = useState(tab0);
  useEffect(() => { const k = (e) => e.key === "Escape" && onClose(); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  return (
    <div className="sheet-bg" onClick={onClose}>
      <div className="sheet funds" role="dialog" aria-label="Funds" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <div className="ftabs">
            <button className={tab === "deposit" ? "on" : ""} onClick={() => setTab("deposit")}>Deposit</button>
            <button className={tab === "withdraw" ? "on" : ""} onClick={() => setTab("withdraw")}>Withdraw</button>
          </div>
          <button className="x" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="fbal"><span>Available</span><b>{usd(ex.wallet.balance)}</b><small>In margin {usd(ex.wallet.margin || 0)} · Pending withdrawals {usd(ex.wallet.pendingWithdrawals || 0)}</small></div>
        {tab === "deposit" ? <Deposit ex={ex} /> : <Withdraw ex={ex} />}
        <p className="custody-note">Custodial · funds held by Stoxhome</p>
      </div>
    </div>
  );
}

function Deposit({ ex }) {
  const cfg = ex.config;
  const [amount, setAmount] = useState("100");
  const [sent, setSent] = useState(null);
  const conf = cfg.confirmations || 1;
  const deposits = ex.deposits || [];
  const tracked = sent && deposits.find((d) => d.txHash?.toLowerCase() === sent.toLowerCase());
  const send = async () => { const h = await ex.actions.depositOnChain({ amount }); if (h) setSent(h); };
  return (
    <div className="fbody">
      <div className="warnbox"><b>Only send BSC (BEP-20) USDT from this connected wallet.</b> Deposits from exchanges or other wallets can't be credited automatically.</div>
      <div className="daddr">
        <QR value={cfg.companyAddress} />
        <div>
          <span className="lbl">Deposit address · {cfg.chainId === 56 ? "BNB Smart Chain" : `chain ${cfg.chainId}`}</span>
          <code>{cfg.companyAddress}</code>
          <div className="drow"><Copy text={cfg.companyAddress} /><span className="lbl">From {ex.wallet.address} only · min {cfg.minDeposit ?? "—"} USDT · {conf} confirmations</span></div>
        </div>
      </div>
      <label className="field">
        <span>Amount <small>USDT</small></span>
        <div className="inp"><input type="number" min="0" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Deposit amount" /><b>USDT</b></div>
      </label>
      <button className="go long" disabled={!!ex.busy || !(Number(amount) > 0)} onClick={send}>{ex.busy === "depositOnChain" ? "Confirm in wallet…" : "Deposit from connected wallet"}</button>
      {sent && (
        <div className="track">
          <span className="lbl">Your deposit</span>
          {tracked?.status === "credited"
            ? <p className="up">Credited {usd(Number(tracked.amount))} to your balance ✓</p>
            : <><p>{tracked ? `${Math.min(tracked.confirmations, conf)} / ${conf} confirmations` : "Waiting for the exchange to see the transfer…"}</p>
                <div className="pend-bar dark"><i style={{ width: `${tracked ? Math.min(1, tracked.confirmations / conf) * 100 : 4}%` }} /></div></>}
          <TxLink hash={sent} explorer={ex.explorer} />
        </div>
      )}
      {deposits.length > 0 && (
        <ul className="flist">
          {deposits.slice(0, 5).map((d) => (
            <li key={d.txHash}><span>{when(d.at)}</span><b>{usd(Number(d.amount))}</b><em className={d.status === "credited" ? "up" : ""}>{d.status === "credited" ? "Credited" : `${d.confirmations}/${conf} conf.`}</em><TxLink hash={d.txHash} explorer={ex.explorer} /></li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Withdraw({ ex }) {
  const cfg = ex.config;
  const [amount, setAmount] = useState("");
  const v = Number(amount) || 0, avail = ex.wallet.balance;
  const tooMuch = v > avail, tooSmall = v > 0 && cfg.minWithdraw && v < Number(cfg.minWithdraw);
  const list = ex.withdrawals || [];
  return (
    <div className="fbody">
      <label className="field">
        <span>Amount <small>max {usd(avail)}</small></span>
        <div className="inp"><input type="number" min="0" inputMode="decimal" value={amount} placeholder="0" onChange={(e) => setAmount(e.target.value)} aria-label="Withdraw amount" /><button type="button" className="mini maxb" onClick={() => setAmount(String(Math.floor(avail * 100) / 100))}>Max</button></div>
      </label>
      <div className="dest"><span className="lbl">Destination (your connected wallet)</span><code>{ex.wallet.full}</code></div>
      {tooMuch && <p className="ferr">That's more than your available balance.</p>}
      {tooSmall && <p className="ferr">Minimum withdrawal is {cfg.minWithdraw} USDT.</p>}
      <button className="go long" disabled={!!ex.busy || !(v > 0) || tooMuch || tooSmall} onClick={async () => { if (await ex.actions.requestPayout({ amount })) setAmount(""); }}>{ex.busy === "payout" ? "Submitting…" : "Request withdrawal"}</button>
      <p className="sheet-note">Withdrawals are reviewed and paid from the Stoxhome treasury, usually within 24h.</p>
      {list.length > 0 && (
        <ul className="flist">
          {list.slice(0, 8).map((w) => (
            <li key={w.id}>
              <span>{when(w.at)}</span><b>{usd(Number(w.amount))}</b>
              <em className={w.status === "paid" ? "up" : w.status === "rejected" ? "dn" : ""}>{w.status}</em>
              {w.status === "pending" ? <button className="mini" disabled={!!ex.busy} onClick={() => ex.actions.cancelPayout({ id: w.id })}>Cancel</button> : <TxLink hash={w.txHash} explorer={ex.explorer} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
