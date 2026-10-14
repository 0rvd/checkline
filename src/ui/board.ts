// Pitch rendering: squares, markings, goal nets, pieces and every tactical highlight
// (moves, tackles, passes, marked receivers, shooting lanes, keeper coverage, threats).
import {
  carrier,
  coveredByKeeper,
  getPiece,
  inGoalMouth,
  other,
  passOptions,
  pieceAt,
  previewMoves,
  shotTargets,
  squareName,
  tackleThreats,
} from '../rules/engine.js';
import type { MatchState, Piece, Square, Team } from '../rules/types.js';
import { escapeHtml, pieceLetter, pieceName, reasonText, t, teamName } from '../i18n/index.js';
import { BALL_SVG, pieceSvg } from './pieces.js';

export interface BoardView {
  game: MatchState;
  selected: string | null;
  cursor: Square;
  flipped: boolean;
  lastMove: Square[];
  /** Team whose pieces the local player may act with right now (null = nobody). */
  activeTeam: Team | null;
  ghost?: { piece: Piece; at: Square };
  gainId?: string;
  incomingId?: string;
  kickoff?: boolean;
  turnBanner?: string;
  bannerKind?: 'turn' | 'golden' | 'surge';
  rippleGoal?: Square;
  flash?: 'goal' | 'tackle' | 'surge';
  toast?: string | null;
}

const key = (sq: Square) => `${sq.c},${sq.r}`;

