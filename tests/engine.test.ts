import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAction,
  carrier,
  coveredByKeeper,
  createMatch,
  createScenario,
  DEFAULT_CONFIG,
  forwardDir,
  getPiece,
  goalRow,
  inBox,
  inGoalMouth,
  isGoldenGoal,
  makeConfig,
  parseSquare,
  passOptions,
  previewMoves,
  scoringRow,
  shotTargets,
  squareName,
  tackleThreats,
  type Action,
  type MatchState,
} from '../src/rules/index.js';

const sq = parseSquare;
const at = (s: MatchState, id: string) => {
  const p = getPiece(s, id);
  return p?.pos ? squareName(p.pos) : null;
};
const dests = (s: MatchState, id: string) =>
  previewMoves(s, id)
    .options.map((o) => squareName(o.to))
    .sort();

function ok(s: MatchState, a: Action): MatchState {
  const r = applyAction(s, a);
  if (!r.ok) assert.fail(`Expected ${JSON.stringify(a)} to succeed: ${r.reason}`);
  return r.state;
}

function rejected(s: MatchState, a: Action): string {
  const before = JSON.stringify(s);
  const r = applyAction(s, a);
  assert.equal(r.ok, false, `Expected ${JSON.stringify(a)} to be rejected`);
  assert.equal(r.state, s, 'Rejected action must return the same state object');
  assert.equal(JSON.stringify(s), before, 'Rejected action must not mutate state');
  return r.ok ? '' : r.why.code;
}

const move = (pieceId: string, to: string): Action => ({ type: 'move', pieceId, to: sq(to) });
const pass = (fromId: string, toId: string): Action => ({ type: 'pass', fromId, toId });
const shoot = (fromId: string, to: string): Action => ({ type: 'shoot', fromId, to: sq(to) });
const END: Action = { type: 'endTurn' };
const SURGE: Action = { type: 'surge' };

/** A lone piece of `kind` on `at`, with a far-away teammate carrying the ball. */
const solo = (kind: 'pawn' | 'queen' | 'knight' | 'rook' | 'bishop' | 'king', square: string, team: 'A' | 'B' = 'A') =>
  createScenario({
    pieces: [
      { id: 'x', team, kind, at: square },
      { id: 'c', team, kind: 'pawn', at: 'A7' },
    ],
    carrier: 'c',
    turn: team,
  });

describe('board, zones and orientation', () => {
  test('8 columns x 12 rows, labelled A-H / 1-12', () => {
    assert.equal(DEFAULT_CONFIG.cols, 8);
    assert.equal(DEFAULT_CONFIG.rows, 12);
    assert.equal(squareName({ c: 0, r: 0 }), 'A1');
    assert.equal(squareName({ c: 7, r: 11 }), 'H12');
  });

  test('goal lines, goal mouths (B-G) and keeper boxes (B-G, two rows deep)', () => {
    const cfg = DEFAULT_CONFIG;
    assert.equal(goalRow(cfg, 'A'), 0);
    assert.equal(scoringRow(cfg, 'A'), 11);
    assert.equal(forwardDir('B'), -1);
    assert.ok(inGoalMouth(cfg, sq('B1'), 'A') && inGoalMouth(cfg, sq('G12'), 'B'));
    assert.ok(!inGoalMouth(cfg, sq('A1'), 'A') && !inGoalMouth(cfg, sq('H12'), 'B'));
    assert.ok(inBox(cfg, sq('E2'), 'A') && !inBox(cfg, sq('E3'), 'A') && inBox(cfg, sq('C11'), 'B'));
  });

  test('formation and kickoff', () => {
    const s = createMatch({ firstTeam: 'A' });
    const expectA: Record<string, string> = { K: 'D1', R1: 'C2', R2: 'F2', B: 'E2', P1: 'B4', P2: 'G4', Q: 'D6', N: 'E4' };
    for (const [slot, square] of Object.entries(expectA)) assert.equal(at(s, `A-${slot}`), square, `A-${slot}`);
    assert.equal(at(s, 'B-K'), 'D12');
    assert.equal(at(s, 'B-Q'), 'D9');
    assert.equal(s.carrierId, 'A-Q');
    assert.equal(s.ap, 3);
    assert.deepEqual(s.surge, { A: true, B: true });
    const b = createMatch({ firstTeam: 'B' });
    assert.equal(at(b, 'B-Q'), 'D7');
    assert.equal(b.turn, 'B');
    assert.equal(createMatch({ random: () => 0.9 }).turn, 'B');
  });
});

