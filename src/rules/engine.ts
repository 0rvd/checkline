// Checkline rules engine (ruleset v3): pure functions over MatchState. No DOM access.
// Every action returns a new state; invalid actions return the original state untouched.
// The server mirror lives in supabase/setup.sql (checkline_private.*) and must stay in step:
// `npm run verify:sql` compares the two on thousands of actions.
import { DEFAULT_CONFIG } from './config.js';
import { formatReasonEn, why } from './reasons.js';
import type {
  Action,
  ActionResult,
  BlockedPass,
  BlockedSquare,
  GameEvent,
  MatchState,
  MoveOption,
  MovePreview,
  PassOption,
  Piece,
  PieceKind,
  Reason,
  RulesConfig,
  ShotTarget,
  Square,
  Team,
} from './types.js';

// ---------------------------------------------------------------- geometry

export const other = (t: Team): Team => (t === 'A' ? 'B' : 'A');

export function squareName(sq: Square): string {
  return String.fromCharCode(65 + sq.c) + String(sq.r + 1);
}

export function parseSquare(name: string): Square {
  const m = /^([A-Za-z])(\d{1,2})$/.exec(name.trim());
  if (!m) throw new Error(`Bad square "${name}"`);
  return { c: m[1].toUpperCase().charCodeAt(0) - 65, r: Number(m[2]) - 1 };
}

export const sameSquare = (a: Square | null | undefined, b: Square | null | undefined): boolean =>
  !!a && !!b && a.c === b.c && a.r === b.r;

export const onBoard = (cfg: RulesConfig, sq: Square): boolean =>
  sq.c >= 0 && sq.c < cfg.cols && sq.r >= 0 && sq.r < cfg.rows;

/** The goal line a team defends. Team A: row 1, Team B: row 12. */
export const goalRow = (cfg: RulesConfig, team: Team): number => (team === 'A' ? 0 : cfg.rows - 1);

/** The goal line a team attacks. */
export const scoringRow = (cfg: RulesConfig, team: Team): number => goalRow(cfg, other(team));

export const forwardDir = (team: Team): 1 | -1 => (team === 'A' ? 1 : -1);

export function forTeam(cfg: RulesConfig, team: Team, sq: Square): Square {
  return team === 'A' ? { c: sq.c, r: sq.r } : { c: sq.c, r: cfg.rows - 1 - sq.r };
}

/** Is `sq` one of the goal-mouth squares defended by `team`? */
export function inGoalMouth(cfg: RulesConfig, sq: Square, team: Team): boolean {
  return sq.r === goalRow(cfg, team) && sq.c >= cfg.goalCols[0] && sq.c <= cfg.goalCols[1];
}

/** Is `sq` inside the keeper box of `team`? */
export function inBox(cfg: RulesConfig, sq: Square, team: Team): boolean {
  return sq.c >= cfg.goalCols[0] && sq.c <= cfg.goalCols[1] && Math.abs(sq.r - goalRow(cfg, team)) < cfg.boxDepth;
}

export function goalSquares(cfg: RulesConfig, defending: Team): Square[] {
  const out: Square[] = [];
  for (let c = cfg.goalCols[0]; c <= cfg.goalCols[1]; c++) out.push({ c, r: goalRow(cfg, defending) });
  return out;
}

const chebyshev = (a: Square, b: Square) => Math.max(Math.abs(a.c - b.c), Math.abs(a.r - b.r));

// ---------------------------------------------------------------- lookups

export function getPiece(state: MatchState, id: string): Piece | undefined {
  return state.pieces.find((p) => p.id === id);
}

export function pieceAt(state: MatchState, sq: Square): Piece | undefined {
  return state.pieces.find((p) => p.pos && p.pos.c === sq.c && p.pos.r === sq.r);
}

export function carrier(state: MatchState): Piece {
  const p = getPiece(state, state.carrierId);
  if (!p) throw new Error('Ball carrier missing');
  return p;
}

export function keeperOf(state: MatchState, team: Team): Piece | undefined {
  return state.pieces.find((p) => p.team === team && p.kind === 'king' && p.pos);
}

