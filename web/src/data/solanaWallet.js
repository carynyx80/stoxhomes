// Solana wallet layer: Wallet Standard discovery (+ legacy Phantom / Solflare / Backpack injections),
// silent reconnect, live account changes, friendly errors and mobile deep links.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getWallets } from "@wallet-standard/app";
import bs58 from "bs58";

const STORE_KEY = "stoxhome.solwallet";
const store = {
  get() { try { return localStorage.getItem(STORE_KEY); } catch { return null; } },
  set(v) { try { v ? localStorage.setItem(STORE_KEY, v) : localStorage.removeItem(STORE_KEY); } catch { /* storage blocked */ } },
};

export const SOL_INSTALL = [
  { name: "Phantom", url: "https://phantom.com/download" },
  { name: "Solflare", url: "https://solflare.com/download" },
  { name: "Backpack", url: "https://backpack.app/download" },
  { name: "OKX Wallet", url: "https://www.okx.com/web3" },
  { name: "Trust Wallet", url: "https://trustwallet.com/download" },
  { name: "Coinbase Wallet", url: "https://www.coinbase.com/wallet/downloads" },
  { name: "Bitget Wallet", url: "https://web3.bitget.com/en/wallet-download" },
];
export function solDeepLinks(href = window.location.href) {
  const u = encodeURIComponent(href), ref = encodeURIComponent(window.location.origin);
  return [
    { name: "Phantom", url: `https://phantom.app/ul/browse/${u}?ref=${ref}` },
    { name: "Solflare", url: `https://solflare.com/ul/v1/browse/${u}?ref=${ref}` },
    { name: "Backpack", url: `https://backpack.app/ul/v1/browse/${u}?ref=${ref}` },
  ];
}
export const isMobile = () => /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "");

// ---- errors ----
const msgOf = (e) => String(e?.message || e?.error?.message || e || "");
const codeOf = (e) => e?.code ?? e?.error?.code;
export const isRejected = (e) => codeOf(e) === 4001 || /reject|denied|cancel|declined|closed the modal/i.test(msgOf(e)) || e?.name === "WalletSignMessageError" && /reject/i.test(msgOf(e));
export function walletError(e) {
  if (isRejected(e)) return { quiet: true, text: "Request cancelled" };
  if (codeOf(e) === -32002 || /already pending|pending request/i.test(msgOf(e))) return { quiet: false, text: "Open your wallet to finish the pending request" };
  if (/locked|unlock/i.test(msgOf(e))) return { quiet: false, text: "Your wallet is locked. Unlock it and try again." };
  if (/cluster|network mismatch|wrong network|devnet|testnet/i.test(msgOf(e))) return { quiet: false, text: "Your wallet is on the wrong Solana network. Switch it to Mainnet and try again." };
  return null;
}

// ---- output normalisation (wallets differ: arrays vs objects, Uint8Array vs number[] vs base58) ----
const first = (r) => (Array.isArray(r) ? r[0] : r);
export function toBytes(x) {
  if (!x) throw new Error("Wallet returned no signature");
  if (x instanceof Uint8Array) return x;
  if (typeof x === "string") return bs58.decode(x);
  if (Array.isArray(x) || ArrayBuffer.isView(x)) return Uint8Array.from(x);
  if (x.data && Array.isArray(x.data)) return Uint8Array.from(x.data); // Buffer JSON shape
  if (typeof x === "object" && Object.keys(x).every((k) => /^\d+$/.test(k))) return Uint8Array.from(Object.values(x));
  throw new Error("Unrecognised signature format from wallet");
}
const sigString = (x) => (typeof x === "string" ? x : bs58.encode(toBytes(x)));
const CONNECT_TIMEOUT_MS = 60_000;

