// Coins, the shop and cosmetic themes. Signed-out players keep them in this browser (localStorage);
// signed-in players keep them in the database (public."user", public.user_cosmetics and
// public.coin_transactions in supabase/setup.sql). The browser wallet never overwrites the
// database one: when signed in, the game only reads the server wallet and asks the server to buy.
// Signed-in players earn coins from online matches only (scored on the server); matches against
// the computer cannot be verified by the server, so they pay only the browser wallet.
// Cosmetic only: pitch floors, piece skins and balls never change the rules. The three
// categories are bought and equipped independently; bundles sell one of each for less.
//
// Earning: every finished match counts; every 3rd finished match pays MATCH_BONUS coins,
// and every win against the computer or an online opponent pays WIN_BONUS coins.
// Tutorial lessons never pay. A match is paid at most once (keyed by match id).

export type ItemKind = 'floor' | 'skin' | 'ball';
export const ITEM_KINDS: readonly ItemKind[] = ['floor', 'skin', 'ball'];

export interface ShopItem {
  id: string;
  kind: ItemKind;
  price: number;
}

export const WIN_BONUS = 3;
export const MATCH_BONUS = 5;
export const MATCHES_PER_BONUS = 3;

/**
 * id 'classic' is the free default of every kind. Prices must match public.cosmetics in
 * supabase/setup.sql (checked by `npm run verify:sql`). Animated pitch floors (aurora and up)
 * cost more, in step with how elaborate they are.
 */
export const SHOP_ITEMS: ShopItem[] = [
  { id: 'classic', kind: 'floor', price: 0 },
  { id: 'midnight', kind: 'floor', price: 10 },
  { id: 'sunset', kind: 'floor', price: 15 },
  { id: 'neon', kind: 'floor', price: 20 },
  { id: 'aurora', kind: 'floor', price: 35 },
  { id: 'synthwave', kind: 'floor', price: 45 },
  { id: 'galaxy', kind: 'floor', price: 60 },
  { id: 'prism', kind: 'floor', price: 80 },
  { id: 'classic', kind: 'skin', price: 0 },
  { id: 'obsidian', kind: 'skin', price: 10 },
  { id: 'neon', kind: 'skin', price: 15 },
  { id: 'gold', kind: 'skin', price: 25 },
  { id: 'classic', kind: 'ball', price: 0 },
  { id: 'ember', kind: 'ball', price: 12 },
  { id: 'frost', kind: 'ball', price: 15 },
  { id: 'neon', kind: 'ball', price: 18 },
  { id: 'cosmic', kind: 'ball', price: 30 },
  { id: 'gold', kind: 'ball', price: 35 },
];

/** Full sets: one pitch floor, one piece skin and one ball, for less than the three together. */
export interface Bundle {
  id: string;
  price: number;
  items: { kind: ItemKind; id: string }[];
}
export const BUNDLES: Bundle[] = [
  { id: 'neon_nights', price: 55, items: [{ kind: 'floor', id: 'synthwave' }, { kind: 'skin', id: 'neon' }, { kind: 'ball', id: 'neon' }] },
  { id: 'cosmic', price: 70, items: [{ kind: 'floor', id: 'galaxy' }, { kind: 'skin', id: 'obsidian' }, { kind: 'ball', id: 'cosmic' }] },
  { id: 'champion', price: 99, items: [{ kind: 'floor', id: 'prism' }, { kind: 'skin', id: 'gold' }, { kind: 'ball', id: 'gold' }] },
];

export interface Wallet {
  coins: number;
  /** Finished matches counted towards the every-3-matches bonus. */
  matches: number;
  wins: number;
  owned: string[]; // "floor:neon", "skin:gold"
  floor: string;
  skin: string;
  ball: string;
  /** Match keys already paid (most recent last, capped). */
  paid: string[];
  /** Signed in: live prices from public.cosmetics / public.bundles ("skin:gold" -> 25, "bundle:cosmic" -> 70). */
  prices?: Record<string, number>;
}

export interface Award {
  coins: number;
  win: number;
  bonus: number;
  /** Matches left until the next completion bonus. */
  toNext: number;
}

const KEY = 'checkline.wallet.v1';
const STARTER = ['floor:classic', 'skin:classic', 'ball:classic'];
const fresh = (): Wallet => ({ coins: 0, matches: 0, wins: 0, owned: [...STARTER], floor: 'classic', skin: 'classic', ball: 'classic', paid: [] });

export function loadWallet(): Wallet {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fresh();
    const w = { ...fresh(), ...(JSON.parse(raw) as Partial<Wallet>) };
    w.coins = Math.max(0, Math.floor(Number(w.coins) || 0));
    if (!Array.isArray(w.owned)) w.owned = [];
    for (const base of STARTER) if (!w.owned.includes(base)) w.owned.push(base);
    if (!Array.isArray(w.paid)) w.paid = [];
    if (!w.owned.includes(`floor:${w.floor}`)) w.floor = 'classic';
    if (!w.owned.includes(`skin:${w.skin}`)) w.skin = 'classic';
    if (typeof w.ball !== 'string' || !w.owned.includes(`ball:${w.ball}`)) w.ball = 'classic';
    return w;
  } catch {
    return fresh();
  }
}

export function saveWallet(w: Wallet): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(w));
  } catch {
    /* storage unavailable: progress lasts for this visit only */
  }
}

