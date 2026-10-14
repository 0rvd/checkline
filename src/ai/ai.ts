// Computer opponent (ruleset v3). Pure functions on top of the real rules engine: every candidate
// action comes from previewMoves / passOptions / shotTargets and is applied with applyAction, so
// the AI can never play an illegal move or see anything a human player cannot.
import {
  applyAction,
  carrier,
  coveredByKeeper,
  goalSquares,
  inGoalMouth,
  markedBy,
  other,
  passOptions,
  pieceMoves,
  previewMoves,
  scoringRow,
  shotTargets,
  turnsPlayed,
} from '../rules/engine.js';
import type { Action, MatchState, Square, Team } from '../rules/types.js';

export type Difficulty = 'easy' | 'medium' | 'hard';
export const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard'];

export interface AiOptions {
  difficulty: Difficulty;
  random?: () => number;
  /** Soft limit for Hard's search (ms). */
  timeBudgetMs?: number;
  now?: () => number;
}

/** Every legal action for the side to move except End Turn (Surge included while available). */
export function legalActions(state: MatchState): Action[] {
  if (state.phase !== 'playing') return [];
  const acts: Action[] = [];
  if (state.surge[state.turn]) acts.push({ type: 'surge' });
  if (state.ap <= 0) return acts;
  for (const p of state.pieces) {
    if (p.team !== state.turn || !p.pos) continue;
    for (const o of previewMoves(state, p.id).options) acts.push({ type: 'move', pieceId: p.id, to: { ...o.to } });
  }
  const c = carrier(state);
  if (c.team === state.turn) {
    for (const o of passOptions(state).options) acts.push({ type: 'pass', fromId: c.id, toId: o.toId });
    if (state.ap >= state.config.shotCost) for (const t of shotTargets(state)) if (!t.why) acts.push({ type: 'shoot', fromId: c.id, to: { ...t.at } });
  }
  return acts;
}

interface Step {
  state: MatchState;
  ended: boolean;
  goal: boolean;
}

function step(state: MatchState, a: Action): Step | null {
  const r = applyAction(state, a);
  if (!r.ok) return null;
  const goal = r.events.some((e) => e.type === 'goal');
  return { state: r.state, ended: goal || r.state.phase === 'finished' || r.state.turn !== state.turn, goal };
}

// ------------------------------------------------------------------ evaluation features

const onBoard = (s: MatchState, t: Team) => s.pieces.filter((p) => p.team === t && p.pos).length;

function openShots(s: MatchState): number {
  return shotTargets(s).filter((t) => !t.why).length;
}

function oneMoveTacklers(s: MatchState): number {
  const c = carrier(s);
  let n = 0;
  for (const p of s.pieces) {
    if (p.team === c.team || !p.pos) continue;
    if (pieceMoves(s, p).options.some((o) => o.kind === 'tackle')) n++;
  }
  return n;
}

/**
 * Fewest moves any opposing piece needs to reach the carrier's square (others frozen), up to
 * `limit`; Infinity if none can. Used by Hard to see multi-move pressure.
 */
export function movesToTackle(s: MatchState, limit = 3): number {
  const c = carrier(s);
  if (!c.pos) return Infinity;
  let best = Infinity;
  for (const p of s.pieces) {
    if (p.team === c.team || !p.pos) continue;
    const spec = s.config.pieces[p.kind];
    const reach = spec.pattern === 'knight' ? 2 : Math.max(1, spec.range);
    if (Math.max(Math.abs(p.pos.c - c.pos.c), Math.abs(p.pos.r - c.pos.r)) > reach * limit) continue;
    const seen = new Set<string>([`${p.pos.c},${p.pos.r}`]);
    let frontier: Square[] = [p.pos];
    for (let d = 1; d <= limit && d < best; d++) {
      const next: Square[] = [];
      for (const sq of frontier) {
        const moved = { ...p, pos: sq };
        const view: MatchState = { ...s, pieces: s.pieces.map((x) => (x.id === p.id ? moved : x)) };
        let hit = false;
        for (const o of pieceMoves(view, moved).options) {
          if (o.kind === 'tackle') {
            hit = true;
            break;
          }
          const k = `${o.to.c},${o.to.r}`;
          if (!seen.has(k)) {
            seen.add(k);
            next.push(o.to);
          }
        }
        if (hit) {
          best = Math.min(best, d);
          break;
        }
      }
      frontier = next;
    }
  }
  return best;
}

