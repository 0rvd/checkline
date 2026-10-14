import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MATCH_BONUS, WIN_BONUS, awardMatch, buyOrEquip, loadWallet, owns, type Wallet } from '../src/ui/economy.js';

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
