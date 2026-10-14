// English rendering of rule reason codes. Used for engine `reason` strings (logs, tests).
// The UI translates codes through src/i18n instead.
import { PIECES } from './config.js';
import type { Reason, ReasonCode, ReasonParams } from './types.js';

export function why(code: ReasonCode, params: ReasonParams = {}): Reason {
  return { code, params };
}

const name = (k?: keyof typeof PIECES) => (k ? PIECES[k].name : 'piece');

export function formatReasonEn(r: Reason): string {
  const p = r.params;
  switch (r.code) {
    case 'unknown_piece':
      return 'Unknown piece';
    case 'match_over':
      return 'The match is over';
    case 'not_your_turn':
      return `It is Team ${p.team}'s turn`;
    case 'captured':
      return 'On the bench until the next kickoff';
    case 'no_ap':
      return 'No Action Points left; end your turn';
    case 'occupied_own':
      return `Your ${name(p.kind)} is on ${p.sq}`;
    case 'opponent_blocks':
      return `The opponent ${name(p.kind)} on ${p.sq} doesn't have the ball; only the ball carrier can be tackled`;
    case 'path_blocked':
      return `The path to ${p.sq} is blocked`;
    case 'pawn_tackle':
      return 'Pawns tackle diagonally forward, like a chess capture';
    case 'keeper_box':
      return 'The keeper must stay inside its box';
    case 'goal_mouth':
      return 'Only the keeper may stand in its goal mouth';
    case 'covered_by_keeper':
      return `The keeper covers ${p.sq}`;
    case 'cannot_reach':
      return `The ${name(p.mover)} cannot reach ${p.sq}`;
    case 'only_carrier':
      return 'Only the ball carrier can pass or shoot';
    case 'not_in_line':
      return 'Passes and shots travel in a straight line (row, column or diagonal)';
    case 'pass_out_of_range':
      return `Out of pass range (${p.dist} > ${p.range})`;
    case 'pass_lane_blocked':
      return `Lane blocked by the ${name(p.kind)} on ${p.sq}`;
    case 'pass_invalid_receiver':
      return 'Receiver must be a teammate in a straight line';
    case 'receiver_marked':
      return `Your ${name(p.kind)} on ${p.sq} is marked by an opponent and can't receive`;
    case 'shot_out_of_range':
      return `Too far to shoot (${p.dist} > ${p.range})`;
    case 'shot_blocked':
      return `Shot blocked by the ${name(p.kind)} on ${p.sq}`;
    case 'shot_not_goal':
      return 'Shots must target an open square in the opponent goal mouth';
    case 'no_surge':
      return 'Surge already used this rally';
    case 'unknown_action':
      return 'Unknown action';
  }
}
