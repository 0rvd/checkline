// Original vector art for the six chess figures, the ball and the goal nets.
// Drawn for Checkline; no third-party assets. Shared gradients live in SVG_DEFS (rendered once).
import { PIECES } from '../rules/config.js';
import type { PieceKind } from '../rules/types.js';

const BASE = '<path d="M23 90 H77 Q80 90 80 86 V82 Q80 75 71 75 H29 Q20 75 20 82 V86 Q20 90 23 90 Z"/>';

const SHAPES: Record<PieceKind, string> = {
  pawn:
    '<circle cx="50" cy="29" r="13"/>' +
    '<path d="M39 46 H61 Q61 51 56 52 Q60 62 64 75 H36 Q40 62 44 52 Q39 51 39 46 Z"/>',
  rook:
    '<path d="M29 18 H38.5 V26 H45.5 V18 H54.5 V26 H61.5 V18 H71 V37 Q71 41 66 41 H34 Q29 41 29 37 Z"/>' +
    '<path d="M35 44 H65 L68.5 75 H31.5 Z"/>',
  bishop:
    '<circle cx="50" cy="10" r="5"/>' +
    '<path d="M50 16 C63 26 65 40 59 50 H41 C35 40 37 26 50 16 Z M47 26 L56 35 L53 38 L44 29 Z" fill-rule="evenodd"/>' +
    '<path d="M42 54 H58 Q57 64 62 75 H38 Q43 64 42 54 Z"/>',
  knight:
    '<path d="M32 75 C32 61 37 54 44 48 C39 47 33 50 28 49 C24 48 22 43 25 39 C31 30 39 21 46 18 L47 9 L55 16 C67 19 74 32 73 47 C72 57 69 66 69 75 Z"/>' +
    '<circle cx="47" cy="29" r="3" class="eye"/>',
  queen:
    '<circle cx="27" cy="19" r="4.5"/><circle cx="39" cy="13" r="4.5"/><circle cx="50" cy="10" r="5"/><circle cx="61" cy="13" r="4.5"/><circle cx="73" cy="19" r="4.5"/>' +
    '<path d="M27 23 L37 40 L40 17 L47 36 L50 14 L53 36 L60 17 L63 40 L73 23 L67 47 H33 Z"/>' +
    '<path d="M36 51 H64 Q60 62 64 75 H36 Q40 62 36 51 Z"/>',
  king:
    '<path d="M46.5 3 H53.5 V9 H59.5 V16 H53.5 V22 H46.5 V16 H40.5 V9 H46.5 Z"/>' +
    '<path d="M31 44 Q27 25 50 24 Q73 25 69 44 Z"/>' +
    '<path d="M36 48 H64 Q60 62 64 75 H36 Q40 62 36 48 Z"/>',
};

/** Gradients used by every figure; include once per page (index.html renders it via the app). */
export const SVG_DEFS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>
  <linearGradient id="cl-fig-dark" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a342b"/><stop offset="1" stop-color="#16130f"/></linearGradient>
  <linearGradient id="cl-fig-light" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff9ec"/><stop offset=".6" stop-color="#efe3c8"/><stop offset="1" stop-color="#cdb98f"/></linearGradient>
  <linearGradient id="cl-fig-gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff1c2"/><stop offset=".55" stop-color="#e2b45a"/><stop offset="1" stop-color="#9a6e22"/></linearGradient>
  <radialGradient id="cl-ball" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#fff"/><stop offset=".7" stop-color="#e9e9e9"/><stop offset="1" stop-color="#9a9a9a"/></radialGradient>
  <radialGradient id="cl-ball-ember" cx=".35" cy=".3" r=".85"><stop offset="0" stop-color="#fff2c4"/><stop offset=".45" stop-color="#ff9a3c"/><stop offset="1" stop-color="#a3260f"/></radialGradient>
  <radialGradient id="cl-ball-frost" cx=".35" cy=".3" r=".85"><stop offset="0" stop-color="#ffffff"/><stop offset=".55" stop-color="#cdeeff"/><stop offset="1" stop-color="#5d9fd0"/></radialGradient>
  <radialGradient id="cl-ball-neon" cx=".35" cy=".3" r=".85"><stop offset="0" stop-color="#2a1748"/><stop offset=".7" stop-color="#120a26"/><stop offset="1" stop-color="#05030d"/></radialGradient>
  <radialGradient id="cl-ball-cosmic" cx=".35" cy=".3" r=".9"><stop offset="0" stop-color="#c9b6ff"/><stop offset=".35" stop-color="#6a4bd8"/><stop offset=".75" stop-color="#22145c"/><stop offset="1" stop-color="#0b0726"/></radialGradient>
  <radialGradient id="cl-ball-gold" cx=".35" cy=".3" r=".85"><stop offset="0" stop-color="#fff6d6"/><stop offset=".5" stop-color="#e8b84e"/><stop offset="1" stop-color="#8a5f17"/></radialGradient>