export function renderBoard(v: BoardView): string {
  const g = v.game;
  const cfg = g.config;
  const rows = Array.from({ length: cfg.rows }, (_, i) => (v.flipped ? i : cfg.rows - 1 - i));
  const cols = Array.from({ length: cfg.cols }, (_, i) => (v.flipped ? cfg.cols - 1 - i : i));
  const dc = (c: number) => (v.flipped ? cfg.cols - 1 - c : c);
  const dr = (r: number) => (v.flipped ? r : cfg.rows - 1 - r);

  const sel = v.selected ? getPiece(g, v.selected) : undefined;
  const moves = new Map<string, { kind: string; scores: boolean }>();
  const blocked = new Map<string, string>();
  const passes = new Set<string>();
  const blockedPasses = new Map<string, { text: string; marked: boolean }>();
  const shots = new Map<string, boolean>();
  let readOnly = false;
  let shotLines = '';
  if (sel?.pos) {
    const pv = previewMoves(g, sel.id);
    readOnly = sel.team !== g.turn || !!pv.unavailable || v.activeTeam !== sel.team;
    for (const o of pv.options) moves.set(key(o.to), { kind: o.kind, scores: o.scores });
    for (const b of pv.blocked) blocked.set(key(b.at), reasonText(b.why));
    if (sel.id === g.carrierId && !readOnly) {
      const po = passOptions(g);
      for (const o of po.options) passes.add(key(o.at));
      for (const b of po.blocked) blockedPasses.set(key(b.at), { text: reasonText(b.why), marked: b.why.code === 'receiver_marked' });
      if (g.ap >= cfg.shotCost) {
        for (const tgt of shotTargets(g)) {
          if (tgt.why) continue;
          shots.set(key(tgt.at), true);
          const x1 = dc(sel.pos.c) + 0.5;
          const y1 = dr(sel.pos.r) + 0.5;
          const x2 = dc(tgt.at.c) + 0.5;
          const y2 = dr(tgt.at.r) + 0.5;
          shotLines += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" vector-effect="non-scaling-stroke"/>`;
        }
      }
    }
  }
  // When the opponent of the side to move holds the ball, show where it could shoot next turn.
  const danger = new Set<string>();
  let dangerLines = '';
  const holder = carrier(g);
  if (g.phase === 'playing' && holder.pos && holder.team !== g.turn) {
    for (const tgt of shotTargets(g)) {
      if (tgt.why) continue;
      danger.add(key(tgt.at));
      dangerLines += `<line class="danger" x1="${dc(holder.pos.c) + 0.5}" y1="${dr(holder.pos.r) + 0.5}" x2="${dc(tgt.at.c) + 0.5}" y2="${dr(tgt.at.r) + 0.5}" vector-effect="non-scaling-stroke"/>`;
    }
  }
  shotLines += dangerLines;
  const threats = g.phase === 'playing' ? tackleThreats(g) : [];
  const threatKeys = new Set(sel?.id === g.carrierId ? threats.map((p) => key(p.pos!)) : []);
  const last = new Set(v.lastMove.map(key));

  const cells: string[] = [];
  rows.forEach((r, ri) => {
    cols.forEach((c, ci) => {
      const sq = { c, r };
      const k = key(sq);
      const p = pieceAt(g, sq);
      const cls = ['cell', r % 2 ? 'band1' : 'band0', (c + r) % 2 ? 'alt' : ''];
      for (const team of ['A', 'B'] as Team[]) {
        if (inGoalMouth(cfg, sq, team)) {
          cls.push('goal-mouth', `goal-${team}`);
          if (coveredByKeeper(g, sq, team)) cls.push('covered');
        }
      }
      if (last.has(k)) cls.push('last');
      const isCursor = v.cursor.c === c && v.cursor.r === r;
      if (isCursor) cls.push('cursor');
      if (v.rippleGoal && v.rippleGoal.c === c && v.rippleGoal.r === r) cls.push('ripple');
      const mv = moves.get(k);
      let marker = '';
      let hint = '';
      if (shots.has(k)) {
        cls.push('shot-target');
        marker = '<span class="marker shot"></span>';
        hint = t('board.hint.shoot');
      } else if (mv) {
        cls.push(readOnly ? 'reach' : mv.kind === 'tackle' ? 'tackle-target' : 'move-target');
        if (mv.scores && !readOnly) cls.push('score-target');
        marker = `<span class="marker ${mv.kind}${mv.scores ? ' scores' : ''}"></span>`;
        hint = readOnly
          ? t('board.hint.reach')
          : mv.kind === 'tackle'
            ? mv.scores
              ? t('board.hint.score')
              : t('board.hint.tackle')
            : mv.scores
              ? t('board.hint.score')
              : t('board.hint.move');
      } else if (blocked.has(k) && !p) {
        cls.push('blocked');
        marker = '<span class="marker blocked"></span>';
        hint = t('board.hint.blocked', { reason: blocked.get(k)! });
      }
      if (passes.has(k)) {
        cls.push('pass-target');
        hint = t('board.hint.pass');
      } else if (blockedPasses.has(k)) {
        cls.push(blockedPasses.get(k)!.marked ? 'pass-marked' : 'pass-blocked');
        hint = t('board.hint.passBlocked', { reason: blockedPasses.get(k)!.text });
      }
      if (threatKeys.has(k)) cls.push('threat-source');
      if (danger.has(k)) {
        cls.push('danger-shot');
        if (!hint) hint = t('board.hint.danger');
      }
      const title = blocked.get(k) ?? blockedPasses.get(k)?.text ?? '';
      const token = p ? renderToken(g, p, threats.length > 0, v) : '';
      const ghost =
        v.ghost && v.ghost.at.c === c && v.ghost.at.r === r
          ? `<div class="token ghost team-${v.ghost.piece.team}">${pieceSvg(v.ghost.piece.kind)}</div>`
          : '';
      const name = squareName(sq);
      const desc = p
        ? t(p.id === g.carrierId ? 'board.withBall' : 'board.piece', { sq: name, team: teamName(p.team), piece: pieceName(p.kind) })
        : t('board.empty', { sq: name });
      cells.push(
        `<button class="${cls.filter(Boolean).join(' ')}" style="grid-row:${ri + 1};grid-column:${ci + 1}"` +
          ` data-act="cell" data-c="${c}" data-r="${r}" tabindex="${isCursor ? 0 : -1}"` +
          ` aria-label="${escapeHtml(desc + hint)}"${title ? ` title="${escapeHtml(title)}"` : ''}>${marker}${token}${ghost}</button>`,
      );
    });
  });

  const rankLabels = rows.map((r) => `<span>${r + 1}</span>`).join('');
  const fileLabels = cols.map((c) => `<span>${String.fromCharCode(65 + c)}</span>`).join('');
  const topTeam: Team = v.flipped ? 'A' : 'B';
  const bottomTeam = other(topTeam);
  const goalLabel = (team: Team) =>
    `<span class="team-dot ${team}"></span>${escapeHtml(t('board.goal', { team: teamName(team), row: team === 'A' ? 1 : cfg.rows }))}`;
  const net = (pos: 'top' | 'bottom', team: Team) =>
    `<div class="net ${pos} team-${team}" style="--goal-from:${cfg.goalCols[0]};--goal-span:${cfg.goalCols[1] - cfg.goalCols[0] + 1}" aria-hidden="true"><i></i></div>`;
  const banner = v.turnBanner
    ? `<div class="turn-banner ${v.bannerKind ?? 'turn'}" aria-hidden="true"><span>${escapeHtml(v.turnBanner)}</span></div>`
    : '';
  return `
    <div class="board-frame ${v.flash ? 'flash-' + v.flash : ''}">
      <div class="end-label top">${goalLabel(topTeam)}</div>
      <div class="board-wrap" dir="ltr" style="--cols:${cfg.cols};--rows:${cfg.rows}">
        <span class="corner"></span>${net('top', topTeam)}
        <div class="ranks" aria-hidden="true">${rankLabels}</div>
        <div class="board" role="grid" aria-label="${escapeHtml(t('board.aria', { cols: cfg.cols, rows: cfg.rows }))}">
          ${cells.join('')}
          ${renderMarkings(cfg.cols, cfg.rows, cfg.goalCols)}
          ${shotLines ? `<svg class="shot-lines" viewBox="0 0 ${cfg.cols} ${cfg.rows}" preserveAspectRatio="none" aria-hidden="true">${shotLines}</svg>` : ''}
          ${banner}
        </div>
        <span class="corner"></span>${net('bottom', bottomTeam)}
        <span class="corner"></span><div class="files" aria-hidden="true">${fileLabels}</div>
      </div>
      <div class="end-label bottom">${goalLabel(bottomTeam)}</div>
      ${v.toast ? `<div class="toast" role="alert">${escapeHtml(v.toast)}</div>` : ''}
    </div>`;
}