describe('movement: range-limited chess', () => {
  test('queen: any direction up to 2', () => {
    assert.deepEqual(dests(solo('queen', 'D6'), 'x'), ['B4', 'B6', 'B8', 'C5', 'C6', 'C7', 'D4', 'D5', 'D7', 'D8', 'E5', 'E6', 'E7', 'F4', 'F6', 'F8']);
  });

  test('rook: straight up to 3; bishop: diagonal up to 3', () => {
    assert.deepEqual(dests(solo('rook', 'D6'), 'x'), ['A6', 'B6', 'C6', 'D3', 'D4', 'D5', 'D7', 'D8', 'D9', 'E6', 'F6', 'G6']);
    assert.deepEqual(dests(solo('bishop', 'D6'), 'x'), ['A3', 'A9', 'B4', 'B8', 'C5', 'C7', 'E5', 'E7', 'F4', 'F8', 'G3', 'G9']);
  });

  test('knight: L-jumps over pieces', () => {
    const s = createScenario({
      pieces: [
        { id: 'n', team: 'A', kind: 'knight', at: 'D6' },
        { id: 'p1', team: 'A', kind: 'pawn', at: 'D7' },
        { id: 'p2', team: 'A', kind: 'pawn', at: 'E6' },
        { id: 'o', team: 'B', kind: 'rook', at: 'C6' },
      ],
      carrier: 'p1',
    });
    assert.deepEqual(dests(s, 'n'), ['B5', 'B7', 'C4', 'C8', 'E4', 'E8', 'F5', 'F7']);
  });

  test('dribbling is slow: the ball carrier slides only one square; a Knight carrier still jumps', () => {
    const q = createScenario({ pieces: [{ id: 'q', team: 'A', kind: 'queen', at: 'D6' }], carrier: 'q' });
    assert.deepEqual(dests(q, 'q'), ['C5', 'C6', 'C7', 'D5', 'D7', 'E5', 'E6', 'E7']);
    const n = createScenario({ pieces: [{ id: 'n', team: 'A', kind: 'knight', at: 'D6' }], carrier: 'n' });
    assert.equal(dests(n, 'n').length, 8);
  });

  test('pawn: one step forward or sideways, never backward; Team B forward is down', () => {
    assert.deepEqual(dests(solo('pawn', 'D6'), 'x'), ['C6', 'D7', 'E6']);
    assert.deepEqual(dests(solo('pawn', 'D6', 'B'), 'x'), ['C6', 'D5', 'E6']);
    rejected(solo('pawn', 'D6'), move('x', 'D5'));
  });

  test('sliding pieces stop at the first piece; cannot land on teammates or non-carriers', () => {
    const s = createScenario({
      pieces: [
        { id: 'r', team: 'A', kind: 'rook', at: 'D6' },
        { id: 'own', team: 'A', kind: 'pawn', at: 'D8' },
        { id: 'opp', team: 'B', kind: 'pawn', at: 'F6' },
        { id: 'bc', team: 'B', kind: 'queen', at: 'A12' },
      ],
      carrier: 'bc',
    });
    assert.deepEqual(dests(s, 'r'), ['A6', 'B6', 'C6', 'D3', 'D4', 'D5', 'D7', 'E6']);
    assert.equal(rejected(s, move('r', 'D8')), 'occupied_own');
    assert.equal(rejected(s, move('r', 'D9')), 'path_blocked');
    assert.equal(rejected(s, move('r', 'F6')), 'opponent_blocks');
    assert.equal(rejected(s, move('r', 'E7')), 'cannot_reach');
  });

  test('keeper: one step any direction, never out of its box', () => {
    const s = solo('king', 'D1');
    assert.deepEqual(dests(s, 'x'), ['C1', 'C2', 'D2', 'E1', 'E2']);
    const edge = solo('king', 'G2');
    assert.equal(rejected(edge, move('x', 'H2')), 'keeper_box');
    assert.equal(rejected(edge, move('x', 'G3')), 'keeper_box');
  });

  test('only the keeper may stand in its own goal mouth; non-carriers cannot enter the opponent goal mouth', () => {
    assert.equal(rejected(solo('rook', 'C3'), move('x', 'C1')), 'goal_mouth');
    const s = createScenario({
      pieces: [
        { id: 'r', team: 'A', kind: 'rook', at: 'C10' },
        { id: 'c', team: 'A', kind: 'pawn', at: 'A7' },
      ],
      carrier: 'c',
    });
    assert.equal(rejected(s, move('r', 'C12')), 'goal_mouth');
    assert.ok(dests(s, 'r').includes('C11'));
  });

  test('ranges are data-driven', () => {
    const cfg = makeConfig({ pieces: { ...DEFAULT_CONFIG.pieces, queen: { ...DEFAULT_CONFIG.pieces.queen, range: 1 } } });
    const s = createScenario({ config: cfg, pieces: [{ id: 'q', team: 'A', kind: 'queen', at: 'D6' }], carrier: 'q' });
    assert.equal(dests(s, 'q').length, 8);
  });
});

