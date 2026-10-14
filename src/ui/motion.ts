// Motion helpers. Every effect is short, never blocks input, and is skipped when the player
// (or their OS) asks for reduced motion.
import type { Square } from '../rules/types.js';

let reduceOverride = false;
export function setReduceMotion(v: boolean): void {
  reduceOverride = v;
  document.documentElement.classList.toggle('reduce-motion', v);
}
export function reducedMotion(): boolean {
  return reduceOverride || (typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches);
}

/** Remember where each piece token is before a re-render (keyed by data-piece). */
export function snapshotTokens(root: HTMLElement): Map<string, DOMRect> {
  const map = new Map<string, DOMRect>();
  root.querySelectorAll<HTMLElement>('.board .token[data-piece]').forEach((el) => map.set(el.dataset.piece!, el.getBoundingClientRect()));
  return map;
}

/** FLIP: slide every token that changed square from its old place to its new one. */
export function flipTokens(root: HTMLElement, before: Map<string, DOMRect>, ms = 280): void {
  if (reducedMotion() || !before.size) return;
  root.querySelectorAll<HTMLElement>('.board .token[data-piece]').forEach((el) => {
    const old = before.get(el.dataset.piece!);
    if (!old) return;
    const now = el.getBoundingClientRect();
    const dx = old.left - now.left;
    const dy = old.top - now.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    el.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) scale(1.08)`, zIndex: 6 },
        { transform: 'translate(0, 0) scale(1)', zIndex: 6 },
      ],
      { duration: ms, easing: 'cubic-bezier(.2,.8,.2,1)' },
    );
  });
}

function cellRect(root: HTMLElement, sq: Square): { el: HTMLElement; x: number; y: number; size: number } | null {
  const board = root.querySelector<HTMLElement>('.board');
  const cell = root.querySelector<HTMLElement>(`.cell[data-c="${sq.c}"][data-r="${sq.r}"]`);
  if (!board || !cell) return null;
  const b = board.getBoundingClientRect();
  const c = cell.getBoundingClientRect();
  return { el: board, x: c.left - b.left + c.width / 2, y: c.top - b.top + c.height / 2, size: c.width };
}

/** Ball flight: a lofted arc for passes, a fast low drive for shots. */
export function flyBall(root: HTMLElement, from: Square, to: Square, ballSvg: string, ms = 420, kind: 'pass' | 'shot' = 'pass'): void {
  if (reducedMotion()) return;
  const a = cellRect(root, from);
  const b = cellRect(root, to);
  if (!a || !b) return;
  const ball = document.createElement('div');
  ball.className = `ball-flight ${kind}`;
  ball.innerHTML = ballSvg;
  const size = a.size * (kind === 'shot' ? 0.46 : 0.42);
  ball.style.width = ball.style.height = `${size}px`;
  a.el.appendChild(ball);
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  const lift = kind === 'shot' ? Math.min(14, dist * 0.06) : Math.min(60, dist * 0.35);
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - lift };
  const spin = kind === 'shot' ? 720 : 400;
  const anim = ball.animate(
    [
      { transform: `translate(${a.x - size / 2}px, ${a.y - size / 2}px) rotate(0deg) scale(.9)` },
      { transform: `translate(${mid.x - size / 2}px, ${mid.y - size / 2}px) rotate(${spin / 2}deg) scale(${kind === 'shot' ? 1.05 : 1.25})` },
      { transform: `translate(${b.x - size / 2}px, ${b.y - size / 2}px) rotate(${spin}deg) scale(${kind === 'shot' ? 0.8 : 0.9})` },
    ],
    { duration: ms, easing: kind === 'shot' ? 'cubic-bezier(.15,.7,.3,1)' : 'cubic-bezier(.3,.6,.4,1)' },
  );
  if (kind === 'shot') {
    // a few fading trail dots behind the shot
    for (let i = 1; i <= 4; i++) {
      const dot = document.createElement('i');
      dot.className = 'shot-trail';
      dot.style.width = dot.style.height = `${size * (0.5 - i * 0.07)}px`;
      a.el.appendChild(dot);
      const d = dot.animate(
        [
          { transform: `translate(${a.x}px, ${a.y}px) translate(-50%, -50%)`, opacity: 0.6 },
          { transform: `translate(${b.x}px, ${b.y}px) translate(-50%, -50%)`, opacity: 0 },
        ],
        { duration: ms, delay: i * 40, easing: 'cubic-bezier(.15,.7,.3,1)', fill: 'backwards' },
      );
      d.onfinish = () => dot.remove();
    }
  }
  anim.onfinish = () => ball.remove();
}

/** Short radial burst on a square (tackles). */
export function burstAt(root: HTMLElement, sq: Square, kind: 'tackle' | 'gain'): void {
  if (reducedMotion()) return;
  const r = cellRect(root, sq);
  if (!r) return;
  const wrap = document.createElement('div');
  wrap.className = `burst ${kind}`;
  wrap.style.left = `${r.x}px`;
  wrap.style.top = `${r.y}px`;
  wrap.style.setProperty('--s', `${r.size}px`);
  const count = kind === 'tackle' ? 10 : 6;
  for (let i = 0; i < count; i++) {
    const spark = document.createElement('i');
    spark.style.setProperty('--a', `${(360 / count) * i}deg`);
    wrap.appendChild(spark);
  }
  r.el.appendChild(wrap);
  window.setTimeout(() => wrap.remove(), 700);
}

/** Confetti for goals, drawn inside a container (the goal overlay). */
export function confetti(container: HTMLElement, colors: string[]): void {
  if (reducedMotion()) return;
  const layer = document.createElement('div');
  layer.className = 'confetti';
  for (let i = 0; i < 46; i++) {
    const p = document.createElement('i');
    p.style.left = `${Math.random() * 100}%`;
    p.style.background = colors[i % colors.length];
    p.style.setProperty('--dx', `${(Math.random() - 0.5) * 160}px`);
    p.style.setProperty('--rot', `${Math.random() * 720 - 360}deg`);
    p.style.animationDelay = `${Math.random() * 0.25}s`;
    p.style.animationDuration = `${1.1 + Math.random() * 0.7}s`;
    layer.appendChild(p);
  }
  container.appendChild(layer);
  window.setTimeout(() => layer.remove(), 2200);
}