export const owns = (w: Wallet, kind: ItemKind, id: string): boolean => w.owned.includes(`${kind}:${id}`);
export const equipped = (w: Wallet, kind: ItemKind): string => w[kind];
export const findItem = (kind: ItemKind, id: string): ShopItem | undefined => SHOP_ITEMS.find((i) => i.kind === kind && i.id === id);
/** Price shown in the shop: the database price when signed in, otherwise the built-in one. */
export const priceOf = (w: Wallet, it: ShopItem): number => {
  const p = w.prices?.[`${it.kind}:${it.id}`];
  return typeof p === 'number' && p >= 0 ? p : it.price;
};

/** Pay for a finished match once. Returns what was earned, or null if this match was already paid. */
export function awardMatch(w: Wallet, matchKey: string, won: boolean): Award | null {
  if (w.paid.includes(matchKey)) return null;
  w.paid = [...w.paid, matchKey].slice(-60);
  w.matches += 1;
  const win = won ? WIN_BONUS : 0;
  const bonus = w.matches % MATCHES_PER_BONUS === 0 ? MATCH_BONUS : 0;
  if (won) w.wins += 1;
  w.coins += win + bonus;
  saveWallet(w);
  return { coins: win + bonus, win, bonus, toNext: MATCHES_PER_BONUS - (w.matches % MATCHES_PER_BONUS) };
}

export type BuyResult = 'bought' | 'equipped' | 'too_poor' | 'unknown';

/** Buy (if needed) and equip an item. */
export function buyOrEquip(w: Wallet, kind: ItemKind, id: string): BuyResult {
  const item = findItem(kind, id);
  if (!item) return 'unknown';
  let result: BuyResult = 'equipped';
  if (!owns(w, kind, id)) {
    if (w.coins < item.price) return 'too_poor';
    w.coins -= item.price;
    w.owned.push(`${kind}:${id}`);
    result = 'bought';
  }
  w[kind] = id;
  saveWallet(w);
  applyTheme(w);
  return result;
}

export const findBundle = (id: string): Bundle | undefined => BUNDLES.find((b) => b.id === id);

export interface BundleQuote {
  /** Bundle price (database price when signed in). */
  price: number;
  /** The three items bought one by one. */
  full: number;
  /** Coins saved against buying all three separately. */
  save: number;
  /** Items the player does not own yet. */
  missing: ShopItem[];
  /** What the player pays now: the bundle price, or less if they already own some items
   *  (never more than buying the missing items one by one). 0 = already complete. */
  cost: number;
}

/** Same calculation as public.cl_buy_bundle on the server. */
export function bundleQuote(w: Wallet, b: Bundle): BundleQuote {
  const items = b.items.map((i) => findItem(i.kind, i.id)).filter((i): i is ShopItem => !!i);
  const full = items.reduce((n, i) => n + priceOf(w, i), 0);
  const price = bundlePrice(w, b);
  const missing = items.filter((i) => !owns(w, i.kind, i.id));
  const missingSum = missing.reduce((n, i) => n + priceOf(w, i), 0);
  return { price, full, save: Math.max(0, full - price), missing, cost: missing.length ? Math.min(price, missingSum) : 0 };
}

export const bundlePrice = (w: Wallet, b: Bundle): number => {
  const p = w.prices?.[`bundle:${b.id}`];
  return typeof p === 'number' && p >= 0 ? p : b.price;
};

/** Buy (if needed) and equip a whole set: all items are added together or nothing changes. */
export function buyBundle(w: Wallet, id: string): BuyResult {
  const b = findBundle(id);
  if (!b) return 'unknown';
  const q = bundleQuote(w, b);
  if (w.coins < q.cost) return 'too_poor';
  w.coins -= q.cost;
  for (const i of q.missing) w.owned.push(`${i.kind}:${i.id}`);
  for (const i of b.items) w[i.kind] = i.id;
  saveWallet(w);
  applyTheme(w);
  return q.missing.length ? 'bought' : 'equipped';
}

/** Equipped themes are applied as data attributes on <html>; styles.css does the rest. */
export function applyTheme(w: Wallet): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.floor = w.floor;
  document.documentElement.dataset.skin = w.skin;
  document.documentElement.dataset.ball = w.ball;
}

/** Take the coins and items stored in the database (signed-in players) into the in-memory wallet. */
export function fromServer(
  local: Wallet,
  s: { coins: number; matches: number; wins: number; owned: string[]; floor: string; skin: string; ball?: string; prices?: Record<string, number> },
): Wallet {
  const owned = Array.from(new Set([...STARTER, ...(Array.isArray(s.owned) ? s.owned : [])]));
  const w: Wallet = {
    ...local,
    coins: Math.max(0, Math.floor(Number(s.coins) || 0)),
    matches: Number(s.matches) || 0,
    wins: Number(s.wins) || 0,
    owned,
    floor: s.floor,
    skin: s.skin,
    ball: s.ball ?? 'classic',
    prices: s.prices && typeof s.prices === 'object' ? s.prices : undefined,
  };
  if (!owned.includes(`floor:${w.floor}`) || !findItem('floor', w.floor)) w.floor = 'classic';
  if (!owned.includes(`skin:${w.skin}`) || !findItem('skin', w.skin)) w.skin = 'classic';
  if (!owned.includes(`ball:${w.ball}`) || !findItem('ball', w.ball)) w.ball = 'classic';
  return w;
}