describe('action points and surge', () => {
  test('3 AP per turn; moves, passes, tackles and shots cost 1; a 4th action is refused', () => {
    let s = createMatch({ firstTeam: 'A' });
    s = ok(s, move('A-P1', 'B5'));
    s = ok(s, move('A-P2', 'G5'));
    s = ok(s, move('A-R1', 'A2'));
    assert.equal(s.ap, 0);
    assert.equal(rejected(s, move('A-N', 'F6')), 'no_ap');
    const next = applyAction(s, END);
    assert.ok(next.ok && next.state.ap === 3 && next.state.turn === 'B');
  });

  test('ending a turn early discards unused AP', () => {
    const r = applyAction(createMatch({ firstTeam: 'A' }), END);
    assert.ok(r.ok);
    assert.deepEqual(r.events[0], { type: 'turnEnd', team: 'A', apLost: 3, next: 'B' });
  });

  test('Surge: +1 AP once per rally, refreshed at the next kickoff', () => {
    let s = createMatch({ firstTeam: 'A' });
    s = ok(s, SURGE);
    assert.equal(s.ap, 4);
    assert.deepEqual(s.surge, { A: false, B: true });
    assert.equal(rejected(s, SURGE), 'no_surge');
    s = ok(ok(s, END), END);
    assert.equal(rejected(s, SURGE), 'no_surge', 'still spent later in the same rally');
    // A goal starts a new rally: Surge returns for both sides.
    const g = createScenario({
      pieces: [
        { id: 'A-Q', team: 'A', kind: 'queen', at: 'C9' },
        { id: 'B-K', team: 'B', kind: 'king', at: 'F12' },
      ],
      carrier: 'A-Q',
      surge: { A: false, B: false },
      resetOnGoal: true,
    });
    const after = ok(g, shoot('A-Q', 'C12'));
    assert.deepEqual(after.surge, { A: true, B: true });
  });
});

