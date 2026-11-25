// Stoxhome "Index house" mark: a house whose roof is the price chart, topped by the live price dot.
const HOUSE = "M8 56 V32 L13 29.5 L17 31.5 L23 22.5 L27 25 L32 11 L56 32 V56 Z M26.5 56 V42 H37.5 V56 Z";

export function LogoMark({ size = 22, fill = "currentColor", dot = "#6f86ff", title = "Stoxhome" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label={title}>
      <path d={HOUSE} fillRule="evenodd" fill={fill} />
      <circle cx="32" cy="5.8" r="4.6" fill={dot} />
    </svg>
  );
}
