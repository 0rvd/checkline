// C-rank ladder. The database is the authority (public.rank_tiers + checkline_private.rank_json);
// this copy is for display only (progress bars, offline fallbacks) and is checked against the
// SQL by `npm run verify:sql`.

export type Tier = 'C5' | 'C4' | 'C3' | 'C2' | 'C1';

/** Points each tier starts at, lowest first. A tier ends where the next one begins. */
export const RANK_TIERS: readonly { tier: Tier; min: number }[] = [
  { tier: 'C5', min: 0 },
  { tier: 'C4', min: 150 },
  { tier: 'C3', min: 300 },
  { tier: 'C2', min: 450 },
  { tier: 'C1', min: 600 },
];

/** Ranked results (server rules, shown in the UI). */
export const RANK_WIN = 10;
export const RANK_LOSS = 6;

export interface RankInfo {
  tier: Tier;
  rankPoints: number;
  tierMin: number;
  /** null at the top tier */
  nextTierAt: number | null;
}

export function rankFor(points: number): RankInfo {
  const p = Math.max(0, Math.floor(Number(points) || 0));
  let i = 0;
  while (i + 1 < RANK_TIERS.length && p >= RANK_TIERS[i + 1].min) i++;
  return { tier: RANK_TIERS[i].tier, rankPoints: p, tierMin: RANK_TIERS[i].min, nextTierAt: RANK_TIERS[i + 1]?.min ?? null };
}

/** 0..1 progress through the current tier (1 at the top tier). */
export function tierProgress(r: Pick<RankInfo, 'rankPoints' | 'tierMin' | 'nextTierAt'>): number {
  if (r.nextTierAt === null) return 1;
  const span = r.nextTierAt - r.tierMin;
  return span > 0 ? Math.min(1, Math.max(0, (r.rankPoints - r.tierMin) / span)) : 1;
}