describe('passing', () => {
  const base = () =>
    createScenario({
      pieces: [
        { id: 'q', team: 'A', kind: 'queen', at: 'D6' },
        { id: 'col', team: 'A', kind: 'knight', at: 'D10' },
        { id: 'row', team: 'A', kind: 'rook', at: 'H6' },
        { id: 'diag', team: 'A', kind: 'pawn', at: 'G9' },
        { id: 'far', team: 'A', kind: 'rook', at: 'D1' },
        { id: 'off', team: 'A', kind: 'bishop', at: 'E8' },
      ],
      carrier: 'q',
    });

  test('any straight line, rows, columns and diagonals, up to 4 squares', () => {
    const s = base();
    assert.deepEqual(passOptions(s).options.map((o) => o.toId).sort(), ['col', 'diag', 'row']);
    const s2 = ok(s, pass('q', 'diag'));
    assert.equal(s2.carrierId, 'diag');
    assert.equal(s2.ap, 2);
  });

  test('marking: a teammate with an opponent directly beside it cannot receive', () => {
    const s = createScenario({
      pieces: [
        { id: 'q', team: 'A', kind: 'queen', at: 'D6' },
        { id: 'r', team: 'A', kind: 'rook', at: 'D9' },
        { id: 'n', team: 'A', kind: 'knight', at: 'G6' },
        { id: 'm', team: 'B', kind: 'pawn', at: 'E9' },
        { id: 'd', team: 'B', kind: 'pawn', at: 'H7' },
      ],
      carrier: 'q',
    });
    assert.equal(rejected(s, pass('q', 'r')), 'receiver_marked');
    assert.equal(ok(s, pass('q', 'n')).carrierId, 'n', 'a diagonal neighbour does not mark');
  });

  test('out of range, off-line and blocked passes are refused', () => {
    const s = base();
    assert.equal(rejected(s, pass('q', 'far')), 'pass_out_of_range');
    assert.equal(rejected(s, pass('q', 'off')), 'pass_invalid_receiver');
    assert.equal(rejected(s, pass('col', 'q')), 'only_carrier');
    const blocked = createScenario({
      pieces: [
        { id: 'q', team: 'A', kind: 'queen', at: 'D6' },
        { id: 'r', team: 'A', kind: 'rook', at: 'G9' },
        { id: 'o', team: 'B', kind: 'pawn', at: 'E7' },
      ],
      carrier: 'q',
    });
    assert.equal(rejected(blocked, pass('q', 'r')), 'pass_lane_blocked');
  });
});

describe('tackling', () => {
  test('moving onto the carrier with a legal move tackles: carrier benched, ball changes hands', () => {
    const s = createScenario({
      pieces: [
        { id: 'b', team: 'A', kind: 'bishop', at: 'C5' },
        { id: 'bc', team: 'B', kind: 'queen', at: 'E7' },
      ],
      carrier: 'bc',
    });
    const r = applyAction(s, move('b', 'E7'));
    assert.ok(r.ok);
    assert.equal(r.state.carrierId, 'b');
    assert.equal(getPiece(r.state, 'bc')!.pos, null);
    assert.equal(r.state.capturesBy.A, 1);
    assert.equal(r.events[0].type, 'tackle');
  });

  test('only the ball carrier can be tackled', () => {
    const s = createScenario({
      pieces: [
        { id: 'r', team: 'A', kind: 'rook', at: 'E5' },
        { id: 'o', team: 'B', kind: 'pawn', at: 'E7' },
        { id: 'bc', team: 'B', kind: 'queen', at: 'A12' },
      ],
      carrier: 'bc',
    });
    assert.equal(rejected(s, move('r', 'E7')), 'opponent_blocks');
  });

  test('pawns tackle diagonally forward only (like a chess capture)', () => {
    const diag = createScenario({
      pieces: [
        { id: 'p', team: 'A', kind: 'pawn', at: 'D6' },
        { id: 'bc', team: 'B', kind: 'queen', at: 'E7' },
      ],
      carrier: 'bc',
    });
    assert.equal(ok(diag, move('p', 'E7')).carrierId, 'p');
    const ahead = createScenario({
      pieces: [
        { id: 'p', team: 'A', kind: 'pawn', at: 'E6' },
        { id: 'bc', team: 'B', kind: 'queen', at: 'E7' },
      ],
      carrier: 'bc',
    });
    assert.equal(rejected(ahead, move('p', 'E7')), 'pawn_tackle');
  });

  test('benched pieces stay off until the next kickoff; tackle threats are reported', () => {
    const s = createScenario({
      pieces: [
        { id: 'n', team: 'A', kind: 'knight', at: 'D5' },
        { id: 'bc', team: 'B', kind: 'queen', at: 'E7' },
      ],
      carrier: 'bc',
    });
    assert.deepEqual(tackleThreats(s).map((p) => p.id), ['n']);
    let t = ok(s, move('n', 'E7'));
    t = ok(ok(t, END), END);
    assert.equal(getPiece(t, 'bc')!.pos, null);
  });
});

