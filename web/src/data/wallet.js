// Wallet connection: EIP-6963 discovery + legacy window.ethereum(.providers), silent reconnect,
// chain switching/adding, account/chain listeners and friendly wallet errors.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ethers } from "ethers";
import { chain } from "../chain.js";

const STORE_KEY = "housedex.wallet";
const store = {
  get() { try { return localStorage.getItem(STORE_KEY); } catch { return null; } },
  set(v) { try { v ? localStorage.setItem(STORE_KEY, v) : localStorage.removeItem(STORE_KEY); } catch { /* storage blocked */ } },
};

// ---- chain params for wallet_addEthereumChain ----
export function chainParams(id = chain.id) {
  const hex = "0x" + Number(id).toString(16);
  if (id === 56) return { chainId: hex, chainName: "BNB Smart Chain", nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 }, rpcUrls: ["https://bsc-dataseed.bnbchain.org"], blockExplorerUrls: ["https://bscscan.com"] };
  if (id === 97) return { chainId: hex, chainName: "BNB Smart Chain Testnet", nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 }, rpcUrls: ["https://data-seed-prebsc-1-s1.bnbchain.org:8545"], blockExplorerUrls: ["https://testnet.bscscan.com"] };
  if (id === 31337) return { chainId: hex, chainName: "Hardhat local", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: [chain.rpc || "http://127.0.0.1:8545"] };
  const p = { chainId: hex, chainName: chain.name || "HouseDEX Demo", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: [chain.rpc] };
  if (chain.explorer) p.blockExplorerUrls = [chain.explorer];
  return p;
}
export const targetChainName = () => chainParams().chainName;
export const nativeSymbol = () => chainParams().nativeCurrency.symbol;

// ---- error helpers ----
export function errCode(e) {
  return e?.code ?? e?.error?.code ?? e?.data?.originalError?.code ?? e?.info?.error?.code ?? e?.data?.code;
}
const codes = (e) => [e?.code, e?.error?.code, e?.data?.originalError?.code, e?.info?.error?.code, e?.data?.code];
export const isRejected = (e) => codes(e).some((c) => c === 4001 || c === "ACTION_REJECTED") || /user (rejected|denied|cancel)/i.test(e?.message || "");
export const isPending = (e) => codes(e).some((c) => c === -32002) || /already pending/i.test(e?.message || "");
const isUnknownChain = (e) => codes(e).some((c) => c === 4902) || /unrecognized chain|not been added|unknown chain/i.test(e?.message || "");

/** Returns { quiet, text } for wallet errors, or null if it isn't a wallet-level error. */
export function walletError(e) {
  if (isRejected(e)) return { quiet: true, text: "Request cancelled" };
  if (isPending(e)) return { quiet: false, text: "Open your wallet to finish the pending request" };
  return null;
}

// ---- discovery ----
const LEGACY_NAMES = [
  ["isOkxWallet", "OKX Wallet"], ["isOKExWallet", "OKX Wallet"], ["isTrust", "Trust Wallet"], ["isTrustWallet", "Trust Wallet"],
  ["isBinance", "Binance Wallet"], ["isRabby", "Rabby"], ["isCoinbaseWallet", "Coinbase Wallet"], ["isMetaMask", "MetaMask"],
];
const legacyName = (p) => (LEGACY_NAMES.find(([k]) => p?.[k]) || [null, "Browser wallet"])[1];

export const INSTALL = [
  { name: "MetaMask", url: "https://metamask.io/download/" },
  { name: "Trust Wallet", url: "https://trustwallet.com/download" },
  { name: "OKX Wallet", url: "https://www.okx.com/web3" },
  { name: "Binance Wallet", url: "https://www.binance.com/en/web3wallet" },
  { name: "Rabby", url: "https://rabby.io/" },
  { name: "Coinbase Wallet", url: "https://www.coinbase.com/wallet/downloads" },
];

export function deepLinks(href = window.location.href) {
  const u = new URL(href), hostPath = u.host + u.pathname + u.search, enc = encodeURIComponent(href);
  return [
    { name: "MetaMask", url: `https://metamask.app.link/dapp/${hostPath}` },
    { name: "Trust Wallet", url: `https://link.trustwallet.com/open_url?coin_id=20000714&url=${enc}` },
    { name: "OKX Wallet", url: `okx://wallet/dapp/url?dappUrl=${enc}` },
  ];
}
export const isMobile = () => /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "");