// ---- adapters (one interface for Wallet Standard and legacy injected providers) ----
function standardAdapter(w) {
  const f = w.features || {};
  let account = null;
  return {
    id: "std:" + w.name, name: w.name, icon: w.icon || null, kind: "standard", raw: w,
    // NOTE: not async on purpose — standard:connect is invoked synchronously inside the click handler,
    // otherwise some browsers/wallets drop the popup (user-activation is lost after an await).
    connect(silent) {
      if (!f["standard:connect"]) return Promise.reject(new Error("This wallet can't connect"));
      return f["standard:connect"].connect(silent ? { silent: true } : undefined).then((r) => {
        account = (r?.accounts?.length ? r.accounts : w.accounts || [])[0] || null;
        return account?.address || null;
      });
    },
    async disconnect() { try { await f["standard:disconnect"]?.disconnect(); } catch { /* ignore */ } account = null; },
    onChange(cb) {
      if (!f["standard:events"]) return () => {};
      return f["standard:events"].on("change", (p) => { if (p.accounts) { account = p.accounts[0] || null; cb(account?.address || null); } });
    },
    chains: () => account?.chains || w.chains || [],
    async signMessage(bytes) {
      if (!f["solana:signMessage"]) throw new Error("This wallet can't sign messages. Try Phantom, Solflare or Backpack.");
      account = account || (w.accounts || [])[0];
      const out = first(await f["solana:signMessage"].signMessage({ account, message: bytes }));
      return toBytes(out?.signature ?? out);
    },
    canSignAndSend: () => !!f["solana:signAndSendTransaction"],
    async signAndSend(txBytes, chain) {
      account = account || (w.accounts || [])[0];
      const out = first(await f["solana:signAndSendTransaction"].signAndSendTransaction({ account, chain, transaction: txBytes, options: { commitment: "confirmed", preflightCommitment: "confirmed" } }));
      return sigString(out?.signature ?? out);
    },
    async signTransaction(txBytes, chain) {
      if (!f["solana:signTransaction"]) throw new Error("This wallet can't sign transactions");
      account = account || (w.accounts || [])[0];
      const out = first(await f["solana:signTransaction"].signTransaction({ account, chain, transaction: txBytes }));
      return toBytes(out?.signedTransaction ?? out);
    },
  };
}
function legacyAdapter(name, p) {
  return {
    id: "legacy:" + name, name, icon: p.icon || null, kind: "legacy", raw: p,
    connect(silent) { // synchronous call into the provider (see note above)
      return Promise.resolve(p.connect(silent ? { onlyIfTrusted: true } : undefined)).then((r) => (r?.publicKey || p.publicKey)?.toString() || null);
    },
    async disconnect() { try { await p.disconnect(); } catch { /* ignore */ } },
    onChange(cb) {
      const a = (pk) => cb(pk ? pk.toString() : null), d = () => cb(null);
      p.on?.("accountChanged", a); p.on?.("disconnect", d);
      return () => { (p.off || p.removeListener)?.call(p, "accountChanged", a); (p.off || p.removeListener)?.call(p, "disconnect", d); };
    },
    chains: () => [],
    async signMessage(bytes) { const r = await p.signMessage(bytes, "utf8"); return toBytes(r?.signature ?? r); },
    canSignAndSend: () => false, // legacy providers need web3.js Transaction objects; we sign bytes and submit via the engine
    async signTransaction(txBytes) {
      const { VersionedTransaction, Transaction } = await import("@solana/web3.js");
      let tx; try { tx = Transaction.from(txBytes); } catch { tx = VersionedTransaction.deserialize(txBytes); }
      const signed = await p.signTransaction(tx);
      return signed.serialize();
    },
  };
}

function useSolanaDiscovery() {
  const [list, setList] = useState([]);
  const [detecting, setDetecting] = useState(true);
  useEffect(() => {
    let api; try { api = getWallets(); } catch { api = null; }
    const build = () => {
      const std = (api?.get() || []).filter((w) => w.features?.["standard:connect"] && (w.chains || []).some((c) => c.startsWith("solana:")));
      const out = std.map(standardAdapter);
      const have = new Set(out.map((w) => w.name.toLowerCase()));
      const legacy = [
        ["Phantom", window.phantom?.solana?.isPhantom ? window.phantom.solana : null],
        ["Solflare", window.solflare?.isSolflare ? window.solflare : null],
        ["Backpack", window.backpack?.isBackpack || window.backpack?.connect ? window.backpack : null],
      ];
      // Phantom/Solflare/Backpack in-app browsers inject the legacy object AND register a standard wallet: list once.
      for (const [name, p] of legacy) if (p && ![...have].some((n) => n.startsWith(name.toLowerCase()))) out.push(legacyAdapter(name, p));
      setList(out);
      if (out.length) setDetecting(false);
    };
    build();
    const offs = api ? [api.on("register", build), api.on("unregister", build)] : [];
    // wallets may register (or inject window.phantom) well after load: keep rebuilding for a few seconds
    const timers = [300, 700, 1500, 3000].map((ms) => setTimeout(build, ms));
    const done = setTimeout(() => setDetecting(false), 3200);
    return () => { timers.forEach(clearTimeout); clearTimeout(done); offs.forEach((o) => o?.()); };
  }, []);
  return { list, detecting };
}

