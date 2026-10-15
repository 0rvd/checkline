#!/usr/bin/env node
// Developer check for supabase/setup.sql. Optional: needs local PostgreSQL 15+ binaries
// (initdb, pg_ctl, psql) on PATH or in PG_BIN. Run with `npm run verify:sql`.
//
// It creates a throwaway database with a minimal Supabase auth stub, then:
//   1. runs setup.sql twice (must be re-runnable),
//   2. compares the SQL rules engine with the TypeScript engine on thousands of actions
//      (legal and illegal) from seeded games: same accept/reject, same reason, same state + events,
//   3. plays a full online match through the RPC functions as two players and checks
//      turn/version enforcement, RLS isolation, write protection, single rating update and Elo,
//      forfeits, cancellation and the leaderboard.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const R = await import(join(root, 'build/src/rules/index.js'));
const { toWire } = await import(join(root, 'build/src/online/wire.js'));
const { planTurn, legalActions } = await import(join(root, 'build/src/ai/ai.js'));
const { RANK_TIERS } = await import(join(root, 'build/src/online/ranks.js'));
const { SHOP_ITEMS, BUNDLES } = await import(join(root, 'build/src/ui/economy.js'));

// ------------------------------------------------------------------ local postgres
function pgBin() {
  if (process.env.PG_BIN) return process.env.PG_BIN;
  const base = '/usr/lib/postgresql';
  if (existsSync(base)) {
    const v = readdirSync(base).map(Number).filter(Boolean).sort((a, b) => b - a)[0];
    if (v) return join(base, String(v), 'bin');
  }
  return '';
}
const BIN = pgBin();
const asRoot = process.getuid?.() === 0;
const exe = (name) => (BIN ? join(BIN, name) : name);
function sh(cmd, args, input) {
  const full = asRoot ? ['runuser', ['-u', 'postgres', '--', cmd, ...args]] : [cmd, args];
  return spawnSync(full[0], full[1], { input, encoding: 'utf8', maxBuffer: 1 << 28 });
}

const dir = mkdtempSync(join(tmpdir(), 'checkline-pg-'));
if (asRoot) spawnSync('chown', ['-R', 'postgres', dir]);
const data = join(dir, 'data');
const port = String(54000 + Math.floor(Math.random() * 900));
let started = false;
function cleanup() {
  if (started) sh(exe('pg_ctl'), ['-D', data, '-m', 'immediate', 'stop']);
  rmSync(dir, { recursive: true, force: true });
}
process.on('exit', cleanup);

const init = sh(exe('initdb'), ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C']);
if (init.status !== 0) {
  console.error('initdb failed. Is PostgreSQL installed? Set PG_BIN to its bin directory.\n' + init.stderr);
  process.exit(2);
}
const start = sh(exe('pg_ctl'), ['-D', data, '-w', '-l', join(dir, 'server.log'), '-o', `-p ${port} -k ${dir} -c listen_addresses=''`, 'start']);
if (start.status !== 0) {
  console.error(start.stderr || start.stdout);
  process.exit(2);
}
started = true;

/** Run SQL as superuser, or as an API role with JWT `sub`. Returns {ok, out, err}. */
function sql(text, as) {
  let prefix = '';
  if (as === 'anon') prefix = 'set role anon;\n';
  else if (as === 'nosub') prefix = 'set role authenticated;\n';
  else if (as) prefix = `set role authenticated; set request.jwt.claim.sub = '${as}';\n`;
  const r = sh(exe('psql'), ['-h', dir, '-p', port, '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1'], prefix + text);
  return { ok: r.status === 0, out: r.stdout.trim(), err: r.stderr.trim() };
}

// ------------------------------------------------------------------ tiny test reporter
let passed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) passed++;
  else failures.push(`${name}${detail ? `: ${detail}` : ''}`);
}
const norm = (v) =>
  Array.isArray(v)
    ? v.map(norm)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => [k, norm(v[k])]))
      : v;
const same = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));

// ------------------------------------------------------------------ 1. install
const stub = sql(readFileSync(join(root, 'supabase/tests/local-stub.sql'), 'utf8'));
check('stub installs', stub.ok, stub.err);
const setupSql = readFileSync(join(root, 'supabase/setup.sql'), 'utf8');
const first = sql(setupSql);
check('setup.sql runs', first.ok, first.err);
const second = sql(setupSql);
check('setup.sql is re-runnable', second.ok, second.err);
if (!first.ok) {
  console.error(failures.join('\n'));
  process.exit(1);
}