function useDiscovery() {
  const [list, setList] = useState([]);
  useEffect(() => {
    const announced = new Map();
    const rebuild = () => {
      const out = [...announced.values()];
      const known = new Set(out.map((w) => w.provider));
      const eth = window.ethereum;
      const legacy = eth ? (Array.isArray(eth.providers) && eth.providers.length ? eth.providers : [eth]) : [];
      legacy.forEach((p, i) => {
        if (!p || known.has(p)) return;
        const name = legacyName(p);
        if (out.some((w) => w.name === name)) return; // same wallet already announced via EIP-6963
        out.push({ id: "injected:" + name + (legacy.length > 1 ? ":" + i : ""), name, icon: null, rdns: null, provider: p });
        known.add(p);
      });
      setList(out);
    };
    const onAnnounce = (ev) => {
      const d = ev?.detail;
      if (!d?.info?.uuid || !d.provider) return;
      announced.set(d.info.uuid, { id: d.info.rdns || d.info.uuid, name: d.info.name || "Wallet", icon: d.info.icon || null, rdns: d.info.rdns || null, provider: d.provider });
      rebuild();
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    rebuild();
    // Some wallets inject window.ethereum late.
    const late = setTimeout(rebuild, 600);
    window.addEventListener("ethereum#initialized", rebuild, { once: true });
    return () => { clearTimeout(late); window.removeEventListener("eip6963:announceProvider", onAnnounce); window.removeEventListener("ethereum#initialized", rebuild); };
  }, []);
  return list;
}

const toChainId = (x) => (typeof x === "string" ? parseInt(x, x.startsWith("0x") ? 16 : 10) : Number(x));

/** notify({kind, text}) shows a toast. */
export function useWallet(notify) {
  const wallets = useDiscovery();
  const [entry, setEntry] = useState(null);
  const [account, setAccount] = useState(null);
  const [chainId, setChainId] = useState(null);
  const [pending, setPending] = useState(null); // "connect" | "switch" | null
  const [pickerOpen, setPickerOpen] = useState(false);
  const inflight = useRef(null); // the one eth_requestAccounts promise
  const tried = useRef(false);
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const say = (kind, text) => notifyRef.current?.({ kind, text });

  const report = useCallback((e, fallback) => {
    const w = walletError(e);
    if (w) say(w.quiet ? "info" : "err", w.text);
    else say("err", fallback || "Wallet error. Please try again.");
  }, []);

  // silent reconnect: eth_accounts only, never a popup
  useEffect(() => {
    if (tried.current || entry) return;
    const saved = store.get();
    if (!saved) { tried.current = true; return; }
    const w = wallets.find((x) => x.id === saved) || (saved.startsWith("injected:") ? wallets.find((x) => x.id.startsWith(saved)) : null);
    if (!w) return; // keep waiting for the announcement
    tried.current = true;
    (async () => {
      try {
        const accs = await w.provider.request({ method: "eth_accounts" });
        if (!accs?.length) return;
        const cid = await w.provider.request({ method: "eth_chainId" });
        setEntry(w); setAccount(ethers.getAddress(accs[0])); setChainId(toChainId(cid));
      } catch { /* stay disconnected */ }
    })();
  }, [wallets, entry]);
  useEffect(() => { const t = setTimeout(() => { tried.current = true; }, 3000); return () => clearTimeout(t); }, []);

  // listeners on the active provider
  useEffect(() => {
    const p = entry?.provider;
    if (!p?.on) return;
    const onAccounts = (accs) => {
      if (accs?.length) setAccount(ethers.getAddress(accs[0]));
      else { setAccount(null); setEntry(null); store.set(null); say("info", "Wallet disconnected"); }
    };
    const onChain = (cid) => setChainId(toChainId(cid));
    const onDisconnect = (err) => {
      // 1013 = temporarily disconnected (MetaMask reconnecting); ignore
      if (err?.code === 1013) return;
      setAccount(null); setEntry(null);
    };
    p.on("accountsChanged", onAccounts);
    p.on("chainChanged", onChain);
    p.on("disconnect", onDisconnect);
    return () => {
      const off = (p.removeListener || p.off)?.bind(p);
      if (!off) return;
      off("accountsChanged", onAccounts); off("chainChanged", onChain); off("disconnect", onDisconnect);
    };
  }, [entry]);

  const connect = useCallback(async (w) => {
    if (inflight.current) { say("info", "Open your wallet to finish the pending request"); return false; }
    setPending("connect");
    const req = w.provider.request({ method: "eth_requestAccounts" });
    inflight.current = req;
    try {
      const accs = await req;
      if (!accs?.length) throw Object.assign(new Error("no accounts"), { code: 4001 });
      const cid = await w.provider.request({ method: "eth_chainId" });
      setEntry(w); setAccount(ethers.getAddress(accs[0])); setChainId(toChainId(cid));
      store.set(w.id);
      setPickerOpen(false);
      say("ok", `Connected ${w.name}`);
      return true;
    } catch (e) {
      report(e, "Could not connect to " + w.name + ".");
      return false;
    } finally {
      inflight.current = null;
      setPending(null);
    }
  }, [report]);

  const disconnect = useCallback(async () => {
    const p = entry?.provider;
    setEntry(null); setAccount(null); setChainId(null); store.set(null); setPickerOpen(false);
    try { await p?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }); } catch { /* not supported */ }
  }, [entry]);

  const switchChain = useCallback(async () => {
    const p = entry?.provider;
    if (!p) return false;
    if (pending === "switch") { say("info", "Open your wallet to finish the pending request"); return false; }
    const params = chainParams();
    setPending("switch");
    try {
      try {
        await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: params.chainId }] });
      } catch (e) {
        if (!isUnknownChain(e)) throw e;
        await p.request({ method: "wallet_addEthereumChain", params: [params] });
        // some wallets don't switch after adding
        const cid = toChainId(await p.request({ method: "eth_chainId" }));
        if (cid !== chain.id) await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: params.chainId }] });
      }
      const cid = toChainId(await p.request({ method: "eth_chainId" }));
      setChainId(cid);
      if (cid !== chain.id) { say("err", `Still on the wrong network. Switch to ${params.chainName} in your wallet.`); return false; }
      return true;
    } catch (e) {
      report(e, `Couldn't switch network. Switch to ${params.chainName} in your wallet.`);
      return false;
    } finally {
      setPending(null);
    }
  }, [entry, pending, report]);

  const browserProvider = useMemo(() => (entry ? new ethers.BrowserProvider(entry.provider, "any") : null), [entry, chainId]); // eslint-disable-line react-hooks/exhaustive-deps
  const signer = useMemo(() => (browserProvider && account ? new ethers.JsonRpcSigner(browserProvider, account) : null), [browserProvider, account]);

  return {
    wallets, entry, account, chainId, signer, pending, pickerOpen,
    connected: !!(entry && account),
    wrongChain: !!(entry && account && chainId != null && chainId !== chain.id),
    openPicker: () => setPickerOpen(true), closePicker: () => setPickerOpen(false),
    connect, disconnect, switchChain,
  };
}
