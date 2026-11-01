import { useEffect, useRef } from "react";

/**
 * The home hero backdrop: a slow field of PayPal holds (dashed rings, like the Paylet mark) drifting over the colour mesh.
 * Every so often one settles: it fills and glows (captured, a winner) or dissolves (voided, never charged) and a new hold
 * drifts in. Pure canvas 2D, paused off-screen and when the tab is hidden; a single still frame for reduced motion.
 */
interface Ring {
  x: number;
  y: number;
  r: number;
  vx: number;
  vy: number;
  spin: number;
  a: number; // opacity
  state: "in" | "held" | "won" | "void";
  t: number; // seconds in the current state
}

const COUNT = 30;

function spawn(w: number, h: number, initial: boolean): Ring {
  const r = 7 + Math.random() ** 1.6 * 26;
  return {
    x: Math.random() * w,
    y: initial ? Math.random() * h : h + r + Math.random() * 60,
    r,
    vx: (Math.random() - 0.5) * 4,
    vy: -(3 + Math.random() * 7) * (0.6 + r / 40),
    spin: (Math.random() < 0.5 ? -1 : 1) * (6 + Math.random() * 10),
    a: initial ? 1 : 0,
    state: initial ? "held" : "in",
    t: 0,
  };
}

export function HoldField() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    let w = 0;
    let h = 0;
    let dpr = 1;
    let rings: Ring[] = [];
    const resize = () => {
      const box = canvas.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      w = box.width;
      h = box.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      if (!rings.length) rings = Array.from({ length: COUNT }, () => spawn(w, h, true));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    let visible = true;
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting));
    io.observe(canvas);

    let last = performance.now();
    let nextSettle = 0.8;
    let raf = 0;
    const draw = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (visible && !document.hidden) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        nextSettle -= dt;
        if (nextSettle <= 0) {
          nextSettle = 0.7 + Math.random() * 0.9;
          const held = rings.filter((r) => r.state === "held" && r.y > h * 0.12 && r.y < h * 0.85);
          const pick = held[Math.floor(Math.random() * held.length)];
          if (pick) {
            pick.state = Math.random() < 0.34 ? "won" : "void";
            pick.t = 0;
          }
        }
        for (let i = 0; i < rings.length; i++) {
          const g = rings[i];
          g.t += dt;
          g.x += g.vx * dt;
          g.y += g.vy * dt;
          if (g.state === "in") {
            g.a = Math.min(1, g.t / 1.2);
            if (g.a >= 1) g.state = "held";
          }
          if (g.state === "void") g.a = Math.max(0, 1 - g.t / 1.1);
          if (g.state === "won") g.a = g.t < 1.6 ? 1 : Math.max(0, 1 - (g.t - 1.6) / 0.9);
          if (g.a <= 0 && g.state !== "in" || g.y < -g.r * 2) {
            rings[i] = spawn(w, h, false);
            continue;
          }
          const base = 0.5 + Math.min(0.35, g.r / 70);
          ctx.save();
          ctx.translate(g.x, g.y);
          ctx.globalAlpha = g.a * base;
          ctx.lineWidth = 1.4 + g.r / 22;
          ctx.strokeStyle = "#fff";
          if (g.state === "won") {
            const k = Math.min(1, g.t / 0.5);
            // the hold becomes a payment: the ring closes and fills
            ctx.setLineDash([]);
            ctx.globalAlpha = g.a;
            ctx.beginPath();
            ctx.arc(0, 0, g.r, 0, Math.PI * 2);
            ctx.stroke();
            ctx.fillStyle = "rgba(255,255,255,0.95)";
            ctx.beginPath();
            ctx.arc(0, 0, g.r * 0.42 * k, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = g.a * (1 - k) * 0.7;
            ctx.beginPath();
            ctx.arc(0, 0, g.r * (1 + k * 0.9), 0, Math.PI * 2);
            ctx.stroke();
          } else {
            const circ = Math.PI * 2 * g.r;
            const n = Math.max(6, Math.round(circ / 9));
            ctx.setLineDash([(circ / n) * 0.58, (circ / n) * 0.42]);
            ctx.lineDashOffset = (now / 1000) * g.spin;
            if (g.state === "void") ctx.scale(1 + g.t * 0.25, 1 + g.t * 0.25);
            ctx.beginPath();
            ctx.arc(0, 0, g.r, 0, Math.PI * 2);
            ctx.stroke();
            ctx.globalAlpha = g.a * base * 0.9;
            ctx.fillStyle = "#fff";
            ctx.beginPath();
            ctx.arc(0, 0, Math.max(1.2, g.r * 0.16), 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.restore();
        }
      }
      if (!reduced) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
    };
  }, []);
  return <canvas ref={ref} className="hold-field" aria-hidden="true" />;
}
