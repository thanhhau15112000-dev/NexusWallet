import { useEffect, useRef, type RefObject } from 'react';

type Point = { x: number; y: number };
type Verdict = 'allow' | 'approval' | 'deny';
type Particle = { start: Point; verdict: Verdict; t: number; speed: number; hold: number; fade: number };
type Row = { key: string; verdict: Verdict; y: number };

const BLOCK_AT = 0.9; // blocked payments stop just before the shield
const APPROVAL_HOLD_MS = 700; // payments needing approval pause at the shield before going to the owner's wallet
const MAX_PARTICLES = 24;
// Anchors as fractions of the mascot-shield.svg box: left edge of the shield, and the right edge of the body.
const SHIELD_IN = { x: 0.1, y: 0.57 };
const BODY_OUT = { x: 0.86, y: 0.57 };

function cubic(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

function curve(from: Point, to: Point): [Point, Point, Point, Point] {
  const mid = from.x + (to.x - from.x) * 0.5;
  return [from, { x: mid, y: from.y }, { x: mid, y: to.y }, to];
}

function isVerdict(value: string | undefined): value is Verdict {
  return value === 'allow' || value === 'approval' || value === 'deny';
}

/**
 * BootScreen background. Every feed row in `source` (elements with `data-flow-row` and `data-verdict`)
 * gets its own lane to the shield mascot (`guard`). Each row emits one dot when it appears, colored by its verdict:
 * signed ones run on into the wallet card (`target`), ones needing approval pause at the shield and then
 * continue to the wallet for the owner's signature, blocked ones stop red at the shield.
 * Renders nothing while the guard is hidden (below `lg`); draws static lanes only under reduced motion.
 */
export function TransactionFlow(props: {
  source: RefObject<HTMLElement | null>;
  guard: RefObject<HTMLElement | null>;
  target: RefObject<HTMLElement | null>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    // Theme tokens, re-read each frame so a light/dark switch recolors the canvas at once.
    const palette = () => {
      const css = getComputedStyle(document.documentElement);
      const read = (name: string) => css.getPropertyValue(name).trim();
      return {
        lane: read('--color-line-strong'),
        verdict: { allow: read('--color-accent'), approval: read('--color-apricot'), deny: read('--color-bad') } as Record<
          Verdict,
          string
        >,
      };
    };
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let particles: Particle[] = [];
    // Each row emits exactly one dot, the first frame it is seen; a new feed batch therefore launches its dots together.
    const emitted = new Set<string>();
    let frame = 0;
    let last = performance.now();

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const { width, height } = canvas.getBoundingClientRect();
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const geometry = () => {
      const base = canvas.getBoundingClientRect();
      const source = props.source.current;
      const s = source?.getBoundingClientRect();
      const g = props.guard.current?.getBoundingClientRect();
      const t = props.target.current?.getBoundingClientRect();
      if (!source || !s || !g || !t || g.width === 0) return null;
      const rows: Row[] = [];
      source.querySelectorAll<HTMLElement>('[data-flow-row]').forEach((el) => {
        const verdict = el.dataset.verdict;
        const key = el.dataset.flowRow;
        if (!key || !isVerdict(verdict)) return;
        const r = el.getBoundingClientRect();
        rows.push({ key, verdict, y: r.top - base.top + r.height / 2 });
      });
      return {
        startX: s.right - base.left,
        rows,
        guardIn: { x: g.left - base.left + g.width * SHIELD_IN.x, y: g.top - base.top + g.height * SHIELD_IN.y },
        exit: curve(
          { x: g.left - base.left + g.width * BODY_OUT.x, y: g.top - base.top + g.height * BODY_OUT.y },
          { x: t.left - base.left, y: t.top - base.top + t.height * 0.5 },
        ),
      };
    };

    const draw = (now: number) => {
      const dt = Math.min(now - last, 50);
      last = now;
      const dpr = window.devicePixelRatio || 1;
      ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);

      const geo = geometry();
      if (geo) {
        const colors = palette();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = colors.lane;
        const lanes = geo.rows.map((row) => curve({ x: geo.startX, y: row.y }, geo.guardIn));
        for (const [a, b, c, d] of [...lanes, geo.exit]) {
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.bezierCurveTo(b.x, b.y, c.x, c.y, d.x, d.y);
          ctx.stroke();
        }

        if (!reduceMotion && document.visibilityState === 'visible') {
          for (const row of geo.rows) {
            if (!emitted.has(row.key) && particles.length < MAX_PARTICLES) {
              particles.push({
                start: { x: geo.startX, y: row.y },
                verdict: row.verdict,
                t: 0,
                speed: 0.00042,
                hold: row.verdict === 'approval' ? APPROVAL_HOLD_MS : 0,
                fade: 1,
              });
              emitted.add(row.key);
            }
          }
          const live = new Set(geo.rows.map((row) => row.key));
          for (const key of emitted) if (!live.has(key)) emitted.delete(key);

          for (const p of particles) {
            const stop = p.verdict === 'deny' ? BLOCK_AT : 2;
            if (p.t < stop) {
              const next = Math.min(stop, p.t + p.speed * dt);
              // Approval: wait at the shield (t = 1) before continuing to the wallet.
              if (p.t < 1 && next >= 1 && p.hold > 0) {
                p.t = 1;
                p.hold -= dt;
              } else if (p.t === 1 && p.hold > 0) {
                p.hold -= dt;
              } else {
                p.t = next;
              }
            } else {
              p.fade -= dt / (p.verdict === 'deny' ? 900 : 300);
            }

            const pos = p.t <= 1 ? cubic(...curve(p.start, geo.guardIn), p.t) : cubic(...geo.exit, p.t - 1);
            const halted = (p.verdict === 'deny' && p.t >= BLOCK_AT) || (p.t === 1 && p.hold > 0);
            ctx.globalAlpha = Math.max(0, p.fade);
            ctx.fillStyle = colors.verdict[p.verdict];
            ctx.beginPath();
            ctx.arc(pos.x, pos.y, halted ? 4.2 : 3.4, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.globalAlpha = 1;
          particles = particles.filter((p) => p.fade > 0);
        }
      }
      frame = requestAnimationFrame(draw);
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    frame = requestAnimationFrame(draw);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [props.source, props.guard, props.target]);

  return <canvas ref={canvasRef} aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" />;
}
