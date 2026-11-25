// Logging with secret scrubbing: any value registered via addSecret() is masked in output.
const secrets = new Set();
export const addSecret = (s) => { if (s) { secrets.add(s); if (s.startsWith("0x")) secrets.add(s.slice(2)); } };
const scrub = (x) => {
  if (typeof x !== "string") return x;
  for (const s of secrets) x = x.split(s).join("<redacted>");
  return x;
};
const ts = () => new Date().toISOString();
export const log = (tag, ...a) => console.log(ts(), `[${tag}]`, ...a.map(scrub));
export const warn = (tag, ...a) => console.warn(ts(), `[${tag}]`, ...a.map(scrub));