/**
 * Fewest AP for the ball to be scored using only the holder's moves, passes and a final shot
 * or dribble, with every other piece frozen. Infinity if no route within `limit`.
 */
export function apToGoal(s: MatchState, limit = 5): number {
  const c0 = carrier(s);
  if (!c0.pos) return Infinity;
  const team = c0.team;
  const opp = other(team);
  const goals = goalSquares(s.config, opp);
  type N = { id: string; c: number; r: number; cost: number };
  const queue: N[] = [{ id: c0.id, c: c0.pos.c, r: c0.pos.r, cost: 0 }];
  const seen = new Set<string>([`${c0.id}@${c0.pos.c},${c0.pos.r}`]);
  for (let qi = 0; qi < queue.length; qi++) {
    const n = queue[qi];
    if (n.cost >= limit) continue;
    const pieces = s.pieces.map((p) => (p.id === n.id ? { ...p, pos: { c: n.c, r: n.r } } : p));
    const grid = new Set(pieces.filter((p) => p.pos).map((p) => p.pos!.c * 16 + p.pos!.r));
    const occupied = (c: number, r: number) => grid.has(c * 16 + r);
    const view: MatchState = { ...s, pieces, carrierId: n.id };
    const clearLine = (dc: number, dr: number, dist: number) => {
      for (let k = 1; k < dist; k++) if (occupied(n.c + dc * k, n.r + dr * k)) return false;
      return true;
    };
    for (const g of goals) {
      const dc = g.c - n.c;
      const dr = g.r - n.r;
      if (dc !== 0 && dr !== 0 && Math.abs(dc) !== Math.abs(dr)) continue;
      const dist = Math.max(Math.abs(dc), Math.abs(dr));
      if (dist > s.config.shotRange || occupied(g.c, g.r) || coveredByKeeper(view, g, opp)) continue;
      if (clearLine(Math.sign(dc), Math.sign(dr), dist)) return n.cost + s.config.shotCost;
    }
    const holder = pieces.find((p) => p.id === n.id)!;
    for (const o of pieceMoves(view, holder).options) {
      if (o.kind !== 'move') continue;
      if (o.scores) return n.cost + 1;
      const k = `${n.id}@${o.to.c},${o.to.r}`;
      if (seen.has(k)) continue;
      seen.add(k);
      queue.push({ id: n.id, c: o.to.c, r: o.to.r, cost: n.cost + 1 });
    }
    for (const mate of pieces) {
      if (mate.team !== team || mate.id === n.id || !mate.pos) continue;
      const dc = mate.pos.c - n.c;
      const dr = mate.pos.r - n.r;
      if (dc !== 0 && dr !== 0 && Math.abs(dc) !== Math.abs(dr)) continue;
      const dist = Math.max(Math.abs(dc), Math.abs(dr));
      if (dist > s.config.passRange || !clearLine(Math.sign(dc), Math.sign(dr), dist)) continue;
      if (s.config.marking && markedBy(s, mate)) continue;
      const k = `${mate.id}@${mate.pos.c},${mate.pos.r}`;
      if (seen.has(k)) continue;
      seen.add(k);
      queue.push({ id: mate.id, c: mate.pos.c, r: mate.pos.r, cost: n.cost + 1 });
    }
  }
  return Infinity;
}

export interface EvalOptions {
  /** Hard: also count tackles that need 2-3 moves. */
  deepThreats?: boolean;
}

/**
 * Static evaluation from `team`'s point of view: score, material, possession, ball progress,
 * AP needed to score, open shots, tackle threats, pass support, Surge in hand and the clock.
 */
