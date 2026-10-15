import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { RANK_TIERS, rankFor, tierProgress } from '../src/online/ranks.js';
import { fromServer, loadWallet, priceOf, SHOP_ITEMS } from '../src/ui/economy.js';

describe('C-rank ladder', () => {
  test('tiers start at 0 / 150 / 300 / 450 / 600 points (C5 -> C1)', () => {
    assert.deepEqual(RANK_TIERS.map((t) => [t.tier, t.min]), [['C5', 0], ['C4', 150], ['C3', 300], ['C2', 450], ['C1', 600]]);
    const cases: [number, string][] = [[0, 'C5'], [149, 'C5'], [150, 'C4'], [299, 'C4'], [300, 'C3'], [449, 'C3'], [450, 'C2'], [599, 'C2'], [600, 'C1'], [9999, 'C1'], [-20, 'C5']];
    for (const [p, tier] of cases) assert.equal(rankFor(p).tier, tier, `${p} points`);
  });
  test('progress through a tier and to the next one', () => {
    assert.deepEqual(rankFor(225), { tier: 'C4', rankPoints: 225, tierMin: 150, nextTierAt: 300 });
    assert.equal(tierProgress(rankFor(225)), 0.5);
    assert.equal(rankFor(700).nextTierAt, null);
    assert.equal(tierProgress(rankFor(700)), 1);
  });
});

describe('signed-in wallet', () => {
  test('server wallet replaces the browser balance and brings live prices', () => {
    const local = { ...loadWallet(), coins: 999, owned: ['floor:classic', 'skin:classic', 'skin:gold'], skin: 'gold' };
    const w = fromServer(local, { coins: 12, matches: 4, wins: 2, owned: ['floor:classic', 'skin:classic'], floor: 'classic', skin: 'gold', prices: { 'skin:gold': 40 } });
    assert.equal(w.coins, 12);
    assert.equal(w.skin, 'classic', 'cannot wear an item the account does not own');
    assert.equal(priceOf(w, SHOP_ITEMS.find((i) => i.kind === 'skin' && i.id === 'gold')!), 40);
    assert.equal(priceOf(local, SHOP_ITEMS.find((i) => i.kind === 'skin' && i.id === 'gold')!), 25);
  });
});
