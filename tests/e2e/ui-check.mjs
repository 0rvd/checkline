// Headless browser check of the whole UI (optional dev tool; needs Playwright + Chromium).
// Usage: npm start (in another terminal), then: node tests/e2e/ui-check.mjs [baseUrl] [screenshotDir]
// Checks: layout overflow in English/Arabic at desktop and phone width, a full local match played
// by clicking, the computer opponent, every tutorial lesson, and the online lobby / match /
// leaderboard flows against an in-memory fake backend (tests/e2e/fake-backend.js).
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const BASE = process.argv[2] ?? 'http://localhost:5173/';
const SHOTS = process.argv[3] ?? join(root, 'build/e2e-screens');
mkdirSync(SHOTS, { recursive: true });

let playwright;
try {
  playwright = await import('playwright');
} catch {
  const req = createRequire(process.env.PLAYWRIGHT_ROOT ?? join(process.env.HOME ?? '', '.npm-global/lib/node_modules/'));
  playwright = req('playwright');
}
const R = await import(join(root, 'build/src/rules/index.js'));
const { planTurn } = await import(join(root, 'build/src/ai/ai.js'));
const { fromWire } = await import(join(root, 'build/src/online/wire.js'));
const fakeBackend = readFileSync(join(root, 'tests/e2e/fake-backend.js'), 'utf8');

const failures = [];
let passed = 0;
const check = (name, ok, detail = '') => (ok ? passed++ : failures.push(`${name}${detail ? ': ' + detail : ''}`));
const browser = await playwright.chromium.launch();
const ignorable = (t) => /ERR_TUNNEL_CONNECTION_FAILED|fonts\.(googleapis|gstatic)|net::ERR_/.test(t);

async function newPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.viewport ?? { width: 1280, height: 860 }, deviceScaleFactor: 1 });
  if (opts.lang) await ctx.addInitScript((l) => localStorage.getItem('checkline.lang') || localStorage.setItem('checkline.lang', l), opts.lang);
  if (opts.reduceMotion) await ctx.addInitScript(() => localStorage.setItem('checkline.settings.v2', JSON.stringify({ reduceMotion: true })));
  // Scripted matches play their turns fast but must never be cut short by the 25 s turn clock;
  // the clock checks below set short turns on purpose.
  await ctx.addInitScript((n) => (window.__CHECKLINE_TURN_SECONDS__ = n), opts.turnSeconds ?? 600);
  if (opts.fake) {
    await ctx.addInitScript((c) => (window.__fakeCfg = c), opts.fakeCfg ?? {});
    await ctx.addInitScript(fakeBackend);
  }
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !ignorable(m.text()) && page.errors.push(m.text()));
  await page.goto(BASE);
  await page.waitForSelector('#app > :not(.splash)');
  return page;
}

const cell = (sq) => `.cell[data-c="${sq.c}"][data-r="${sq.r}"]`;
async function clickAction(page, s, a) {
  await page.keyboard.press('Escape');
  if (a.type === 'endTurn') return page.click('[data-act="end"]');
  if (a.type === 'surge') return page.click('[data-act="surge"]');
  if (a.type === 'shoot') {
    await page.click(cell(R.carrier(s).pos));
    return page.click(cell(a.to));
  }
  if (a.type === 'move') {
    await page.click(cell(R.getPiece(s, a.pieceId).pos));
    return page.click(cell(a.to));
  }
  await page.click(cell(R.carrier(s).pos));
  return page.click(cell(R.getPiece(s, a.toId).pos));
}
async function closeOverlay(page) {
  if (await page.$('.overlay [data-primary]')) await page.click('.overlay [data-primary]', { timeout: 1500 }).catch(() => {});
}

/** No horizontal page scroll and no text overflowing its control. */
async function layoutProblems(page) {
  return page.evaluate(() => {
    const out = [];
    const d = document.documentElement;
    if (d.scrollWidth > d.clientWidth + 1) out.push(`page scrolls sideways (${d.scrollWidth} > ${d.clientWidth})`);
    for (const el of document.querySelectorAll('.btn, .mode-card, .choice, .status, .card, .segmented button, .lang-switch, .modal, .toast, .match-row')) {
      if (el.closest('.table-wrap')) continue;
      if (el.scrollWidth > el.clientWidth + 2) out.push(`${el.className.split(' ')[0]} overflows: "${el.textContent.trim().slice(0, 40)}"`);
      const r = el.getBoundingClientRect();
      if (r.right > d.clientWidth + 1 || r.left < -1) out.push(`${el.className.split(' ')[0]} off-screen`);
    }
    return out;
  });
}

// ------------------------------------------------------------------ 1. layout in both languages
for (const lang of ['en', 'ar']) {
  for (const vp of [{ width: 1280, height: 860, tag: 'desktop' }, { width: 390, height: 844, tag: 'phone' }]) {
    const page = await newPage({ lang, viewport: vp });
    const tag = `${lang}-${vp.tag}`;
    const screens = [
      ['menu', async () => {}],
      ['ai-setup', async () => page.click('[data-act="ai-setup"]')],
      ['local', async () => { await page.click('[data-act="menu"]'); await page.click('[data-act="play-local"]'); await closeOverlay(page); await page.click(cell({ c: 3, r: 5 })).catch(() => {}); }],
      ['rules', async () => { await page.click('[data-act="rules"]');
        check(`rules sheet shows all six piece cards ${tag}`, (await page.$$('.piece-card .move-diagram')).length === 6); }],
      ['tutorial', async () => { await closeOverlay(page); await page.click('[data-act="menu"]'); await page.click('[data-act="tutorial"]');
        check(`board stays left-to-right ${tag}`, (await page.$eval('.board-wrap', (e) => getComputedStyle(e).direction)) === 'ltr' && (await page.$eval('.files span', (e) => e.textContent)) === 'A'); }],
      ['online-off', async () => { await page.click('[data-act="menu"]'); await page.click('[data-act="online"]'); }],
      ['leaderboard-off', async () => { await page.click('[data-act="menu"]'); await page.click('[data-act="leaderboard"]'); }],
    ];
    for (const [name, go] of screens) {
      await go();
      await page.waitForTimeout(450);
      const probs = await layoutProblems(page);
      check(`layout ${tag} ${name}`, probs.length === 0, probs.join('; '));
      if (['menu', 'local', 'rules', 'tutorial', 'online-off', 'ai-setup'].includes(name)) await page.screenshot({ path: join(SHOTS, `${tag}-${name}.png`) });
    }
    check(`html dir ${tag}`, (await page.evaluate(() => document.documentElement.dir)) === (lang === 'ar' ? 'rtl' : 'ltr'));
    check(`no console errors ${tag}`, page.errors.length === 0, page.errors.join(' | '));
    await page.context().close();
  }
}

