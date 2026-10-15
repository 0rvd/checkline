import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BUNDLES, MATCH_BONUS, SHOP_ITEMS, WIN_BONUS, awardMatch, buyBundle, buyOrEquip, bundleQuote, loadWallet, owns, type Wallet } from '../src/ui/economy.js';

const wallet = (over: Partial<Wallet> = {}): Wallet => ({ ...loadWallet(), ...over });

describe('coins and shop', () => {
  test('a win pays the win bonus; every 3rd finished match pays the match bonus', () => {
    const w = wallet();
    assert.deepEqual(awardMatch(w, 'm1', true), { coins: WIN_BONUS, win: WIN_BONUS, bonus: 0, toNext: 2 });
    assert.equal(awardMatch(w, 'm2', false)?.coins, 0);
    const third = awardMatch(w, 'm3', true)!;
    assert.equal(third.coins, WIN_BONUS + MATCH_BONUS);
    assert.equal(third.toNext, 3);
    assert.equal(w.coins, 2 * WIN_BONUS + MATCH_BONUS);
    assert.equal(w.matches, 3);
    assert.equal(w.wins, 2);
  });

  test('a match is paid only once', () => {
    const w = wallet();
    assert.ok(awardMatch(w, 'online-abc', true));
    assert.equal(awardMatch(w, 'online-abc', true), null);
    assert.equal(w.coins, WIN_BONUS);
  });

  test('items must be affordable; bought items are owned and equipped; equipping owned items is free', () => {
    const w = wallet({ coins: 12 });
    assert.equal(buyOrEquip(w, 'skin', 'gold'), 'too_poor');
    assert.equal(w.coins, 12);
    assert.equal(buyOrEquip(w, 'floor', 'midnight'), 'bought');
    assert.equal(w.coins, 2);
    assert.ok(owns(w, 'floor', 'midnight'));
    assert.equal(w.floor, 'midnight');
    assert.equal(buyOrEquip(w, 'floor', 'classic'), 'equipped');
    assert.equal(buyOrEquip(w, 'floor', 'midnight'), 'equipped');
    assert.equal(w.coins, 2);
    assert.equal(buyOrEquip(w, 'floor', 'nope'), 'unknown');
  });

  test('defaults are owned and equipped', () => {
    const w = wallet();
    assert.ok(owns(w, 'floor', 'classic') && owns(w, 'skin', 'classic'));
    assert.equal(w.floor, 'classic');
    assert.equal(w.skin, 'classic');
  });
});

describe('balls and full sets', () => {
  const B = (id: string) => BUNDLES.find((b) => b.id === id)!;
  test('every set has one floor, one skin and one ball and costs less than the three', () => {
    for (const b of BUNDLES) {
      assert.deepEqual(b.items.map((i) => i.kind).sort(), ['ball', 'floor', 'skin']);
      const q = bundleQuote(wallet(), b);
      assert.ok(q.price < q.full && q.save === q.full - q.price, b.id);
    }
  });
  test('animated floors cost more than the plain ones', () => {
    const floors = SHOP_ITEMS.filter((i) => i.kind === 'floor');
    const plainMax = Math.max(...floors.filter((i) => ['classic', 'midnight', 'sunset', 'neon'].includes(i.id)).map((i) => i.price));
    assert.ok(floors.filter((i) => ['aurora', 'synthwave', 'galaxy', 'prism'].includes(i.id)).every((i) => i.price > plainMax));
  });
  test('buying a set adds all three, equips them, and charges once', () => {
    const w = wallet({ coins: 60 });
    assert.equal(buyBundle(w, 'neon_nights'), 'bought');
    assert.equal(w.coins, 5);
    assert.deepEqual([w.floor, w.skin, w.ball], ['synthwave', 'neon', 'neon']);
    assert.equal(buyBundle(w, 'neon_nights'), 'equipped', 'repeat purchase is free');
    assert.equal(w.coins, 5);
  });
  test('owning part of a set: pay the lower of the set price and the missing items', () => {
    const w = wallet({ coins: 200, owned: ['floor:classic', 'skin:classic', 'ball:classic', 'skin:obsidian', 'ball:cosmic'] });
    assert.equal(bundleQuote(w, B('cosmic')).cost, 60);
    const w2 = wallet({ coins: 200, owned: ['floor:classic', 'skin:classic', 'ball:classic', 'skin:gold'] });
    assert.equal(bundleQuote(w2, B('champion')).cost, 99);
  });
  test('not enough coins: nothing changes', () => {
    const w = wallet({ coins: 54 });
    assert.equal(buyBundle(w, 'neon_nights'), 'too_poor');
    assert.equal(w.coins, 54);
    assert.equal(w.floor, 'classic');
    assert.ok(!owns(w, 'floor', 'synthwave'));
  });
  test('balls are bought and equipped on their own', () => {
    const w = wallet({ coins: 20, floor: 'classic' });
    assert.equal(buyOrEquip(w, 'ball', 'ember'), 'bought');
    assert.deepEqual([w.floor, w.skin, w.ball, w.coins], ['classic', 'classic', 'ember', 8]);
  });
});
