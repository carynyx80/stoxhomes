// Fixed-point helpers. No floats anywhere in money paths.
// Money: integer micro-USDT (1e-6) BigInt. Prices/sizes: WAD (1e18) BigInt.

export const WAD = 10n ** 18n;
export const MICRO = 10n ** 6n;
export const WAD_PER_MICRO = 10n ** 12n; // 1 micro-USDT expressed in WAD-USD
export const BPS = 10_000n;

export class AppError extends Error {
  constructor(code, message, status = 400) {
    super(message || code);
    this.code = code;
    this.status = status;
  }
}

export const abs = (x) => (x < 0n ? -x : x);
export const min = (a, b) => (a < b ? a : b);
export const max = (a, b) => (a > b ? a : b);

/** Floor division for signed BigInt (rounds toward -infinity). */
export function floorDiv(a, b) {
  if (b === 0n) throw new Error('division by zero');
  const q = a / b;
  if ((a % b !== 0n) && ((a < 0n) !== (b < 0n))) return q - 1n;
  return q;
}

/** Ceil division for signed BigInt. */
export function ceilDiv(a, b) {
  return -floorDiv(-a, b);
}

function parseDecimal(str, decimals, { signed = false, field = 'value' } = {}) {
  if (typeof str === 'number') {
    if (!Number.isFinite(str)) throw new AppError('BAD_INPUT', `${field} must be a decimal string`);
    str = String(str);
    if (/e/i.test(str)) throw new AppError('BAD_INPUT', `${field} must be a decimal string`);
  }
  if (typeof str !== 'string' || str.length === 0 || str.length > 60) {
    throw new AppError('BAD_INPUT', `${field} must be a decimal string`);
  }
  const re = signed ? /^(-|\+)?(\d+)(?:\.(\d+))?$/ : /^(\d+)(?:\.(\d+))?$/;
  const m = str.trim().match(re);
  if (!m) throw new AppError('BAD_INPUT', `${field} must be a decimal string`);
  const sign = signed && m[1] === '-' ? -1n : 1n;
  const intPart = signed ? m[2] : m[1];
  const frac = (signed ? m[3] : m[2]) || '';
  if (frac.length > decimals) throw new AppError('BAD_INPUT', `${field} has more than ${decimals} decimals`);
  const v = BigInt(intPart) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
  return sign * v;
}

export const parseUsdt = (s, field = 'amount') => parseDecimal(s, 6, { field });
export const parseWad = (s, field = 'value') => parseDecimal(s, 18, { field });
export const parseShares = (s, field = 'shares') => parseDecimal(s, 12, { field });
export const parseSignedWad = (s, field = 'size') => parseDecimal(s, 18, { signed: true, field });

export function formatUnits(v, decimals) {
  v = BigInt(v);
  const neg = v < 0n;
  if (neg) v = -v;
  const base = 10n ** BigInt(decimals);
  const i = v / base;
  let f = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + i.toString() + (f ? '.' + f : '');
}
export const fmtUsdt = (v) => formatUnits(v, 6);
export const fmtWad = (v) => formatUnits(v, 18);

/** WAD-USD -> micro-USDT, floor (rounds against the holder of a positive value). */
export const wadToMicroFloor = (x) => floorDiv(x, WAD_PER_MICRO);
export const microToWad = (x) => x * WAD_PER_MICRO;

/** notional in micro-USDT of |size| * price (both WAD) */
export const notionalMicro = (size, price) => (abs(size) * price) / WAD / WAD_PER_MICRO;