/** A goal square is covered when the defending keeper stands on it or next to it. */
export function coveredByKeeper(state: MatchState, sq: Square, defending: Team): boolean {
  const k = keeperOf(state, defending);
  return !!k?.pos && chebyshev(k.pos, sq) <= 1;
}

export const pieceName = (state: MatchState, p: Piece): string => state.config.pieces[p.kind].name;

/** Turns already completed (both sides). */
export const turnsPlayed = (s: MatchState): number => s.turnNumber - 1;
/** Golden goal: regulation is over and the score is level. */
export const isGoldenGoal = (s: MatchState): boolean => s.resetOnGoal && turnsPlayed(s) >= s.config.regulationTurns && s.phase === 'playing';

// ---------------------------------------------------------------- setup

export function validateConfig(cfg: RulesConfig): void {
  const seen = new Set<string>();
  for (const team of ['A', 'B'] as Team[]) {
    for (const slot of cfg.formation) {
      const sq = forTeam(cfg, team, slot);
      if (!onBoard(cfg, sq)) throw new Error(`Formation slot ${slot.slot} is off the board`);
      const key = `${sq.c},${sq.r}`;
      if (seen.has(key)) throw new Error(`Formation overlap at ${squareName(sq)}`);
      seen.add(key);
      if (slot.kind === 'king' && !inBox(cfg, sq, team)) throw new Error('The keeper must start in its box');
      if (slot.kind !== 'king' && inGoalMouth(cfg, sq, team)) throw new Error('Only the keeper may start in the goal mouth');
    }
  }
  for (const team of ['A', 'B'] as Team[]) {
    const ko = forTeam(cfg, team, cfg.kickoff);
    const clash = cfg.formation.some(
      (s) =>
        (s.slot !== cfg.kickoff.slot && sameSquare(forTeam(cfg, team, s), ko)) || sameSquare(forTeam(cfg, other(team), s), ko),
    );
    if (clash) throw new Error(`Kickoff square ${squareName(ko)} collides with the formation`);
  }
}

function formationPieces(cfg: RulesConfig): Piece[] {
  const pieces: Piece[] = [];
  for (const team of ['A', 'B'] as Team[]) {
    for (const slot of cfg.formation) {
      pieces.push({ id: `${team}-${slot.slot}`, team, kind: slot.kind, pos: forTeam(cfg, team, slot) });
    }
  }
  return pieces;
}

/** Everyone back to formation (benched pieces return), Surge refreshed, kickoff to `team`. */
function resetRally(state: MatchState, team: Team): GameEvent {
  const cfg = state.config;
  state.pieces = formationPieces(cfg);
  const kickId = `${team}-${cfg.kickoff.slot}`;
  getPiece(state, kickId)!.pos = forTeam(cfg, team, cfg.kickoff);
  state.carrierId = kickId;
  state.turn = team;
  state.kickoffTeam = team;
  state.ap = cfg.apPerTurn;
  state.surge = { A: true, B: true };
  return { type: 'kickoff', team, carrierId: kickId };
}

export interface CreateMatchOptions {
  config?: RulesConfig;
  firstTeam?: Team;
  random?: () => number;
}

export function createMatch(opts: CreateMatchOptions = {}): MatchState {
  const config = opts.config ?? DEFAULT_CONFIG;
  validateConfig(config);
  const first: Team = opts.firstTeam ?? ((opts.random ?? Math.random)() < 0.5 ? 'A' : 'B');
  const state: MatchState = {
    config,
    pieces: [],
    carrierId: '',
    turn: first,
    ap: config.apPerTurn,
    score: { A: 0, B: 0 },
    rally: 1,
    turnNumber: 1,
    kickoffTeam: first,
    phase: 'playing',
    winner: null,
    capturesBy: { A: 0, B: 0 },
    surge: { A: true, B: true },
    resetOnGoal: true,
  };
  resetRally(state, first);
  return state;
}