const T0 = Date.now();
const lap = (label) => process.env.VERBOSE && console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${label}`);
lap('installed');
// ------------------------------------------------------------------ 2. rules parity
function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function legal(s) {
  return [{ type: 'endTurn' }, ...legalActions(s)];
}
const strip = (a) => {
  const { _o, ...rest } = a;
  return rest;
};
function randomIllegal(s, rand) {
  const p = s.pieces[Math.floor(rand() * s.pieces.length)];
  const roll = rand();
  if (roll < 0.45) return { type: 'move', pieceId: p.id, to: { c: Math.floor(rand() * 10) - 1, r: Math.floor(rand() * 14) - 1 } };
  if (roll < 0.65) return { type: 'pass', fromId: rand() < 0.8 ? s.carrierId : p.id, toId: p.id };
  if (roll < 0.85) {
    const goalRow = rand() < 0.5 ? 0 : 11;
    return { type: 'shoot', fromId: rand() < 0.85 ? s.carrierId : p.id, to: { c: Math.floor(rand() * 9) - 1, r: rand() < 0.8 ? goalRow : Math.floor(rand() * 12) } };
  }
  if (roll < 0.9) return { type: 'surge' };
  return [{ type: 'warp' }, { type: 'move', pieceId: 'nope', to: { c: 1, r: 1 } }, { type: 'move', pieceId: p.id, to: { c: 1.5, r: 2 } }, { type: 'move', pieceId: p.id }][Math.floor(rand() * 4)];
}

const cases = [];
// Seeded AI games (Medium vs Easy) reach goals, rally resets and match wins; random games add variety.
for (let g = 0; g < Number(process.env.PARITY_GAMES ?? 40); g++) {
  const rand = rng(1000 + g);
  let s = R.createMatch({ random: rand });
  const strong = R.other(s.turn); // the side that does not kick off plays Medium
  for (let turn = 0; turn < 160 && s.phase === 'playing'; turn++) {
    const team = s.turn;
    const plan = g % 4 === 3
      ? [strip((() => { const acts = legal(s); return acts[Math.floor(rand() * acts.length)]; })())]
      : planTurn(s, { difficulty: team === strong ? 'medium' : 'easy', random: rand });
    for (const a of plan) {
      for (let k = 0; k < 2; k++) cases.push({ state: s, action: randomIllegal(s, rand) });
      cases.push({ state: s, action: a });
      s = R.applyAction(s, a).state;
      if (s.turn !== team || s.phase !== 'playing') break;
    }
  }
  if (s.phase === 'finished') cases.push({ state: s, action: { type: 'endTurn' } });
}
// Clock edge cases: the same positions at the end of regulation / golden goal / the hard stop.
const base = cases.length;
for (let i = 0; i < base; i += 37) {
  const st = cases[i].state;
  if (st.phase !== 'playing') continue;
  for (const [turnNumber, score] of [[30, { A: 1, B: 1 }], [30, { A: 2, B: 1 }], [34, { A: 1, B: 1 }], [40, { A: 0, B: 0 }], [40, { A: 2, B: 1 }]]) {
    const variant = { ...st, turnNumber, score };
    cases.push({ state: variant, action: { type: 'endTurn' } });
    cases.push({ state: variant, action: cases[i].action });
    for (const a of legalActions(variant).filter((x) => x.type === 'shoot')) cases.push({ state: variant, action: a });
  }
}
lap(`generated ${cases.length} parity cases`);
const lines = cases.map((c, i) => `${i}\t${JSON.stringify(toWire(c.state))}\t${JSON.stringify(c.action)}`);
const parity = sql(
  'create schema verify; create table verify.cases (id int primary key, state jsonb, action jsonb);\n' +
    'copy verify.cases from stdin;\n' +
    lines.join('\n') +
    '\n\\.\n' +
    "select id || E'\\t' || checkline_private.apply_action(state, action)::text from verify.cases order by id;",
);
check('parity query runs', parity.ok, parity.err);
lap('parity query done');
let mismatches = 0;
let accepted = 0;
let goals = 0;
if (parity.ok) {
  const out = parity.out.split('\n');
  for (const line of out) {
    const tab = line.indexOf('\t');
    const id = Number(line.slice(0, tab));
    const got = JSON.parse(line.slice(tab + 1));
    const c = cases[id];
    const exp = R.applyAction(c.state, c.action);
    let ok;
    if (exp.ok) {
      accepted++;
      if (exp.events.some((e) => e.type === 'goal')) goals++;
      ok = got.ok === true && same(got.state, toWire(exp.state)) && same(got.events, exp.events);
    } else {
      ok = got.ok === false && same(got.why, exp.why);
    }
    if (!ok && mismatches++ < 3) {
      console.error('PARITY MISMATCH', JSON.stringify(c.action), '\nTS :', JSON.stringify(exp.ok ? { events: exp.events } : exp.why), '\nSQL:', JSON.stringify(got.ok ? { events: got.events } : got.why));
    }
  }
  check(`rules parity on ${cases.length} actions`, mismatches === 0 && out.length === cases.length, `${mismatches} mismatches`);
}

lap('parity compared');
// ------------------------------------------------------------------ 3. RPC flow + security
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';
// U1 and U2 have email accounts; U3 is a guest (anonymous sign-in).
sql(`insert into auth.users (id, email, is_anonymous) values ('${U1}', 'alice@example.com', false), ('${U2}', 'bob@example.com', false), ('${U3}', null, true);`);
const rpc = (as, call) => {
  const r = sql(`select ${call};`, as);
  return { ...r, json: r.ok && r.out ? JSON.parse(r.out) : null };
};
const errOf = (r) => (/CL:[a-z_:]+/.exec(r.err) ?? [r.err.split('\n')[0]])[0];
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

// Anonymous visitors
check('anon can read leaderboard', rpc('anon', 'public.cl_get_leaderboard(0, 20)').ok);
check('anon cannot create matches', /permission denied/.test(rpc('anon', 'public.cl_create_match(true)').err));
check('anon cannot read matches', /permission denied/.test(sql('select count(*) from public.cl_matches;', 'anon').err));
check('signed-out RPC is refused', errOf(rpc('nosub', "public.cl_create_match(true)")) === 'CL:not_signed_in');

// Profiles
check('profile required before creating a match', errOf(rpc(U1, 'public.cl_create_match(true)')) === 'CL:profile_required');
check('display name validated', errOf(rpc(U1, "public.cl_upsert_profile(' A ')")) === 'CL:invalid_name');
check('profile created', rpc(U1, "public.cl_upsert_profile('Alice')").json?.displayName === 'Alice');
rpc(U2, "public.cl_upsert_profile('Bob')");
rpc(U3, "public.cl_upsert_profile('سارة')");
check('Arabic display names stored', rpc(U3, 'public.cl_get_my_profile()').json?.displayName === 'سارة');
// Unique names (case- and space-insensitive) and the sign-up trigger
check('taken name refused', errOf(rpc(U2, "public.cl_upsert_profile(' alice ')")) === 'CL:name_taken');
check('name availability for visitors', sql("select public.cl_name_available('ALICE');", 'anon').out === 'f' && sql("select public.cl_name_available('Zed');", 'anon').out === 't');
check('own name counts as available when renaming', sql("select public.cl_name_available('alice');", U1).out === 't');
const U4 = '44444444-4444-4444-8444-444444444444';
const U5 = '55555555-5555-4555-8555-555555555555';
sql(`insert into auth.users (id, raw_user_meta_data) values ('${U4}', '{"display_name":"  Dana  "}'), ('${U5}', '{"display_name":"dana"}');`);
check('sign-up creates the profile from the chosen name', rpc(U4, 'public.cl_get_my_profile()').json?.displayName === 'Dana');
check('sign-up with a taken name still succeeds, without a profile', sql(`select count(*) from auth.users where id = '${U5}';`).out === '1' && !rpc(U5, 'public.cl_get_my_profile()').json);

// Direct table writes are blocked
for (const [label, stmt] of [
  ['insert profile', `insert into public."user" (id, username) values ('${U3}', 'xx');`],
  ['edit own rating', `update public."user" set rating = 3000 where id = '${U1}';`],
  ['edit own coins', `update public."user" set coins = 3000 where id = '${U1}';`],
  ['edit own rank points', `update public."user" set rank_points = 3000 where id = '${U1}';`],
  ['give self an item', `insert into public.user_cosmetics (user_id, kind, item_id) values ('${U1}', 'skin', 'gold');`],
  ['write coin history', `insert into public.coin_transactions (user_id, amount, balance_after, kind, actor) values ('${U1}', 5, 5, 'admin_grant', 'me');`],
  ['change prices', `update public.cosmetics set price = 0;`],
  ['change rank tiers', `update public.rank_tiers set min_points = 0;`],
  ['insert match', `insert into public.cl_matches (code, player_a) values ('ABCDEF', '${U1}');`],
  ['insert result', `insert into public.cl_match_results (match_id, winner_id, reason, score_a, score_b) values (gen_random_uuid(), '${U1}', 'goals', 3, 0);`],
  ['call private rules', `select checkline_private.initial_state('A');`],
]) {
  const r = sql(stmt, U1);
  check(`client cannot ${label}`, !r.ok && /permission denied/.test(r.err), r.err || 'succeeded');
}

// Create + join
const created = rpc(U1, 'public.cl_create_match(true)').json;
check('match created waiting', created?.status === 'waiting' && /^[A-Z2-9]{6}$/.test(created?.code ?? ''));
check('second create returns the same waiting match', rpc(U1, 'public.cl_create_match(true)').json?.id === created?.id);
check('lobby lists public match to others', (rpc(U2, 'public.cl_list_open_matches()').json ?? []).some((m) => m.id === created.id));
check('lobby hides your own match', !(rpc(U1, 'public.cl_list_open_matches()').json ?? []).some((m) => m.id === created.id));
check('cannot join own match', errOf(rpc(U1, `public.cl_join_match(${q(created.code)})`)) === 'CL:own_match');
const joined = rpc(U2, `public.cl_join_match(${q(created.code.toLowerCase())})`).json;
check('join activates match', joined?.status === 'active' && joined?.version === 1 && joined?.playerB?.name === 'Bob');
check('initial state matches client createMatch', joined && same(joined.state, toWire(R.createMatch({ firstTeam: joined.state.turn }))));
check('third player cannot join', errOf(rpc(U3, `public.cl_join_match(${q(created.code)})`)) === 'CL:match_unavailable');
check('third player cannot see match (RLS)', sql(`select count(*) from public.cl_matches where id = '${created.id}';`, U3).out === '0');
check('third player cannot fetch match', errOf(rpc(U3, `public.cl_get_match('${created.id}')`)) === 'CL:match_not_found');
check('rejoin returns active match', rpc(U2, `public.cl_join_match(${q(created.code)})`).json?.status === 'active');

// Turn + version enforcement
let state = R.createMatch({ firstTeam: joined.state.turn });
let version = joined.version;
const userFor = (team) => (team === 'A' ? U1 : U2);
const submit = (as, v, action) => rpc(as, `public.cl_submit_action('${created.id}', ${v}, ${q(JSON.stringify(action))}::jsonb)`);
check('wrong player is refused', errOf(submit(userFor(R.other(state.turn)), version, { type: 'endTurn' })) === 'CL:not_your_turn');
check('outsider is refused', errOf(submit(U3, version, { type: 'endTurn' })) === 'CL:match_not_found');
check('stale version is refused', errOf(submit(userFor(state.turn), version - 1, { type: 'endTurn' })) === 'CL:stale_state');
const keeper = `${state.turn}-K`;
check('illegal move is refused with reason', errOf(submit(userFor(state.turn), version, { type: 'move', pieceId: keeper, to: { c: 3, r: 5 } })).startsWith('CL:illegal:'));
check('moving an opponent piece is refused', errOf(submit(userFor(state.turn), version, { type: 'move', pieceId: `${R.other(state.turn)}-P1`, to: { c: 2, r: 6 } })) === 'CL:illegal:not_your_turn');
check('rejections do not change the version', rpc(U1, `public.cl_get_match('${created.id}')`).json?.version === version);

lap('security checks');
// Full match through the API, mirrored by the client engine
const strongTeam = R.other(state.turn);
const rand = rng(77);
let steps = 0;
let apiMismatch = 0;
let view = joined;
for (let turn = 0; turn < 300 && state.phase === 'playing'; turn++) {
  const team = state.turn;
  const plan = planTurn(state, { difficulty: team === strongTeam ? 'medium' : 'easy', random: rand });
  for (const action of plan) {
    steps++;
    const r = submit(userFor(team), version, action);
    if (!r.ok) {
      apiMismatch++;
      console.error('API rejected legal action', JSON.stringify(action), r.err);
      break;
    }
    state = R.applyAction(state, action).state;
    view = r.json;
    version = view.version;
    if (!same(view.state, toWire(state))) apiMismatch++;
    if (state.turn !== team || state.phase !== 'playing') break;
  }
  if (apiMismatch) break;
}
check(`full match via API (${steps} actions) stays in sync`, apiMismatch === 0 && state.phase === 'finished');
check('match finished with a winner (goals or clock)', view.status === 'finished' && ['goals', 'clock'].includes(view.endReason) && view.winnerId === (state.winner === 'A' ? U1 : U2));
const winner = state.winner === 'A' ? U1 : U2;
const loser = winner === U1 ? U2 : U1;
const wAfter = (r) => (winner === U1 ? r.aRatingAfter : r.bRatingAfter);
const lAfter = (r) => (winner === U1 ? r.bRatingAfter : r.aRatingAfter);
check('result recorded with Elo +16/-16 at equal ratings', view.result && wAfter(view.result) === 1216 && lAfter(view.result) === 1184 && view.result.winnerId === winner);
check('exactly one result row', sql(`select count(*) from public.cl_match_results where match_id = '${created.id}';`).out === '1');
check('moves logged', sql(`select count(*) from public.cl_match_moves where match_id = '${created.id}';`).out === String(version - 1));
check('no actions after the end', errOf(submit(userFor(state.turn), version, { type: 'endTurn' })) === 'CL:match_not_active');
check('cannot resign a finished match', errOf(rpc(loser, `public.cl_resign('${created.id}')`)) === 'CL:match_not_active');
sql(`select checkline_private.finalize_match(m) from public.cl_matches m where id = '${created.id}';`);
const pw = rpc(winner, 'public.cl_get_my_profile()').json;
const pl = rpc(loser, 'public.cl_get_my_profile()').json;
check('re-finalizing does not double count', pw.rating === 1216 && pw.wins === 1 && pl.rating === 1184 && pl.losses === 1 && pw.games === 1);
check('full match between two accounts is ranked: winner +10, loser 0 (floor)', view.result?.ranked === true && view.result?.rankNote === null &&
  (winner === U1 ? view.result.aPointsAfter : view.result.bPointsAfter) === 10 && (winner === U1 ? view.result.bPointsAfter : view.result.aPointsAfter) === 0 &&
  pw.rankPoints === 10 && pw.tier === 'C5' && pl.rankPoints === 0);
check('full match pays the winner +3 coins with the result', (winner === U1 ? view.result.aCoins : view.result.bCoins) === 3 && (winner === U1 ? view.result.bCoins : view.result.aCoins) === 0 &&
  sql(`select coins from public."user" where id = '${winner}';`).out === '3' &&
  sql(`select count(*) from public.coin_transactions where match_id = '${created.id}' and kind = 'match_reward';`).out === '1');
check('re-finalizing pays nothing twice', sql(`select coins || '|' || rank_points from public."user" where id = '${winner}';`).out === '3|10');
check('outsider cannot read moves or results', sql(`select (select count(*) from public.cl_match_moves where match_id = '${created.id}') + (select count(*) from public.cl_match_results where match_id = '${created.id}');`, U3).out === '0');
check('participant can read own result', sql(`select count(*) from public.cl_match_results where match_id = '${created.id}';`, winner).out === '1');

lap(`api match ${steps} steps`);
// Forfeit (private match joined by code)
const priv = rpc(U1, 'public.cl_create_match(false)').json;
check('private match hidden from lobby', !(rpc(U3, 'public.cl_list_open_matches()').json ?? []).some((m) => m.id === priv.id));
check('private match joinable by code', rpc(U3, `public.cl_join_match(${q(priv.code)})`).json?.status === 'active');
check('my matches lists active match', (rpc(U3, 'public.cl_list_my_matches()').json ?? []).some((m) => m.id === priv.id));
check('heartbeat works', rpc(U3, `public.cl_touch_match('${priv.id}')`).json?.status === 'active');
check('no forfeit while opponent is connected', errOf(rpc(U3, `public.cl_claim_forfeit('${priv.id}')`)) === 'CL:opponent_still_connected');
sql(`update public.cl_matches set a_seen_at = now() - interval '5 minutes' where id = '${priv.id}';`);
const before1 = rpc(U1, 'public.cl_get_my_profile()').json.rating;
const ff = rpc(U3, `public.cl_claim_forfeit('${priv.id}')`).json;
const expChange = Math.round(32 * (1 - 1 / (1 + Math.pow(10, (before1 - 1200) / 400))));
check('forfeit win recorded with Elo', ff?.endReason === 'forfeit' && ff?.winnerId === U3 && ff?.result?.bRatingAfter === 1200 + expChange && ff?.result?.aRatingAfter === before1 - expChange);

// Resign
const m3 = rpc(U2, 'public.cl_create_match(true)').json;
rpc(U3, `public.cl_join_match(${q(m3.code)})`);
const res = rpc(U3, `public.cl_resign('${m3.id}')`).json;
check('resign gives the opponent the win', res?.endReason === 'resign' && res?.winnerId === U2 && !!res?.result);

// Draw at the hard stop (turn 40, level score)
const m5 = rpc(U2, 'public.cl_create_match(true)').json;
const j5 = rpc(U3, `public.cl_join_match(${q(m5.code)})`).json;
sql(`update public.cl_matches set state = jsonb_set(jsonb_set(state, '{turnNumber}', '40'), '{score}', '{"A":1,"B":1}') where id = '${m5.id}';`);
const r2 = rpc(U2, 'public.cl_get_my_profile()').json;
const r3 = rpc(U3, 'public.cl_get_my_profile()').json;
const mover5 = j5.state.turn === 'A' ? U2 : U3;
const d = rpc(mover5, `public.cl_submit_action('${m5.id}', ${j5.version}, '{"type":"endTurn"}'::jsonb)`).json;
const expA = Math.round(32 * (0.5 - 1 / (1 + Math.pow(10, (r3.rating - r2.rating) / 400))));
check('level at turn 40 is a draw', d?.status === 'finished' && d?.endReason === 'draw' && d?.winnerId === null && d?.state?.winner === null);
check('draw rated with Elo (0.5 each) and counted', d?.result && d.result.winnerId === null && d.result.aRatingAfter === r2.rating + expA && d.result.bRatingAfter === r3.rating - expA &&
  rpc(U2, 'public.cl_get_my_profile()').json.draws === r2.draws + 1 && rpc(U3, 'public.cl_get_my_profile()').json.draws === r3.draws + 1);

// Turn clock: 25 s per turn (+3 s grace), enforced with the server's clock.
const m6 = rpc(U1, 'public.cl_create_match(false)').json;
const j6 = rpc(U2, `public.cl_join_match(${q(m6.code)})`).json;
const idle = j6.state.turn === 'A' ? U1 : U2;
const waiter = idle === U1 ? U2 : U1;
const claim = (as, v) => rpc(as, `public.cl_claim_timeout('${m6.id}', ${v})`);
const ago = (secs) => sql(`update public.cl_matches set turn_started_at = now() - interval '${secs} seconds' where id = '${m6.id}';`);
check('clock: nobody can end a turn before its time is up', errOf(claim(waiter, j6.version)) === 'CL:turn_time_left' && errOf(claim(idle, j6.version)) === 'CL:turn_time_left');
ago(20);
const early = rpc(idle, `public.cl_submit_action('${m6.id}', ${j6.version}, '{"type":"surge"}'::jsonb)`);
const startedAfter = sql(`select extract(epoch from now() - turn_started_at)::int from public.cl_matches where id = '${m6.id}';`).out;
check('clock: an action inside the turn is accepted and does not reset the clock', early.ok && Number(startedAfter) >= 19, early.err || startedAfter);
const v6 = early.json?.version ?? j6.version;
ago(27);
check('clock: still playable inside the 3 s grace', errOf(claim(waiter, v6)) === 'CL:turn_time_left');
ago(29);
sql(`update public.cl_matches set ${idle === U1 ? 'a_seen_at' : 'b_seen_at'} = now() - interval '1 minute' where id = '${m6.id}';`);
check('clock: an action after the deadline is refused and changes nothing', errOf(rpc(idle, `public.cl_submit_action('${m6.id}', ${v6}, '{"type":"endTurn"}'::jsonb)`)) === 'CL:turn_expired' &&
  sql(`select version from public.cl_matches where id = '${m6.id}';`).out === String(v6));
check('clock: an expiry request with an old version is refused', errOf(claim(waiter, v6 - 1)) === 'CL:stale_state');
const t6 = claim(waiter, v6).json;
const seenAfter = sql(`select extract(epoch from now() - ${idle === U1 ? 'a_seen_at' : 'b_seen_at'})::int from public.cl_matches where id = '${m6.id}';`).out;
check('clock: an expired turn is ended on the server (unused AP lost)', t6?.version === v6 + 1 && t6?.state?.turn !== j6.state.turn && t6?.lastEvents?.[0]?.type === 'turnEnd');
check('clock: the timed-out player is not marked present', Number(seenAfter) >= 50);
check('clock: the next turn starts a fresh clock', Date.parse(t6.turnStartedAt) > Date.now() - 60000);
check('clock: a repeated expiry request cannot end a second turn', errOf(claim(idle, v6)) === 'CL:stale_state' && errOf(claim(idle, t6.version)) === 'CL:turn_time_left' &&
  sql(`select version from public.cl_matches where id = '${m6.id}';`).out === String(t6.version));
// Reconnect: fetching the match resolves an expired turn (once), even if nobody asked.
ago(40);
const g1 = rpc(waiter, `public.cl_get_match('${m6.id}')`).json;
const g2 = rpc(idle, `public.cl_get_match('${m6.id}')`).json;
check('clock: a reconnecting player gets the expired turn ended, once', g1?.version === t6.version + 1 && g2?.version === g1.version && g1.state.turn === j6.state.turn);
ago(40);
rpc(idle, `public.cl_touch_match('${m6.id}')`);
check('clock: the heartbeat also ends an expired turn', sql(`select version from public.cl_matches where id = '${m6.id}';`).out === String(g1.version + 1));
const t6b = rpc(waiter, `public.cl_get_match('${m6.id}')`).json;

// Matches from the old rules cannot continue
sql(`update public.cl_matches set rules_version = 2 where id = '${m6.id}';`);
check('outdated match refuses new actions', errOf(rpc(waiter, `public.cl_submit_action('${m6.id}', ${t6b.version}, '{"type":"endTurn"}'::jsonb)`)) === 'CL:match_outdated');
check('outdated match can still be resigned', rpc(waiter, `public.cl_resign('${m6.id}')`).json?.status === 'finished');

// Cancel
const m4 = rpc(U2, 'public.cl_create_match(true)').json;
check('only the host can cancel', errOf(rpc(U1, `public.cl_cancel_match('${m4.id}')`)) === 'CL:match_not_found');
check('host cancels waiting match', rpc(U2, `public.cl_cancel_match('${m4.id}')`).json?.status === 'cancelled');
check('cancelled match cannot be joined', errOf(rpc(U1, `public.cl_join_match(${q(m4.code)})`)) === 'CL:match_unavailable');

// Leaderboard
const lb = rpc('anon', 'public.cl_get_leaderboard(0, 20)').json;
const ratings = lb.rows.map((r) => r.rating);
check('leaderboard ranks all rated players', lb.total === 3 && lb.rows.length === 3 && lb.rows.map((r) => r.rank).join() === '1,2,3');
check('leaderboard sorted by rating', ratings.every((v, i) => i === 0 || ratings[i - 1] >= v));
const page2 = rpc('anon', 'public.cl_get_leaderboard(1, 1)').json;
check('leaderboard pagination', page2.rows.length === 1 && page2.rows[0].rank === 2 && page2.total === 3);
check('leaderboard limit is capped', rpc('anon', 'public.cl_get_leaderboard(0, 5000)').ok);
check('leaderboard includes my rank when signed in', rpc(U3, 'public.cl_get_leaderboard(0, 1)').json?.me?.id === U3);
// Ties: equal rating and record -> earlier rating_updated_at, then id.
sql(`update public."user" set rating = 1300, wins = 1, losses = 0, rating_updated_at = '2026-01-01' where id in ('${U1}', '${U2}');`);
const tie = rpc('anon', 'public.cl_get_leaderboard(0, 2)').json;
check('ties broken deterministically by id', tie.rows[0].id === U1 && tie.rows[1].id === U2);


// ------------------------------------------------------------------ C-ranks
check('rank tiers in SQL match src/online/ranks.ts', sql("select string_agg(code || ':' || min_points, ',' order by sort) from public.rank_tiers;").out === RANK_TIERS.map((t) => `${t.tier}:${t.min}`).join(','));
check('bundles in SQL match src/ui/economy.ts', sql("select string_agg(b.id || ':' || b.price || ':' || (select string_agg(i.kind || '=' || i.item_id, '+' order by i.kind) from public.bundle_items i where i.bundle_id = b.id), ',' order by b.id) from public.bundles b;").out ===
  [...BUNDLES].sort((a, b) => (a.id < b.id ? -1 : 1)).map((b) => `${b.id}:${b.price}:${[...b.items].sort((x, y) => (x.kind < y.kind ? -1 : 1)).map((i) => `${i.kind}=${i.id}`).join('+')}`).join(','));
check('every set costs less than its three items', sql(`select count(*) from public.bundles b where b.price >= (select sum(c.price) from public.bundle_items i join public.cosmetics c on c.kind = i.kind and c.id = i.item_id where i.bundle_id = b.id);`).out === '0' &&
  sql(`select count(*) from public.bundles b where (select count(distinct kind) from public.bundle_items i where i.bundle_id = b.id) <> 3;`).out === '0');
check('shop prices in SQL match src/ui/economy.ts', sql("select string_agg(kind || ':' || id || ':' || price, ',' order by kind, id) from public.cosmetics;").out ===
  [...SHOP_ITEMS].sort((a, b) => (a.kind + ':' + a.id < b.kind + ':' + b.id ? -1 : 1)).map((i) => `${i.kind}:${i.id}:${i.price}`).join(','));
const tierOf = (pts) => sql(`select checkline_private.rank_json(${pts}) ->> 'tier';`).out;
check('rank tiers: C5 0-149, C4 150-299, C3 300-449, C2 450-599, C1 600+',
  [[0, 'C5'], [149, 'C5'], [150, 'C4'], [299, 'C4'], [300, 'C3'], [449, 'C3'], [450, 'C2'], [599, 'C2'], [600, 'C1'], [5000, 'C1']].every(([p, t]) => tierOf(p) === t));
check('rank shows progress to the next tier', (() => { const j = JSON.parse(sql(`select checkline_private.rank_json(160);`).out); return j.tierMin === 150 && j.nextTierAt === 300; })());
check('tier follows points edited by the owner', sql(`update public."user" set rank_points = 455 where id = '${U2}';`).ok && rpc(U2, 'public.cl_get_my_profile()').json?.tier === 'C2');
check('guest games are unranked (no points)', ff?.result?.ranked === false && ff?.result?.rankNote === 'guest' && ff?.result?.aPointsAfter === ff?.result?.aPointsBefore);
// Ranked short match: the quitter still loses 6, the winner gains nothing.
const playMatch = (host, guest, turnNumber, quitter) => {
  const m = rpc(host, 'public.cl_create_match(false)').json;
  rpc(guest, `public.cl_join_match(${q(m.code)})`);
  if (turnNumber) sql(`update public.cl_matches set state = jsonb_set(state, '{turnNumber}', '${turnNumber}') where id = '${m.id}';`);
  return rpc(quitter, `public.cl_resign('${m.id}')`).json;
};
const u1Before = rpc(U1, 'public.cl_get_my_profile()').json.rankPoints;
const short = playMatch(U1, U2, 0, U2);
check('early resign: loser -6, winner +0, no coins', short?.result?.ranked === true && short?.result?.rankNote === 'short_match' &&
  short.result.bPointsAfter === 449 && short.result.aPointsAfter === u1Before && short.result.aCoins === 0 && short.result.bCoins === 0);
check('the player who resigned drops a tier (C2 -> C3)', rpc(U2, 'public.cl_get_my_profile()').json?.tier === 'C3');
// Same opponent: points for at most 3 wins in 24 hours.
const priorWins = Number(sql(`select count(*) from public.cl_match_results where ranked and winner_id = '${U1}' and (a_points_after > a_points_before or b_points_after > b_points_before);`).out);
const gains = [];
for (let i = priorWins; i < 4; i++) {
  const r = playMatch(U1, U2, 10, U2);
  gains.push(r?.result?.aPointsAfter - r?.result?.aPointsBefore);
}
check('repeat opponent: no points after 3 wins in 24h, losses still count', gains.slice(0, -1).every((g) => g === 10) && gains[gains.length - 1] === 0 &&
  sql(`select rank_note from public.cl_match_results where winner_id = '${U1}' order by created_at desc limit 1;`).out === 'repeat_opponent', JSON.stringify(gains));
check('every 3rd played match pays +5', sql(`select count(*) from public.coin_transactions t join public.cl_match_results r on r.match_id = t.match_id
  where t.kind = 'match_reward' and t.amount in (5, 8);`).out !== '0');

// ------------------------------------------------------------------ coins, shop and inventory
const W = (u) => rpc(u, 'public.cl_get_wallet()').json;
const ledgerOk = () => sql(`select count(*) from public."user" u where u.coins <> coalesce((select sum(amount) from public.coin_transactions t where t.user_id = u.id), 0);`).out === '0';
check('coin history adds up to every balance', ledgerOk());
check('client-reported results are not paid (no cl_report_match)', !rpc(U3, "public.cl_report_match('ai-abc123', true)").ok);
check('wallet has the price list from public.cosmetics', W(U3)?.prices?.['skin:gold'] === 25 && W(U3)?.owned?.includes('skin:classic'));
const admin = (who, n, note) => sql(`select public.cl_admin_adjust_coins('${who}', ${n}, '${note}');`);
check('admin grant by username', JSON.parse(admin('sara', 0, 'x').out || 'null') === null && JSON.parse(admin('سارة', 20, 'Welcome gift').out).coins === W(U3).coins);
check('admin grant by email', JSON.parse(admin('ALICE@example.com', 5, 'Bug bounty').out)?.player === 'Alice');
check('admin needs a note and a non-zero amount', /note_required/.test(admin('Alice', 5, '').err) && /bad_amount/.test(admin('Alice', 0, 'xyz').err));
check('admin cannot take more than the player has', /too_poor/.test(admin('Alice', -100000, 'Oops').err) && Number(sql(`select coins from public."user" where id = '${U1}';`).out) >= 0);
check('admin removal is recorded', JSON.parse(admin('Alice', -5, 'Correction').out)?.amount === -5 &&
  sql(`select count(*) from public.coin_transactions where user_id = '${U1}' and kind in ('admin_grant', 'admin_remove');`).out === '2');
check('players cannot call the admin coin function', !rpc(U1, "public.cl_admin_adjust_coins('Alice', 1000, 'free')").ok && !rpc('anon', "public.cl_admin_adjust_coins('Alice', 1000, 'free')").ok);
const c3 = W(U3).coins;
check('hand edit in the Table Editor is audited', sql(`update public."user" set coins = coins + 7 where id = '${U3}';`).ok &&
  sql(`select amount || '|' || kind from public.coin_transactions where user_id = '${U3}' order by id desc limit 1;`).out === '7|manual_edit' && W(U3).coins === c3 + 7);
check('coin history still adds up', ledgerOk());
sql(`update public."user" set coins = 15 where id = '${U3}';`);
check('unknown item refused', errOf(rpc(U3, "public.cl_buy_item('skin', 'rainbow')")) === 'CL:unknown_item');
check('too expensive refused, nothing changes', errOf(rpc(U3, "public.cl_buy_item('skin', 'gold')")) === 'CL:too_poor' && W(U3)?.coins === 15 && !W(U3).owned.includes('skin:gold'));
const bought = rpc(U3, "public.cl_buy_item('floor', 'sunset')").json;
check('buy deducts, records, adds and equips in one step', bought?.coins === 0 && bought?.floor === 'sunset' && bought?.owned?.includes('floor:sunset') &&
  sql(`select amount || '|' || item from public.coin_transactions where user_id = '${U3}' and kind = 'purchase';`).out === '-15|floor:sunset' &&
  sql(`select price_paid from public.user_cosmetics where user_id = '${U3}' and item_id = 'sunset';`).out === '15');
check('owned items equip for free', rpc(U3, "public.cl_buy_item('floor', 'classic')").json?.floor === 'classic' && rpc(U3, "public.cl_buy_item('floor', 'sunset')").json?.coins === 0);
sql(`update public.cosmetics set active = false where kind = 'floor' and id = 'sunset';`);
check('retired items stay usable for owners but cannot be bought', rpc(U3, "public.cl_buy_item('floor', 'sunset')").ok && errOf(rpc(U1, "public.cl_buy_item('floor', 'sunset')")) === 'CL:unknown_item');
sql(`update public.cosmetics set active = true where kind = 'floor' and id = 'sunset';`);
check('price changes in public.cosmetics apply to purchases', sql(`update public.cosmetics set price = 1 where kind = 'skin' and id = 'neon';`).ok && rpc(U1, "public.cl_buy_item('skin', 'neon')").ok &&
  sql(`select amount from public.coin_transactions where user_id = '${U1}' and item = 'skin:neon';`).out === '-1');
check('equipping an unowned item by hand is refused', /not_owned/.test(sql(`update public."user" set equipped_skin = 'gold' where id = '${U3}';`).err));

// ------------------------------------------------------------------ balls and full sets
const U7 = '77777777-7777-4777-8777-777777777777';
sql(`insert into auth.users (id, email, is_anonymous, raw_user_meta_data) values ('${U7}', 'kim@example.com', false, '{"display_name":"Kim"}');`);
const W7 = () => W(U7);
check('new players own the Classic ball too', W7()?.owned?.includes('ball:classic') && W7()?.ball === 'classic' && W7()?.prices?.['ball:gold'] === 35 && W7()?.prices?.['bundle:champion'] === 99);
check('unknown set refused', errOf(rpc(U7, "public.cl_buy_bundle('nope')")) === 'CL:unknown_item');
admin('Kim', 54, 'Set test');
check('set: too few coins refused, nothing changes', errOf(rpc(U7, "public.cl_buy_bundle('neon_nights')")) === 'CL:too_poor' && W7().coins === 54 && W7().owned.length === 3);
admin('Kim', 1, 'Set test');
const nb = rpc(U7, "public.cl_buy_bundle('neon_nights')").json;
check('set: one payment, three items, all equipped', nb?.coins === 0 && nb.floor === 'synthwave' && nb.skin === 'neon' && nb.ball === 'neon' &&
  ['floor:synthwave', 'skin:neon', 'ball:neon'].every((x) => nb.owned.includes(x)) &&
  sql(`select string_agg(amount || '|' || item, ',') from public.coin_transactions where user_id = '${U7}' and kind = 'purchase';`).out === '-55|bundle:neon_nights' &&
  sql(`select count(*) from public.user_cosmetics where user_id = '${U7}' and source = 'bundle';`).out === '3');
rpc(U7, "public.cl_buy_item('floor', 'classic')");
const again = rpc(U7, "public.cl_buy_bundle('neon_nights')").json;
check('set already owned: equips it again for free', again?.coins === 0 && again.floor === 'synthwave' && sql(`select count(*) from public.coin_transactions where user_id = '${U7}' and kind = 'purchase';`).out === '1');
// Partly owned: pay the lower of the set price and the missing items.
sql(`insert into public.user_cosmetics (user_id, kind, item_id, source) values ('${U7}', 'skin', 'obsidian', 'admin'), ('${U7}', 'ball', 'cosmic', 'admin');`);
admin('Kim', 100, 'Set test');
const cb = rpc(U7, "public.cl_buy_bundle('cosmic')").json;
check('set partly owned: pays only the missing floor (60, not 70)', cb?.coins === 40 && cb.floor === 'galaxy' && cb.skin === 'obsidian' && cb.ball === 'cosmic');
sql(`insert into public.user_cosmetics (user_id, kind, item_id, source) values ('${U7}', 'skin', 'gold', 'admin');`);
admin('Kim', 100, 'Set test');
const ch = rpc(U7, "public.cl_buy_bundle('champion')").json;
check('set partly owned: never more than the set price (99, not 115)', ch?.coins === 140 - 99 && ch.floor === 'prism' && ch.ball === 'gold');
check('balls buy and equip on their own (mix and match)', rpc(U7, "public.cl_buy_item('ball', 'ember')").json?.ball === 'ember' && W7().floor === 'prism' && W7().skin === 'gold' && W7().coins === 41 - 12);
check('equipping an unowned ball by hand is refused', /not_owned/.test(sql(`update public."user" set equipped_ball = 'frost' where id = '${U7}';`).err));
check('retired sets cannot be bought', sql(`update public.bundles set active = false where id = 'cosmic';`).ok && errOf(rpc(U1, "public.cl_buy_bundle('cosmic')")) === 'CL:unknown_item');
sql(`update public.bundles set active = true where id = 'cosmic';`);
check('players cannot change set prices or contents', /permission denied/.test(sql(`update public.bundles set price = 0;`, U7).err) && /permission denied/.test(sql(`delete from public.bundle_items;`, U7).err));
check('coin history still adds up after sets', ledgerOk());

// ------------------------------------------------------------------ privacy and Auth sync
check('players read only their own row', sql('select count(*) from public."user";', U3).out === '1' && sql('select count(*) from public.coin_transactions;', U3).out === sql(`select count(*) from public.coin_transactions where user_id = '${U3}';`).out);
check('visitors cannot read players', /permission denied/.test(sql('select count(*) from public."user";', 'anon').err));
const lbAll = rpc('anon', 'public.cl_get_leaderboard(0, 50)');
check('leaderboard shows tiers but never emails or coins', lbAll.ok && !/@|"coins"|"email"/.test(lbAll.out) && lbAll.json.rows.every((r) => /^C[1-5]$/.test(r.tier)));
const anyMatch = rpc(U1, `public.cl_get_match('${created.id}')`);
check('match data never includes emails', anyMatch.ok && !/@/.test(anyMatch.out) && /^C[1-5]$/.test(anyMatch.json.playerA.tier));
check('own profile includes own email', rpc(U1, 'public.cl_get_my_profile()').json?.email === 'alice@example.com');
const U6 = '66666666-6666-4666-8666-666666666666';
sql(`insert into auth.users (id, email, is_anonymous, raw_user_meta_data) values ('${U6}', 'eve@example.com', false, '{"display_name":"Eve"}');`);
check('sign-up creates the player row with email and Classic items', sql(`select username || '|' || email || '|' || is_guest from public."user" where id = '${U6}';`).out === 'Eve|eve@example.com|false' &&
  sql(`select count(*) from public.user_cosmetics where user_id = '${U6}' and item_id = 'classic';`).out === '3');
check('email changed in Authentication updates the player row', sql(`update auth.users set email = 'eve2@example.com' where id = '${U6}';`).ok && sql(`select email from public."user" where id = '${U6}';`).out === 'eve2@example.com');
check('guest upgraded to an email account becomes ranked-eligible', sql(`update auth.users set is_anonymous = false, email = 'sara@example.com' where id = '${U3}';`).ok && sql(`select is_guest from public."user" where id = '${U3}';`).out === 'f');
check('deleting the account deletes the player and their data', sql(`delete from auth.users where id = '${U6}';`).ok && sql(`select count(*) from public."user" where id = '${U6}';`).out === '0');
check('no password column anywhere in public tables', sql(`select count(*) from information_schema.columns where table_schema = 'public' and column_name ilike '%pass%';`).out === '0');
check('every exposed table has row-level security', sql(`select count(*) from pg_tables where schemaname = 'public' and not rowsecurity;`).out === '0');

// ------------------------------------------------------------------ report
console.log(`SQL rules parity: ${cases.length} actions (${accepted} accepted, ${goals} goals, ${cases.length - accepted} rejections compared)`);
if (failures.length) {
  console.error(`\n${failures.length} check(s) FAILED:\n - ${failures.join('\n - ')}`);
  process.exitCode = 1;
} else {
  console.log(`All ${passed} SQL checks passed.`);
}
