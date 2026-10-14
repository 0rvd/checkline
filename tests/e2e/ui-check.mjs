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
  if (opts.fake) {
    await ctx.addInitScript((c) => (window.__fakeCfg = c), opts.fakeCfg ?? {});
    await ctx.addInitScript(fakeBackend);
  }
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !ignorable(m.text()) && page.errors.push(m.text()));
  await page.goto(BASE);
  await page.waitForSelector('#app > *');
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
  await page.waitForSelector('#app > *');
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
  await page.waitForSelector('.match-row');
  await page.screenshot({ path: join(SHOTS, 'en-online-lobby.png') });
  check('online: lobby lists open matches', /Marco/.test(await page.textContent('.lobby')));
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
  // Turn timer: after my turn, the opponent idles past 90 s and I end their turn.
  await page.keyboard.press('Escape');
  await page.click('[data-act="end"]');
  await page.waitForFunction(() => window.__fake.current().state.turn === 'B', null, { timeout: 4000 });
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__fake.turnStartedAgo(120));
  await page.waitForSelector('[data-act="claim-time"]', { timeout: 5000 });
  await page.screenshot({ path: join(SHOTS, 'en-online-timeout.png') });
  await page.click('[data-act="claim-time"]');
  await page.waitForFunction(() => !document.querySelector('[data-act="end"]').disabled, null, { timeout: 5000 }).catch(() => {});
  check('online: expired turn timer can be claimed and the turn returns', (await page.textContent('.turn')).includes('Ivory') && !(await page.$('[data-act="claim-time"]')));
  // Opponent disappears -> claim win.
  await page.evaluate(() => window.__fake.opponentGone(130));
  await page.waitForSelector('[data-act="claim"]', { timeout: 5000 });
  await page.screenshot({ path: join(SHOTS, 'en-online-away.png') });
  await page.click('[data-act="claim"]');
  await page.waitForSelector('.overlay .rating-change', { timeout: 5000 });
  const res = await page.textContent('.overlay');
  check('online: forfeit win shows result and rating change', /You win/.test(res) && /left the match/.test(res) && /\+\d+/.test(res));
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
    check(`leaderboard ${lang}: rank, name, rating, W, D, L columns`, (await page.$$eval('table.lb thead th', (r) => r.length)) === 6);
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