export interface ScenarioPiece {
  id?: string;
  team: Team;
  kind: PieceKind;
  at: string;
}

export interface ScenarioOptions {
  config?: RulesConfig;
  pieces: ScenarioPiece[];
  carrier: string;
  turn?: Team;
  ap?: number;
  score?: Record<Team, number>;
  surge?: Record<Team, boolean>;
  turnNumber?: number;
  /** true = full match rules (reset after goals, match clock). Tutorials use false. */
  resetOnGoal?: boolean;
}

export function createScenario(opts: ScenarioOptions): MatchState {
  const config = opts.config ?? DEFAULT_CONFIG;
  const counters: Record<string, number> = {};
  const pieces: Piece[] = opts.pieces.map((sp) => {
    const letter = config.pieces[sp.kind].letter;
    const key = `${sp.team}-${letter}`;
    counters[key] = (counters[key] ?? 0) + 1;
    return { id: sp.id ?? `${key}${counters[key]}`, team: sp.team, kind: sp.kind, pos: parseSquare(sp.at) };
  });
  const state: MatchState = {
    config,
    pieces,
    carrierId: '',
    turn: opts.turn ?? 'A',
    ap: opts.ap ?? config.apPerTurn,
    score: opts.score ? { ...opts.score } : { A: 0, B: 0 },
    rally: 1,
    turnNumber: opts.turnNumber ?? 1,
    kickoffTeam: opts.turn ?? 'A',
    phase: 'playing',
    winner: null,
    capturesBy: { A: 0, B: 0 },
    surge: opts.surge ? { ...opts.surge } : { A: true, B: true },
    resetOnGoal: opts.resetOnGoal ?? false,
  };
  const byId = getPiece(state, opts.carrier);
  const bySq = /^[A-Za-z]\d{1,2}$/.test(opts.carrier) ? pieceAt(state, parseSquare(opts.carrier)) : undefined;
  const c = byId ?? bySq;
  if (!c) throw new Error(`Scenario carrier "${opts.carrier}" not found`);
  state.carrierId = c.id;
  return state;
}

function clone(state: MatchState): MatchState {
  return {
    ...state,
    pieces: state.pieces.map((p) => ({ ...p, pos: p.pos ? { ...p.pos } : null })),
    score: { ...state.score },
    capturesBy: { ...state.capturesBy },
    surge: { ...state.surge },
  };
}

// ---------------------------------------------------------------- movement

const ORTH: [number, number][] = [
  [0, 1],
  [0, -1],
  [-1, 0],
  [1, 0],
];
const DIAG: [number, number][] = [
  [-1, 1],
  [1, 1],
  [-1, -1],
  [1, -1],
];
const ALL8 = [...ORTH, ...DIAG];
const KNIGHT: [number, number][] = [
  [1, 2],
  [2, 1],
  [2, -1],
  [1, -2],
  [-1, -2],
  [-2, -1],
  [-2, 1],
  [-1, 2],
];

/** Can piece `p` stand on empty square `sq`? Returns a reason if not, plus whether it scores. */
function landingRule(state: MatchState, p: Piece, sq: Square): { why: Reason | null; scores: boolean } {
  const cfg = state.config;
  const opp = other(p.team);
  if (p.kind === 'king' && !inBox(cfg, sq, p.team)) return { why: why('keeper_box'), scores: false };
  if (inGoalMouth(cfg, sq, p.team) && p.kind !== 'king') return { why: why('goal_mouth'), scores: false };
  if (inGoalMouth(cfg, sq, opp)) {
    if (p.id !== state.carrierId) return { why: why('goal_mouth'), scores: false };
    if (coveredByKeeper(state, sq, opp)) return { why: why('covered_by_keeper', { sq: squareName(sq) }), scores: false };
    return { why: null, scores: true };
  }
  return { why: null, scores: false };
}

/**
 * Where a piece can go (ignores whose turn it is and AP). Options are moves or tackles;
 * `blocked` lists squares in its pattern it cannot use, with a reason.
 */