export function evaluate(s: MatchState, team: Team, eo: EvalOptions = {}): number {
  const opp = other(team);
  if (s.phase === 'finished') return s.winner === team ? 1e6 : s.winner === opp ? -1e6 : 0;
  let v = (s.score[team] - s.score[opp]) * 8000;
  const late = s.resetOnGoal ? Math.max(0, turnsPlayed(s) - s.config.regulationTurns + 10) / 10 : 0;
  v += (s.score[team] - s.score[opp]) * 3000 * late;
  v += (onBoard(s, team) - onBoard(s, opp)) * 60;
  v += (s.surge[team] ? 70 : 0) - (s.surge[opp] ? 70 : 0);

  const c = carrier(s);
  if (!c.pos) return v;
  const sign = c.team === team ? 1 : -1;
  const dist = Math.abs(scoringRow(s.config, c.team) - c.pos.r);
  let side = 450 + (s.config.rows - 1 - dist) * 40;
  const shots = openShots(s);
  side += shots > 0 ? 900 + (shots - 1) * 150 : 0;
  side += (6 - Math.min(apToGoal(s), 6)) * 110;
  const t1 = oneMoveTacklers(s);
  side -= Math.min(t1, 2) * 520;
  if (eo.deepThreats && t1 === 0) {
    const m = movesToTackle(s, 3);
    if (m === 2) side -= 330;
    else if (m === 3) side -= 150;
  }
  if (inGoalMouth(s.config, c.pos, c.team)) side -= 400;
  const probe: MatchState = { ...s, turn: c.team, ap: 1, phase: 'playing' };
  side += Math.min(passOptions(probe).options.length, 3) * 25;
  v += sign * side;
  return v;
}

function hashState(s: MatchState): string {
  let h = `${s.turn}${s.ap}${s.carrierId}${s.score.A}${s.score.B}${s.surge.A ? 1 : 0}${s.surge.B ? 1 : 0}|`;
  for (const p of s.pieces) h += p.pos ? `${p.pos.c}${p.pos.r.toString(16)}` : '--';
  return h;
}

// ------------------------------------------------------------------ difficulty strategies

/** Easy: legal but loose. Random with a forward lean; misses chances and wastes Surge. */
function planEasy(state: MatchState, rand: () => number): Action[] {
  const plan: Action[] = [];
  let s = state;
  const team = state.turn;
  while (s.turn === team && s.phase === 'playing') {
    const acts = legalActions(s).filter((a) => a.type !== 'surge' || rand() < 0.15);
    if (!acts.length || s.ap <= 0 || (plan.length > 0 && rand() < 0.2)) break;
    let chosen: Action | undefined;
    const shots = acts.filter((a) => a.type === 'shoot');
    if (shots.length && rand() < 0.6) chosen = shots[0];
    if (!chosen && rand() < 0.4) {
      const c = carrier(s);
      if (c.team === team) {
        const dir = team === 'A' ? 1 : -1;
        const fwd = acts.filter((a) => a.type === 'move' && a.pieceId === c.id && (a.to.r - c.pos!.r) * dir > 0);
        if (fwd.length) chosen = fwd[Math.floor(rand() * fwd.length)];
      }
    }
    if (!chosen) chosen = acts[Math.floor(rand() * acts.length)];
    const st = step(s, chosen);
    if (!st) break;
    plan.push(chosen);
    s = st.state;
    if (st.ended) return plan;
  }
  plan.push({ type: 'endTurn' });
  return plan;
}

/** Medium: one action at a time, best evaluated result; stops when nothing improves. */
function planMedium(state: MatchState, rand: () => number): Action[] {
  const plan: Action[] = [];
  let s = state;
  const team = state.turn;
  while (s.turn === team && s.phase === 'playing') {
    const base = evaluate(s, team);
    const scored = legalActions(s)
      .map((a) => {
        const st = step(s, a);
        return st ? { a, st, v: evaluate(st.state, team) + (rand() - 0.5) * 60 - (a.type === 'surge' ? 120 : 0) } : null;
      })
      .filter((x): x is { a: Action; st: Step; v: number } => !!x)
      .sort((x, y) => y.v - x.v);
    if (!scored.length) break;
    let pick = scored[0];
    if (scored.length > 1 && rand() < 0.12 && scored[0].v - scored[1].v < 120) pick = scored[1];
    if (pick.v <= base + 5) break;
    plan.push(pick.a);
    s = pick.st.state;
    if (pick.st.ended) return plan;
  }
  plan.push({ type: 'endTurn' });
  return plan;
}

interface Node {
  state: MatchState;
  actions: Action[];
  ended: boolean;
  v: number;
}