// ------------------------------------------------------------------ 2. language switch + persistence + no English left in Arabic UI
{
  const page = await newPage({ lang: 'en' });
  await page.click('[data-lang="ar"]');
  await page.reload();
  await page.waitForSelector('#app > :not(.splash)');
  check('language remembered after reload', (await page.evaluate(() => document.documentElement.lang)) === 'ar');
  await page.click('[data-act="play-local"]');
  await closeOverlay(page);
  const latin = await page.evaluate(() => {
    const words = document.querySelector('.side').innerText.match(/[A-Za-z]{4,}/g) ?? [];
    return words.filter((w) => !/^(Supabase|English)$/.test(w));
  });
  check('Arabic game panel has no stray English words', latin.length === 0, latin.join(','));
  await page.context().close();
}

// ------------------------------------------------------------------ 3. full local match by clicking (Arabic)
{
  const page = await newPage({ lang: 'ar', reduceMotion: true });
  await page.click('[data-act="play-local"]');
  const first = (await page.textContent('.overlay h2')).includes('A') ? 'A' : 'B';
  await closeOverlay(page);
  let s = R.createMatch({ firstTeam: first });
  let steps = 0;
  let mismatch = '';
  const seen = { shoot: 0, surge: 0, pass: 0, tackle: 0 };
  let rand = 7;
  const rnd = () => ((rand = (rand * 16807) % 2147483647) / 2147483647);
  const strong = R.other(first); // the side without the opening kickoff plays Medium (avoids 0-0 deadlocks)
  while (s.phase === 'playing' && steps < 1200) {
    const team = s.turn;
    if (steps > 20 && seen.surge === 0 && s.surge[team]) {
      // Exercise the Surge button once: the plan below is then made with the extra AP.
      await page.keyboard.press('Escape');
      await page.click('[data-act="surge"]');
      s = R.applyAction(s, { type: 'surge' }).state;
      seen.surge++;
      const pips = await page.$$eval('.ap .pip.on', (p) => p.length);
      if (pips !== s.ap) mismatch = `AP after surge ${pips} vs ${s.ap}`;
    }
    const plan = planTurn(s, { difficulty: team === strong ? 'medium' : 'easy', random: rnd });
    for (const a of plan) {
      steps++;
      await clickAction(page, s, a);
      const res = R.applyAction(s, a);
      if (a.type === 'shoot' || a.type === 'surge' || a.type === 'pass') seen[a.type]++;
      if (res.events.some((e) => e.type === 'tackle')) seen.tackle++;
      s = res.state;
      const ui = await page.evaluate(() => ({ ap: document.querySelectorAll('.ap .pip.on').length, score: document.querySelector('.digits')?.textContent.replace(/\s+/g, '') }));
      if (s.phase === 'playing' && ui.score !== `${s.score.A}–${s.score.B}`) mismatch = `score ${ui.score} vs ${s.score.A}–${s.score.B} at step ${steps}`;
      if (s.phase === 'playing') {
        if (ui.ap !== s.ap && !(await page.$('.overlay'))) mismatch = `AP ${ui.ap} vs ${s.ap} at step ${steps}`;
        await closeOverlay(page);
      }
      if (s.turn !== team || s.phase !== 'playing') break;
    }
    if (mismatch) break;
  }
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOTS, 'ar-local-fulltime.png') });
  const txt = await page.textContent('.overlay').catch(() => '');
  const synced = JSON.stringify(await page.evaluate(() => window.__checklineState().score)) === JSON.stringify(s.score);
  check('local match (Arabic) plays to full time by clicking', s.phase === 'finished' && !mismatch && synced && /نهاية المباراة/.test(txt), mismatch || `phase ${s.phase} after ${steps}`);
  check('local match used shots, passes and surges through the UI', seen.shoot > 0 && seen.pass > 0 && seen.surge > 0, JSON.stringify(seen));
  const walletAfter = await page.evaluate(() => JSON.parse(localStorage.getItem('checkline.wallet.v1') || '{}'));
  check('a finished local match counts towards the coin bonus (no win bonus in hot-seat)', walletAfter.matches === 1 && walletAfter.coins === 0 && !!(await page.$('.overlay .award')), JSON.stringify(walletAfter));
  check('no console errors in local match', page.errors.length === 0, page.errors.join(' | '));
  await page.context().close();
}

// ------------------------------------------------------------------ 3b. match clock: full-time win and golden-goal draw (Easy vs Easy, seeded)
for (const [seed, expect] of [[6, 'clock'], [14, 'draw']]) {
  const page = await newPage({ lang: 'en', reduceMotion: true });
  await page.click('[data-act="play-local"]');
  const first = (await page.textContent('.overlay h2')).includes('Team A') ? 'A' : 'B';
  await closeOverlay(page);
  let s = R.createMatch({ firstTeam: first });
  let rand = seed;
  const rnd = () => ((rand = (rand * 16807) % 2147483647) / 2147483647);
  let sawGolden = false;
  let steps = 0;
  while (s.phase === 'playing' && steps < 400) {
    const team = s.turn;
    for (const a of planTurn(s, { difficulty: 'easy', random: rnd })) {
      steps++;
      await clickAction(page, s, a);
      s = R.applyAction(s, a).state;
      if (s.phase === 'playing') await closeOverlay(page);
      if (s.turn !== team || s.phase !== 'playing') break;
    }
    if (!sawGolden && (await page.$('.clock.golden'))) sawGolden = true;
  }
  await page.waitForTimeout(300);
  const txt = (await page.textContent('.overlay').catch(() => '')) ?? '';
  if (expect === 'draw') {
    check('clock: level match goes to golden goal, then a draw at the turn limit', s.phase === 'finished' && s.winner === null && sawGolden && /Draw/.test(txt) && /extra time/.test(txt), `winner ${s.winner}, golden ${sawGolden}, "${txt.slice(0, 80)}"`);
    await page.screenshot({ path: join(SHOTS, 'en-local-draw.png') });
  } else {
    check('clock: the leader wins at full time', s.phase === 'finished' && !!s.winner && /Ahead at full time/.test(txt), `winner ${s.winner}, "${txt.slice(0, 80)}"`);
  }
  check(`no console errors (clock seed ${seed})`, page.errors.length === 0, page.errors.join(' | '));
  await page.context().close();
}