export function pieceMoves(state: MatchState, p: Piece): { options: MoveOption[]; blocked: BlockedSquare[] } {
  const cfg = state.config;
  const options: MoveOption[] = [];
  const blocked: BlockedSquare[] = [];
  if (!p.pos) return { options, blocked };
  const from = p.pos;
  const spec = cfg.pieces[p.kind];
  // Dribbling is slow: the ball carrier slides only one square (Knights still jump their L).
  const range = p.id === state.carrierId ? 1 : spec.range;
  const block = (sq: Square, w: Reason) => blocked.push({ at: sq, reason: formatReasonEn(w), why: w });

  /** Evaluate a landing square. Returns true if the square is occupied (stops a slide). */
  const consider = (sq: Square, allowTackle: boolean, allowMove: boolean): boolean => {
    const occ = pieceAt(state, sq);
    if (occ) {
      if (occ.team === p.team) block(sq, why('occupied_own', { kind: occ.kind, sq: squareName(sq) }));
      else if (occ.id !== state.carrierId) block(sq, why('opponent_blocks', { kind: occ.kind, sq: squareName(sq) }));
      else if (!allowTackle) block(sq, why('pawn_tackle'));
      else if (p.kind === 'king' && !inBox(cfg, sq, p.team)) block(sq, why('keeper_box'));
      else options.push({ to: { ...sq }, kind: 'tackle', scores: inGoalMouth(cfg, sq, other(p.team)) });
      return true;
    }
    if (!allowMove) return false;
    const land = landingRule(state, p, sq);
    if (land.why) block(sq, land.why);
    else options.push({ to: { ...sq }, kind: 'move', scores: land.scores });
    return false;
  };

  const slide = (dirs: [number, number][], range: number) => {
    for (const [dc, dr] of dirs) {
      let stopped = false;
      for (let k = 1; k <= range; k++) {
        const sq = { c: from.c + dc * k, r: from.r + dr * k };
        if (!onBoard(cfg, sq)) break;
        if (stopped) {
          block(sq, why('path_blocked', { sq: squareName(sq) }));
          continue;
        }
        if (consider(sq, true, true)) stopped = true;
      }
    }
  };

  switch (spec.pattern) {
    case 'king':
      for (const [dc, dr] of ALL8) {
        const sq = { c: from.c + dc, r: from.r + dr };
        if (onBoard(cfg, sq)) consider(sq, true, true);
      }
      break;
    case 'queen':
      slide(ALL8, range);
      break;
    case 'rook':
      slide(ORTH, range);
      break;
    case 'bishop':
      slide(DIAG, range);
      break;
    case 'knight':
      for (const [dc, dr] of KNIGHT) {
        const sq = { c: from.c + dc, r: from.r + dr };
        if (onBoard(cfg, sq)) consider(sq, true, true);
      }
      break;
    case 'pawn': {
      const f = forwardDir(p.team);
      for (const [dc, dr] of [
        [0, f],
        [-1, 0],
        [1, 0],
      ] as [number, number][]) {
        const sq = { c: from.c + dc, r: from.r + dr };
        if (onBoard(cfg, sq)) consider(sq, false, true);
      }
      for (const dc of [-1, 1]) {
        const sq = { c: from.c + dc, r: from.r + f };
        if (!onBoard(cfg, sq)) continue;
        const occ = pieceAt(state, sq);
        if (occ && occ.team !== p.team && occ.id === state.carrierId) consider(sq, true, false);
      }
      break;
    }
  }
  return { options, blocked };
}

function unavailableReason(state: MatchState, p: Piece | undefined, cost: number): Reason | undefined {
  if (!p) return why('unknown_piece');
  if (state.phase === 'finished') return why('match_over');
  if (p.team !== state.turn) return why('not_your_turn', { team: state.turn });
  if (!p.pos) return why('captured');
  if (state.ap < cost) return why('no_ap');
  return undefined;
}

