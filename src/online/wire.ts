// Conversion between the client MatchState and the JSON stored in cl_matches.state.
// The server (supabase/setup.sql) produces exactly this shape.
import { DEFAULT_CONFIG } from '../rules/config.js';
import type { MatchState, Piece, RulesConfig, Team } from '../rules/types.js';

export type WireState = Omit<MatchState, 'config' | 'resetOnGoal'>;

export function toWire(s: MatchState): WireState {
  return {
    pieces: s.pieces.map((p) => ({ id: p.id, team: p.team, kind: p.kind, pos: p.pos ? { c: p.pos.c, r: p.pos.r } : null })),
    carrierId: s.carrierId,
    turn: s.turn,
    ap: s.ap,
    score: { A: s.score.A, B: s.score.B },
    rally: s.rally,
    turnNumber: s.turnNumber,
    kickoffTeam: s.kickoffTeam,
    phase: s.phase,
    winner: s.winner,
    capturesBy: { A: s.capturesBy.A, B: s.capturesBy.B },
    surge: { A: s.surge.A, B: s.surge.B },
  };
}

const isTeam = (t: unknown): t is Team => t === 'A' || t === 'B';

/** Rebuild a MatchState from server JSON. Throws on malformed data. */
export function fromWire(w: unknown, config: RulesConfig = DEFAULT_CONFIG): MatchState {
  const o = w as WireState;
  if (!o || !Array.isArray(o.pieces) || !isTeam(o.turn) || typeof o.carrierId !== 'string') {
    throw new Error('Malformed match state');
  }
  const pieces: Piece[] = o.pieces.map((p) => {
    if (!isTeam(p.team) || !(p.kind in config.pieces)) throw new Error('Malformed piece');
    return { id: String(p.id), team: p.team, kind: p.kind, pos: p.pos ? { c: Number(p.pos.c), r: Number(p.pos.r) } : null };
  });
  return {
    config,
    pieces,
    carrierId: o.carrierId,
    turn: o.turn,
    ap: Number(o.ap),
    score: { A: Number(o.score?.A ?? 0), B: Number(o.score?.B ?? 0) },
    rally: Number(o.rally ?? 1),
    turnNumber: Number(o.turnNumber ?? 1),
    kickoffTeam: isTeam(o.kickoffTeam) ? o.kickoffTeam : o.turn,
    phase: o.phase === 'finished' ? 'finished' : 'playing',
    winner: isTeam(o.winner) ? o.winner : null,
    capturesBy: { A: Number(o.capturesBy?.A ?? 0), B: Number(o.capturesBy?.B ?? 0) },
    surge: { A: o.surge?.A !== false, B: o.surge?.B !== false },
    resetOnGoal: true,
  };
}