describe('shooting and scoring', () => {
  const shotSetup = () =>
    createScenario({
      pieces: [
        { id: 'q', team: 'A', kind: 'queen', at: 'F9' },
        { id: 'B-K', team: 'B', kind: 'king', at: 'C12' },
        { id: 'far', team: 'B', kind: 'rook', at: 'A5' },
      ],
      carrier: 'q',
      resetOnGoal: true,
    });

  test('the keeper covers every goal square it could step onto', () => {
    const s = shotSetup();
    assert.ok(coveredByKeeper(s, sq('C12'), 'B') && coveredByKeeper(s, sq('D12'), 'B'));
    assert.ok(!coveredByKeeper(s, sq('E12'), 'B'));
    const t = Object.fromEntries(shotTargets(s).map((x) => [squareName(x.at), x.why?.code ?? 'open']));
    assert.deepEqual(t, { B12: 'not_in_line', C12: 'covered_by_keeper', D12: 'not_in_line', E12: 'not_in_line', F12: 'open', G12: 'not_in_line' });
  });

  test('a shot into an open goal square scores and restarts with the conceding side', () => {
    const r = applyAction(shotSetup(), shoot('q', 'F12'));
    assert.ok(r.ok);
    assert.equal(r.state.score.A, 1);
    assert.deepEqual(r.events.map((e) => e.type), ['shot', 'goal', 'kickoff']);
    assert.equal(r.state.turn, 'B');
    assert.equal(r.state.carrierId, 'B-Q');
    assert.ok(r.state.pieces.every((p) => p.pos), 'benched pieces return');
  });

  test('shots need a straight, clear line within 4 to an open square', () => {
    const s = shotSetup();
    assert.equal(rejected(s, shoot('q', 'C12')), 'covered_by_keeper');
    assert.equal(rejected(s, shoot('q', 'D12')), 'not_in_line');
    assert.equal(rejected(s, shoot('q', 'E11')), 'shot_not_goal');
    const blocked = createScenario({
      pieces: [
        { id: 'q', team: 'A', kind: 'queen', at: 'C9' },
        { id: 'B-K', team: 'B', kind: 'king', at: 'C12' },
        { id: 'blk', team: 'B', kind: 'rook', at: 'E11' },
      ],
      carrier: 'q',
    });
    assert.equal(rejected(blocked, shoot('q', 'F12')), 'shot_blocked');
    const far = createScenario({ pieces: [{ id: 'q', team: 'A', kind: 'queen', at: 'E6' }], carrier: 'q' });
    assert.equal(rejected(far, shoot('q', 'E12')), 'shot_out_of_range');
  });

  test('dribbling into an open goal square scores; covered squares cannot be entered', () => {
    const s = createScenario({
      pieces: [
        { id: 'n', team: 'A', kind: 'knight', at: 'D10' },
        { id: 'B-K', team: 'B', kind: 'king', at: 'F12' },
      ],
      carrier: 'n',
    });
    assert.equal(rejected(s, move('n', 'E12')), 'covered_by_keeper');
    const r = applyAction(s, move('n', 'C12'));
    assert.ok(r.ok && r.state.score.A === 1);
  });

  test('tackling the keeper while it holds the ball in its goal mouth is a goal', () => {
    const s = createScenario({
      pieces: [
        { id: 'n', team: 'A', kind: 'knight', at: 'C10' },
        { id: 'B-K', team: 'B', kind: 'king', at: 'D12' },
      ],
      carrier: 'B-K',
    });
    const r = applyAction(s, move('n', 'D12'));
    assert.ok(r.ok);
    assert.equal(r.state.score.A, 1);
  });

  test('Team B scores into row 1', () => {
    const s = createScenario({
      pieces: [
        { id: 'q', team: 'B', kind: 'queen', at: 'D4' },
        { id: 'A-K', team: 'A', kind: 'king', at: 'F1' },
      ],
      carrier: 'q',
      turn: 'B',
    });
    assert.equal(ok(s, shoot('q', 'D1')).score.B, 1);
  });
});