export function previewMoves(state: MatchState, pieceId: string): MovePreview {
  const p = getPiece(state, pieceId);
  if (!p) return { options: [], blocked: [], unavailable: 'Unknown piece', unavailableWhy: why('unknown_piece') };
  const geo = pieceMoves(state, p);
  const u = unavailableReason(state, p, 1);
  return { ...geo, unavailable: u && formatReasonEn(u), unavailableWhy: u };
}

/** Opposing pieces that could tackle the current carrier with a single move. */
export function tackleThreats(state: MatchState): Piece[] {
  const c = carrier(state);
  if (!c.pos) return [];
  return state.pieces.filter(
    (p) => p.team !== c.team && p.pos && pieceMoves(state, p).options.some((o) => o.kind === 'tackle'),
  );
}

// ---------------------------------------------------------------- passing & shooting

/** Straight-line geometry between two squares: step direction and distance, or null if not aligned. */
function line(a: Square, b: Square): { dc: number; dr: number; dist: number } | null {
  const dc = b.c - a.c;
  const dr = b.r - a.r;
  if (dc === 0 && dr === 0) return null;
  if (dc !== 0 && dr !== 0 && Math.abs(dc) !== Math.abs(dr)) return null;
  return { dc: Math.sign(dc), dr: Math.sign(dr), dist: Math.max(Math.abs(dc), Math.abs(dr)) };
}

function firstBlocker(state: MatchState, from: Square, l: { dc: number; dr: number; dist: number }): Piece | undefined {
  for (let k = 1; k < l.dist; k++) {
    const p = pieceAt(state, { c: from.c + l.dc * k, r: from.r + l.dr * k });
    if (p) return p;
  }
  return undefined;
}

/** The first opponent directly beside `p` (up/down/left/right): `p` is marked and cannot receive a pass. */
export function markedBy(state: MatchState, p: Piece): Piece | undefined {
  if (!p.pos) return undefined;
  return state.pieces.find((o) => o.team !== p.team && o.pos && Math.abs(o.pos.c - p.pos!.c) + Math.abs(o.pos.r - p.pos!.r) === 1);
}

export function passOptions(state: MatchState): {
  options: PassOption[];
  blocked: BlockedPass[];
  unavailable?: string;
  unavailableWhy?: Reason;
} {
  const cfg = state.config;
  const from = carrier(state);
  const unavailableWhy = unavailableReason(state, from, 1);
  const unavailable = unavailableWhy && formatReasonEn(unavailableWhy);
  const options: PassOption[] = [];
  const blocked: BlockedPass[] = [];
  if (!from.pos) return { options, blocked, unavailable, unavailableWhy };
  for (const mate of state.pieces) {
    if (mate.team !== from.team || mate.id === from.id || !mate.pos) continue;
    const l = line(from.pos, mate.pos);
    if (!l) continue;
    if (l.dist > cfg.passRange) {
      const w = why('pass_out_of_range', { kind: mate.kind, dist: l.dist, range: cfg.passRange });
      blocked.push({ toId: mate.id, at: { ...mate.pos }, reason: formatReasonEn(w), why: w });
      continue;
    }
    const b = firstBlocker(state, from.pos, l);
    if (b) {
      const w = why('pass_lane_blocked', { kind: b.kind, sq: squareName(b.pos!), team: b.team });
      blocked.push({ toId: mate.id, at: { ...mate.pos }, reason: formatReasonEn(w), why: w });
      continue;
    }
    if (cfg.marking && markedBy(state, mate)) {
      const w = why('receiver_marked', { kind: mate.kind, sq: squareName(mate.pos) });
      blocked.push({ toId: mate.id, at: { ...mate.pos }, reason: formatReasonEn(w), why: w });
      continue;
    }
    options.push({ toId: mate.id, at: { ...mate.pos } });
  }
  return { options, blocked, unavailable, unavailableWhy };
}

