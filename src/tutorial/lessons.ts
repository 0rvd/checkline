// Guided tutorial: short interactive scenarios built on the real rules engine.
// Each lesson is a position plus a success check on the events it produces.
// Lesson text lives in the language files under lesson.<id>.title/task/tip/success.
import { createScenario, getPiece, shotTargets } from '../rules/engine.js';
import type { GameEvent, MatchState } from '../rules/types.js';

export type LessonId = 'movement' | 'dribble' | 'passing' | 'tackle' | 'shoot' | 'surge' | 'defend';

export interface Lesson {
  id: LessonId;
  setup: () => MatchState;
  check: (events: GameEvent[], state: MatchState) => boolean;
  /** Show the Surge button in this lesson. */
  surge?: boolean;
}

export const LESSONS: Lesson[] = [
  {
    // Pieces move like chess pieces, with short ranges.
    id: 'movement',
    setup: () =>
      createScenario({
        pieces: [
          { id: 'A-B', team: 'A', kind: 'bishop', at: 'C3' },
          { id: 'A-R1', team: 'A', kind: 'rook', at: 'F3' },
          { id: 'A-Q', team: 'A', kind: 'queen', at: 'D5' },
          { id: 'B-K', team: 'B', kind: 'king', at: 'D12' },
          { id: 'B-P1', team: 'B', kind: 'pawn', at: 'E9' },
        ],
        carrier: 'A-Q',
      }),
    check: (events) => events.some((e) => e.type === 'move' && e.pieceId === 'A-B' && Math.abs(e.to.c - e.from.c) === Math.abs(e.to.r - e.from.r)),
  },
  {
    // The ball carrier moves one square at a time, but a Knight still jumps.
    id: 'dribble',
    setup: () =>
      createScenario({
        pieces: [
          { id: 'A-N', team: 'A', kind: 'knight', at: 'D5' },
          { id: 'A-Q', team: 'A', kind: 'queen', at: 'B4' },
          { id: 'B-P1', team: 'B', kind: 'pawn', at: 'D6' },
          { id: 'B-P2', team: 'B', kind: 'pawn', at: 'C6' },
          { id: 'B-B', team: 'B', kind: 'bishop', at: 'E6' },
          { id: 'B-K', team: 'B', kind: 'king', at: 'D12' },
        ],
        carrier: 'A-N',
      }),
    check: (events, s) => events.some((e) => e.type === 'move' && e.pieceId === 'A-N') && s.carrierId === 'A-N',
  },
  {
    // Passes travel in straight lines; a marked teammate cannot receive.
    id: 'passing',
    setup: () =>
      createScenario({
        pieces: [
          { id: 'A-P1', team: 'A', kind: 'pawn', at: 'C5' },
          { id: 'A-Q', team: 'A', kind: 'queen', at: 'C8' },
          { id: 'A-R2', team: 'A', kind: 'rook', at: 'F8' },
          { id: 'B-P1', team: 'B', kind: 'pawn', at: 'D8' },
          { id: 'B-K', team: 'B', kind: 'king', at: 'D12' },
        ],
        carrier: 'A-P1',
      }),
    check: (events) => events.some((e) => e.type === 'pass' && e.toId === 'A-R2'),
  },
  {
    // Only the carrier can be tackled; Pawns tackle diagonally forward.
    id: 'tackle',
    setup: () =>
      createScenario({
        pieces: [
          { id: 'A-P1', team: 'A', kind: 'pawn', at: 'C7' },
          { id: 'A-R1', team: 'A', kind: 'rook', at: 'A5' },
          { id: 'B-Q', team: 'B', kind: 'queen', at: 'D8' },
          { id: 'B-P1', team: 'B', kind: 'pawn', at: 'C8' },
          { id: 'B-K', team: 'B', kind: 'king', at: 'D12' },
        ],
        carrier: 'B-Q',
      }),
    check: (events) => events.some((e) => e.type === 'tackle'),
  },
  {
    // Shoot into an open goal-mouth square; the keeper covers its square and its neighbours.
    id: 'shoot',
    setup: () =>
      createScenario({
        pieces: [
          { id: 'A-Q', team: 'A', kind: 'queen', at: 'F9' },
          { id: 'A-N', team: 'A', kind: 'knight', at: 'B8' },
          { id: 'B-K', team: 'B', kind: 'king', at: 'D12' },
          { id: 'B-B', team: 'B', kind: 'bishop', at: 'E10' },
          { id: 'B-R1', team: 'B', kind: 'rook', at: 'B10' },
        ],
        carrier: 'A-Q',
      }),
    check: (events) => events.some((e) => e.type === 'goal'),
  },
  {
    // Surge: one extra action per rally.
    id: 'surge',
    surge: true,
    setup: () =>
      createScenario({
        pieces: [
          { id: 'A-Q', team: 'A', kind: 'queen', at: 'F9' },
          { id: 'A-B', team: 'A', kind: 'bishop', at: 'C7' },
          { id: 'B-K', team: 'B', kind: 'king', at: 'D12' },
          { id: 'B-P1', team: 'B', kind: 'pawn', at: 'F11' },
          { id: 'B-R1', team: 'B', kind: 'rook', at: 'B10' },
        ],
        carrier: 'A-Q',
        ap: 1,
      }),
    check: (events) => events.some((e) => e.type === 'goal'),
  },
  {
    // Defending: shut every open shooting lane before your turn ends.
    id: 'defend',
    setup: () =>
      createScenario({
        pieces: [
          { id: 'A-K', team: 'A', kind: 'king', at: 'D1' },
          { id: 'A-R1', team: 'A', kind: 'rook', at: 'A3' },
          { id: 'A-B', team: 'A', kind: 'bishop', at: 'H4' },
          { id: 'B-Q', team: 'B', kind: 'queen', at: 'F5' },
          { id: 'B-N', team: 'B', kind: 'knight', at: 'C8' },
          { id: 'B-K', team: 'B', kind: 'king', at: 'D12' },
        ],
        carrier: 'B-Q',
      }),
    check: (events, s) =>
      events.some((e) => e.type === 'move' || e.type === 'tackle') &&
      (getPiece(s, s.carrierId)?.team === 'A' || shotTargets(s).every((x) => x.why !== null)),
  },
];