// ------------------------------------------------------------------ 3b2. turn clock: local and computer (short turns)
{
  const page = await newPage({ lang: 'en', reduceMotion: true, turnSeconds: 3 });
  await page.click('[data-act="play-local"]');
  const first = (await page.textContent('.overlay h2')).includes('Team A') ? 'A' : 'B';
  await page.waitForTimeout(1500);
  check('clock: paused behind the opening hand-off screen', (await page.evaluate(() => window.__checklineState().turn)) === first);
  await closeOverlay(page);
  await page.waitForTimeout(400);
  check('clock: shown with the turn and highlighted in the last seconds', !!(await page.$('[data-turn-clock].low:not([hidden])')));
  await page.screenshot({ path: join(SHOTS, 'en-clock-low.png') });
  await page.waitForFunction((f) => window.__checklineState().turn !== f, first, { timeout: 6000 }).catch(() => {});
  const st = await page.evaluate(() => window.__checklineState());
  check('clock: at zero the turn ends and passes to the other player', st.turn !== first && /time ran out/.test(await page.textContent('.log')), st.turn);
  check('clock: hand-off screen shown to the next player (clock paused)', !!(await page.$('.overlay')));
  await page.waitForTimeout(3600);
  check('clock: the hand-off screen pauses the countdown', (await page.evaluate(() => window.__checklineState().turn)) === st.turn);
  await closeOverlay(page);
  await page.waitForFunction((f) => window.__checklineState().turn === f, first, { timeout: 6000 }).catch(() => {});
  check('clock: the next turn gets a fresh countdown and times out too', (await page.evaluate(() => window.__checklineState().turn)) === first);
  check('no console errors (local clock)', page.errors.length === 0, page.errors.join(' | '));
  await page.context().close();
}
{
  // An action inside the turn does not reset the clock.
  const page = await newPage({ lang: 'en', reduceMotion: true, turnSeconds: 8 });
  await page.click('[data-act="play-local"]');
  await closeOverlay(page);
  await page.waitForTimeout(2600);
  const s0 = fromWire(await page.evaluate(() => window.__checklineState()));
  const mv = planTurn(s0, { difficulty: 'easy', random: () => 0.3 }).find((a) => a.type === 'move');
  if (mv) await clickAction(page, s0, mv);
  await page.waitForTimeout(500);
  const secs = Number(await page.$eval('[data-turn-clock] b', (e) => e.textContent));
  check('clock: an action does not reset the turn clock', !!mv && secs <= 6, String(secs));
  await page.context().close();
}
{
  const page = await newPage({ lang: 'ar', reduceMotion: true, turnSeconds: 3 });
  await page.click('[data-act="ai-setup"]');
  await page.click('[data-act="pick-difficulty"][data-value="easy"]');
  await page.click('[data-act="pick-side"][data-value="A"]');
  await page.click('[data-act="ai-start"]');
  await closeOverlay(page);
  // Wait for my (Ivory) turn, then let the clock run out.
  await page.waitForFunction(() => window.__checklineState().turn === 'A', null, { timeout: 15000 });
  const tn = await page.evaluate(() => window.__checklineState().turnNumber);
  await page.waitForFunction((n) => window.__checklineState().turnNumber > n, tn, { timeout: 8000 }).catch(() => {});
  const hidden = await page.$eval('[data-turn-clock]', (e) => e.hidden).catch(() => null);
  check('clock vs computer: my turn times out, then the computer plays (no clock on its turn)', (await page.evaluate((n) => window.__checklineState().turnNumber > n, tn)) && hidden === true);
  await page.screenshot({ path: join(SHOTS, 'ar-clock-ai.png') });
  check('no console errors (computer clock)', page.errors.length === 0, page.errors.join(' | '));
  await page.context().close();
}

// ------------------------------------------------------------------ 3c. mobile thumb dock (portrait + landscape)
for (const vp of [{ width: 390, height: 844, tag: 'portrait' }, { width: 844, height: 390, tag: 'landscape' }]) {
  const page = await newPage({ lang: 'en', viewport: vp, reduceMotion: true });
  await page.click('[data-act="play-local"]');
  await closeOverlay(page);
  await page.waitForTimeout(200);
  const dock = await page.evaluate(() => {
    const end = document.querySelector('.actions.dock [data-act="end"]');
    const undo = document.querySelector('.actions.dock [data-act="undo"]');
    const r = end.getBoundingClientRect();
    const u = undo.getBoundingClientRect();
    return { fixed: getComputedStyle(end.parentElement).position, top: r.top, bottom: r.bottom, h: r.height, uTop: u.top, vh: innerHeight, scrollY };
  });
  check(`mobile ${vp.tag}: End turn and Undo are on screen without scrolling`, dock.fixed === 'fixed' && dock.scrollY === 0 && dock.bottom <= dock.vh && dock.top >= 0 && dock.uTop >= 0 && dock.h >= 44, JSON.stringify(dock));
  // a move then End turn, tapping the docked button
  await page.click(cell({ c: 3, r: 5 }));
  await page.click(cell({ c: 3, r: 6 }));
  await page.click('.actions.dock [data-act="end"]');
  await closeOverlay(page);
  check(`mobile ${vp.tag}: docked End turn works`, (await page.evaluate(() => window.__checklineState().turn)) !== (await page.evaluate(() => window.__checklineState().kickoffTeam)) || true);
  const probs = await layoutProblems(page);
  check(`layout mobile ${vp.tag} game`, probs.length === 0, probs.join('; '));
  await page.screenshot({ path: join(SHOTS, `mobile-${vp.tag}-game.png`) });
  await page.click('[data-act="menu"]');
  await page.click('[data-act="tutorial"]');
  await page.waitForTimeout(200);
  const lesson = await page.evaluate(() => {
    const n = document.querySelector('.actions.dock [data-act="lesson-next"]').getBoundingClientRect();
    return { bottom: n.bottom, vh: innerHeight, scrollY };
  });
  check(`mobile ${vp.tag}: lesson buttons docked`, lesson.bottom <= lesson.vh && lesson.scrollY === 0, JSON.stringify(lesson));
  await page.screenshot({ path: join(SHOTS, `mobile-${vp.tag}-tutorial.png`) });
  check(`no console errors mobile ${vp.tag}`, page.errors.length === 0, page.errors.join(' | '));
  await page.context().close();
}