/** Why a shot from `from` (by `team`) at goal square `to` is impossible, or null if it scores. */
function shotProblem(state: MatchState, team: Team, from: Square, to: Square): Reason | null {
  const cfg = state.config;
  const opp = other(team);
  if (!inGoalMouth(cfg, to, opp)) return why('shot_not_goal');
  const l = line(from, to);
  if (!l) return why('not_in_line');
  if (l.dist > cfg.shotRange) return why('shot_out_of_range', { dist: l.dist, range: cfg.shotRange });
  const b = firstBlocker(state, from, l);
  if (b) return why('shot_blocked', { kind: b.kind, sq: squareName(b.pos!) });
  if (pieceAt(state, to) || coveredByKeeper(state, to, opp)) return why('covered_by_keeper', { sq: squareName(to) });
  return null;
}

/** Every square of the opponent goal mouth, with whether the current carrier could score there. */
export function shotTargets(state: MatchState): ShotTarget[] {
  const c = carrier(state);
  if (!c.pos) return [];
  return goalSquares(state.config, other(c.team)).map((at) => ({ at, why: shotProblem(state, c.team, c.pos!, at) }));
}

// ---------------------------------------------------------------- actions

const fail = (state: MatchState, w: Reason): ActionResult => ({ ok: false, state, reason: formatReasonEn(w), why: w });

/** Match clock: full time, golden goal, draw. Only for real matches (resetOnGoal). */
function clockCheck(s: MatchState, events: GameEvent[]): void {
  if (!s.resetOnGoal || s.phase === 'finished') return;
  const cfg = s.config;
  const done = turnsPlayed(s);
  const lead: Team | null = s.score.A === s.score.B ? null : s.score.A > s.score.B ? 'A' : 'B';
  if (done >= cfg.regulationTurns && lead) {
    finish(s, lead, events);
  } else if (done >= cfg.maxTurns) {
    finish(s, null, events);
  } else if (done === cfg.regulationTurns) {
    events.push({ type: 'goldenGoal' });
  }
}

function finish(s: MatchState, winner: Team | null, events: GameEvent[]): void {
  s.phase = 'finished';
  s.winner = winner;
  s.ap = 0;
  events.push({ type: 'fullTime', winner });
}

function scoreGoal(s: MatchState, team: Team, scorerId: string, events: GameEvent[]): void {
  s.score[team] += 1;
  events.push({ type: 'goal', team, score: { ...s.score }, carrierId: scorerId });
  const golden = s.resetOnGoal && turnsPlayed(s) >= s.config.regulationTurns;
  if (s.score[team] >= s.config.goalsToWin || golden) {
    s.phase = 'finished';
    s.winner = team;
    s.ap = 0;
    events.push({ type: 'win', team });
    return;
  }
  if (!s.resetOnGoal) return;
  s.rally += 1;
  s.turnNumber += 1;
  events.push(resetRally(s, other(team)));
  clockCheck(s, events);
}

function validSquare(to: unknown): to is Square {
  const t = to as Square;
  return !!t && Number.isInteger(t.c) && Number.isInteger(t.r);
}

