import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, carrier, createMatch, createScenario, type Action, type MatchState, type Team } from '../src/rules/index.js';
import { DIFFICULTIES, legalActions, movesToTackle, planTurn, type Difficulty } from '../src/ai/ai.js';

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Execute a plan; asserts every action is legal and the plan hands the turn over (or the match ends). */
function runPlan(s: MatchState, plan: Action[]): { state: MatchState; goal: boolean } {
  const team = s.turn;
  let goal = false;
  for (const a of plan) {
    const r = applyAction(s, a);
    assert.ok(r.ok, `AI played an illegal action ${JSON.stringify(a)}: ${r.ok ? '' : r.reason}`);
    s = r.state;
    if (r.events.some((e) => e.type === 'goal')) goal = true;
    if (s.turn !== team || s.phase !== 'playing') return { state: s, goal };
  }
  assert.fail('Plan did not end the turn');
}

/** Sample mid-game positions from seeded Easy-vs-Easy play. */
function samplePositions(count: number, seed: number, needBall: boolean): MatchState[] {
  const rand = rng(seed);
  const out: MatchState[] = [];
  for (let g = 0; g < 60 && out.length < count; g++) {
    let s = createMatch({ random: rand });
    for (let t = 0; t < 30 && s.phase === 'playing'; t++) {
      if (t > 2 && (!needBall || carrier(s).team === s.turn) && rand() < 0.5) out.push(s);
      s = runPlan(s, planTurn(s, { difficulty: 'easy', random: rand })).state;
    }
  }
  return out.slice(0, count);
}

function play(dA: Difficulty, dB: Difficulty, seed: number, maxTurns: number): MatchState {
  const rand = rng(seed);
  let s = createMatch({ random: rand });
  for (let t = 0; t < maxTurns && s.phase === 'playing'; t++) {
    const d = s.turn === 'A' ? dA : dB;
    s = runPlan(s, planTurn(s, { difficulty: d, random: rand, timeBudgetMs: 800 })).state;
  }
  return s;
}

/** Brute force: can the side to move tackle the carrier or score within its AP? */
function canPunish(s: MatchState): boolean {
  const team = s.turn;
  const seen = new Set<string>();
  let frontier = [s];
  for (let d = 0; d < s.config.apPerTurn; d++) {
    const next: MatchState[] = [];
    for (const st of frontier) {
      for (const a of legalActions(st)) {
        const r = applyAction(st, a);
        if (!r.ok) continue;
        if (r.events.some((e) => e.type === 'tackle' || (e.type === 'goal' && e.team === team))) return true;
        const k = JSON.stringify(r.state.pieces.map((p) => p.pos)) + r.state.carrierId;
        if (seen.has(k)) continue;
        seen.add(k);
        if (r.state.turn === team) next.push(r.state);
      }
    }
    frontier = next;
  }
  return false;
}

