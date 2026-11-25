import { useLayoutEffect, useMemo, useRef, useState } from "react";

const PL = 8, PR = 60, PT = 20, PB = 28;

export default function Chart({ data, range, symbol, lines = [] }) {
  const [hover, setHover] = useState(null);
  const ref = useRef(null), box = useRef(null);
  const [[W, H], setDim] = useState([900, 340]);
  useLayoutEffect(() => {
    const ro = new ResizeObserver(([e]) => setDim([Math.max(200, e.contentRect.width), Math.max(180, e.contentRect.height)]));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  const g = useMemo(() => {
    const vals = data.flatMap((d) => [d.index, d.mark]);
    let min = Math.min(...vals), max = Math.max(...vals);
    const span0 = max - min;
    for (const l of lines) if (l.v > min - span0 * 0.6 && l.v < max + span0 * 0.6) { min = Math.min(min, l.v); max = Math.max(max, l.v); }
    const minSpan = ((min + max) / 2) * 0.004; // never zoom tighter than ±0.2%
    if (max - min < minSpan) { const c = (min + max) / 2; min = c - minSpan / 2; max = c + minSpan / 2; }
    const pad = (max - min) * 0.12 || 1; min -= pad; max += pad;
    const t0 = data[0].t, t1 = data[data.length - 1].t, tSpan = t1 - t0 || 1;
    const x = (i) => PL + ((data[i].t - t0) / tSpan) * (W - PL - PR); // time scale (live data is irregular)
    const y = (v) => PT + (1 - (v - min) / (max - min)) * (H - PT - PB);
    const line = (k) => data.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(d[k]).toFixed(1)}`).join("");
    const idx = line("index");
    const area = idx + `L${x(data.length - 1)} ${H - PB}L${x(0)} ${H - PB}Z`;
    const ticks = Array.from({ length: 5 }, (_, i) => min + ((max - min) * (i + 0.5)) / 5);
    const nx = W < 500 ? 3 : 5;
    const xt = Array.from({ length: nx }, (_, k) => t0 + (tSpan * k) / (nx - 1));
    return { x, y, idx, mark: line("mark"), area, ticks, xt };
  }, [data, W, H, lines]);

  const fmtDate = (t) => new Date(t).toLocaleDateString("en-GB", range === "1M" ? { day: "2-digit", month: "short" } : { month: "short", year: "2-digit" });
  const onMove = (e) => {
    const b = ref.current.getBoundingClientRect();
    const px = ((e.clientX - b.left) / b.width) * W;
    const tt = data[0].t + ((px - PL) / (W - PL - PR)) * (data[data.length - 1].t - data[0].t);
    let i = 0;
    for (let k = 0; k < data.length; k++) if (Math.abs(data[k].t - tt) < Math.abs(data[i].t - tt)) i = k;
    setHover(i);
  };
  const last = data[data.length - 1];
  const h = hover != null ? data[hover] : null;

  return (
    <div className="chart" ref={box}>
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} width={W} height={H} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <defs>
          <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--blue)" stopOpacity=".28" />
            <stop offset="1" stopColor="var(--blue)" stopOpacity="0" />
          </linearGradient>
          <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" stroke="var(--blue)" strokeOpacity=".08" strokeWidth="2" />
          </pattern>
        </defs>
        {g.ticks.map((v) => (
          <g key={v}>
            <line x1={PL} x2={W - PR} y1={g.y(v)} y2={g.y(v)} className="gridline" />
            <text x={W - PR + 8} y={g.y(v) + 4} className="axis">{v.toFixed(1)}</text>
          </g>
        ))}
        {g.xt.map((t, k) => (
          <text key={k} x={PL + ((t - data[0].t) / ((data[data.length - 1].t - data[0].t) || 1)) * (W - PL - PR)} y={H - 8} className="axis" textAnchor={k === 0 ? "start" : k === g.xt.length - 1 ? "end" : "middle"}>{fmtDate(t)}</text>
        ))}
        <g key={symbol + range} className="draw">
          <path d={g.area} fill="url(#hatch)" />
          <path d={g.area} fill="url(#fill)" className="area" />
          <path d={g.mark} className="ln-mark" pathLength="1" />
          <path d={g.idx} className="ln-index" pathLength="1" />
        </g>
        {lines.filter((l) => g.y(l.v) > PT - 4 && g.y(l.v) < H - PB + 4).map((l) => (
          <g key={l.label} className={"pline " + l.kind}>
            <line x1={PL} x2={W - PR} y1={g.y(l.v)} y2={g.y(l.v)} />
            <rect x={PL} y={g.y(l.v) - 9} width={l.label.length * 6.6 + 12} height="18" />
            <text x={PL + 6} y={g.y(l.v) + 3.5}>{l.label}</text>
          </g>
        ))}
        <circle cx={g.x(data.length - 1)} cy={g.y(last.index)} r="5" className="dot" />
        <circle cx={g.x(data.length - 1)} cy={g.y(last.index)} r="5" className="dot pulse" />
        <g transform={`translate(${W - PR},${g.y(last.index)})`}>
          <rect x="2" y="-11" width={PR - 2} height="22" className="lasttag" />
          <text x="8" y="4" className="lasttxt">{last.index.toFixed(2)}</text>
        </g>
        {h && (
          <g>
            <line x1={g.x(hover)} x2={g.x(hover)} y1={PT} y2={H - PB} className="cross" />
            <circle cx={g.x(hover)} cy={g.y(h.index)} r="4" className="dot" />
            <circle cx={g.x(hover)} cy={g.y(h.mark)} r="3" className="dot red" />
          </g>
        )}
      </svg>
      {h && (
        <div className="tip" style={{ left: `${(g.x(hover) / W) * 100}%` }}>
          <b>{new Date(h.t).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}</b>
          <span>Index <i>{h.index.toFixed(2)}</i></span>
          <span>Mark <i>{h.mark.toFixed(2)}</i></span>
          <span>Premium <i>{(((h.mark / h.index) - 1) * 100).toFixed(3)}%</i></span>
        </div>
      )}
    </div>
  );
}