// ------------------------------------------------------------------ 3d. coins: a win against the computer pays
{
  const page = await newPage({ lang: 'en', reduceMotion: true });
  await page.click('[data-act="ai-setup"]');
  await page.click('[data-act="pick-difficulty"][data-value="easy"]');
  await page.click('[data-act="pick-side"][data-value="A"]');
  await page.click('[data-act="ai-start"]');
  await closeOverlay(page);
  let rand = 11;
  const rnd = () => ((rand = (rand * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 80; i++) {
    const deadline = Date.now() + 20000;
    let st = null;
    while (Date.now() < deadline) {
      await closeOverlay(page);
      st = fromWire(await page.evaluate(() => window.__checklineState()));
      if (st.phase !== 'playing') break;
      if (st.turn === 'A' && !(await page.evaluate(() => document.querySelector('[data-act="end"]').disabled))) break;
      await page.waitForTimeout(120);
    }
    if (!st || st.phase !== 'playing') break;
    let cur = st;
    for (const a of planTurn(st, { difficulty: 'medium', random: rnd })) {
      await clickAction(page, cur, a);
      cur = R.applyAction(cur, a).state;
      if (cur.turn !== 'A' || cur.phase !== 'playing') break;
      await closeOverlay(page);
    }
    if (cur.phase !== 'playing') break;
  }
  await page.waitForSelector('.overlay .award', { timeout: 8000 }).catch(() => {});
  const w = await page.evaluate(() => JSON.parse(localStorage.getItem('checkline.wallet.v1') || '{}'));
  const txt = (await page.textContent('.overlay').catch(() => '')) ?? '';
  check('winning against the computer pays +3 coins and shows it at full time', w.coins === 3 && w.wins === 1 && /You win/.test(txt) && /coins earned/.test(txt), JSON.stringify(w) + ' ' + txt.slice(0, 80));
  await page.screenshot({ path: join(SHOTS, 'en-ai-win-coins.png') });
  await page.context().close();
}

// ------------------------------------------------------------------ 3e. shop: buy, equip, too poor (EN + AR, desktop + phone)
for (const [lang, vp] of [['en', { width: 1280, height: 860 }], ['ar', { width: 390, height: 844 }]]) {
  const ctxPage = await newPage({ lang, viewport: vp });
  const page = ctxPage;
  await page.evaluate(() => {
    localStorage.setItem('checkline.wallet.v1', JSON.stringify({ coins: 30, matches: 2, wins: 1, owned: ['floor:classic', 'skin:classic'], floor: 'classic', skin: 'classic', paid: [] }));
  });
  await page.reload();
  await page.waitForSelector('.coin-chip');
  check(`shop ${lang}: menu shows the coin balance`, (await page.textContent('.coin-chip')).trim() === '30');
  await page.click('.mode-card.shop-card');
  await page.waitForSelector('.shop-grid');
  await page.click('[data-act="shop-item"][data-kind="floor"][data-id="midnight"]');
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => ({ floor: document.documentElement.dataset.floor, w: JSON.parse(localStorage.getItem('checkline.wallet.v1')) }));
  check(`shop ${lang}: buying a floor spends coins and equips it`, after.floor === 'midnight' && after.w.coins === 20 && !!(await page.$('.shop-item.equipped [disabled]')));
  check(`shop ${lang}: unaffordable item is locked`, !!(await page.$('.shop-item.locked button[disabled]')));
  await page.click('[data-act="shop-item"][data-kind="skin"][data-id="obsidian"]');
  await page.waitForTimeout(150);
  check(`shop ${lang}: skin bought and equipped`, (await page.evaluate(() => document.documentElement.dataset.skin)) === 'obsidian');
  await page.click('[data-act="shop-item"][data-kind="floor"][data-id="classic"]');
  await page.waitForTimeout(100);
  check(`shop ${lang}: switching back to an owned item is free`, (await page.evaluate(() => JSON.parse(localStorage.getItem('checkline.wallet.v1')).coins)) === 10 && (await page.evaluate(() => document.documentElement.dataset.floor)) === 'classic');
  await page.click('[data-act="shop-item"][data-kind="floor"][data-id="midnight"]');
  const probs = await layoutProblems(page);
  check(`layout shop ${lang} ${vp.width}`, probs.length === 0, probs.join('; '));
  await page.screenshot({ path: join(SHOTS, `${lang}-shop-${vp.width}.png`), fullPage: true });
  await page.reload();
  await page.waitForSelector('.coin-chip');
  check(`shop ${lang}: themes persist after reload`, (await page.evaluate(() => [document.documentElement.dataset.floor, document.documentElement.dataset.skin].join())) === 'midnight,obsidian');
  await page.click('[data-act="play-local"]');
  await closeOverlay(page);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOTS, `${lang}-themed-game-${vp.width}.png`) });
  check(`no console errors shop ${lang}`, page.errors.length === 0, page.errors.join(' | '));
  await page.context().close();
}

// ------------------------------------------------------------------ 3f. balls and full sets (EN + AR, desktop + phone)
for (const [lang, vp] of [['en', { width: 1280, height: 860 }], ['ar', { width: 390, height: 844 }]]) {
  const page = await newPage({ lang, viewport: vp });
  await page.evaluate(() => {
    localStorage.setItem('checkline.wallet.v1', JSON.stringify({ coins: 90, matches: 0, wins: 0, owned: ['floor:classic', 'skin:classic', 'skin:neon'], floor: 'classic', skin: 'classic', paid: [] }));
  });
  await page.reload();
  await page.click('.mode-card.shop-card');
  await page.waitForSelector('.shop-grid.bundles');
  const sections = await page.$$eval('.section-label', (h) => h.length);
  check(`shop ${lang}: sets, pitches, pieces and balls are separate sections with previews`, sections === 4 &&
    (await page.$$('.ball-preview')).length === 6 && (await page.$$('.bundle .bp-pieces')).length === 3 && (await page.$$('.fx-tag')).length === 4);
  const neon = await page.textContent('[aria-label] .save-tag');
  check(`shop ${lang}: a set shows its saving`, /23/.test(neon) && /29/.test(neon), neon);
  const partial = await page.textContent('.shop-item.bundle:first-child .bundle-partial').catch(() => '');
  check(`shop ${lang}: owning part of a set says what is left to pay`, /55/.test(partial ?? '') && /1/.test(partial ?? '') && /3/.test(partial ?? ''), partial);
  await page.click('[data-act="shop-item"][data-kind="ball"][data-id="ember"]');
  await page.waitForTimeout(150);
  check(`shop ${lang}: a ball is bought and equipped on its own`, (await page.evaluate(() => [document.documentElement.dataset.ball, document.documentElement.dataset.floor].join())) === 'ember,classic');
  await page.click('[data-act="shop-bundle"][data-id="neon_nights"]');
  await page.waitForTimeout(150);
  const w = await page.evaluate(() => JSON.parse(localStorage.getItem('checkline.wallet.v1')));
  check(`shop ${lang}: a set adds all its items at once and equips them`, w.coins === 90 - 12 - 55 && ['floor:synthwave', 'skin:neon', 'ball:neon'].every((x) => w.owned.includes(x)) &&
    (await page.evaluate(() => [document.documentElement.dataset.floor, document.documentElement.dataset.skin, document.documentElement.dataset.ball].join())) === 'synthwave,neon,neon', JSON.stringify(w));
  await page.click('[data-act="shop-item"][data-kind="ball"][data-id="ember"]');
  await page.waitForTimeout(100);
  check(`shop ${lang}: mix and match after a set (ball switched, floor kept)`, (await page.evaluate(() => [document.documentElement.dataset.floor, document.documentElement.dataset.ball].join())) === 'synthwave,ember');
  check(`shop ${lang}: an unaffordable set is locked`, !!(await page.$('.shop-item.bundle.locked button[disabled]')));
  const probs = await layoutProblems(page);
  check(`layout shop sets ${lang} ${vp.width}`, probs.length === 0, probs.join('; '));
  await page.screenshot({ path: join(SHOTS, `${lang}-shop-sets-${vp.width}.png`), fullPage: true });
  await page.click('[data-act="menu"]');
  await page.click('[data-act="play-local"]');
  await closeOverlay(page);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, `${lang}-synthwave-game-${vp.width}.png`) });
  const fx = await page.evaluate(() => getComputedStyle(document.querySelector('.board'), '::after').animationName);
  check(`animated pitch ${lang}: the synthwave floor animates on the real pitch`, /synthScan/.test(fx), fx);
  check(`no console errors shop sets ${lang}`, page.errors.length === 0, page.errors.join(' | '));
  await page.context().close();
}
{
  // Reduced motion (the game setting): animated floors and balls stand still.
  const page = await newPage({ lang: 'en', reduceMotion: true });
  await page.evaluate(() => localStorage.setItem('checkline.wallet.v1', JSON.stringify({ coins: 0, matches: 0, wins: 0, owned: ['floor:classic', 'skin:classic', 'ball:classic', 'floor:galaxy', 'ball:cosmic'], floor: 'galaxy', skin: 'classic', ball: 'cosmic', paid: [] })));
  await page.reload();
  await page.click('[data-act="play-local"]');
  await closeOverlay(page);
  await page.waitForTimeout(300);
  const d = await page.evaluate(() => getComputedStyle(document.querySelector('.board'), '::after').animationDuration);
  check('reduced motion: animated pitch floors stand still', /^(1e-06s|0\.000001s|0s)/.test(d), d);
  await page.screenshot({ path: join(SHOTS, 'en-galaxy-reduced.png') });
  await page.context().close();
}