describe('computer opponent', () => {
  test('legalActions only returns actions the engine accepts', () => {
    for (const s of samplePositions(25, 11, false)) {
      for (const a of legalActions(s)) assert.ok(applyAction(s, a).ok, JSON.stringify(a));
    }
  });

  for (const difficulty of DIFFICULTIES) {
    test(`${difficulty}: plans use only legal actions, respect AP and always hand over the turn`, () => {
      const rand = rng(3);
      for (const s of samplePositions(20, 21, false)) {
        const plan = planTurn(s, { difficulty, random: rand, timeBudgetMs: 600 });
        const moves = plan.filter((a) => a.type !== 'endTurn' && a.type !== 'surge').length;
        const surged = plan.filter((a) => a.type === 'surge').length;
        assert.ok(surged <= (s.surge[s.turn] ? 1 : 0), `${difficulty} surged ${surged} times`);
        const budget = s.ap + surged * s.config.surgeAp;
        assert.ok(moves <= budget, `${difficulty} planned ${moves} actions with ${budget} AP`);
        runPlan(s, plan);
      }
    });
  }

  test('AI plays either side (Team B attacks toward row 1)', () => {
    const s = createScenario({
      pieces: [
        { id: 'B-Q', team: 'B', kind: 'queen', at: 'F4' },
        { id: 'A-K', team: 'A', kind: 'king', at: 'D1' },
        { id: 'A-R1', team: 'A', kind: 'rook', at: 'A6' },
      ],
      carrier: 'B-Q',
      turn: 'B',
      resetOnGoal: true,
    });
    for (const difficulty of ['medium', 'hard'] as Difficulty[]) {
      const { state, goal } = runPlan(s, planTurn(s, { difficulty, random: rng(1) }));
      assert.ok(goal, `${difficulty} should score from F4 toward row 1`);
      assert.equal(state.score.B, 1);
    }
  });

  test('Medium and Hard find a two-step goal (step out of the blocked lane, then shoot)', () => {
    const s = createScenario({
      pieces: [
        { id: 'A-Q', team: 'A', kind: 'queen', at: 'F9' },
        { id: 'B-K', team: 'B', kind: 'king', at: 'D12' },
        { id: 'B-P1', team: 'B', kind: 'pawn', at: 'F11' },
        { id: 'B-R1', team: 'B', kind: 'rook', at: 'B10' },
      ],
      carrier: 'A-Q',
      resetOnGoal: true,
    });
    for (const difficulty of ['medium', 'hard'] as Difficulty[]) {
      const plan = planTurn(s, { difficulty, random: rng(2) });
      const r = runPlan(s, plan);
      assert.ok(r.goal, `${difficulty}: ${JSON.stringify(plan)}`);
      assert.ok(plan.some((a) => a.type === 'shoot'), `${difficulty} should finish with a shot`);
    }
  });

  test('Hard uses Surge when it turns a near-miss into a goal', () => {
    const s = createScenario({
      pieces: [
        { id: 'A-Q', team: 'A', kind: 'queen', at: 'F9' },
        { id: 'B-K', team: 'B', kind: 'king', at: 'D12' },
        { id: 'B-P1', team: 'B', kind: 'pawn', at: 'F11' },
      ],
      carrier: 'A-Q',
      ap: 1,
      resetOnGoal: true,
    });
    const plan = planTurn(s, { difficulty: 'hard', random: rng(2) });
    assert.ok(plan.some((a) => a.type === 'surge'), JSON.stringify(plan));
    assert.ok(runPlan(s, plan).goal);
  });

  test('every level takes an open shot that wins the match', () => {
    const s = createScenario({
      pieces: [
        { id: 'A-N', team: 'A', kind: 'knight', at: 'G9' },
        { id: 'B-K', team: 'B', kind: 'king', at: 'C12' },
      ],
      carrier: 'A-N',
      score: { A: 2, B: 2 },
      resetOnGoal: true,
    });
    for (const difficulty of ['medium', 'hard'] as Difficulty[]) {
      const r = runPlan(s, planTurn(s, { difficulty, random: rng(7) }));
      assert.equal(r.state.winner, 'A', difficulty);
    }
  });

  test('Hard protects its carrier from multi-move tackles far better than Medium', () => {
    const positions = samplePositions(40, 9, true);
    const exposed: Record<Difficulty, number> = { easy: 0, medium: 0, hard: 0 };
    for (const d of DIFFICULTIES) {
      const rand = rng(5);
      for (const s of positions) {
        const { state, goal } = runPlan(s, planTurn(s, { difficulty: d, random: rand, timeBudgetMs: 800 }));
        if (!goal && state.phase === 'playing' && canPunish(state)) exposed[d]++;
      }
    }
    console.log(`exposure (carrier punishable next turn): ${JSON.stringify(exposed)} of ${positions.length}`);
    assert.ok(exposed.hard * 3 <= exposed.medium, `hard ${exposed.hard} vs medium ${exposed.medium}`);
    assert.ok(exposed.medium >= 10, `sample should contain risky positions (medium ${exposed.medium})`);
  });

  test('difficulties behave differently: Easy is random, Medium/Hard are consistent', () => {
    const s = createMatch({ firstTeam: 'A' });
    const easyPlans = new Set(Array.from({ length: 8 }, (_, i) => JSON.stringify(planTurn(s, { difficulty: 'easy', random: rng(i) }))));
    assert.ok(easyPlans.size > 1, 'Easy should vary');
    const hardPlans = new Set(Array.from({ length: 3 }, (_, i) => JSON.stringify(planTurn(s, { difficulty: 'hard', random: rng(i) }))));
    assert.ok(hardPlans.size <= 2, 'Hard should be (nearly) deterministic');
  });

  test('Hard stays within its thinking time budget', () => {
    let worst = 0;
    for (const s of samplePositions(15, 31, false)) {
      const t0 = Date.now();
      planTurn(s, { difficulty: 'hard', random: rng(4), timeBudgetMs: 800 });
      worst = Math.max(worst, Date.now() - t0);
    }
    assert.ok(worst < 2500, `worst Hard planning time ${worst}ms`);
  });

  test('stronger levels beat weaker ones in full matches', () => {
    for (const strong of ['medium', 'hard'] as Difficulty[]) {
      for (const seed of [301, 304]) {
        const a = play('easy', strong, seed, 60);
        assert.equal(a.phase, 'finished', 'matches end within the clock');
        assert.equal(a.winner, 'B' as Team, `${strong} (B) should beat easy (seed ${seed}), got ${JSON.stringify(a.score)}`);
        const b = play(strong, 'easy', seed, 60);
        assert.equal(b.winner, 'A' as Team, `${strong} (A) should beat easy (seed ${seed}), got ${JSON.stringify(b.score)}`);
      }
    }
  });

  test('movesToTackle counts real chess moves to reach the carrier', () => {
    const s = createScenario({
      pieces: [
        { id: 'B-Q', team: 'B', kind: 'queen', at: 'E7' },
        { id: 'A-R1', team: 'A', kind: 'rook', at: 'A7' }, // A7 -> D7, then tackle: 2
        { id: 'A-Q', team: 'A', kind: 'queen', at: 'D3' }, // needs 3
      ],
      carrier: 'B-Q',
      turn: 'A',
    });
    assert.equal(movesToTackle(s), 2);
    const pawnOnly = createScenario({
      pieces: [
        { id: 'B-Q', team: 'B', kind: 'queen', at: 'E7' },
        { id: 'A-P1', team: 'A', kind: 'pawn', at: 'D6' }, // diagonal forward: tackles at once
      ],
      carrier: 'B-Q',
      turn: 'A',
    });
    assert.equal(movesToTackle(pawnOnly), 1);
  });
});
