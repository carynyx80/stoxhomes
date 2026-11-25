// Built-in wallet marks (used for install / deep-link rows and wallets that don't ship an icon).
const svg = (body) => "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${body}</svg>`);
export const WALLET_LOGOS = {
  Phantom: svg('<rect width="64" height="64" rx="14" fill="#AB9FF2"/><path d="M14 40c0-12 8.3-21 18.8-21C43 19 50 27.6 50 37.4c0 1.4-1.2 2.6-2.7 2.6H39c-.9 0-1.6.7-1.6 1.6v1c0 3.3-2.6 5.9-5.8 5.9-3 0-5.4-2.2-5.8-5.1-.4 2.9-2.9 5.1-5.9 5.1-3.3 0-6-2.7-6-6V40z" fill="#fff"/><circle cx="32" cy="33" r="3" fill="#AB9FF2"/><circle cx="41" cy="33" r="3" fill="#AB9FF2"/>'),
  Solflare: svg('<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFC10B"/><stop offset="1" stop-color="#FB3F2E"/></linearGradient></defs><rect width="64" height="64" rx="14" fill="url(#g)"/><path d="M32 13l5.5 12.5L50 31l-12.5 5.5L32 49l-5.5-12.5L14 31l12.5-5.5z" fill="#fff"/>'),
  Backpack: svg('<rect width="64" height="64" rx="14" fill="#E33E3F"/><path d="M26 15h12a4 4 0 014 4v3H22v-3a4 4 0 014-4z" fill="#fff" opacity=".8"/><rect x="17" y="22" width="30" height="28" rx="7" fill="#fff"/><rect x="24" y="36" width="16" height="6" rx="3" fill="#E33E3F"/>'),
  "OKX Wallet": svg('<rect width="64" height="64" rx="14" fill="#000"/><g fill="#fff"><rect x="16" y="16" width="10" height="10"/><rect x="38" y="16" width="10" height="10"/><rect x="27" y="27" width="10" height="10"/><rect x="16" y="38" width="10" height="10"/><rect x="38" y="38" width="10" height="10"/></g>'),
  "Trust Wallet": svg('<rect width="64" height="64" rx="14" fill="#0500FF"/><path d="M32 13l15 6v11c0 10-6.5 17-15 21-8.5-4-15-11-15-21V19z" fill="none" stroke="#fff" stroke-width="4" stroke-linejoin="round"/>'),
  "Coinbase Wallet": svg('<rect width="64" height="64" rx="14" fill="#0052FF"/><circle cx="32" cy="32" r="17" fill="#fff"/><rect x="26" y="26" width="12" height="12" rx="2" fill="#0052FF"/>'),
  "Bitget Wallet": svg('<rect width="64" height="64" rx="14" fill="#00F0FF"/><path d="M22 18h12l-8 14 8 14H22l-8-14zM34 18h10l8 14-8 14H34l8-14z" fill="#000"/>'),
};
export const logoFor = (name = "") => WALLET_LOGOS[name] || WALLET_LOGOS[Object.keys(WALLET_LOGOS).find((k) => name.toLowerCase().startsWith(k.toLowerCase().split(" ")[0]))] || null;