function beamLines(start: MatchState, team: Team, widths: number[], budgetLeft: () => boolean, eo: EvalOptions): Node[] {
  const all: Node[] = [{ state: start, actions: [], ended: false, v: evaluate(start, team, eo) }];
  let frontier = [all[0]];
  const seen = new Set<string>([hashState(start)]);
  for (let depth = 0; depth < widths.length && frontier.length; depth++) {
    const next: Node[] = [];
    for (const node of frontier) {
      if (node.ended || node.state.turn !== team) continue;
      for (const a of legalActions(node.state)) {
        const st = step(node.state, a);
        if (!st) continue;
        const h = hashState(st.state);
        if (seen.has(h)) continue;
        seen.add(h);
        const child: Node = { state: st.state, actions: [...node.actions, a], ended: st.ended, v: evaluate(st.state, team, eo) };
        next.push(child);
        all.push(child);
      }
      if (!budgetLeft()) break;
    }
    next.sort((x, y) => y.v - x.v);
    frontier = next.slice(0, widths[depth + 1] ?? 0);
    if (!budgetLeft()) break;
  }
  return all.sort((x, y) => y.v - x.v);
}

/** Greedy best value our side can reach this turn (Hard's third ply). */
function followUp(start: MatchState, team: Team, eo: EvalOptions): number {
  let s = start;
  let best = evaluate(s, team, eo);
  for (let guard = 0; guard < 6 && s.turn === team && s.phase === 'playing'; guard++) {
    let bestStep: Step | null = null;
    let bestV = best;
    for (const a of legalActions(s)) {
      const st = step(s, a);
      if (!st) continue;
      const v = evaluate(st.state, team, eo);
      if (v > bestV) {
        bestV = v;
        bestStep = st;
      }
    }
    if (!bestStep) break;
    best = bestV;
    s = bestStep.state;
    if (bestStep.ended) break;
  }
  return best;
}

/**
 * Hard: searches whole-turn sequences (including when to Surge), then tests the best lines
 * against the opponent's best reply and our own follow-up turn, within a time budget.
 */
function planHard(state: MatchState, opts: AiOptions): Action[] {
  const team = state.turn;
  const rand = opts.random ?? Math.random;
  const now = opts.now ?? (() => Date.now());
  const start = now();
  const budget = opts.timeBudgetMs ?? 1200;
  const budgetLeft = () => now() - start < budget;
  const eo: EvalOptions = { deepThreats: true };

  const lines = beamLines(state, team, [Infinity, 12, 8, 6, 4], budgetLeft, eo);
  const scoring = lines
    .filter((n) => n.state.score[team] > state.score[team])
    .sort((x, y) => x.actions.length - y.actions.length || y.v - x.v)[0];
  if (scoring) return finish(scoring);

  const candidates = lines.slice(0, 10);
  let best = candidates[0];
  let bestScore = -Infinity;
  for (const cand of candidates) {
    let after = cand.state;
    if (after.turn === team && after.phase === 'playing') {
      const r = applyAction(after, { type: 'endTurn' });
      if (r.ok) after = r.state;
    }
    let value: number;
    if (after.phase !== 'playing') {
      value = evaluate(after, team, eo);
    } else {
      const replies = beamLines(after, other(team), [Infinity, 6, 4, 3], () => now() - start < budget * 2, eo);
      let afterReply = replies[0].state;
      if (afterReply.turn !== team && afterReply.phase === 'playing') {
        const r = applyAction(afterReply, { type: 'endTurn' });
        if (r.ok) afterReply = r.state;
      }
      value = afterReply.phase !== 'playing' ? evaluate(afterReply, team, eo) : followUp(afterReply, team, eo);
      value = value * 0.8 + cand.v * 0.2 + rand() * 4;
    }
    if (value > bestScore) {
      bestScore = value;
      best = cand;
    }
    if (!budgetLeft()) break;
  }
  return finish(best);

  function finish(n: Node): Action[] {
    const plan = [...n.actions];
    if (!n.ended) plan.push({ type: 'endTurn' });
    return plan;
  }
}

/**
 * Plan the computer's whole turn. Returns actions in order; the last one is End Turn unless a
 * goal ends the turn first. Callers should stop if the turn changes mid-plan.
 */
export function planTurn(state: MatchState, opts: AiOptions): Action[] {
  if (state.phase !== 'playing') return [];
  const rand = opts.random ?? Math.random;
  switch (opts.difficulty) {
    case 'easy':
      return planEasy(state, rand);
    case 'medium':
      return planMedium(state, rand);
    case 'hard':
      return planHard(state, opts);
  }
}
