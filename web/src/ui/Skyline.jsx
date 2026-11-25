// Procedural skylines with a landmark per city. Drawn on a 200x80 box, ground at y=80.
function rng(seed) { let s = seed; return () => ((s = (s * 16807) % 2147483647) / 2147483647); }

const LANDMARK = {
  NYC: "M96 80V22h2l1-8 1 8h2v58Z M90 80V34h18v46Z", // spire tower
  LA: "M40 80v-8q30-14 60-6q30-10 60 4v10Z M150 80V40h10v40Z", // hills + tower
  MIA: "M120 80V30q8-6 16 0v50Z M30 80q-2-22 4-36m0 0q-10-2-14 4m14-4q10-4 14 2m-14-2q-4-10-12-10m12 10q6-10 14-8", // curved tower + palm
  SF: "M98 80L104 6l6 74Z M150 80V36h3v-8h4v8h3v44Z", // Transamerica + tower
  LDN: "M60 80V24l4-10 4 10v56Z M120 80L134 10l14 70Z", // Big Ben + Shard
};

export default function Skyline({ symbol, seed = 1, className = "" }) {
  const r = rng(seed * 997 + 3);
  const rects = [];
  let x = 0;
  while (x < 200) {
    const w = 6 + Math.floor(r() * 14);
    const h = 14 + Math.floor(r() * (symbol === "LA" || symbol === "MIA" ? 26 : 44));
    rects.push(<rect key={x} x={x} y={80 - h} width={w - 1.5} height={h} />);
    x += w;
  }
  return (
    <svg className={"skyline " + className} viewBox="0 0 200 80" preserveAspectRatio="xMidYMax meet" aria-hidden="true">
      <g className="sk-back">{rects}</g>
      <path className="sk-mark" d={LANDMARK[symbol]} />
      <line x1="0" y1="79.5" x2="200" y2="79.5" className="sk-ground" />
    </svg>
  );
}
