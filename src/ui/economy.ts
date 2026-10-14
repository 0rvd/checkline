// Coins, the shop and cosmetic themes. Everything is stored in this browser (localStorage).
// Cosmetic only: floors and skins never change the rules.
//
// Earning: every finished match counts; every 3rd finished match pays MATCH_BONUS coins,
// and every win against the computer or an online opponent pays WIN_BONUS coins.
// Tutorial lessons never pay. A match is paid at most once (keyed by match id).

export type ItemKind = 'floor' | 'skin';

export interface ShopItem {
  id: string;
  kind: ItemKind;
  price: number;
}

export const WIN_BONUS = 3;
export const MATCH_BONUS = 5;
export const MATCHES_PER_BONUS = 3;

/** id 'classic' is the free default for both kinds. */
export const SHOP_ITEMS: ShopItem[] = [
  { id: 'classic', kind: 'floor', price: 0 },
  { id: 'midnight', kind: 'floor', price: 10 },
  { id: 'sunset', kind: 'floor', price: 15 },
  { id: 'neon', kind: 'floor', price: 20 },
  { id: 'classic', kind: 'skin', price: 0 },
  { id: 'obsidian', kind: 'skin', price: 10 },
  { id: 'neon', kind: 'skin', price: 15 },
  { id: 'gold', kind: 'skin', price: 25 },
];

export interface Wallet {
  coins: number;
  /** Finished matches counted towards the every-3-matches bonus. */
  matches: number;
  wins: number;
  owned: string[]; // "floor:neon", "skin:gold"
  floor: string;
  skin: string;
  /** Match keys already paid (most recent last, capped). */
  paid: string[];
}

export interface Award {
  coins: number;
  win: number;
  bonus: number;
  /** Matches left until the next completion bonus. */
  toNext: number;
}

const KEY = 'checkline.wallet.v1';
const fresh = (): Wallet => ({ coins: 0, matches: 0, wins: 0, owned: ['floor:classic', 'skin:classic'], floor: 'classic', skin: 'classic', paid: [] });

export function loadWallet(): Wallet {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fresh();
    const w = { ...fresh(), ...(JSON.parse(raw) as Partial<Wallet>) };
    w.coins = Math.max(0, Math.floor(Number(w.coins) || 0));
    if (!Array.isArray(w.owned)) w.owned = [];
    for (const base of ['floor:classic', 'skin:classic']) if (!w.owned.includes(base)) w.owned.push(base);
    if (!Array.isArray(w.paid)) w.paid = [];
    if (!w.owned.includes(`floor:${w.floor}`)) w.floor = 'classic';
    if (!w.owned.includes(`skin:${w.skin}`)) w.skin = 'classic';
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
export const equipped = (w: Wallet, kind: ItemKind): string => (kind === 'floor' ? w.floor : w.skin);
export const findItem = (kind: ItemKind, id: string): ShopItem | undefined => SHOP_ITEMS.find((i) => i.kind === kind && i.id === id);

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
  if (kind === 'floor') w.floor = id;
  else w.skin = id;
  saveWallet(w);
  applyTheme(w);
  return result;
}

/** Equipped themes are applied as data attributes on <html>; styles.css does the rest. */
export function applyTheme(w: Wallet): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.floor = w.floor;
  document.documentElement.dataset.skin = w.skin;
}