describe('match format', () => {
  test('first to 3 goals wins', () => {
    const s = createScenario({
      pieces: [
        { id: 'q', team: 'A', kind: 'queen', at: 'D9' },
        { id: 'B-Q', team: 'B', kind: 'queen', at: 'A5' },
      ],
      carrier: 'q',
      score: { A: 2, B: 1 },
      resetOnGoal: true,
    });
    const r = applyAction(s, shoot('q', 'D12'));
    assert.ok(r.ok && r.state.phase === 'finished' && r.state.winner === 'A');
    assert.equal(rejected(r.state, END), 'match_over');
  });

  test('after 30 turns the leader wins on the clock', () => {
    let s = createMatch({ firstTeam: 'A' });
    s = { ...s, turnNumber: 30, score: { A: 1, B: 0 } };
    const r = applyAction(s, END);
    assert.ok(r.ok);
    assert.equal(r.state.phase, 'finished');
    assert.equal(r.state.winner, 'A');
    assert.ok(r.events.some((e) => e.type === 'fullTime'));
  });

  test('level after 30 turns: golden goal, and the next goal wins', () => {
    let s = createMatch({ firstTeam: 'A' });
    s = { ...s, turnNumber: 30, score: { A: 1, B: 1 } };
    const r = applyAction(s, END);
    assert.ok(r.ok && r.state.phase === 'playing');
    assert.ok(r.events.some((e) => e.type === 'goldenGoal'));
    assert.ok(isGoldenGoal(r.state));
    const g = createScenario({
      pieces: [
        { id: 'q', team: 'A', kind: 'queen', at: 'D9' },
        { id: 'B-Q', team: 'B', kind: 'queen', at: 'A5' },
      ],
      carrier: 'q',
      score: { A: 1, B: 1 },
      turnNumber: 33,
      resetOnGoal: true,
    });
    const w = applyAction(g, shoot('q', 'D12'));
    assert.ok(w.ok && w.state.phase === 'finished' && w.state.winner === 'A');
  });

  test('still level after 40 turns: draw', () => {
    let s = createMatch({ firstTeam: 'A' });
    s = { ...s, turnNumber: 40, score: { A: 2, B: 2 } };
    const r = applyAction(s, END);
    assert.ok(r.ok && r.state.phase === 'finished' && r.state.winner === null);
    assert.deepEqual(r.events.at(-1), { type: 'fullTime', winner: null });
  });

  test('a seeded random match always ends (goals, clock or draw) with invariants intact', () => {
    let seed = 99;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let g = 0; g < 6; g++) {
      let s = createMatch({ random: rand });
      let steps = 0;
      while (s.phase === 'playing' && steps < 5000) {
        steps++;
        const acts: Action[] = [END];
        if (s.surge[s.turn]) acts.push(SURGE);
        for (const p of s.pieces) {
          if (p.team !== s.turn || !p.pos) continue;
          for (const o of previewMoves(s, p.id).options) acts.push({ type: 'move', pieceId: p.id, to: o.to });
        }
        for (const o of passOptions(s).options) acts.push({ type: 'pass', fromId: s.carrierId, toId: o.toId });
        for (const t of shotTargets(s)) if (!t.why && carrier(s).team === s.turn) acts.push({ type: 'shoot', fromId: s.carrierId, to: t.at });
        const pool = s.ap > 0 && acts.length > 1 && rand() < 0.9 ? acts.slice(1) : acts;
        const r = applyAction(s, pool[Math.floor(rand() * pool.length)]);
        if (!r.ok) continue; // e.g. surge/move with 0 AP filtered by engine
        s = r.state;
        const onBoard = s.pieces.filter((p) => p.pos);
        const keys = onBoard.map((p) => `${p.pos!.c},${p.pos!.r}`);
        assert.equal(new Set(keys).size, keys.length, 'no stacking');
        assert.ok(carrier(s).pos, 'ball always held by a piece on the board');
        for (const p of onBoard) {
          if (p.kind === 'king') assert.ok(inBox(s.config, p.pos!, p.team), 'keeper in box');
          else assert.ok(!inGoalMouth(s.config, p.pos!, p.team), 'no outfield piece in own goal mouth');
        }
      }
      assert.equal(s.phase, 'finished', `match ${g} did not end`);
      assert.ok(s.turnNumber <= s.config.maxTurns + 1);
    }
  });
});