export function applyAction(state: MatchState, action: Action): ActionResult {
  const cfg = state.config;
  if (state.phase === 'finished') return fail(state, why('match_over'));

  switch (action.type) {
    case 'endTurn': {
      const next = clone(state);
      const apLost = next.ap;
      next.turn = other(state.turn);
      next.ap = cfg.apPerTurn;
      next.turnNumber += 1;
      const events: GameEvent[] = [{ type: 'turnEnd', team: state.turn, apLost, next: next.turn }];
      clockCheck(next, events);
      return { ok: true, state: next, events };
    }

    case 'surge': {
      if (!state.surge[state.turn]) return fail(state, why('no_surge'));
      const next = clone(state);
      next.surge[state.turn] = false;
      next.ap += cfg.surgeAp;
      return { ok: true, state: next, events: [{ type: 'surge', team: state.turn }] };
    }

    case 'move': {
      const p = getPiece(state, action.pieceId);
      if (!p) return fail(state, why('unknown_piece'));
      if (!validSquare(action.to)) return fail(state, why('unknown_action'));
      const to = action.to;
      const preview = previewMoves(state, p.id);
      const opt = preview.options.find((o) => sameSquare(o.to, to));
      if (!opt) {
        if (preview.unavailableWhy) return fail(state, preview.unavailableWhy);
        const b = preview.blocked.find((x) => sameSquare(x.at, to));
        return fail(state, b?.why ?? why('cannot_reach', { mover: p.kind, sq: onBoard(cfg, to) ? squareName(to) : '?' }));
      }
      if (preview.unavailableWhy) return fail(state, preview.unavailableWhy);

      const next = clone(state);
      const mover = getPiece(next, p.id)!;
      const from = { ...mover.pos! };
      const events: GameEvent[] = [];
      if (opt.kind === 'tackle') {
        const victim = getPiece(next, next.carrierId)!;
        victim.pos = null;
        mover.pos = { ...to };
        next.carrierId = mover.id;
        next.capturesBy[mover.team] += 1;
        events.push({ type: 'tackle', pieceId: mover.id, capturedId: victim.id, at: { ...to } });
      } else {
        mover.pos = { ...to };
        events.push({ type: 'move', pieceId: mover.id, from, to: { ...to } });
      }
      next.ap -= 1;
      if (opt.scores) scoreGoal(next, mover.team, mover.id, events);
      return { ok: true, state: next, events };
    }

    case 'pass': {
      if (action.fromId !== state.carrierId) return fail(state, why('only_carrier'));
      const passes = passOptions(state);
      if (passes.unavailableWhy) return fail(state, passes.unavailableWhy);
      const opt = passes.options.find((o) => o.toId === action.toId);
      if (!opt) {
        const b = passes.blocked.find((x) => x.toId === action.toId);
        return fail(state, b?.why ?? why('pass_invalid_receiver'));
      }
      const next = clone(state);
      next.carrierId = action.toId;
      next.ap -= 1;
      return { ok: true, state: next, events: [{ type: 'pass', fromId: action.fromId, toId: action.toId }] };
    }

    case 'shoot': {
      if (action.fromId !== state.carrierId) return fail(state, why('only_carrier'));
      const c = carrier(state);
      const u = unavailableReason(state, c, cfg.shotCost);
      if (u) return fail(state, u);
      if (!validSquare(action.to)) return fail(state, why('unknown_action'));
      const problem = shotProblem(state, c.team, c.pos!, action.to);
      if (problem) return fail(state, problem);
      const next = clone(state);
      next.ap -= cfg.shotCost;
      const events: GameEvent[] = [{ type: 'shot', fromId: c.id, from: { ...c.pos! }, to: { ...action.to } }];
      scoreGoal(next, c.team, c.id, events);
      return { ok: true, state: next, events };
    }
  }
  return fail(state, why('unknown_action'));
}

/** Short English description of an event (logs, debugging). The UI uses src/i18n instead. */
export function describeEvent(state: MatchState, e: GameEvent): string {
  const n = (id: string) => {
    const p = getPiece(state, id);
    return p ? `${p.team} ${pieceName(state, p)}` : id;
  };
  switch (e.type) {
    case 'move':
      return `${n(e.pieceId)} ${squareName(e.from)} → ${squareName(e.to)}`;
    case 'pass':
      return `${n(e.fromId)} passes to ${n(e.toId)}`;
    case 'shot':
      return `${n(e.fromId)} shoots from ${squareName(e.from)} into ${squareName(e.to)}`;
    case 'tackle':
      return `${n(e.pieceId)} tackles ${n(e.capturedId)} on ${squareName(e.at)}`;
    case 'surge':
      return `Team ${e.team} surges (+1 AP)`;
    case 'goal':
      return `GOAL Team ${e.team}! ${e.score.A}–${e.score.B}`;
    case 'win':
      return `Team ${e.team} wins the match`;
    case 'goldenGoal':
      return 'Golden goal: next goal wins';
    case 'fullTime':
      return e.winner ? `Full time: Team ${e.winner} wins` : 'Full time: draw';
    case 'kickoff':
      return `Kickoff: Team ${e.team}`;
    case 'turnEnd':
      return `Team ${e.team} ends turn${e.apLost ? ` (${e.apLost} AP unused)` : ''}`;
  }
}