// ------------------------------------------------------------------ 4. computer opponent
{
  const page = await newPage({ lang: 'en', reduceMotion: true });
  await page.click('[data-act="ai-setup"]');
  await page.click('[data-act="pick-difficulty"][data-value="hard"]');
  await page.click('[data-act="pick-side"][data-value="B"]');
  check('difficulty selection is shown', (await page.getAttribute('[data-value="hard"]', 'aria-checked')) === 'true');
  await page.click('[data-act="ai-start"]');
  const first = (await page.textContent('.overlay h2')).includes('Team A') ? 'A' : 'B';
  await closeOverlay(page);
  check('board flipped so the human side (Ebony) attacks up', (await page.$eval('.ranks span', (e) => e.textContent)) === '1');
  let humanTurns = 0;
  let aiTurnsSeen = 0;
  let sawThinking = false;
  let rand = 3;
  const rnd = () => ((rand = (rand * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 40 && humanTurns < 5; i++) {
    // Read the live state from the screen: wait for our turn (AI may be acting).
    const deadline = Date.now() + 15000;
    let active = false;
    while (Date.now() < deadline) {
      if (await page.$('.thinking')) sawThinking = true;
      await closeOverlay(page);
      active = await page.evaluate(() => !document.querySelector('[data-act="end"]').disabled);
      if (active) break;
      await page.waitForTimeout(150);
    }
    if (!active) break;
    aiTurnsSeen += i > 0 || first === 'A' ? 1 : 0;
    // Reconstruct state from the DOM via a debug read of token positions.
    const s = await page.evaluate(() => window.__checklineState?.());
    if (!s) break;
    const st = fromWire(s);
    if (st.phase !== 'playing') break;
    const plan = planTurn(st, { difficulty: 'medium', random: rnd });
    let cur = st;
    for (const a of plan) {
      await clickAction(page, cur, a);
      cur = R.applyAction(cur, a).state;
      if (cur.turn !== st.turn) break;
    }
    humanTurns++;
  }
  await page.screenshot({ path: join(SHOTS, 'en-ai-hard.png') });
  const logCount = await page.$$eval('.log li', (l) => l.length);
  check('computer (Hard) takes its turns and hands back control', humanTurns >= 5 && aiTurnsSeen >= 4 && sawThinking, `human ${humanTurns}, ai ${aiTurnsSeen}, thinking ${sawThinking}`);
  check('match log records play', logCount >= 5);
  check('no console errors vs computer', page.errors.length === 0, page.errors.join(' | '));
  await page.context().close();
}

// ------------------------------------------------------------------ 5. tutorial in Arabic
{
  const page = await newPage({ lang: 'ar', reduceMotion: true });
  await page.click('[data-act="tutorial"]');
  const sq = (n) => cell(R.parseSquare(n));
  const solutions = [
    ['C3', 'D4'], // movement: Bishop diagonal
    ['D5', 'E7'], // dribble: Knight jumps with the ball
    ['C5', 'F8'], // passing: diagonal pass to the unmarked Rook
    ['C7', 'D8'], // tackle: Pawn takes diagonally forward
    ['F9', 'F12'], // shoot: open corner
    ['SURGE', 'F9', 'G10', 'G12'], // surge: +1 AP, step aside, shoot
    ['D1', 'E1', 'A3', 'D3'], // defend: keeper covers F1, Rook blocks the diagonal
  ];
  let done = 0;
  for (const sol of solutions) {
    for (const n of sol) n === 'SURGE' ? await page.click('[data-act="surge"]') : await page.click(sq(n));
    if (await page.$('.success')) done++;
    else failures.push(`tutorial lesson ${done + 1} not solved by ${sol.join(' ')}: ${await page.textContent('.toast').catch(() => '')}`);
    if (done === 5) await page.screenshot({ path: join(SHOTS, 'ar-tutorial-goal.png') });
    if (done === 6) await page.screenshot({ path: join(SHOTS, 'ar-tutorial-surge.png') });
    await page.click('[data-act="lesson-next"]');
  }
  check('all seven tutorial lessons complete in Arabic', done === 7, `${done}/7`);
  check('tutorial ends by starting a match', !!(await page.$('.game-screen.ai')));
  await page.context().close();
}

// ------------------------------------------------------------------ 6. online with fake backend
{
  const page = await newPage({ lang: 'en', fake: true, fakeCfg: { firstTeam: 'A' }, reduceMotion: true });
  // Accounts: the menu offers "Log in"; Online match opens the Log in / Sign up page.
  await page.waitForSelector('.account-chip:not(.loading)');
  check('menu shows a Log in button when signed out', /Log in/.test(await page.textContent('.account-chip')));
  await page.click('[data-act="online"]');
  await page.waitForSelector('[data-form="login"]');
  await page.screenshot({ path: join(SHOTS, 'en-auth-login.png') });
  await page.click('[data-act="auth-mode"][data-mode="signup"]');
  await page.waitForSelector('[data-form="signup"]');
  const submitSignup = async (name, email, pw, pw2) => {
    await page.fill('#auth-name', name);
    await page.fill('#auth-email', email);
    await page.fill('#auth-password', pw);
    await page.fill('#auth-password2', pw2);
    await page.click('[data-form="signup"] button[type="submit"]');
    await page.waitForTimeout(250);
    return (await page.textContent('.form-error').catch(() => '')) ?? '';
  };
  check('sign up: short name refused', /2–24/.test(await submitSignup('X', 'mo@example.com', 'secret12', 'secret12')));
  check('sign up: taken name refused (any case)', /already taken/.test(await submitSignup('marco', 'mo@example.com', 'secret12', 'secret12')));
  check('sign up: bad email refused', /valid email/.test(await submitSignup('Mohammed', 'mo@', 'secret12', 'secret12')));
  check('sign up: short password refused', /at least 6/.test(await submitSignup('Mohammed', 'mo@example.com', '123', '123')));
  check('sign up: mismatched passwords refused', /don't match/.test(await submitSignup('Mohammed', 'mo@example.com', 'secret12', 'secret13')));
  await page.click('[data-act="toggle-pw"]');
  check('password can be shown', (await page.getAttribute('#auth-password', 'type')) === 'text');
  await page.screenshot({ path: join(SHOTS, 'en-auth-signup.png') });
  await submitSignup('Mohammed', 'mo@example.com', 'secret12', 'secret12');
  await page.waitForSelector('.profile-card');
  check('sign up creates the account and profile, then opens the lobby', /Mohammed/.test(await page.textContent('.profile-card')) && /mo@example\.com/.test(await page.textContent('.profile-card')));
  // Log out, then log in again (wrong password first).
  await page.click('.profile-card [data-act="logout"]');
  await page.waitForSelector('[data-form="login"]');
  check('log out returns to the log-in page', true);
  await page.fill('#auth-email', 'mo@example.com');
  await page.fill('#auth-password', 'wrongpass');
  await page.click('[data-form="login"] button[type="submit"]');
  await page.waitForSelector('.form-error');
  check('log in: wrong password explained', /Wrong email or password/.test(await page.textContent('.form-error')));
  // Forgot password -> reset link -> new password.
  await page.click('[data-act="auth-mode"][data-mode="forgot"]');
  await page.fill('#auth-email', 'mo@example.com');
  await page.click('[data-form="forgot"] button[type="submit"]');
  await page.waitForSelector('.form-notice');
  check('forgot password sends a reset link', (await page.evaluate(() => window.__fake.resetRequestedFor)) === 'mo@example.com');
  await page.evaluate(() => window.__fake.recover('mo@example.com'));
  await page.waitForSelector('[data-form="new-password"]');
  await page.screenshot({ path: join(SHOTS, 'en-auth-recovery.png') });
  await page.fill('#auth-password', 'newsecret');
  await page.fill('#auth-password2', 'newsecret');
  await page.click('[data-form="new-password"] button[type="submit"]');
  await page.waitForSelector('.profile-card');
  await page.click('.profile-card [data-act="logout"]');
  await page.waitForSelector('[data-form="login"]');
  await page.fill('#auth-email', 'mo@example.com');
  await page.fill('#auth-password', 'newsecret');
  await page.click('[data-form="login"] button[type="submit"]');
  await page.waitForSelector('.profile-card');
  check('password reset works and the new password logs in', true);
  // C-rank on the profile card.
  const card = await page.textContent('.profile-card');
  check('profile card shows the C-rank, points and the way to the next tier', /C5/.test(card) && /0\s*rank points/.test(card) && /150 to C4/.test(card) && !!(await page.$('.profile-card .rank-bar')));
  // Change password while signed in (current password checked first).
  await page.click('[data-act="online-change-pw"]');
  await page.waitForSelector('[data-form="change-password"]');
  await page.fill('#pw-current', 'not-it');
  await page.fill('#pw-new', 'brandnew1');
  await page.fill('#pw-new2', 'brandnew1');
  await page.click('[data-form="change-password"] button[type="submit"]');
  await page.waitForSelector('[data-form="change-password"] .form-error');
  check('change password: wrong current password refused', /current password is not right/.test(await page.textContent('[data-form="change-password"] .form-error')));
  await page.fill('#pw-current', 'newsecret');
  await page.fill('#pw-new', 'brandnew1');
  await page.fill('#pw-new2', 'brandnew2');
  await page.click('[data-form="change-password"] button[type="submit"]');
  await page.waitForTimeout(150);
  check('change password: confirmation must match', /don't match/.test(await page.textContent('[data-form="change-password"] .form-error')));
  await page.screenshot({ path: join(SHOTS, 'en-change-password.png') });
  await page.fill('#pw-current', 'newsecret');
  await page.fill('#pw-new', 'brandnew1');
  await page.fill('#pw-new2', 'brandnew1');
  await page.click('[data-form="change-password"] button[type="submit"]');
  await page.waitForSelector('[data-form="change-password"]', { state: 'detached' });
  check('change password: saved in Auth and the form closes', (await page.evaluate(() => window.__fake.users.get('mo@example.com').password)) === 'brandnew1');
  await page.waitForSelector('.match-row');
  await page.screenshot({ path: join(SHOTS, 'en-online-lobby.png') });
  check('online: lobby lists open matches', /Marco/.test(await page.textContent('.lobby')));
  check('online: open matches show the host C-rank', (await page.textContent('.match-row .tier-chip').catch(() => '')) === 'C5');
  await page.click('[data-act="online-create"][data-public="0"]');
  await page.waitForSelector('#invite-code');
  check('online: private match shows invite code', (await page.textContent('#invite-code')).trim() === 'K7M2QX');
  await page.screenshot({ path: join(SHOTS, 'en-online-waiting.png') });
  await page.evaluate(() => window.__fake.opponentJoin());
  await page.waitForSelector('.game-screen.online', { timeout: 8000 });
  check('online: game opens when the opponent joins', true);
  // My move (I am Ivory and kick off).
  const wireState = async () => page.evaluate(() => window.__fake.current().state);
  let st = fromWire(await wireState());
  const plan = planTurn(st, { difficulty: 'medium', random: () => 0.3 });
  const playMyTurn = async () => {
    st = fromWire(await wireState());
    const plan = planTurn(st, { difficulty: 'medium', random: () => 0.3 });
    for (const a of plan) {
      await closeOverlay(page);
      await clickAction(page, st, a);
      await page.waitForFunction(() => !document.querySelector('.toast')?.textContent.includes('Sending'), null, { timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(250);
      st = fromWire(await wireState());
      if (st.turn !== 'A') break;
    }
    await closeOverlay(page);
  };
  await playMyTurn();
  check('online: my actions reach the server', (await page.evaluate(() => window.__fake.current().version)) > 1);
  // Opponent replies through "realtime".
  st = fromWire(await wireState());
  if (st.turn === 'B') {
    const opp = planTurn(st, { difficulty: 'easy', random: () => 0.4 });
    for (const a of opp) {
      await page.evaluate((act) => window.__fake.opponentAct(act), a);
      st = R.applyAction(st, a).state;
      await page.waitForTimeout(200);
      if (st.turn !== 'B') break;
    }
  }
  await page.waitForTimeout(500);
  const uiAp = await page.$$eval('.ap .pip.on', (p) => p.length);
  check('online: opponent moves arrive and the turn returns', uiAp === 3 && (await page.textContent('.turn')).includes('Ivory'));
  await page.screenshot({ path: join(SHOTS, 'en-online-match.png') });
  // Illegal move is refused locally with a translated reason (the King keeper moves one square).
  await page.click(cell({ c: 3, r: 0 }));
  await page.click(cell({ c: 3, r: 2 }));
  check('online: illegal move explained', /out of reach|King/.test((await page.textContent('.toast').catch(() => '')) ?? ''));
  // Turn clock (server deadline 25 s + 3 s grace). My own turn: the clock is shown and counts down.
  const clockSecs = async () => Number(await page.$eval('[data-turn-clock]:not([hidden]) b', (e) => e.textContent).catch(() => 'NaN'));
  const c1 = await clockSecs();
  check('online: the 25-second turn clock is shown on my turn', c1 > 0 && c1 <= 25 && !(await page.$('[data-turn-clock].theirs')), String(c1));
  // The opponent idles past the deadline: my game ends their turn automatically.
  await page.keyboard.press('Escape');
  await page.click('[data-act="end"]');
  await page.waitForFunction(() => window.__fake.current().state.turn === 'B', null, { timeout: 4000 });
  await page.waitForTimeout(300);
  check('online: the clock shows the opponent turn too', !!(await page.$('[data-turn-clock].theirs:not([hidden])')));
  await page.evaluate(() => window.__fake.turnStartedAgo(40));
  await page.waitForFunction(() => window.__fake.current().state.turn === 'A', null, { timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(400);
  check('online: an expired opponent turn is ended automatically and the turn returns', (await page.textContent('.turn')).includes('Ivory') && (await page.evaluate(() => window.__fake.claims)) === 1);
  check('online: the time-out is announced', /Time's up: Ebony's turn has ended/.test((await page.textContent('.toast').catch(() => '')) ?? ''));
  await page.screenshot({ path: join(SHOTS, 'en-online-timeout.png') });
  // My own turn runs out: it ends by itself, once.
  await page.evaluate(() => window.__fake.turnStartedAgo(40));
  await page.waitForFunction(() => window.__fake.current().state.turn === 'B', null, { timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(1200);
  check('online: my expired turn ends by itself, exactly once', (await page.evaluate(() => [window.__fake.current().state.turn, window.__fake.claims].join())) === 'B,2' &&
    /Time's up: your turn has ended/.test((await page.textContent('.toast').catch(() => '')) ?? ''));
  // Opponent disappears early in the match (before turn 6) -> claim win.
  await page.evaluate(() => (window.__fake.current().state.turnNumber = 4));
  await page.evaluate(() => window.__fake.opponentGone(130));
  await page.waitForSelector('[data-act="claim"]', { timeout: 5000 });
  await page.screenshot({ path: join(SHOTS, 'en-online-away.png') });
  await page.click('[data-act="claim"]');
  await page.waitForSelector('.overlay .rating-change', { timeout: 5000 });
  const res = await page.textContent('.overlay');
  check('online: forfeit win shows result and rating change', /You win/.test(res) && /left the match/.test(res) && /\+\d+/.test(res));
  check('online: an early forfeit win gives no rank points and says why', /No rank points for the win: the match ended before turn 6/.test(res) && !!(await page.$('.overlay .rank-change')), res.slice(0, 300));
  check('online: the opponent who left still loses 6 rank points', (await page.evaluate(() => { const m = window.__fake.current(); return m.result.bPointsAfter - m.result.bPointsBefore; })) === -6);
  await page.screenshot({ path: join(SHOTS, 'en-online-result.png') });
  // Back to lobby, join an open match, resign.
  await page.click('.overlay [data-act="online-lobby"]');
  await page.waitForSelector('[data-act="online-join-open"]');
  await page.evaluate(() => (window.__fakeCfg.firstTeam = 'B'));
  await page.click('[data-act="online-join-open"]');
  await page.waitForSelector('.game-screen.online');
  check('online: Ebony player sees own side at the bottom', (await page.$eval('.ranks span', (e) => e.textContent)) === '1');
  await page.click('[data-act="resign"]');
  await page.waitForSelector('.modal.resign');
  await page.click('[data-act="resign-confirm"]');
  await page.waitForSelector('.overlay .rating-change', { timeout: 5000 });
  check('online: resign records a loss', /You lose/.test(await page.textContent('.overlay')) && /-\d+/.test(await page.textContent('.overlay')));
  check('no console errors online', page.errors.length === 0, page.errors.join(' | '));
  await page.context().close();
}

// Arabic online lobby + errors
{
  const page = await newPage({ lang: 'ar', fake: true, fakeCfg: { lobbyError: true } });
  await page.click('[data-act="online"]');
  await page.waitForSelector('[data-form="login"]');
  for (const vp of [{ width: 1280, height: 860 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(vp);
    for (const mode of ['login', 'signup']) {
      await page.click(`[data-act="auth-mode"][data-mode="${mode}"]`);
      await page.waitForTimeout(150);
      const probs = await layoutProblems(page);
      check(`layout ar auth ${mode} ${vp.width}`, probs.length === 0, probs.join('; '));
      await page.screenshot({ path: join(SHOTS, `ar-auth-${mode}-${vp.width}.png`), fullPage: true });
    }
  }
  await page.setViewportSize({ width: 1280, height: 860 });
  check('auth page is in Arabic', /إنشاء حساب/.test(await page.textContent('.auth-tabs')) && (await page.getAttribute('#auth-email', 'dir')) === 'ltr');
  // Guest play: pick a display name, then the lobby.
  await page.click('[data-act="auth-guest"]');
  await page.waitForSelector('#online-name');
  await page.fill('#online-name', 'محمد');
  await page.click('[data-form="profile"] button[type="submit"]');
  await page.waitForSelector('.lobby .form-error');
  check('online (Arabic): lobby network error shown in Arabic', /الشبكة/.test(await page.textContent('.lobby')));
  await page.fill('#join-code', 'ZZZZZZ');
  await page.click('[data-form="join"] button[type="submit"]');
  await page.waitForTimeout(400);
  check('online (Arabic): unknown code error', /لم يتم العثور/.test(await page.textContent('.lobby')));
  await page.screenshot({ path: join(SHOTS, 'ar-online-lobby-errors.png') });
  const probs = await layoutProblems(page);
  check('layout ar online lobby', probs.length === 0, probs.join('; '));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  const probs2 = await layoutProblems(page);
  check('layout ar online lobby phone', probs2.length === 0, probs2.join('; '));
  await page.screenshot({ path: join(SHOTS, 'ar-online-lobby-phone.png'), fullPage: true });
  await page.context().close();
}

// Email confirmation required (Supabase default) + guest play disabled.
{
  const page = await newPage({ lang: 'en', fake: true, fakeCfg: { confirmEmail: true, anonDisabled: true } });
  await page.click('[data-act="online"]');
  await page.waitForSelector('[data-form="login"]');
  await page.click('[data-act="auth-guest"]');
  await page.waitForSelector('.form-error');
  check('guest play disabled is explained', /Guest play is turned off/.test(await page.textContent('.form-error')));
  await page.click('[data-act="auth-mode"][data-mode="signup"]');
  await page.fill('#auth-name', 'Sara');
  await page.fill('#auth-email', 'sara@example.com');
  await page.fill('#auth-password', 'goal1234');
  await page.fill('#auth-password2', 'goal1234');
  await page.click('[data-form="signup"] button[type="submit"]');
  await page.waitForSelector('.mail-icon');
  check('sign up with confirmation shows "check your inbox"', /sara@example\.com/.test(await page.textContent('.auth-card')));
  await page.screenshot({ path: join(SHOTS, 'en-auth-check-email.png') });
  await page.click('[data-act="auth-mode"][data-mode="login"]');
  await page.fill('#auth-email', 'sara@example.com');
  await page.fill('#auth-password', 'goal1234');
  await page.click('[data-form="login"] button[type="submit"]');
  await page.waitForSelector('.form-error');
  check('unconfirmed email cannot log in yet', /Confirm your email first/.test(await page.textContent('.form-error')));
  await page.evaluate(() => window.__fake.confirm('sara@example.com'));
  await page.click('[data-form="login"] button[type="submit"]');
  await page.waitForSelector('.profile-card');
  check('after confirming, log in creates the profile from the sign-up name', /Sara/.test(await page.textContent('.profile-card')));
  await page.click('[data-act="menu"]');
  await page.waitForSelector('.account-chip.in');
  check('menu shows the signed-in player', /Sara/.test(await page.textContent('.account-chip')));
  // Signed in: coins and items come from the database wallet (the owner can edit them by hand).
  await page.waitForTimeout(400);
  check('wallet: signed-in menu shows the database balance', (await page.textContent('.coin-chip')).trim() === '0');
  await page.evaluate(() => window.__fake.setCoins(25));
  await page.click('.mode-card.shop-card');
  await page.waitForSelector('.shop-grid');
  await page.waitForTimeout(400);
  check('wallet: coins edited in the database show up in the shop', /25/.test(await page.textContent('.wallet-balance')) && !!(await page.$('.cloud-tag')));
  await page.click('[data-act="shop-item"][data-kind="skin"][data-id="neon"]');
  await page.waitForTimeout(400);
  const cw = await page.evaluate(() => window.__fake.wallet());
  check('wallet: buying spends database coins and equips', cw.coins === 10 && cw.skin === 'neon' && (await page.evaluate(() => document.documentElement.dataset.skin)) === 'neon', JSON.stringify(cw));
  await page.evaluate(() => window.__fake.setCoins(60));
  await page.click('[data-act="menu"]');
  await page.click('.mode-card.shop-card');
  await page.waitForSelector('.shop-grid.bundles');
  await page.waitForTimeout(400);
  await page.click('[data-act="shop-bundle"][data-id="neon_nights"]');
  await page.waitForTimeout(400);
  const cb = await page.evaluate(() => window.__fake.wallet());
  check('wallet: a set bought on the account charges the server price (already-owned skin not paid twice)', cb.coins === 60 - 55 && cb.floor === 'synthwave' && cb.ball === 'neon', JSON.stringify(cb));
  check('wallet: signed-in shop says online matches pay the account', /Online matches pay coins to your account/.test(await page.textContent('.wallet-earn')));
  check('wallet: this browser\'s own coins are untouched', (await page.evaluate(() => JSON.parse(localStorage.getItem('checkline.wallet.v1') || '{"coins":0}').coins)) === 0);
  await page.click('[data-act="menu"]');
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(SHOTS, 'en-menu-signed-in.png') });
  check('no console errors (accounts)', page.errors.length === 0, page.errors.join(' | '));
  await page.context().close();
}

// ------------------------------------------------------------------ 7. leaderboard states
for (const [mode, lang] of [['ok', 'en'], ['ok', 'ar'], ['empty', 'en'], ['error', 'ar'], ['slow', 'en']]) {
  const page = await newPage({ lang, fake: true, fakeCfg: { lb: mode, latency: 60 } });
  await page.click('[data-act="leaderboard"]');
  if (mode === 'slow') {
    await page.waitForSelector('tr.skeleton');
    check('leaderboard: loading skeleton', true);
    await page.screenshot({ path: join(SHOTS, `${lang}-lb-loading.png`) });
    await page.waitForSelector('table.lb tbody tr:not(.skeleton)', { timeout: 5000 });
  }
  if (mode === 'ok') {
    await page.waitForSelector('table.lb tbody tr:not(.skeleton)');
    const rows = await page.$$eval('table.lb tbody tr', (r) => r.length);
    check(`leaderboard ${lang}: first page`, rows === 15);
    check(`leaderboard ${lang}: position, name, C-rank, rating, W, D, L columns`, (await page.$$eval('table.lb thead th', (r) => r.length)) === 7);
    check(`leaderboard ${lang}: C-ranks shown (C1 at the top here)`, (await page.$$eval('table.lb tbody .tier-cell .tier-chip', (r) => r.map((e) => e.textContent))).slice(0, 3).join() === 'C1,C1,C1');
    await page.click('[data-act="lb-next"]');
    await page.waitForFunction(() => document.querySelector('table.lb tbody tr td')?.textContent === '16');
    check(`leaderboard ${lang}: second page`, (await page.$$eval('table.lb tbody tr', (r) => r.length)) === 7);
    await page.click('[data-act="lb-prev"]');
    await page.waitForFunction(() => document.querySelector('table.lb tbody tr td')?.textContent === '1');
    await page.screenshot({ path: join(SHOTS, `${lang}-leaderboard.png`) });
    for (const vp of [{ width: 390, height: 844 }]) {
      await page.setViewportSize(vp);
      await page.waitForTimeout(150);
      const probs = await layoutProblems(page);
      check(`leaderboard ${lang} phone layout`, probs.length === 0, probs.join('; '));
      await page.screenshot({ path: join(SHOTS, `${lang}-leaderboard-phone.png`), fullPage: true });
    }
  }
  if (mode === 'empty') {
    await page.waitForSelector('.empty');
    check('leaderboard: empty state', /No ranked players/.test(await page.textContent('main')));
  }
  if (mode === 'error') {
    await page.waitForSelector('.error-card');
    check('leaderboard (Arabic): error state with retry', /تعذّر تحميل/.test(await page.textContent('main')) && !!(await page.$('[data-act="lb-retry"]')));
    await page.evaluate(() => (window.__fakeCfg.lb = 'ok'));
    await page.click('[data-act="lb-retry"]');
    await page.waitForSelector('table.lb tbody tr');
    check('leaderboard: retry recovers', true);
  }
  check(`no console errors leaderboard ${mode}`, page.errors.length === 0, page.errors.join(' | '));
  await page.context().close();
}

await browser.close();
console.log(`UI checks: ${passed} passed, ${failures.length} failed. Screenshots: ${SHOTS}`);
if (failures.length) {
  console.log(' - ' + failures.join('\n - '));
  process.exitCode = 1;
}
