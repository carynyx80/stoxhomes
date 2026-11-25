import { useCallback, useEffect, useRef, useState } from "react";

// Slideshow shell: every menu section is a horizontal slide. Hash (#trade, #vault…) mirrors the slide.
export default function AppShell({ slides, header, children }) {
  const ids = slides.map((s) => s.id);
  const fromHash = () => Math.max(0, ids.indexOf(window.location.hash.slice(1)));
  const [i, setI] = useState(fromHash);
  const track = useRef(null);
  const touch = useRef(null);
  const n = slides.length;

  const go = useCallback((k) => {
    const next = Math.max(0, Math.min(n - 1, k));
    setI(next);
    const h = "#" + ids[next];
    if (window.location.hash !== h) history.replaceState(null, "", window.location.pathname + h);
  }, [n, ids.join()]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onHash = () => setI(fromHash());
    window.addEventListener("hashchange", onHash);
    window.addEventListener("popstate", onHash);
    return () => { window.removeEventListener("hashchange", onHash); window.removeEventListener("popstate", onHash); };
  }, [ids.join()]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (!window.location.hash) history.replaceState(null, "", window.location.pathname + "#" + ids[i]); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (document.querySelector(".sheet, .scrim, [role=dialog]")) return;
      if (e.key === "ArrowRight") { e.preventDefault(); go(i + 1); }
      if (e.key === "ArrowLeft") { e.preventDefault(); go(i - 1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [i, go]);

  useEffect(() => {
    const b = document.querySelector(".slidemenu button.on");
    const m = b && b.closest(".slidemenu");
    if (m) m.scrollTo({ left: Math.max(0, b.offsetLeft - 16), behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [i]);

  const onTouchStart = (e) => {
    const p = e.touches[0];
    const t = e.target;
    if (t.closest && t.closest("input[type=range], .chart, .cities, .slidemenu, .noswipe")) { touch.current = null; return; }
    touch.current = { x: p.clientX, y: p.clientY, t: Date.now() };
  };
  const onTouchEnd = (e) => {
    const s = touch.current; touch.current = null;
    if (!s) return;
    const p = e.changedTouches[0], dx = p.clientX - s.x, dy = p.clientY - s.y;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.4 && Date.now() - s.t < 800) go(i + (dx < 0 ? 1 : -1));
  };

  return (
    <div className="shell">
      <div className="blueprint" aria-hidden="true" />
      {header}
      <nav className="slidemenu" aria-label="Sections">
        <div className="sm-in">
          {slides.map((s, k) => (
            <button key={s.id} className={k === i ? "on" : ""} aria-current={k === i ? "page" : undefined} onClick={() => go(k)}>
              <small>{String(k + 1).padStart(2, "0")}</small>{s.label}
            </button>
          ))}
          <i className="sm-bar" style={{ "--k": i, "--n": n }} />
        </div>
      </nav>
      <div className="stage" onScroll={(e) => { if (e.currentTarget.scrollLeft) e.currentTarget.scrollLeft = 0; }} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        <div className="slidetrack" ref={track} style={{ transform: `translate3d(${-i * 100}%,0,0)` }}>
          {slides.map((s, k) => (
            <section key={s.id} className={"slide" + (k === i ? " on" : "")} id={"slide-" + s.id} aria-hidden={k !== i} inert={k !== i ? "" : undefined} aria-label={s.label}>
              <div className="slide-in">{s.render()}</div>
            </section>
          ))}
        </div>
      </div>
      <div className="slidectl">
        <button className="arrow" aria-label="Previous section" disabled={i === 0} onClick={() => go(i - 1)}>←</button>
        <div className="dots" role="tablist">
          {slides.map((s, k) => <button key={s.id} role="tab" aria-selected={k === i} aria-label={s.label} className={k === i ? "on" : ""} onClick={() => go(k)} />)}
        </div>
        <span className="slidecount">{String(i + 1).padStart(2, "0")} / {String(n).padStart(2, "0")} · {slides[i].label}</span>
        <button className="arrow" aria-label="Next section" disabled={i === n - 1} onClick={() => go(i + 1)}>→</button>
      </div>
      {children}
    </div>
  );
}