/** Same surface as the EVM useWallet: wallets, entry, account, connected, pending, picker, connect, disconnect. */
export function useSolanaWallet(notify, { chain = "solana:mainnet" } = {}) {
  const { list: wallets, detecting } = useSolanaDiscovery();
  const [entry, setEntry] = useState(null);
  const [account, setAccount] = useState(null);
  const [pending, setPending] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const inflight = useRef(false);
  const tried = useRef(false);
  const nref = useRef(notify); nref.current = notify;
  const say = (kind, text) => nref.current?.({ kind, text });
  const report = (e, fallback) => { const w = walletError(e); say(w?.quiet ? "info" : "err", w ? w.text : fallback); };

  // silent reconnect (no popup): standard:connect {silent:true} / Phantom onlyIfTrusted
  useEffect(() => {
    if (tried.current || entry) return;
    const saved = store.get();
    if (!saved) { tried.current = true; return; }
    const w = wallets.find((x) => x.id === saved);
    if (!w) return;
    tried.current = true;
    (async () => {
      try { const a = await w.connect(true); if (a) { setEntry(w); setAccount(a); } } catch { /* stay disconnected */ }
    })();
  }, [wallets, entry]);
  useEffect(() => { const t = setTimeout(() => { tried.current = true; }, 3000); return () => clearTimeout(t); }, []);

  // live account changes
  useEffect(() => {
    if (!entry) return;
    return entry.onChange((a) => {
      if (a) setAccount(a);
      else { setAccount(null); setEntry(null); store.set(null); say("info", "Wallet disconnected"); }
    });
  }, [entry]);

  const connect = useCallback(async (w) => {
    if (inflight.current) { say("info", "Open your wallet to finish the pending request"); return false; }
    inflight.current = true; setPending("connect");
    let timer;
    try {
      const call = w.connect(false); // invoked synchronously in the click handler — keeps the popup alive
      const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${w.name} didn't respond. Open the extension (it may be locked) and try again.`)), CONNECT_TIMEOUT_MS); });
      const a = await Promise.race([call, timeout]);
      if (!a) throw Object.assign(new Error("User rejected the request."), { code: 4001 });
      const chains = w.chains();
      if (chains.length && !chains.includes(chain)) say("err", "Your wallet is on the wrong Solana network. Switch it to Mainnet.");
      setEntry(w); setAccount(a); store.set(w.id); setPickerOpen(false);
      say("ok", `Connected ${w.name}`);
      return true;
    } catch (e) { report(e, /didn't respond/.test(e?.message || "") ? e.message : `Could not connect to ${w.name}.`); return false; }
    finally { clearTimeout(timer); inflight.current = false; setPending(null); }
  }, [chain]);

  const disconnect = useCallback(async () => {
    const w = entry; setEntry(null); setAccount(null); store.set(null); setPickerOpen(false);
    await w?.disconnect();
  }, [entry]);

  return useMemo(() => ({
    kind: "solana", chain, wallets, detecting, evmOnly: wallets.length === 0 && typeof window !== "undefined" && !!window.ethereum, entry, account, pending, pickerOpen, chainId: null,
    connected: !!(entry && account), wrongChain: false,
    openPicker: () => setPickerOpen(true), closePicker: () => setPickerOpen(false),
    connect, disconnect, switchChain: async () => true,
  }), [chain, wallets, detecting, entry, account, pending, pickerOpen, connect, disconnect]);
}
