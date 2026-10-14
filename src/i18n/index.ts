// Localization: language state, lookup with {param} interpolation, and helpers that turn
// rule codes, pieces, teams and game events into translated text.
import type { GameEvent, MovePattern, PieceKind, Reason, Team } from '../rules/types.js';
import { ar } from './ar.js';
import { en, type MessageKey } from './en.js';

export type Lang = 'en' | 'ar';
export type { MessageKey };
export type Params = Record<string, string | number>;

const catalogs: Record<Lang, Record<MessageKey, string>> = { en, ar };
const STORAGE_KEY = 'checkline.lang';

function detect(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'ar') return saved;
  } catch {
    /* storage unavailable */
  }
  const nav = typeof navigator !== 'undefined' ? navigator.language || '' : '';
  return nav.toLowerCase().startsWith('ar') ? 'ar' : 'en';
}

let current: Lang = typeof window === 'undefined' ? 'en' : detect();

export const getLang = (): Lang => current;
export const isRtl = (): boolean => current === 'ar';

/** Apply lang/dir to <html>. Call once at start and after every change. */
export function applyDocumentLang(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = current;
  document.documentElement.dir = isRtl() ? 'rtl' : 'ltr';
}

export function setLang(lang: Lang): void {
  current = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* remembered for this session only */
  }
  applyDocumentLang();
}

export function t(key: MessageKey, params?: Params): string {
  const raw = catalogs[current][key] ?? en[key] ?? key;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}

/** Same as t() but HTML-escapes parameter values (for strings that contain markup). */
export function tHtml(key: MessageKey, params?: Params): string {
  if (!params) return t(key);
  const safe: Params = {};
  for (const [k, v] of Object.entries(params)) safe[k] = typeof v === 'number' ? v : escapeHtml(v);
  return t(key, safe);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

export const teamName = (team: Team): string => t(team === 'A' ? 'team.A' : 'team.B');
export const teamFull = (team: Team): string => t('team.full', { letter: team, name: teamName(team) });
export const pieceName = (kind: PieceKind): string => t(`piece.${kind}` as MessageKey);
export const pieceLetter = (kind: PieceKind): string => t(`letter.${kind}` as MessageKey);
export const pieceRole = (kind: PieceKind): string => t(`role.${kind}` as MessageKey);
/** How a movement pattern works, e.g. "Up to 3 squares diagonally". */
export const moveText = (pattern: MovePattern, range: number): string => t(`move.${pattern}` as MessageKey, { n: range });

/** Translate an engine reason code. */
export function reasonText(why: Reason): string {
  const p = why.params;
  return t(`reason.${why.code}` as MessageKey, {
    piece: p.kind ? pieceName(p.kind) : '',
    mover: p.mover ? pieceName(p.mover) : '',
    sq: p.sq ?? '',
    team: p.team ? teamName(p.team) : '',
    dist: p.dist ?? '',
    range: p.range ?? '',
  });
}

const sq = (s: { c: number; r: number }) => String.fromCharCode(65 + s.c) + String(s.r + 1);

/** Translate a game event for the match log. `lookup` resolves piece ids to team/kind. */
export function eventText(e: GameEvent, lookup: (id: string) => { team: Team; kind: PieceKind } | undefined): string {
  const who = (id: string) => {
    const p = lookup(id);
    return p ? { team: teamName(p.team), piece: pieceName(p.kind) } : { team: '', piece: id };
  };
  switch (e.type) {
    case 'move':
      return t('log.move', { ...who(e.pieceId), from: sq(e.from), to: sq(e.to) });
    case 'shot':
      return t('log.shot', { ...who(e.fromId), from: sq(e.from), to: sq(e.to) });
    case 'surge':
      return t('log.surge', { team: teamName(e.team) });
    case 'goldenGoal':
      return t('log.golden');
    case 'fullTime':
      return e.winner ? t('log.fullTime', { team: teamName(e.winner) }) : t('log.draw');
    case 'pass':
      return t('log.pass', { ...who(e.fromId), other: who(e.toId).piece });
    case 'tackle':
      return t('log.tackle', { ...who(e.pieceId), other: who(e.capturedId).piece, sq: sq(e.at) });
    case 'goal':
      return t('log.goal', { team: teamName(e.team), a: e.score.A, b: e.score.B });
    case 'win':
      return t('log.win', { team: teamName(e.team) });
    case 'kickoff':
      return t('log.kickoff', { team: teamName(e.team) });
    case 'turnEnd':
      return e.apLost ? t('log.turnEndAp', { team: teamName(e.team), n: e.apLost }) : t('log.turnEnd', { team: teamName(e.team) });
  }
}

/** Check that every catalog has the same keys and placeholders (used by tests). */
export function catalogProblems(): string[] {
  const problems: string[] = [];
  const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(',');
  for (const key of Object.keys(en) as MessageKey[]) {
    for (const lang of ['ar'] as Lang[]) {
      const v = catalogs[lang][key];
      if (typeof v !== 'string' || !v.trim()) problems.push(`${lang}: missing ${key}`);
      else if (ph(v) !== ph(en[key])) problems.push(`${lang}: placeholders differ in ${key}`);
    }
  }
  return problems;
}
