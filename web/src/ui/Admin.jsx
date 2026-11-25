import { useCallback, useEffect, useState } from "react";

const usd = (v, d = 2) => (v < 0 ? "−$" : "$") + Math.abs(Number(v) || 0).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");
const when = (s) => new Date(Number(s) * 1000).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

export default function AdminPage({ ex }) {
  const [ov, setOv] = useState(null);
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState(null);
  const [rejecting, setRejecting] = useState(null);
  const [reason, setReason] = useState("");
  const load = useCallback(async () => {
    if (!ex.isAdmin) return;
    try {
      const [o, w] = await Promise.all([ex.admin.call("/admin/overview"), ex.admin.call("/admin/withdrawals?status=pending")]);
      setOv(o); setRows(Array.isArray(w) ? w : w.withdrawals || []); setErr(null);
    } catch (e) { setErr(e.message); }
  }, [ex.isAdmin, ex.session?.token]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); const h = setInterval(load, 6000); return () => clearInterval(h); }, [load]);

  const run = async (label, fn) => {
    try { await fn(); ex.notify?.({ kind: "ok", text: label + " — done" }); } catch (e) { ex.notify?.({ kind: "err", text: label + ": " + e.message }); }
    load(); ex.reload();
  };

  if (!ex.wallet.connected || !ex.isAdmin) {
    return (
      <section className="panel admin-gate">
        <h2>Admin</h2>
        <p>{!ex.wallet.connected ? "Connect the Stoxhome company wallet to continue." : !ex.session ? "Sign in with the company wallet to continue." : "This wallet is not the Stoxhome company wallet."}</p>
        {!ex.wallet.connected ? <button className="go long" onClick={() => ex.actions.connect()}>Connect wallet</button>
          : !ex.session ? <button className="go long" disabled={ex.signing} onClick={() => ex.actions.signIn()}>{ex.signing ? "Check your wallet…" : "Sign in"}</button> : null}
      </section>
    );
  }

  const surplus = Number(ov?.surplus ?? 0);
  const L = ov?.liabilities || {};
  const markets = ex.markets;
  return (
    <div className="admin">
      {err && <div className="errbar">{err}</div>}
      <section className="panel ov">
        <div className="sec-head"><h3>Treasury</h3><span className="sub">Company wallet {short(ex.config.companyAddress)}</span></div>
        <div className="ov-grid">
          <div className="fact"><span>USDT on chain</span><b>{usd(ov?.companyUsdtOnChain)}</b></div>
          <div className="fact"><span>Liabilities · users</span><b>{usd(L.users)}</b></div>
          <div className="fact"><span>Liabilities · vault</span><b>{usd(L.vault)}</b></div>
          <div className="fact"><span>Protocol fees</span><b>{usd(L.protocolFees)}</b></div>
          <div className={"fact surplus " + (surplus < 0 ? "neg" : "pos")}><span>Surplus</span><b>{usd(surplus)}</b></div>
          <div className="fact"><span>Pending withdrawals</span><b>{ov?.pendingWithdrawals?.count ?? 0} · {usd(ov?.pendingWithdrawals?.amount)}</b></div>
        </div>
      </section>

      <section className="panel">
        <div className="sec-head"><h3>Pending withdrawals</h3><span className="count">{rows.length}</span></div>
        {rows.length === 0 ? <div className="empty"><b>Nothing to pay.</b><span>New requests appear here.</span></div> : (
          <div className="tbl awd">
            <div className="tr th"><span>Requested</span><span>User / destination</span><span>Amount</span><span /></div>
            {rows.map((w) => (
              <div className="tr" key={w.id}>
                <span data-k="Requested">{when(w.at)}</span>
                <span data-k="Destination"><code title={w.to}>{short(w.to)}</code></span>
                <span data-k="Amount"><b>{usd(Number(w.amount))}</b></span>
                <span className="acts">
                  {rejecting === w.id ? (
                    <>
                      <input className="reason" placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reject reason" />
                      <button className="mini" disabled={!reason.trim()} onClick={() => run("Reject", () => ex.admin.call(`/admin/withdrawals/${w.id}/reject`, { method: "POST", body: { reason } })).then(() => { setRejecting(null); setReason(""); })}>Confirm reject</button>
                      <button className="mini" onClick={() => setRejecting(null)}>Back</button>
                    </>
                  ) : (
                    <>
                      <button className="mini" onClick={() => { setRejecting(w.id); setReason(""); }}>Reject</button>
                      <button className="ghost" disabled={!!ex.busy} onClick={async () => { await ex.admin.pay(w); load(); ex.reload(); }}>{ex.busy === "pay:" + w.id ? "Paying…" : "Pay"}</button>
                    </>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="admin-forms">
        <Form title="Post index print" fields={[["symbol", "select", markets.map((m) => m.symbol)], ["value", "number"], ["source", "text", "e.g. S&P CoreLogic Case-Shiller, Oct"]]}
          onSubmit={(v) => run(`Index print ${v.symbol}`, () => ex.admin.call("/admin/index", { method: "POST", body: { symbol: v.symbol, value: String(v.value), source: v.source } }))}
          note="Smoothed over 7 days; prints that move more than 10% are rejected." />
        <Form title="Schedule print" fields={[["symbol", "select", markets.map((m) => m.symbol)], ["at", "datetime-local"]]}
          onSubmit={(v) => run(`Schedule ${v.symbol}`, () => ex.admin.call("/admin/schedule-print", { method: "POST", body: { symbol: v.symbol, at: Math.floor(new Date(v.at).getTime() / 1000) } }))}
          note="The market goes close-only 6h before." />
        <section className="panel aform">
          <div className="sec-head"><h3>Markets</h3></div>
          <ul className="mkt-toggle">
            {markets.map((m) => (
              <li key={m.id}><b>{m.symbol}</b><span className={m.active ? "up" : "dn"}>{m.active ? "Active" : "Paused"}</span>
                <button className="mini" onClick={() => run(`${m.active ? "Pause" : "Resume"} ${m.symbol}`, () => ex.admin.call(`/admin/markets/${m.id}`, { method: "POST", body: { active: !m.active } }))}>{m.active ? "Pause" : "Resume"}</button></li>
            ))}
          </ul>
        </section>
        <Form title="Seed vault" fields={[["amount", "number"]]} onSubmit={(v) => run("Seed vault", () => ex.admin.call("/admin/vault/seed", { method: "POST", body: { amount: String(v.amount) } }))}
          note="Moves company capital (from company equity) into the vault." />
      </div>
    </div>
  );
}

function Form({ title, fields, onSubmit, note }) {
  const [v, setV] = useState(() => Object.fromEntries(fields.map(([k, t, o]) => [k, t === "select" ? o[0] : ""])));
  const [busy, setBusy] = useState(false);
  const submit = async (e) => { e.preventDefault(); setBusy(true); try { await onSubmit(v); } finally { setBusy(false); } };
  return (
    <form className="panel aform" onSubmit={submit}>
      <div className="sec-head"><h3>{title}</h3></div>
      <div className="aform-body">
        {fields.map(([k, t, o]) => (
          <label key={k} className="afield"><span>{k}</span>
            {t === "select"
              ? <select value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })}>{o.map((x) => <option key={x}>{x}</option>)}</select>
              : <input type={t} step="any" required={k !== "source"} placeholder={typeof o === "string" ? o : ""} value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} />}
          </label>
        ))}
        {note && <p className="sheet-note">{note}</p>}
        <button className="ghost" disabled={busy}>{busy ? "Working…" : "Submit"}</button>
      </div>
    </form>
  );
}
