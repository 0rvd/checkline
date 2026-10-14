// Data-driven values for ruleset v3 ("Checkline 1.0"). Tuning knobs live here; the engine,
// AI, UI and tutorial read them. The server mirror (supabase/setup.sql) hardcodes the same
// numbers: run `npm run verify:sql` after changing anything.
import type { PieceKind, PieceSpec, RulesConfig } from './types.js';

export const PIECES: Record<PieceKind, PieceSpec> = {
  king: { kind: 'king', name: 'King', letter: 'K', pattern: 'king', range: 1, footballRole: 'Goalkeeper' },
  queen: { kind: 'queen', name: 'Queen', letter: 'Q', pattern: 'queen', range: 2, footballRole: 'Playmaker' },
  rook: { kind: 'rook', name: 'Rook', letter: 'R', pattern: 'rook', range: 3, footballRole: 'Full-back' },
  bishop: { kind: 'bishop', name: 'Bishop', letter: 'B', pattern: 'bishop', range: 3, footballRole: 'Holding midfielder' },
  knight: { kind: 'knight', name: 'Knight', letter: 'N', pattern: 'knight', range: 1, footballRole: 'Striker' },
  pawn: { kind: 'pawn', name: 'Pawn', letter: 'P', pattern: 'pawn', range: 1, footballRole: 'Winger / presser' },
};

const col = (letter: string): number => letter.toUpperCase().charCodeAt(0) - 65;

/**
 * Formation (Team A view, row 0 = own goal line). Team B mirrors by row.
 * Keeper D1; Rooks C2, F2 guard the posts; Bishop E2 screens; Pawns B4, G4 on the wings;
 * Queen D4 and Knight E4 in midfield. The kicking side's Queen starts on its midfield
 * square (D6 / D7) with the ball.
 *
 * Tuned with AI-vs-AI simulation (see DECISIONS.md): goal mouth B-G, dribbling is slow,
 * marking is orthogonal, shots reach 5 squares, passes 4.
 */
export const DEFAULT_CONFIG: RulesConfig = {
  cols: 8,
  rows: 12,
  apPerTurn: 3,
  surgeAp: 1,
  passRange: 4,
  shotRange: 5,
  shotCost: 1,
  marking: true,
  goalCols: [col('B'), col('G')],
  boxDepth: 2,
  goalsToWin: 3,
  regulationTurns: 30,
  maxTurns: 40,
  pieces: PIECES,
  formation: [
    { slot: 'K', kind: 'king', c: col('D'), r: 0 },
    { slot: 'R1', kind: 'rook', c: col('C'), r: 1 },
    { slot: 'R2', kind: 'rook', c: col('F'), r: 1 },
    { slot: 'B', kind: 'bishop', c: col('E'), r: 1 },
    { slot: 'P1', kind: 'pawn', c: col('B'), r: 3 },
    { slot: 'P2', kind: 'pawn', c: col('G'), r: 3 },
    { slot: 'Q', kind: 'queen', c: col('D'), r: 3 },
    { slot: 'N', kind: 'knight', c: col('E'), r: 3 },
  ],
  kickoff: { slot: 'Q', c: col('D'), r: 5 },
};

export function makeConfig(overrides: Partial<RulesConfig> = {}): RulesConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    pieces: { ...DEFAULT_CONFIG.pieces, ...(overrides.pieces ?? {}) },
  };
}
