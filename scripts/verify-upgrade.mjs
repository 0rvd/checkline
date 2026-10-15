#!/usr/bin/env node
// Developer check: supabase/setup.sql must upgrade every earlier database shape in place,
// keeping players, coins and items. Needs local PostgreSQL (same as verify-sql.mjs).
// Fixtures in supabase/tests/legacy/ are the earlier scripts.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (p) => readFileSync(join(root, p), 'utf8');
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
const sh = (cmd, args, input) =>
  spawnSync(...(asRoot ? ['runuser', ['-u', 'postgres', '--', cmd, ...args]] : [cmd, args]), { input, encoding: 'utf8', maxBuffer: 1 << 26 });

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => (ok ? passed++ : failures.push(`${name}${detail ? `: ${detail}` : ''}`));

function scenario(name, steps, verify) {
  const dir = mkdtempSync(join(tmpdir(), 'checkline-up-'));
  if (asRoot) spawnSync('chown', ['-R', 'postgres', dir]);
  const data = join(dir, 'data');
  const port = String(55000 + Math.floor(Math.random() * 900));
  const init = sh(exe('initdb'), ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C']);
  if (init.status !== 0) {
    console.error('initdb failed. Is PostgreSQL installed? Set PG_BIN.\n' + init.stderr);
    process.exit(2);
  }
  sh(exe('pg_ctl'), ['-D', data, '-w', '-l', join(dir, 'log'), '-o', `-p ${port} -k ${dir} -c listen_addresses=''`, 'start']);
  const sql = (text) => {
    const r = sh(exe('psql'), ['-h', dir, '-p', port, '-U', 'postgres', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1'], text);
    return { ok: r.status === 0, out: r.stdout.trim(), err: r.stderr.trim() };
  };
  try {
    for (const [label, text] of steps) {
      const r = sql(text);
      check(`${name}: ${label}`, r.ok, r.err.split('\n').find((l) => l.startsWith('ERROR')) ?? '');
      if (!r.ok) return;
    }
    verify(sql);
  } finally {
    sh(exe('pg_ctl'), ['-D', data, '-m', 'immediate', 'stop']);
    rmSync(dir, { recursive: true, force: true });
  }
}

const stub = read('supabase/tests/local-stub.sql');
const setup = read('supabase/setup.sql');
const ORVD = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const accounts = `insert into auth.users (id, email, is_anonymous, raw_user_meta_data) values
  ('${ORVD}', 'orvd@example.com', false, '{"display_name":"ORVD"}'),
  ('${BOB}', 'bob@example.com', false, '{"display_name":"Bob"}');`;
const row = (sql, id) =>
  sql(`select username || '|' || coalesce(email, '') || '|' || coins || '|' || equipped_floor || '|' || equipped_skin || '|' || rating
       from public."user" where id = '${id}';`).out;
const owned = (sql, id) => sql(`select string_agg(kind || ':' || item_id, ',' order by kind, item_id) from public.user_cosmetics where user_id = '${id}';`).out;
const ledgerOk = (sql) =>
  sql(`select count(*) from public."user" u where u.coins <> coalesce((select sum(amount) from public.coin_transactions t where t.user_id = u.id), 0);`).out === '0';

scenario(
  'v0.3 + cl_users (004)',
  [
    ['stub', stub],
    ['old setup', read('supabase/tests/legacy/v03-cl_users.sql')],
    [
      'old data',
      `${accounts}
      update public.cl_profiles set rating = 1216, wins = 1, games = 1 where display_name = 'ORVD';
      update public.cl_users set coins = 42, owned = array['floor:classic','skin:classic','skin:gold','floor:neon'], skin = 'gold', floor = 'neon' where display_name = 'ORVD';`,
    ],
    ['new setup', setup],
    ['new setup again', setup],
  ],
  (sql) => {
    check('v0.3 + cl_users: player, rating, coins and equipped items kept', row(sql, ORVD) === 'ORVD|orvd@example.com|42|neon|gold|1216', row(sql, ORVD));
    check('v0.3 + cl_users: items moved to user_cosmetics', owned(sql, ORVD) === 'ball:classic,floor:classic,floor:neon,skin:classic,skin:gold', owned(sql, ORVD));
    check('v0.3 + cl_users: coins recorded once as a migration', sql(`select count(*) || '|' || sum(amount) from public.coin_transactions where kind = 'migration';`).out === '1|42' && ledgerOk(sql));
    check('v0.3 + cl_users: old table kept privately', sql(`select to_regclass('public.cl_users') is null and to_regclass('checkline_private.legacy_cl_users') is not null;`).out === 't');
  },
);

scenario(
  'v0.3 + cl_wallets (003)',
  [
    ['stub', stub],
    ['old setup', read('supabase/tests/legacy/v03-cl_wallets.sql')],
    ['old data', `${accounts} update public.cl_wallets set coins = 17, owned = array['floor:classic','skin:classic','floor:sunset'], floor = 'sunset' where user_id = '${BOB}';`],
    ['new setup', setup],
  ],
  (sql) => {
    check('v0.3 + cl_wallets: coins and items kept', row(sql, BOB) === 'Bob|bob@example.com|17|sunset|classic|1200' && owned(sql, BOB) === 'ball:classic,floor:classic,floor:sunset,skin:classic', row(sql, BOB));
    check('v0.3 + cl_wallets: empty wallet adds no history', sql(`select count(*) from public.coin_transactions where user_id = '${ORVD}';`).out === '0' && ledgerOk(sql));
  },
);

scenario(
  'step-1 users table',
  [
    ['stub', stub],
    ['old script', read('supabase/tests/legacy/step1-users.sql')],
    [
      'old data',
      `insert into auth.users (id, email, is_anonymous, raw_user_meta_data) values ('${ORVD}', 'orvd@example.com', false, '{"display_name":"ORVD"}');
      update public.users set coins = 100, skins = array['classic','gold'], skin = 'gold';`,
    ],
    ['new setup', setup],
    ['sign-up after the upgrade', `insert into auth.users (id, email, is_anonymous, raw_user_meta_data) values ('${BOB}', 'bob@example.com', false, '{"display_name":"Bob"}');`],
  ],
  (sql) => {
    check('step-1 users: player and coins kept', row(sql, ORVD) === 'ORVD|orvd@example.com|100|classic|gold|1200', row(sql, ORVD));
    check(
      'step-1 users: old sign-up triggers removed, new sign-ups work',
      row(sql, BOB) === 'Bob|bob@example.com|0|classic|classic|1200' &&
        sql(`select string_agg(tgname, ',' order by tgname) from pg_trigger where tgrelid = 'auth.users'::regclass and not tgisinternal;`).out ===
          'cl_on_auth_user_created,cl_on_auth_user_updated',
    );
    check('step-1 users: test table retired', sql(`select to_regclass('public.users') is null;`).out === 't');
  },
);

scenario(
  'v0.4 (public."user") to v0.5',
  [
    ['stub', stub],
    ['v0.4 setup', read('supabase/tests/legacy/v04.sql')],
    [
      'v0.4 data',
      `${accounts}
      select public.cl_admin_adjust_coins('ORVD', 77, 'Before upgrade');
      insert into public.user_cosmetics (user_id, kind, item_id, source) values ('${ORVD}', 'floor', 'neon', 'purchase'), ('${ORVD}', 'skin', 'gold', 'purchase');
      update public."user" set equipped_floor = 'neon', equipped_skin = 'gold' where id = '${ORVD}';`,
    ],
    ['new setup', setup],
    ['new setup again', setup],
  ],
  (sql) => {
    check('v0.4: coins, items and equipped cosmetics kept', row(sql, ORVD) === 'ORVD|orvd@example.com|77|neon|gold|1200', row(sql, ORVD));
    check('v0.4: everyone gets the Classic ball, nothing else changes', owned(sql, ORVD) === 'ball:classic,floor:classic,floor:neon,skin:classic,skin:gold' &&
      sql(`select equipped_ball from public."user" where id = '${ORVD}';`).out === 'classic', owned(sql, ORVD));
    check('v0.4: coin history kept and still adds up', sql(`select count(*) from public.coin_transactions;`).out === '1' && ledgerOk(sql));
    check('v0.4: new floors, balls and sets added', sql(`select count(*) from public.cosmetics;`).out === '18' && sql(`select count(*) from public.bundle_items;`).out === '9');
    check('v0.4: old 90-second claim function replaced', sql(`select string_agg(pg_get_function_identity_arguments(oid), ';') from pg_proc where proname = 'cl_claim_timeout';`).out === 'p_match_id uuid, p_expected_version integer');
  },
);

scenario(
  'empty step-1 table (the live project today)',
  [
    ['stub', stub],
    ['old script', read('supabase/tests/legacy/step1-users.sql')],
    ['new setup', setup],
  ],
  (sql) => {
    const tables = sql(`select string_agg(table_name, ',' order by table_name) from information_schema.tables where table_schema = 'public';`).out;
    check('empty step-1 table: removed, nothing else left behind', tables === 'bundle_items,bundles,cl_match_moves,cl_match_results,cl_matches,coin_transactions,cosmetics,rank_tiers,user,user_cosmetics', tables);
  },
);

scenario(
  'reset then fresh setup',
  [
    ['stub', stub],
    ['setup', setup],
    ['data', accounts],
    ['reset', read('supabase/reset-everything.sql')],
    ['setup again', setup],
  ],
  (sql) => {
    check('reset removes every account and table, setup rebuilds', sql(`select count(*) from auth.users;`).out === '0' && sql(`select count(*) from public.rank_tiers;`).out === '5');
  },
);

if (failures.length) {
  console.error(`\n${failures.length} upgrade check(s) FAILED:\n - ${failures.join('\n - ')}`);
  process.exitCode = 1;
} else {
  console.log(`All ${passed} upgrade checks passed.`);
}