function renderMarkings(cols: number, rows: number, goal: [number, number]): string {
  const mid = rows / 2;
  const s = 'vector-effect="non-scaling-stroke"';
  const gx = goal[0];
  const gw = goal[1] - goal[0] + 1;
  return `
    <svg class="markings" viewBox="0 0 ${cols} ${rows}" preserveAspectRatio="none" aria-hidden="true">
      <rect x="0.04" y="0.04" width="${cols - 0.08}" height="${rows - 0.08}" ${s}/>
      <line x1="0" y1="${mid}" x2="${cols}" y2="${mid}" ${s}/>
      <circle cx="${cols / 2}" cy="${mid}" r="1.2" ${s}/>
      <circle cx="${cols / 2}" cy="${mid}" r="0.08" class="spot"/>
      <rect x="${gx}" y="0.04" width="${gw}" height="2" ${s} class="box"/>
      <rect x="${gx}" y="${rows - 2}" width="${gw}" height="1.96" ${s} class="box"/>
      <line x1="${gx}" y1="1" x2="${gx + gw}" y2="1" ${s} class="goal-line"/>
      <line x1="${gx}" y1="${rows - 1}" x2="${gx + gw}" y2="${rows - 1}" ${s} class="goal-line"/>
      <circle cx="${cols / 2}" cy="3" r="0.07" class="spot"/>
      <circle cx="${cols / 2}" cy="${rows - 3}" r="0.07" class="spot"/>
    </svg>`;
}

export function renderToken(g: MatchState, p: Piece, threatened: boolean, v?: BoardView): string {
  const isCarrier = p.id === g.carrierId;
  const cls = ['token', `team-${p.team}`, `kind-${p.kind}`];
  if (isCarrier) cls.push('carrier');
  if (isCarrier && threatened) cls.push('threatened');
  if (v && p.id === v.selected) cls.push('selected');
  if (v && p.team === v.activeTeam && g.phase === 'playing') cls.push('active-team');
  if (v?.gainId === p.id) cls.push('gain');
  if (v?.incomingId === p.id) cls.push('incoming');
  if (v?.kickoff && isCarrier) cls.push('kickoff');
  return `<div class="${cls.join(' ')}" data-piece="${p.id}">
    ${pieceSvg(p.kind)}
    <span class="letter">${pieceLetter(p.kind)}</span>
    ${isCarrier ? `<span class="ball">${BALL_SVG}</span>` : ''}
  </div>`;
}
