// Core data types for the Checkline rules engine (ruleset v3). No DOM or rendering here.

export type Team = 'A' | 'B';

/** Column 0..cols-1 (A..H), row 0..rows-1 (displayed as 1..rows). Row 0 is Team A's goal line. */
export interface Square {
  c: number;
  r: number;
}

export type PieceKind = 'pawn' | 'queen' | 'knight' | 'rook' | 'bishop' | 'king';

/**
 * How a piece moves (range-limited chess):
 * - king:   1 square any direction (the keeper; must stay in its own box)
 * - queen:  slides any direction up to `range`
 * - rook:   slides orthogonally up to `range`
 * - bishop: slides diagonally up to `range`
 * - knight: L-shaped jump over anything
 * - pawn:   1 square forward or sideways; tackles 1 square diagonally forward
 */
export type MovePattern = 'king' | 'queen' | 'rook' | 'bishop' | 'knight' | 'pawn';

export interface PieceSpec {
  kind: PieceKind;
  name: string;
  letter: string;
  pattern: MovePattern;
  /** Max squares for sliding pieces (ignored for king/knight/pawn). */
  range: number;
  footballRole: string;
}

/** Formation entry expressed from Team A's point of view; Team B is mirrored by row. */
export interface FormationSlot {
  slot: string;
  kind: PieceKind;
  c: number;
  r: number;
}

export interface KickoffSpec {
  slot: string;
  c: number;
  r: number;
}

export interface RulesConfig {
  cols: number;
  rows: number;
  apPerTurn: number;
  /** Extra AP granted by Surge (once per rally per side). */
  surgeAp: number;
  passRange: number;
  shotRange: number;
  /** AP cost of a shot (moves, passes and tackles cost 1). */
  shotCost: number;
  /** Marking: a teammate with an opponent directly beside it (not diagonal) cannot receive a pass. */
  marking: boolean;
  /** Goal mouth columns (inclusive), on each end row. */
  goalCols: [number, number];
  /** Keeper box: same columns as the goal mouth, this many rows deep from the goal line. */
  boxDepth: number;
  goalsToWin: number;
  /** Turns in regulation time (both sides' turns counted). */
  regulationTurns: number;
  /** Hard stop: a level match after this many turns is a draw (golden goal before that). */
  maxTurns: number;
  pieces: Record<PieceKind, PieceSpec>;
  formation: FormationSlot[];
  kickoff: KickoffSpec;
}

export interface Piece {
  id: string;
  team: Team;
  kind: PieceKind;
  /** null while on the bench (tackled) until the next kickoff. */
  pos: Square | null;
}

export type MatchPhase = 'playing' | 'finished';

export interface MatchState {
  config: RulesConfig;
  pieces: Piece[];
  carrierId: string;
  turn: Team;
  ap: number;
  score: Record<Team, number>;
  rally: number;
  /** 1-based number of the turn being played (both sides' turns counted). */
  turnNumber: number;
  kickoffTeam: Team;
  phase: MatchPhase;
  /** Winner when finished; null when finished as a draw (or still playing). */
  winner: Team | null;
  capturesBy: Record<Team, number>;
  /** Surge still available this rally. */
  surge: Record<Team, boolean>;
  /** Tutorial scenarios keep the board after a goal and ignore the clock. */
  resetOnGoal: boolean;
}

export type Action =
  | { type: 'move'; pieceId: string; to: Square }
  | { type: 'pass'; fromId: string; toId: string }
  | { type: 'shoot'; fromId: string; to: Square }
  | { type: 'surge' }
  | { type: 'endTurn' };

export type GameEvent =
  | { type: 'move'; pieceId: string; from: Square; to: Square }
  | { type: 'pass'; fromId: string; toId: string }
  | { type: 'shot'; fromId: string; from: Square; to: Square }
  | { type: 'tackle'; pieceId: string; capturedId: string; at: Square }
  | { type: 'surge'; team: Team }
  | { type: 'goal'; team: Team; score: Record<Team, number>; carrierId: string }
  | { type: 'win'; team: Team }
  | { type: 'goldenGoal' }
  | { type: 'fullTime'; winner: Team | null }
  | { type: 'kickoff'; team: Team; carrierId: string }
  | { type: 'turnEnd'; team: Team; apLost: number; next: Team };

/**
 * Machine-readable reason codes. The UI translates these; `reason` strings in results are the
 * English rendering. The server rules (supabase/setup.sql) use the same codes.
 */
export type ReasonCode =
  | 'unknown_piece'
  | 'match_over'
  | 'not_your_turn'
  | 'captured'
  | 'no_ap'
  | 'occupied_own'
  | 'opponent_blocks'
  | 'path_blocked'
  | 'pawn_tackle'
  | 'keeper_box'
  | 'goal_mouth'
  | 'covered_by_keeper'
  | 'cannot_reach'
  | 'only_carrier'
  | 'not_in_line'
  | 'pass_out_of_range'
  | 'pass_lane_blocked'
  | 'pass_invalid_receiver'
  | 'receiver_marked'
  | 'shot_out_of_range'
  | 'shot_blocked'
  | 'shot_not_goal'
  | 'no_surge'
  | 'unknown_action';

export interface ReasonParams {
  kind?: PieceKind;
  mover?: PieceKind;
  sq?: string;
  team?: Team;
  dist?: number;
  range?: number;
}

export interface Reason {
  code: ReasonCode;
  params: ReasonParams;
}

export type ActionResult =
  | { ok: true; state: MatchState; events: GameEvent[] }
  | { ok: false; state: MatchState; reason: string; why: Reason };

export interface MoveOption {
  to: Square;
  kind: 'move' | 'tackle';
  /** This move puts the ball in the opponent's goal. */
  scores: boolean;
}

export interface BlockedSquare {
  at: Square;
  reason: string;
  why: Reason;
}

export interface MovePreview {
  options: MoveOption[];
  /** Squares in the piece's pattern that it cannot use right now, with a reason. */
  blocked: BlockedSquare[];
  unavailable?: string;
  unavailableWhy?: Reason;
}

export interface PassOption {
  toId: string;
  at: Square;
}

export interface BlockedPass {
  toId: string;
  at: Square;
  reason: string;
  why: Reason;
}

export interface ShotTarget {
  at: Square;
  /** null = open: shooting here scores. Otherwise why it is not possible. */
  why: Reason | null;
}