</defs></svg>`;

export function pieceSvg(kind: PieceKind): string {
  return `<svg class="figure" viewBox="0 0 100 100" aria-hidden="true">${SHAPES[kind]}${BASE}</svg>`;
}

/** The ball. Its parts have classes so ball skins (styles.css, :root[data-ball]) can recolour it. */
export const BALL_SVG =
  '<svg class="ball-icon" viewBox="0 0 24 24" aria-hidden="true">' +
  '<circle class="ball-body" cx="12" cy="12" r="10.5" fill="url(#cl-ball)" stroke="#111" stroke-width="1.3"/>' +
  '<g class="ball-panels"><path class="ball-patch" d="M12 7.2 L16.4 10.4 L14.7 15.6 H9.3 L7.6 10.4 Z" fill="#141414"/>' +
  '<path class="ball-seam" d="M12 7.2 V2 M16.4 10.4 L21.6 8.8 M14.7 15.6 L18 20 M9.3 15.6 L6 20 M7.6 10.4 L2.4 8.8" stroke="#141414" stroke-width="1.2"/></g>' +
  '</svg>';

/** Tiny movement diagram: 7x7 grid, piece in the centre, reachable squares dotted, pawn tackles crossed. */
export function moveDiagram(kind: PieceKind): string {
  const cells: string[] = [];
  const reach = new Set<string>();
  const add = (dc: number, dr: number) => reach.add(`${dc},${dr}`);
  const range = PIECES[kind].range;
  const steps = Array.from({ length: range }, (_, i) => i + 1);
  const dirs8 = [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  if (kind === 'king') dirs8.forEach(([c, r]) => add(c, r));
  if (kind === 'queen') dirs8.forEach(([c, r]) => steps.forEach((k) => add(c * k, r * k)));
  if (kind === 'rook') dirs8.slice(0, 4).forEach(([c, r]) => steps.forEach((k) => add(c * k, r * k)));
  if (kind === 'bishop') dirs8.slice(4).forEach(([c, r]) => steps.forEach((k) => add(c * k, r * k)));
  if (kind === 'knight') [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]].forEach(([c, r]) => add(c, r));
  const tackle = new Set<string>();
  if (kind === 'pawn') {
    add(0, 1);
    add(1, 0);
    add(-1, 0);
    tackle.add('1,1');
    tackle.add('-1,1');
  }
  for (let r = 3; r >= -3; r--) {
    for (let c = -3; c <= 3; c++) {
      const x = (c + 3) * 10;
      const y = (3 - r) * 10;
      const k = `${c},${r}`;
      cells.push(`<rect x="${x}" y="${y}" width="10" height="10" class="${(c + r + 6) % 2 ? 'd1' : 'd0'}"/>`);
      if (c === 0 && r === 0) cells.push(`<circle cx="${x + 5}" cy="${y + 5}" r="3.8" class="me"/>`);
      else if (reach.has(k)) cells.push(`<circle cx="${x + 5}" cy="${y + 5}" r="2.2" class="dot"/>`);
      else if (tackle.has(k)) cells.push(`<path d="M${x + 2.5} ${y + 2.5} L${x + 7.5} ${y + 7.5} M${x + 7.5} ${y + 2.5} L${x + 2.5} ${y + 7.5}" class="x"/>`);
    }
  }
  return `<svg class="move-diagram" viewBox="0 0 70 70" aria-hidden="true">${cells.join('')}</svg>`;
}
