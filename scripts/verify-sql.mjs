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
sql(`insert into auth.users (id) values ('${U1}'), ('${U2}'), ('${U3}');`);
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

// Direct table writes are blocked
for (const [label, stmt] of [
  ['insert profile', `insert into public.cl_profiles (id, display_name) values ('${U3}', 'x');`],
  ['edit own rating', `update public.cl_profiles set rating = 3000 where id = '${U1}';`],
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

// Turn timer
const m6 = rpc(U1, 'public.cl_create_match(false)').json;
const j6 = rpc(U2, `public.cl_join_match(${q(m6.code)})`).json;
const idle = j6.state.turn === 'A' ? U1 : U2;
const waiter = idle === U1 ? U2 : U1;
check('timeout: the player to move cannot claim', errOf(rpc(idle, `public.cl_claim_timeout('${m6.id}')`)) === 'CL:not_your_turn');
check('timeout: not before 90 seconds', errOf(rpc(waiter, `public.cl_claim_timeout('${m6.id}')`)) === 'CL:turn_time_left');
sql(`update public.cl_matches set turn_started_at = now() - interval '2 minutes', ${idle === U1 ? 'a_seen_at' : 'b_seen_at'} = now() - interval '1 minute' where id = '${m6.id}';`);
const t6 = rpc(waiter, `public.cl_claim_timeout('${m6.id}')`).json;
const seenAfter = sql(`select extract(epoch from now() - ${idle === U1 ? 'a_seen_at' : 'b_seen_at'})::int from public.cl_matches where id = '${m6.id}';`).out;
check('timeout ends the idle turn on the server', t6?.version === j6.version + 1 && t6?.state?.turn !== j6.state.turn && t6?.lastEvents?.[0]?.type === 'turnEnd');
check('timeout does not count as the idle player being present', Number(seenAfter) >= 50);
check('timeout resets the turn timer', Date.parse(t6.turnStartedAt) > Date.now() - 60000);

// Matches from the old rules cannot continue
sql(`update public.cl_matches set rules_version = 2 where id = '${m6.id}';`);
check('outdated match refuses new actions', errOf(rpc(waiter, `public.cl_submit_action('${m6.id}', ${t6.version}, '{"type":"endTurn"}'::jsonb)`)) === 'CL:match_outdated');
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
sql(`update public.cl_profiles set rating = 1300, wins = 1, losses = 0, rating_updated_at = '2026-01-01' where id in ('${U1}', '${U2}');`);
const tie = rpc('anon', 'public.cl_get_leaderboard(0, 2)').json;
check('ties broken deterministically by id', tie.rows[0].id === U1 && tie.rows[1].id === U2);

// ------------------------------------------------------------------ report
console.log(`SQL rules parity: ${cases.length} actions (${accepted} accepted, ${goals} goals, ${cases.length - accepted} rejections compared)`);
if (failures.length) {
  console.error(`\n${failures.length} check(s) FAILED:\n - ${failures.join('\n - ')}`);
  process.exitCode = 1;
} else {
  console.log(`All ${passed} SQL checks passed.`);
}
