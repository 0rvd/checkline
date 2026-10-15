-- =====================================================================================
-- Checkline: complete Supabase database setup  (rules v3 / app v0.4)
-- =====================================================================================
-- Run this whole file in Dashboard -> SQL Editor. It is safe to run again at any time.
--
-- Tables (public schema, all protected by row-level security):
--   public."user"              one row per player: username, email (private), coins, equipped
--                              skin and pitch floor, C-rank points, Elo rating and record
--   public.rank_tiers          C5 ... C1 and the points each tier starts at
--   public.cosmetics           the shop catalogue (pitch floors, piece skins and balls, with prices)
--   public.bundles             full sets (one floor + one skin + one ball) sold for less
--   public.bundle_items        what each set contains
--   public.user_cosmetics      what each player owns (inventory)
--   public.coin_transactions   every coin change: match rewards, purchases, admin grants/removals,
--                              hand edits in the Table Editor (audit trail)
--   public.cl_matches          online matches (the two participants, invite code, public-lobby
--                              flag, status, authoritative game state, 25-second turn clock)
--   public.cl_match_moves      every accepted action in a match
--   public.cl_match_results    one row per finished match: score, Elo and C-rank changes, coins
--   checkline_private.*        server copy of the game rules + internal helpers (not exposed)
--   public.cl_* functions      the only way the game can change data (RPC)
--
-- Passwords are never stored here: Supabase Auth keeps them (hashed). Emails are copied into
-- public."user" for you to see, but only the player themself can read their own email.
--
-- Upgrading: earlier versions are migrated in place, keeping every player, match and coin:
--   cl_profiles  -> renamed to public."user" (same ids, ratings, records)
--   cl_users / cl_wallets (coins + items) and the test table public.users -> copied into
--   public."user", public.user_cosmetics and public.coin_transactions; the old tables are
--   then moved to the private schema as checkline_private.legacy_* (or removed if empty).
--
-- Keep in sync: the rule constants mirror src/rules/config.ts, shop prices mirror
-- src/ui/economy.ts. Check with `npm run verify:sql` (needs local PostgreSQL).
--   board 8x12 | 3 AP, Surge +1 once per rally | pass 4, shot 5, shot cost 1 | goal mouth B-G,
--   keeper box B-G x 2 rows | orthogonal marking | first to 3, regulation 30 turns, draw at 40
-- =====================================================================================

begin;

create schema if not exists checkline_private;
revoke all on schema checkline_private from public;

-- -------------------------------------------------------------------------------------
-- 1. Tables
-- -------------------------------------------------------------------------------------

-- 1.1 Players. Upgrading from v0.3: the old cl_profiles table becomes public."user".
do $$
begin
  if to_regclass('public."user"') is null and to_regclass('public.cl_profiles') is not null then
    alter table public.cl_profiles rename to "user";
    alter table public."user" rename column display_name to username;
    alter index if exists public.cl_profiles_display_name_unique rename to user_username_unique;
    alter index if exists public.cl_profiles_leaderboard_idx rename to user_leaderboard_idx;
    raise notice 'Checkline: cl_profiles renamed to public."user" (all players kept).';
  end if;
end
$$;

create table if not exists public."user" (
  id uuid primary key references auth.users (id) on delete cascade,   -- the Supabase Auth user id
  username text not null check (char_length(username) between 2 and 24),
  email text,                                                         -- copied from Auth; private
  is_guest boolean not null default false,                            -- anonymous (guest) account
  coins integer not null default 0 check (coins >= 0),
  equipped_skin text not null default 'classic',
  equipped_floor text not null default 'classic',
  equipped_ball text not null default 'classic',
  rank_points integer not null default 0 check (rank_points >= 0),    -- C-rank ladder (C5..C1)
  rating integer not null default 1200,                               -- Elo (leaderboard order)
  wins integer not null default 0 check (wins >= 0),
  draws integer not null default 0 check (draws >= 0),
  losses integer not null default 0 check (losses >= 0),
  games integer not null default 0 check (games >= 0),
  ranked_games integer not null default 0 check (ranked_games >= 0),
  rating_updated_at timestamptz not null default now(),               -- earlier wins leaderboard ties
  rank_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Old triggers from earlier versions that pointed at tables replaced below.
drop trigger if exists cl_on_profile_created on public."user";
drop trigger if exists cl_on_profile_renamed on public."user";
drop trigger if exists cl_on_auth_email_changed on auth.users;
drop trigger if exists users_on_sign_up on auth.users;
drop trigger if exists users_on_email_change on auth.users;

-- Columns added after earlier versions.
alter table public."user" add column if not exists draws integer not null default 0;
alter table public."user" add column if not exists email text;
alter table public."user" add column if not exists is_guest boolean not null default false;
alter table public."user" add column if not exists coins integer not null default 0 check (coins >= 0);
alter table public."user" add column if not exists equipped_skin text not null default 'classic';
alter table public."user" add column if not exists equipped_floor text not null default 'classic';
alter table public."user" add column if not exists equipped_ball text not null default 'classic';
alter table public."user" add column if not exists rank_points integer not null default 0 check (rank_points >= 0);
alter table public."user" add column if not exists ranked_games integer not null default 0 check (ranked_games >= 0);
alter table public."user" add column if not exists rank_updated_at timestamptz;
comment on table public."user" is
  'Checkline players. Passwords live only in Supabase Auth. Change coins with public.cl_admin_adjust_coins (audited); hand edits of coins are audited too.';
comment on column public."user".email is 'Copied from Authentication -> Users. Only the player can read it; never shown publicly.';
comment on column public."user".rank_points is 'C-rank points. The tier (C5..C1) is always derived from this via public.rank_tiers.';

-- Email and guest flag from Auth (kept in step by triggers further down).
update public."user" u set email = a.email, is_guest = coalesce(a.is_anonymous, false)
from auth.users a
where a.id = u.id and (u.email is distinct from a.email or u.is_guest is distinct from coalesce(a.is_anonymous, false));

-- Unique usernames, ignoring upper/lower case and outer spaces ("Ali" = " ALI "). Older
-- duplicates: the oldest player keeps the name, later ones get " 2", " 3", ...
with ranked as (
  select id, username, row_number() over (partition by lower(btrim(username)) order by created_at, id) as n
  from public."user"
)
update public."user" p set username = left(btrim(r.username), 21) || ' ' || r.n, updated_at = now()
from ranked r where p.id = r.id and r.n > 1;
create unique index if not exists user_username_unique on public."user" (lower(btrim(username)));
create unique index if not exists user_email_unique on public."user" (lower(email)) where email is not null;
create index if not exists user_leaderboard_idx
  on public."user" (rating desc, wins desc, losses asc, rating_updated_at asc, id asc) where games > 0;

-- 1.2 C-rank tiers. A player's tier is always looked up from their points, never stored.
create table if not exists public.rank_tiers (
  code text primary key check (code ~ '^C[1-9]$'),
  min_points integer not null unique check (min_points >= 0),
  sort smallint not null unique
);
insert into public.rank_tiers (code, min_points, sort) values
  ('C5', 0, 1), ('C4', 150, 2), ('C3', 300, 3), ('C2', 450, 4), ('C1', 600, 5)
on conflict (code) do update set min_points = excluded.min_points, sort = excluded.sort;
comment on table public.rank_tiers is 'C5 0-149, C4 150-299, C3 300-449, C2 450-599, C1 600+ (a tier ends where the next begins).';

-- 1.3 Matches. Participants: player_a (Ivory, the host) and player_b (Ebony, who joined).
-- Invite / lobby: `code` is the private invite code; `is_public` lists it in the lobby.
-- `state` is the authoritative game state; `version` increases with every accepted action.
create table if not exists public.cl_matches (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z2-9]{6}$'),
  is_public boolean not null default true,
  status text not null default 'waiting'
    check (status in ('waiting', 'active', 'finished', 'cancelled')),
  player_a uuid not null references public."user" (id) on delete cascade,  -- Ivory (Team A)
  player_b uuid references public."user" (id) on delete cascade,           -- Ebony (Team B)
  state jsonb,
  version integer not null default 0,
  rules_version integer not null default 3,
  last_action jsonb,
  last_events jsonb,
  last_actor uuid,
  winner_id uuid references public."user" (id) on delete cascade,  -- null + finished = draw
  end_reason text,
  a_seen_at timestamptz not null default now(),
  b_seen_at timestamptz,
  turn_started_at timestamptz,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint cl_matches_distinct_players check (player_b is null or player_b <> player_a),
  constraint cl_matches_started_has_state
    check (status in ('waiting', 'cancelled') or (player_b is not null and state is not null))
);
-- Upgrades from v0.2: rows that existed before get rules_version 2 (old rules, not playable).
alter table public.cl_matches add column if not exists rules_version integer not null default 2;
alter table public.cl_matches alter column rules_version set default 3;
alter table public.cl_matches add column if not exists turn_started_at timestamptz;
alter table public.cl_matches drop constraint if exists cl_matches_end_reason_check;
alter table public.cl_matches add constraint cl_matches_end_reason_check
  check (end_reason in ('goals', 'clock', 'draw', 'resign', 'forfeit'));
create index if not exists cl_matches_lobby_idx on public.cl_matches (status, is_public, created_at desc);
create index if not exists cl_matches_player_a_idx on public.cl_matches (player_a);
create index if not exists cl_matches_player_b_idx on public.cl_matches (player_b);

-- Every accepted action (seq = match version after the action).
create table if not exists public.cl_match_moves (
  match_id uuid not null references public.cl_matches (id) on delete cascade,
  seq integer not null,
  player_id uuid not null references public."user" (id) on delete cascade,
  team text not null check (team in ('A', 'B')),
  action jsonb not null,
  events jsonb not null,
  created_at timestamptz not null default now(),
  primary key (match_id, seq)
);

-- Final result. The primary key on match_id means a match is scored exactly once, so Elo,
-- C-rank points and coins can never be applied twice (retries, reconnects, double clicks).
create table if not exists public.cl_match_results (
  match_id uuid primary key references public.cl_matches (id) on delete cascade,
  player_a uuid references public."user" (id) on delete cascade,
  player_b uuid references public."user" (id) on delete cascade,
  winner_id uuid references public."user" (id) on delete cascade,  -- null = draw
  reason text not null,
  a_rating_before integer,
  a_rating_after integer,
  b_rating_before integer,
  b_rating_after integer,
  score_a integer not null,
  score_b integer not null,
  created_at timestamptz not null default now()
);
-- Upgrades from v0.2 (which stored winner/loser columns only).
alter table public.cl_match_results add column if not exists player_a uuid references public."user" (id) on delete cascade;
alter table public.cl_match_results add column if not exists player_b uuid references public."user" (id) on delete cascade;
alter table public.cl_match_results add column if not exists a_rating_before integer;
alter table public.cl_match_results add column if not exists a_rating_after integer;
alter table public.cl_match_results add column if not exists b_rating_before integer;
alter table public.cl_match_results add column if not exists b_rating_after integer;
alter table public.cl_match_results alter column winner_id drop not null;
do $$
declare v_col text;
begin
  foreach v_col in array array['loser_id', 'winner_rating_before', 'winner_rating_after', 'loser_rating_before', 'loser_rating_after'] loop
    if exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'cl_match_results' and column_name = v_col) then
      execute format('alter table public.cl_match_results alter column %I drop not null', v_col);
    end if;
  end loop;
end
$$;
alter table public.cl_match_results drop constraint if exists cl_match_results_reason_check;
alter table public.cl_match_results add constraint cl_match_results_reason_check
  check (reason in ('goals', 'clock', 'draw', 'resign', 'forfeit'));
-- v0.4: C-rank points and coins paid with the result.
alter table public.cl_match_results add column if not exists ranked boolean not null default false;
alter table public.cl_match_results add column if not exists a_points_before integer;
alter table public.cl_match_results add column if not exists a_points_after integer;
alter table public.cl_match_results add column if not exists b_points_before integer;
alter table public.cl_match_results add column if not exists b_points_after integer;
alter table public.cl_match_results add column if not exists a_coins integer not null default 0;
alter table public.cl_match_results add column if not exists b_coins integer not null default 0;
alter table public.cl_match_results add column if not exists rank_note text;
create index if not exists cl_match_results_created_idx on public.cl_match_results (created_at desc);

-- 1.4 Shop catalogue and inventory.
create table if not exists public.cosmetics (
  kind text not null,
  id text not null check (id ~ '^[a-z0-9_-]{2,24}$'),
  price integer not null check (price >= 0),
  sort smallint not null default 0,
  active boolean not null default true,
  primary key (kind, id)
);
-- v0.5: balls are a third, independent category.
alter table public.cosmetics drop constraint if exists cosmetics_kind_check;
alter table public.cosmetics add constraint cosmetics_kind_check check (kind in ('floor', 'skin', 'ball'));
-- Catalogue (prices match src/ui/economy.ts). Re-running adds new items and keeps prices you changed.
-- Animated floors (aurora, synthwave, galaxy, prism) cost more, in step with how elaborate they are.
insert into public.cosmetics (kind, id, price, sort) values
  ('floor', 'classic', 0, 0), ('floor', 'midnight', 10, 1), ('floor', 'sunset', 15, 2), ('floor', 'neon', 20, 3),
  ('floor', 'aurora', 35, 4), ('floor', 'synthwave', 45, 5), ('floor', 'galaxy', 60, 6), ('floor', 'prism', 80, 7),
  ('skin', 'classic', 0, 0), ('skin', 'obsidian', 10, 1), ('skin', 'neon', 15, 2), ('skin', 'gold', 25, 3),
  ('ball', 'classic', 0, 0), ('ball', 'ember', 12, 1), ('ball', 'frost', 15, 2), ('ball', 'neon', 18, 3),
  ('ball', 'cosmic', 30, 4), ('ball', 'gold', 35, 5)
on conflict (kind, id) do nothing;

-- Full sets: one floor + one skin + one ball for less than the three separately.
create table if not exists public.bundles (
  id text primary key check (id ~ '^[a-z0-9_-]{2,24}$'),
  price integer not null check (price >= 0),
  sort smallint not null default 0,
  active boolean not null default true
);
create table if not exists public.bundle_items (
  bundle_id text not null references public.bundles (id) on delete cascade on update cascade,
  kind text not null check (kind in ('floor', 'skin', 'ball')),
  item_id text not null,
  primary key (bundle_id, kind),
  foreign key (kind, item_id) references public.cosmetics (kind, id) on update cascade
);
comment on table public.bundles is 'Full sets. Price must stay below the sum of the three items (checked when bought: never more than the missing items cost).';
insert into public.bundles (id, price, sort) values ('neon_nights', 55, 1), ('cosmic', 70, 2), ('champion', 99, 3)
on conflict (id) do nothing;
insert into public.bundle_items (bundle_id, kind, item_id) values
  ('neon_nights', 'floor', 'synthwave'), ('neon_nights', 'skin', 'neon'), ('neon_nights', 'ball', 'neon'),
  ('cosmic', 'floor', 'galaxy'), ('cosmic', 'skin', 'obsidian'), ('cosmic', 'ball', 'cosmic'),
  ('champion', 'floor', 'prism'), ('champion', 'skin', 'gold'), ('champion', 'ball', 'gold')
on conflict (bundle_id, kind) do nothing;

create table if not exists public.user_cosmetics (
  user_id uuid not null references public."user" (id) on delete cascade,
  kind text not null,
  item_id text not null,
  source text not null default 'purchase',
  price_paid integer not null default 0 check (price_paid >= 0),
  acquired_at timestamptz not null default now(),
  primary key (user_id, kind, item_id),
  foreign key (kind, item_id) references public.cosmetics (kind, id) on update cascade
);

alter table public.user_cosmetics drop constraint if exists user_cosmetics_source_check;
alter table public.user_cosmetics add constraint user_cosmetics_source_check
  check (source in ('starter', 'purchase', 'bundle', 'admin', 'migration'));

-- 1.5 Coin history. Every change to public."user".coins writes one row here.
create table if not exists public.coin_transactions (
  id bigint generated always as identity primary key,
  user_id uuid not null references public."user" (id) on delete cascade,
  amount integer not null,
  balance_after integer not null check (balance_after >= 0),
  kind text not null check (kind in ('match_reward', 'purchase', 'admin_grant', 'admin_remove', 'manual_edit', 'migration')),
  match_id uuid references public.cl_matches (id) on delete set null,
  item text,
  note text,
  actor text not null,
  created_at timestamptz not null default now()
);
create index if not exists coin_transactions_user_idx on public.coin_transactions (user_id, created_at desc);
-- A match pays each player at most once (second guard next to cl_match_results' primary key).
create unique index if not exists coin_transactions_match_once
  on public.coin_transactions (user_id, match_id) where kind = 'match_reward';

-- -------------------------------------------------------------------------------------
-- 2. Server-side game rules (mirror of src/rules/engine.ts, ruleset v3)
--    State JSON: { pieces:[{id,team,kind,pos:{c,r}|null}], carrierId, turn, ap, score:{A,B},
--                  rally, turnNumber, kickoffTeam, phase, winner, capturesBy:{A,B}, surge:{A,B} }
--    Columns c = 0..7 (A..H), rows r = 0..11 (1..12). Team A defends row 0, Team B row 11.
-- -------------------------------------------------------------------------------------

create or replace function checkline_private.sq(p_c integer, p_r integer)
returns text language sql immutable set search_path = '' as $$
  select chr(65 + p_c) || (p_r + 1)::text
$$;

create or replace function checkline_private.reason(p_code text, p_params jsonb default '{}'::jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('code', p_code, 'params', coalesce(p_params, '{}'::jsonb))
$$;

create or replace function checkline_private.other(p_team text)
returns text language sql immutable set search_path = '' as $$
  select case when p_team = 'A' then 'B' else 'A' end
$$;

-- Sliding range by piece (king, knight and pawn have fixed patterns).
create or replace function checkline_private.piece_range(p_kind text)
returns integer language sql immutable set search_path = '' as $$
  select case p_kind when 'queen' then 2 when 'rook' then 3 when 'bishop' then 3 else 1 end
$$;

create or replace function checkline_private.goal_row(p_team text)
returns integer language sql immutable set search_path = '' as $$
  select case when p_team = 'A' then 0 else 11 end
$$;

-- Goal mouth B..G (columns 1..6) on the goal line defended by p_team.
create or replace function checkline_private.in_goal_mouth(p_c integer, p_r integer, p_team text)
returns boolean language sql immutable set search_path = '' as $$
  select p_r = checkline_private.goal_row(p_team) and p_c between 1 and 6
$$;

-- Keeper box: columns B..G, two rows deep from the goal line.
create or replace function checkline_private.in_box(p_c integer, p_r integer, p_team text)
returns boolean language sql immutable set search_path = '' as $$
  select p_c between 1 and 6 and abs(p_r - checkline_private.goal_row(p_team)) < 2
$$;

create or replace function checkline_private.get_piece(p_state jsonb, p_id text)
returns jsonb language sql immutable set search_path = '' as $$
  select p from jsonb_array_elements(p_state -> 'pieces') p where p ->> 'id' = p_id limit 1
$$;

create or replace function checkline_private.piece_at(p_state jsonb, p_c integer, p_r integer)
returns jsonb language sql immutable set search_path = '' as $$
  select p from jsonb_array_elements(p_state -> 'pieces') p
  where jsonb_typeof(p -> 'pos') = 'object'
    and (p -> 'pos' ->> 'c')::integer = p_c
    and (p -> 'pos' ->> 'r')::integer = p_r
  limit 1
$$;

create or replace function checkline_private.set_pos(p_state jsonb, p_id text, p_pos jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_set(p_state, array['pieces', (idx - 1)::text, 'pos'], p_pos)
  from jsonb_array_elements(p_state -> 'pieces') with ordinality as t(p, idx)
  where t.p ->> 'id' = p_id
$$;

-- A goal square is covered when the defending keeper stands on it or next to it.
create or replace function checkline_private.covered(p_state jsonb, p_c integer, p_r integer, p_def text)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce((
    select greatest(abs((p -> 'pos' ->> 'c')::integer - p_c), abs((p -> 'pos' ->> 'r')::integer - p_r)) <= 1
    from jsonb_array_elements(p_state -> 'pieces') p
    where p ->> 'team' = p_def and p ->> 'kind' = 'king' and jsonb_typeof(p -> 'pos') = 'object'
    limit 1), false)
$$;

-- Formation (Team A view); Team B is mirrored by row.
create or replace function checkline_private.formation()
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_agg(
           jsonb_build_object(
             'id', t.team || '-' || f.slot,
             'team', t.team,
             'kind', f.kind,
             'pos', jsonb_build_object('c', f.c, 'r', case when t.team = 'A' then f.r else 11 - f.r end))
           order by t.ord, f.ord)
  from (values ('A', 1), ('B', 2)) as t(team, ord),
       (values ('K', 'king', 3, 0, 1), ('R1', 'rook', 2, 1, 2), ('R2', 'rook', 5, 1, 3),
               ('B', 'bishop', 4, 1, 4), ('P1', 'pawn', 1, 3, 5), ('P2', 'pawn', 6, 3, 6),
               ('Q', 'queen', 3, 3, 7), ('N', 'knight', 4, 3, 8)) as f(slot, kind, c, r, ord)
$$;

-- Kickoff: formation, the kicking side's Queen on its midfield square (D6 / D7), Surge refreshed.
create or replace function checkline_private.reset_rally(p_state jsonb, p_team text)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  v_s jsonb := p_state || jsonb_build_object('pieces', checkline_private.formation());
begin
  v_s := checkline_private.set_pos(v_s, p_team || '-Q',
           jsonb_build_object('c', 3, 'r', case when p_team = 'A' then 5 else 6 end));
  return v_s || jsonb_build_object('carrierId', p_team || '-Q', 'turn', p_team, 'kickoffTeam', p_team, 'ap', 3,
                                   'surge', jsonb_build_object('A', true, 'B', true));
end
$$;

create or replace function checkline_private.initial_state(p_first text)
returns jsonb language sql immutable set search_path = '' as $$
  select checkline_private.reset_rally(
    jsonb_build_object(
      'pieces', '[]'::jsonb, 'carrierId', '', 'turn', p_first, 'ap', 3,
      'score', jsonb_build_object('A', 0, 'B', 0), 'rally', 1, 'turnNumber', 1,
      'kickoffTeam', p_first, 'phase', 'playing', 'winner', null,
      'capturesBy', jsonb_build_object('A', 0, 'B', 0),
      'surge', jsonb_build_object('A', true, 'B', true)),
    p_first)
$$;

-- Where a piece can go (ignores turn/AP): options (o_blocked = false) and squares in its pattern
-- it cannot use (o_blocked = true) with the reason. Same algorithm as pieceMoves() in the client.
create or replace function checkline_private.piece_moves(p_state jsonb, p_piece jsonb)
returns table (o_c integer, o_r integer, o_kind text, o_scores boolean, o_blocked boolean, o_why jsonb)
language plpgsql immutable set search_path = '' as $$
declare
  v_team text := p_piece ->> 'team';
  v_opp text := checkline_private.other(p_piece ->> 'team');
  v_kind text := p_piece ->> 'kind';
  v_id text := p_piece ->> 'id';
  v_is_carrier boolean := (p_piece ->> 'id') = (p_state ->> 'carrierId');
  v_fc integer; v_fr integer; v_range integer; v_c integer; v_r integer; v_f integer;
  v_dirs integer[]; v_stopped boolean; v_occ jsonb; v_sq text;
  v_allow_tackle boolean; v_allow_move boolean;
begin
  if jsonb_typeof(p_piece -> 'pos') is distinct from 'object' then return; end if;
  v_fc := (p_piece -> 'pos' ->> 'c')::integer;
  v_fr := (p_piece -> 'pos' ->> 'r')::integer;
  v_f := case when v_team = 'A' then 1 else -1 end;
  -- Dribbling is slow: the ball carrier slides only one square.
  v_range := case when v_is_carrier then 1 else checkline_private.piece_range(v_kind) end;

  -- Candidate list as flat (dc, dr, slide, allowTackle, allowMove) tuples.
  for v_c, v_r, v_dirs in
    select d.dc, d.dr, array[d.slide, d.tackle, d.mv]
    from (
      select * from (values
        -- king / queen / rook / bishop directions (orth first, then diag) -- same order as the client
        ('king', 0, 1, 0, 1, 1, 1), ('king', 0, -1, 0, 1, 1, 2), ('king', -1, 0, 0, 1, 1, 3), ('king', 1, 0, 0, 1, 1, 4),
        ('king', -1, 1, 0, 1, 1, 5), ('king', 1, 1, 0, 1, 1, 6), ('king', -1, -1, 0, 1, 1, 7), ('king', 1, -1, 0, 1, 1, 8),
        ('queen', 0, 1, 1, 1, 1, 1), ('queen', 0, -1, 1, 1, 1, 2), ('queen', -1, 0, 1, 1, 1, 3), ('queen', 1, 0, 1, 1, 1, 4),
        ('queen', -1, 1, 1, 1, 1, 5), ('queen', 1, 1, 1, 1, 1, 6), ('queen', -1, -1, 1, 1, 1, 7), ('queen', 1, -1, 1, 1, 1, 8),
        ('rook', 0, 1, 1, 1, 1, 1), ('rook', 0, -1, 1, 1, 1, 2), ('rook', -1, 0, 1, 1, 1, 3), ('rook', 1, 0, 1, 1, 1, 4),
        ('bishop', -1, 1, 1, 1, 1, 1), ('bishop', 1, 1, 1, 1, 1, 2), ('bishop', -1, -1, 1, 1, 1, 3), ('bishop', 1, -1, 1, 1, 1, 4),
        ('knight', 1, 2, 0, 1, 1, 1), ('knight', 2, 1, 0, 1, 1, 2), ('knight', 2, -1, 0, 1, 1, 3), ('knight', 1, -2, 0, 1, 1, 4),
        ('knight', -1, -2, 0, 1, 1, 5), ('knight', -2, -1, 0, 1, 1, 6), ('knight', -2, 1, 0, 1, 1, 7), ('knight', -1, 2, 0, 1, 1, 8),
        -- pawn: forward / sideways moves (no tackle), then diagonal-forward tackles (no move)
        ('pawn', 0, 9, 0, 0, 1, 1), ('pawn', -1, 0, 0, 0, 1, 2), ('pawn', 1, 0, 0, 0, 1, 3),
        ('pawn', -1, 9, 0, 1, 0, 4), ('pawn', 1, 9, 0, 1, 0, 5)
      ) as x(kind, dc, dr, slide, tackle, mv, ord)
      where x.kind = v_kind order by x.ord
    ) d
  loop
    -- 9 is the placeholder for "forward" (pawns): +1 for Team A, -1 for Team B.
    if v_r = 9 then v_r := v_f; end if;
    v_allow_tackle := v_dirs[2] = 1;
    v_allow_move := v_dirs[3] = 1;
    v_stopped := false;
    for v_k in 1..(case when v_dirs[1] = 1 then v_range else 1 end) loop
      o_c := v_fc + v_c * v_k;
      o_r := v_fr + v_r * v_k;
      exit when o_c < 0 or o_c > 7 or o_r < 0 or o_r > 11;
      v_sq := checkline_private.sq(o_c, o_r);
      o_kind := null; o_scores := false; o_blocked := false; o_why := null;
      if v_stopped then
        o_blocked := true; o_why := checkline_private.reason('path_blocked', jsonb_build_object('sq', v_sq));
        return next; continue;
      end if;
      v_occ := checkline_private.piece_at(p_state, o_c, o_r);
      if v_occ is not null then
        v_stopped := true;
        -- Pawn diagonal squares only matter when the opposing carrier stands there.
        if not v_allow_move and not (v_occ ->> 'team' <> v_team and v_occ ->> 'id' = p_state ->> 'carrierId') then
          continue;
        end if;
        if v_occ ->> 'team' = v_team then
          o_blocked := true; o_why := checkline_private.reason('occupied_own', jsonb_build_object('kind', v_occ ->> 'kind', 'sq', v_sq));
        elsif v_occ ->> 'id' <> p_state ->> 'carrierId' then
          o_blocked := true; o_why := checkline_private.reason('opponent_blocks', jsonb_build_object('kind', v_occ ->> 'kind', 'sq', v_sq));
        elsif not v_allow_tackle then
          o_blocked := true; o_why := checkline_private.reason('pawn_tackle');
        elsif v_kind = 'king' and not checkline_private.in_box(o_c, o_r, v_team) then
          o_blocked := true; o_why := checkline_private.reason('keeper_box');
        else
          o_kind := 'tackle'; o_scores := checkline_private.in_goal_mouth(o_c, o_r, v_opp);
        end if;
        return next; continue;
      end if;
      if not v_allow_move then continue; end if;
      -- Landing rules for an empty square.
      if v_kind = 'king' and not checkline_private.in_box(o_c, o_r, v_team) then
        o_blocked := true; o_why := checkline_private.reason('keeper_box');
      elsif checkline_private.in_goal_mouth(o_c, o_r, v_team) and v_kind <> 'king' then
        o_blocked := true; o_why := checkline_private.reason('goal_mouth');
      elsif checkline_private.in_goal_mouth(o_c, o_r, v_opp) then
        if not v_is_carrier then
          o_blocked := true; o_why := checkline_private.reason('goal_mouth');
        elsif checkline_private.covered(p_state, o_c, o_r, v_opp) then
          o_blocked := true; o_why := checkline_private.reason('covered_by_keeper', jsonb_build_object('sq', v_sq));
        else
          o_kind := 'move'; o_scores := true;
        end if;
      else
        o_kind := 'move';
      end if;
      return next;
    end loop;
  end loop;
end
$$;

-- Why a piece cannot act right now (null if it can).
create or replace function checkline_private.unavailable(p_state jsonb, p_piece jsonb, p_cost integer)
returns jsonb language sql immutable set search_path = '' as $$
  select case
    when p_piece is null then checkline_private.reason('unknown_piece')
    when p_state ->> 'phase' = 'finished' then checkline_private.reason('match_over')
    when p_piece ->> 'team' <> p_state ->> 'turn'
      then checkline_private.reason('not_your_turn', jsonb_build_object('team', p_state ->> 'turn'))
    when jsonb_typeof(p_piece -> 'pos') is distinct from 'object' then checkline_private.reason('captured')
    when (p_state ->> 'ap')::integer < p_cost then checkline_private.reason('no_ap')
  end
$$;

-- First piece strictly between two squares on a straight line (null if clear).
create or replace function checkline_private.first_blocker(p_state jsonb, p_c integer, p_r integer, p_dc integer, p_dr integer, p_dist integer)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare v_p jsonb;
begin
  for v_k in 1..(p_dist - 1) loop
    v_p := checkline_private.piece_at(p_state, p_c + p_dc * v_k, p_r + p_dr * v_k);
    if v_p is not null then return v_p; end if;
  end loop;
  return null;
end
$$;

-- Match clock: full time, golden goal, draw. Appends events; returns {state, events}.
create or replace function checkline_private.clock_check(p_state jsonb, p_events jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  v_s jsonb := p_state;
  v_ev jsonb := p_events;
  v_done integer := (p_state ->> 'turnNumber')::integer - 1;
  v_a integer := (p_state -> 'score' ->> 'A')::integer;
  v_b integer := (p_state -> 'score' ->> 'B')::integer;
  v_lead text := case when v_a = v_b then null when v_a > v_b then 'A' else 'B' end;
begin
  if v_s ->> 'phase' = 'finished' then return jsonb_build_object('state', v_s, 'events', v_ev); end if;
  if v_done >= 30 and v_lead is not null then
    v_s := v_s || jsonb_build_object('phase', 'finished', 'winner', v_lead, 'ap', 0);
    v_ev := v_ev || jsonb_build_array(jsonb_build_object('type', 'fullTime', 'winner', v_lead));
  elsif v_done >= 40 then
    v_s := v_s || jsonb_build_object('phase', 'finished', 'winner', null, 'ap', 0);
    v_ev := v_ev || jsonb_build_array(jsonb_build_object('type', 'fullTime', 'winner', null));
  elsif v_done = 30 then
    v_ev := v_ev || jsonb_build_array(jsonb_build_object('type', 'goldenGoal'));
  end if;
  return jsonb_build_object('state', v_s, 'events', v_ev);
end
$$;

-- A goal for p_team: win at 3 goals or in golden goal, otherwise reset the rally (+ clock).
create or replace function checkline_private.score_goal(p_state jsonb, p_team text, p_scorer text, p_events jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  v_s jsonb := p_state;
  v_ev jsonb := p_events;
  v_goals integer := (p_state -> 'score' ->> p_team)::integer + 1;
  v_golden boolean := (p_state ->> 'turnNumber')::integer - 1 >= 30;
  v_opp text := checkline_private.other(p_team);
begin
  v_s := jsonb_set(v_s, array['score', p_team], to_jsonb(v_goals));
  v_ev := v_ev || jsonb_build_array(jsonb_build_object('type', 'goal', 'team', p_team, 'score', v_s -> 'score', 'carrierId', p_scorer));
  if v_goals >= 3 or v_golden then
    v_s := v_s || jsonb_build_object('phase', 'finished', 'winner', p_team, 'ap', 0);
    v_ev := v_ev || jsonb_build_array(jsonb_build_object('type', 'win', 'team', p_team));
    return jsonb_build_object('ok', true, 'state', v_s, 'events', v_ev);
  end if;
  v_s := v_s || jsonb_build_object('rally', (v_s ->> 'rally')::integer + 1, 'turnNumber', (v_s ->> 'turnNumber')::integer + 1);
  v_s := checkline_private.reset_rally(v_s, v_opp);
  v_ev := v_ev || jsonb_build_array(jsonb_build_object('type', 'kickoff', 'team', v_opp, 'carrierId', v_opp || '-Q'));
  return jsonb_build_object('ok', true) || checkline_private.clock_check(v_s, v_ev);
end
$$;

-- Apply one action. Returns {ok:true,state,events} or {ok:false,why:{code,params}}.
-- Mirrors applyAction() in src/rules/engine.ts, including the order of checks.
create or replace function checkline_private.apply_action(p_state jsonb, p_action jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  v_s jsonb := p_state;
  v_type text := p_action ->> 'type';
  v_team text; v_ap integer; v_opp text;
  v_piece jsonb; v_from jsonb; v_mate jsonb; v_victim jsonb; v_blocker jsonb; v_marker jsonb;
  v_un jsonb; v_blocked jsonb; v_ev jsonb;
  v_to_c integer; v_to_r integer; v_dc integer; v_dr integer; v_dist integer; v_fc integer; v_fr integer;
  v_opt record;
begin
  if v_s ->> 'phase' = 'finished' then
    return jsonb_build_object('ok', false, 'why', checkline_private.reason('match_over'));
  end if;

  if v_type = 'endTurn' then
    v_team := v_s ->> 'turn';
    v_ap := (v_s ->> 'ap')::integer;
    v_s := v_s || jsonb_build_object('turn', checkline_private.other(v_team), 'ap', 3,
                                     'turnNumber', (v_s ->> 'turnNumber')::integer + 1);
    return jsonb_build_object('ok', true) || checkline_private.clock_check(v_s, jsonb_build_array(jsonb_build_object(
             'type', 'turnEnd', 'team', v_team, 'apLost', v_ap, 'next', checkline_private.other(v_team))));
  end if;

  if v_type = 'surge' then
    v_team := v_s ->> 'turn';
    if not coalesce((v_s -> 'surge' ->> v_team)::boolean, false) then
      return jsonb_build_object('ok', false, 'why', checkline_private.reason('no_surge'));
    end if;
    v_s := jsonb_set(v_s, array['surge', v_team], 'false'::jsonb);
    v_s := v_s || jsonb_build_object('ap', (v_s ->> 'ap')::integer + 1);
    return jsonb_build_object('ok', true, 'state', v_s, 'events', jsonb_build_array(jsonb_build_object('type', 'surge', 'team', v_team)));
  end if;

  if v_type = 'move' then
    v_piece := checkline_private.get_piece(v_s, p_action ->> 'pieceId');
    if v_piece is null then
      return jsonb_build_object('ok', false, 'why', checkline_private.reason('unknown_piece'));
    end if;
    if jsonb_typeof(p_action -> 'to' -> 'c') is distinct from 'number'
       or jsonb_typeof(p_action -> 'to' -> 'r') is distinct from 'number'
       or abs((p_action -> 'to' ->> 'c')::numeric) > 1000 or abs((p_action -> 'to' ->> 'r')::numeric) > 1000
       or (p_action -> 'to' ->> 'c')::numeric % 1 <> 0 or (p_action -> 'to' ->> 'r')::numeric % 1 <> 0 then
      return jsonb_build_object('ok', false, 'why', checkline_private.reason('unknown_action'));
    end if;
    v_to_c := (p_action -> 'to' ->> 'c')::integer;
    v_to_r := (p_action -> 'to' ->> 'r')::integer;
    v_un := checkline_private.unavailable(v_s, v_piece, 1);
    select * into v_opt from checkline_private.piece_moves(v_s, v_piece) m
      where not m.o_blocked and m.o_c = v_to_c and m.o_r = v_to_r limit 1;
    if not found then
      if v_un is not null then return jsonb_build_object('ok', false, 'why', v_un); end if;
      select m.o_why into v_blocked from checkline_private.piece_moves(v_s, v_piece) m
        where m.o_blocked and m.o_c = v_to_c and m.o_r = v_to_r limit 1;
      if v_blocked is not null then return jsonb_build_object('ok', false, 'why', v_blocked); end if;
      return jsonb_build_object('ok', false, 'why', checkline_private.reason('cannot_reach', jsonb_build_object(
               'mover', v_piece ->> 'kind',
               'sq', case when v_to_c between 0 and 7 and v_to_r between 0 and 11
                          then checkline_private.sq(v_to_c, v_to_r) else '?' end)));
    end if;
    if v_un is not null then return jsonb_build_object('ok', false, 'why', v_un); end if;

    v_team := v_piece ->> 'team';
    if v_opt.o_kind = 'tackle' then
      v_victim := checkline_private.get_piece(v_s, v_s ->> 'carrierId');
      v_s := checkline_private.set_pos(v_s, v_victim ->> 'id', 'null'::jsonb);
      v_s := checkline_private.set_pos(v_s, v_piece ->> 'id', jsonb_build_object('c', v_to_c, 'r', v_to_r));
      v_s := v_s || jsonb_build_object('carrierId', v_piece ->> 'id');
      v_s := jsonb_set(v_s, array['capturesBy', v_team], to_jsonb((v_s -> 'capturesBy' ->> v_team)::integer + 1));
      v_ev := jsonb_build_array(jsonb_build_object(
                'type', 'tackle', 'pieceId', v_piece ->> 'id', 'capturedId', v_victim ->> 'id',
                'at', jsonb_build_object('c', v_to_c, 'r', v_to_r)));
    else
      v_s := checkline_private.set_pos(v_s, v_piece ->> 'id', jsonb_build_object('c', v_to_c, 'r', v_to_r));
      v_ev := jsonb_build_array(jsonb_build_object('type', 'move', 'pieceId', v_piece ->> 'id', 'from', v_piece -> 'pos',
                                                   'to', jsonb_build_object('c', v_to_c, 'r', v_to_r)));
    end if;
    v_s := v_s || jsonb_build_object('ap', (v_s ->> 'ap')::integer - 1);
    if v_opt.o_scores then
      return checkline_private.score_goal(v_s, v_team, v_piece ->> 'id', v_ev);
    end if;
    return jsonb_build_object('ok', true, 'state', v_s, 'events', v_ev);
  end if;

  if v_type = 'pass' then
    if (p_action ->> 'fromId') is distinct from (v_s ->> 'carrierId') then
      return jsonb_build_object('ok', false, 'why', checkline_private.reason('only_carrier'));
    end if;
    v_from := checkline_private.get_piece(v_s, v_s ->> 'carrierId');
    v_un := checkline_private.unavailable(v_s, v_from, 1);
    if v_un is not null then return jsonb_build_object('ok', false, 'why', v_un); end if;
    v_mate := checkline_private.get_piece(v_s, p_action ->> 'toId');
    if v_mate is null or v_mate ->> 'team' <> v_from ->> 'team' or v_mate ->> 'id' = v_from ->> 'id'
       or jsonb_typeof(v_mate -> 'pos') is distinct from 'object' then
      return jsonb_build_object('ok', false, 'why', checkline_private.reason('pass_invalid_receiver'));
    end if;
    v_fc := (v_from -> 'pos' ->> 'c')::integer; v_fr := (v_from -> 'pos' ->> 'r')::integer;
    v_dc := (v_mate -> 'pos' ->> 'c')::integer - v_fc;
    v_dr := (v_mate -> 'pos' ->> 'r')::integer - v_fr;
    if (v_dc <> 0 and v_dr <> 0 and abs(v_dc) <> abs(v_dr)) then
      return jsonb_build_object('ok', false, 'why', checkline_private.reason('pass_invalid_receiver'));
    end if;
    v_dist := greatest(abs(v_dc), abs(v_dr));
    if v_dist > 4 then
      return jsonb_build_object('ok', false, 'why', checkline_private.reason('pass_out_of_range',
               jsonb_build_object('kind', v_mate ->> 'kind', 'dist', v_dist, 'range', 4)));
    end if;
    v_blocker := checkline_private.first_blocker(v_s, v_fc, v_fr, sign(v_dc)::integer, sign(v_dr)::integer, v_dist);
    if v_blocker is not null then
      return jsonb_build_object('ok', false, 'why', checkline_private.reason('pass_lane_blocked', jsonb_build_object(
               'kind', v_blocker ->> 'kind',
               'sq', checkline_private.sq((v_blocker -> 'pos' ->> 'c')::integer, (v_blocker -> 'pos' ->> 'r')::integer),
               'team', v_blocker ->> 'team')));
    end if;
    -- Marking: an opponent directly beside the receiver (not diagonal) stops the pass.
    select p into v_marker from jsonb_array_elements(v_s -> 'pieces') p
      where p ->> 'team' <> v_mate ->> 'team' and jsonb_typeof(p -> 'pos') = 'object'
        and abs((p -> 'pos' ->> 'c')::integer - (v_mate -> 'pos' ->> 'c')::integer)
          + abs((p -> 'pos' ->> 'r')::integer - (v_mate -> 'pos' ->> 'r')::integer) = 1
      limit 1;
    if v_marker is not null then
      return jsonb_build_object('ok', false, 'why', checkline_private.reason('receiver_marked', jsonb_build_object(
               'kind', v_mate ->> 'kind',
               'sq', checkline_private.sq((v_mate -> 'pos' ->> 'c')::integer, (v_mate -> 'pos' ->> 'r')::integer))));
    end if;
    v_s := v_s || jsonb_build_object('carrierId', v_mate ->> 'id', 'ap', (v_s ->> 'ap')::integer - 1);
    return jsonb_build_object('ok', true, 'state', v_s, 'events', jsonb_build_array(jsonb_build_object(
             'type', 'pass', 'fromId', v_from ->> 'id', 'toId', v_mate ->> 'id')));
  end if;

  if v_type = 'shoot' then
    if (p_action ->> 'fromId') is distinct from (v_s ->> 'carrierId') then
      return jsonb_build_object('ok', false, 'why', checkline_private.reason('only_carrier'));
    end if;
    v_from := checkline_private.get_piece(v_s, v_s ->> 'carrierId');
    v_un := checkline_private.unavailable(v_s, v_from, 1);
    if v_un is not null then return jsonb_build_object('ok', false, 'why', v_un); end if;
    if jsonb_typeof(p_action -> 'to' -> 'c') is distinct from 'number'
       or jsonb_typeof(p_action -> 'to' -> 'r') is distinct from 'number'
       or abs((p_action -> 'to' ->> 'c')::numeric) > 1000 or abs((p_action -> 'to' ->> 'r')::numeric) > 1000
       or (p_action -> 'to' ->> 'c')::numeric % 1 <> 0 or (p_action -> 'to' ->> 'r')::numeric % 1 <> 0 then
      return jsonb_build_object('ok', false, 'why', checkline_private.reason('unknown_action'));
    end if;
    v_to_c := (p_action -> 'to' ->> 'c')::integer;
    v_to_r := (p_action -> 'to' ->> 'r')::integer;
    v_team := v_from ->> 'team';
    v_opp := checkline_private.other(v_team);
    if not checkline_private.in_goal_mouth(v_to_c, v_to_r, v_opp) then
      return jsonb_build_object('ok', false, 'why', checkline_private.reason('shot_not_goal'));
    end if;
    v_fc := (v_from -> 'pos' ->> 'c')::integer; v_fr := (v_from -> 'pos' ->> 'r')::integer;
    v_dc := v_to_c - v_fc; v_dr := v_to_r - v_fr;
    if (v_dc = 0 and v_dr = 0) or (v_dc <> 0 and v_dr <> 0 and abs(v_dc) <> abs(v_dr)) then
      return jsonb_build_object('ok', false, 'why', checkline_private.reason('not_in_line'));
    end if;
    v_dist := greatest(abs(v_dc), abs(v_dr));
    if v_dist > 5 then
      return jsonb_build_object('ok', false, 'why', checkline_private.reason('shot_out_of_range',
               jsonb_build_object('dist', v_dist, 'range', 5)));
    end if;
    v_blocker := checkline_private.first_blocker(v_s, v_fc, v_fr, sign(v_dc)::integer, sign(v_dr)::integer, v_dist);
    if v_blocker is not null then
      return jsonb_build_object('ok', false, 'why', checkline_private.reason('shot_blocked', jsonb_build_object(
               'kind', v_blocker ->> 'kind',
               'sq', checkline_private.sq((v_blocker -> 'pos' ->> 'c')::integer, (v_blocker -> 'pos' ->> 'r')::integer))));
    end if;
    if checkline_private.piece_at(v_s, v_to_c, v_to_r) is not null or checkline_private.covered(v_s, v_to_c, v_to_r, v_opp) then
      return jsonb_build_object('ok', false, 'why', checkline_private.reason('covered_by_keeper',
               jsonb_build_object('sq', checkline_private.sq(v_to_c, v_to_r))));
    end if;
    v_s := v_s || jsonb_build_object('ap', (v_s ->> 'ap')::integer - 1);
    return checkline_private.score_goal(v_s, v_team, v_from ->> 'id', jsonb_build_array(jsonb_build_object(
             'type', 'shot', 'fromId', v_from ->> 'id', 'from', v_from -> 'pos',
             'to', jsonb_build_object('c', v_to_c, 'r', v_to_r))));
  end if;

  return jsonb_build_object('ok', false, 'why', checkline_private.reason('unknown_action'));
end
$$;

-- -------------------------------------------------------------------------------------
-- 3. Internal helpers
-- -------------------------------------------------------------------------------------

create or replace function checkline_private.require_uid()
returns uuid language plpgsql stable set search_path = '' as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'CL:not_signed_in'; end if;
  return v_uid;
end
$$;

-- The C-rank tier for a number of points, read from public.rank_tiers (never stored).
create or replace function checkline_private.rank_json(p_points integer)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'tier', t.code,
    'rankPoints', greatest(coalesce(p_points, 0), 0),
    'tierMin', t.min_points,
    'nextTierAt', (select min(n.min_points) from public.rank_tiers n where n.min_points > t.min_points))
  from public.rank_tiers t
  where t.min_points <= greatest(coalesce(p_points, 0), 0)
  order by t.min_points desc
  limit 1
$$;

-- Public player card (no email, no coins). p_private adds the player's own email.
drop function if exists checkline_private.profile_json(uuid);
create or replace function checkline_private.profile_json(p_id uuid, p_private boolean default false)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', p.id, 'displayName', p.username, 'rating', p.rating,
                            'wins', p.wins, 'draws', p.draws, 'losses', p.losses, 'games', p.games,
                            'rankedGames', p.ranked_games, 'isGuest', p.is_guest)
         || coalesce(checkline_private.rank_json(p.rank_points), '{}'::jsonb)
         || case when p_private then jsonb_build_object('email', p.email) else '{}'::jsonb end
  from public."user" p where p.id = p_id
$$;

-- The JSON shape every match RPC returns (consumed by src/online/backend.ts).
create or replace function checkline_private.match_view(p_match public.cl_matches)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', p_match.id,
    'code', p_match.code,
    'status', p_match.status,
    'isPublic', p_match.is_public,
    'rulesVersion', p_match.rules_version,
    'playerA', (select jsonb_build_object('id', p.id, 'name', p.username, 'rating', p.rating,
                                          'tier', checkline_private.rank_json(p.rank_points) ->> 'tier')
                from public."user" p where p.id = p_match.player_a),
    'playerB', (select jsonb_build_object('id', p.id, 'name', p.username, 'rating', p.rating,
                                          'tier', checkline_private.rank_json(p.rank_points) ->> 'tier')
                from public."user" p where p.id = p_match.player_b),
    'state', p_match.state,
    'version', p_match.version,
    'lastAction', p_match.last_action,
    'lastEvents', p_match.last_events,
    'lastActor', p_match.last_actor,
    'winnerId', p_match.winner_id,
    'endReason', p_match.end_reason,
    'aSeenAt', p_match.a_seen_at,
    'bSeenAt', p_match.b_seen_at,
    'turnStartedAt', p_match.turn_started_at,
    'createdAt', p_match.created_at,
    'startedAt', p_match.started_at,
    'finishedAt', p_match.finished_at,
    'serverNow', now(),
    'result', (select jsonb_build_object(
                 'winnerId', r.winner_id, 'reason', r.reason,
                 'aRatingBefore', r.a_rating_before, 'aRatingAfter', r.a_rating_after,
                 'bRatingBefore', r.b_rating_before, 'bRatingAfter', r.b_rating_after,
                 'ranked', r.ranked, 'rankNote', r.rank_note,
                 'aPointsBefore', r.a_points_before, 'aPointsAfter', r.a_points_after,
                 'bPointsBefore', r.b_points_before, 'bPointsAfter', r.b_points_after,
                 'aCoins', r.a_coins, 'bCoins', r.b_coins)
               from public.cl_match_results r where r.match_id = p_match.id))
$$;

-- Change a player's coins and write the matching coin_transactions row, atomically.
-- Raises CL:too_poor instead of ever letting the balance go below zero.
create or replace function checkline_private.change_coins(p_uid uuid, p_amount integer, p_kind text,
  p_match uuid default null, p_item text default null, p_note text default null, p_actor text default 'server')
returns integer language plpgsql security definer set search_path = '' as $$
declare v_balance integer;
begin
  select coins into v_balance from public."user" where id = p_uid for update;
  if not found then raise exception 'CL:profile_required'; end if;
  if coalesce(p_amount, 0) = 0 then return v_balance; end if;
  if v_balance + p_amount < 0 then raise exception 'CL:too_poor'; end if;
  perform set_config('checkline.coin_ledger', 'on', true);   -- tells the audit trigger this change is logged here
  update public."user" set coins = coins + p_amount where id = p_uid returning coins into v_balance;
  perform set_config('checkline.coin_ledger', 'off', true);
  insert into public.coin_transactions (user_id, amount, balance_after, kind, match_id, item, note, actor)
  values (p_uid, p_amount, v_balance, p_kind, p_match, p_item, p_note, coalesce(p_actor, 'server'));
  return v_balance;
end
$$;

-- Score a finished match exactly once, in one transaction: result row, Elo, C-rank points,
-- record and coins. The insert into cl_match_results (primary key match_id) is the gate:
-- if the match was already scored, nothing else happens.
--
-- Elo (K = 32, unchanged from v0.3): E_a = 1 / (1 + 10^((R_b - R_a) / 400)); S = 1 / 0.5 / 0;
--   change = round(32 * (S_a - E_a)); A gains `change`, B loses the same (zero-sum). Every
--   finished online match, guests included. Elo orders the leaderboard.
-- C-rank points (the visible C5..C1 ladder), only between two registered (non-guest) players:
--   win +10, loss -6 (never below 0), draw 0. Anti-abuse:
--   * the winner gains nothing if the match was over before turn 6 (resign / forfeit early),
--     but the player who quit still loses 6 - so quitting never dodges a loss;
--   * the winner gains nothing from the same opponent more than 3 times in 24 hours.
-- Coins: +3 for a win, +5 on every 3rd finished online match, only for matches that were
--   actually played (ended by goals / clock / draw, or reached turn 6).
create or replace function checkline_private.finalize_match(p_match public.cl_matches)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_a public."user";
  v_b public."user";
  v_expected numeric;
  v_score numeric;
  v_change integer;
  v_played boolean;
  v_ranked boolean;
  v_note text;
  v_loser uuid;
  v_gain integer;
  v_a_delta integer := 0;
  v_b_delta integer := 0;
  v_a_coins integer := 0;
  v_b_coins integer := 0;
begin
  if p_match.status <> 'finished' or p_match.player_b is null or p_match.end_reason is null then return; end if;
  perform 1 from public."user" where id in (p_match.player_a, p_match.player_b) order by id for update;
  select * into v_a from public."user" where id = p_match.player_a;
  select * into v_b from public."user" where id = p_match.player_b;

  -- Elo
  v_expected := 1 / (1 + power(10::numeric, (v_b.rating - v_a.rating)::numeric / 400));
  v_score := case when p_match.winner_id is null then 0.5 when p_match.winner_id = v_a.id then 1 else 0 end;
  v_change := round(32 * (v_score - v_expected));

  -- Was the match really played?
  v_played := p_match.end_reason in ('goals', 'clock', 'draw')
              or coalesce((p_match.state ->> 'turnNumber')::integer, 0) >= 6;

  -- C-rank points
  v_ranked := not v_a.is_guest and not v_b.is_guest;
  if not v_ranked then
    v_note := 'guest';
  elsif p_match.winner_id is not null then
    v_loser := case when p_match.winner_id = v_a.id then v_b.id else v_a.id end;
    if not v_played then
      v_note := 'short_match';
    elsif (select count(*) from public.cl_match_results r
           where r.ranked and r.created_at > now() - interval '24 hours'
             and r.winner_id = p_match.winner_id and v_loser in (r.player_a, r.player_b)
             and case when r.player_a = p_match.winner_id then r.a_points_after - r.a_points_before
                      else r.b_points_after - r.b_points_before end > 0) >= 3 then
      v_note := 'repeat_opponent';
    end if;
    v_gain := case when v_note is null then 10 else 0 end;
    if p_match.winner_id = v_a.id then v_a_delta := v_gain; v_b_delta := -6;
    else v_b_delta := v_gain; v_a_delta := -6; end if;
  end if;

  -- Coins
  if v_played then
    v_a_coins := case when p_match.winner_id = v_a.id then 3 else 0 end + case when (v_a.games + 1) % 3 = 0 then 5 else 0 end;
    v_b_coins := case when p_match.winner_id = v_b.id then 3 else 0 end + case when (v_b.games + 1) % 3 = 0 then 5 else 0 end;
  end if;

  insert into public.cl_match_results (match_id, player_a, player_b, winner_id, reason,
    a_rating_before, a_rating_after, b_rating_before, b_rating_after, score_a, score_b,
    ranked, rank_note, a_points_before, a_points_after, b_points_before, b_points_after, a_coins, b_coins)
  values (p_match.id, v_a.id, v_b.id, p_match.winner_id, p_match.end_reason,
    v_a.rating, v_a.rating + v_change, v_b.rating, v_b.rating - v_change,
    coalesce((p_match.state -> 'score' ->> 'A')::integer, 0), coalesce((p_match.state -> 'score' ->> 'B')::integer, 0),
    v_ranked, v_note,
    v_a.rank_points, greatest(v_a.rank_points + v_a_delta, 0), v_b.rank_points, greatest(v_b.rank_points + v_b_delta, 0),
    v_a_coins, v_b_coins)
  on conflict (match_id) do nothing;
  if not found then return; end if;  -- already scored

  update public."user" set
    rating = rating + v_change, games = games + 1,
    wins = wins + case when v_score = 1 then 1 else 0 end,
    draws = draws + case when v_score = 0.5 then 1 else 0 end,
    losses = losses + case when v_score = 0 then 1 else 0 end,
    rank_points = greatest(rank_points + v_a_delta, 0),
    ranked_games = ranked_games + case when v_ranked then 1 else 0 end,
    rank_updated_at = case when v_a_delta <> 0 then now() else rank_updated_at end,
    rating_updated_at = case when v_change <> 0 then now() else rating_updated_at end
  where id = v_a.id;
  update public."user" set
    rating = rating - v_change, games = games + 1,
    wins = wins + case when v_score = 0 then 1 else 0 end,
    draws = draws + case when v_score = 0.5 then 1 else 0 end,
    losses = losses + case when v_score = 1 then 1 else 0 end,
    rank_points = greatest(rank_points + v_b_delta, 0),
    ranked_games = ranked_games + case when v_ranked then 1 else 0 end,
    rank_updated_at = case when v_b_delta <> 0 then now() else rank_updated_at end,
    rating_updated_at = case when v_change <> 0 then now() else rating_updated_at end
  where id = v_b.id;

  perform checkline_private.change_coins(v_a.id, v_a_coins, 'match_reward', p_match.id, null, 'Online match', 'server');
  perform checkline_private.change_coins(v_b.id, v_b_coins, 'match_reward', p_match.id, null, 'Online match', 'server');
end
$$;

-- Turn clock: every online turn lasts 25 seconds (src/online/backend.ts TURN_SECONDS), plus
-- 3 seconds of grace for network delay and the move animation (TURN_GRACE_SECONDS). The
-- deadline is counted from turn_started_at, which is reset only when a new turn begins
-- (commit_action), never by an action inside the turn, and always with the server's clock.
create or replace function checkline_private.turn_deadline(p_m public.cl_matches)
returns timestamptz language sql stable set search_path = '' as $$
  select coalesce(p_m.turn_started_at, p_m.started_at, p_m.updated_at) + interval '28 seconds'
$$;

-- End the current turn of a locked, active match if its deadline has passed (exactly what
-- End turn does: unused AP are lost). Returns the match unchanged otherwise, so calling it
-- twice, or from two places at once (the row is locked), ends a turn only once.
create or replace function checkline_private.expire_turn(p_m public.cl_matches)
returns public.cl_matches language plpgsql set search_path = '' as $$
declare
  v_idle text := p_m.state ->> 'turn';
  v_action jsonb := jsonb_build_object('type', 'endTurn', 'timeout', true);
  v_res jsonb;
begin
  if p_m.status <> 'active' or p_m.rules_version <> 3 or p_m.state is null
     or now() < checkline_private.turn_deadline(p_m) then
    return p_m;
  end if;
  v_res := checkline_private.apply_action(p_m.state, v_action);
  if not (v_res ->> 'ok')::boolean then return p_m; end if;
  return checkline_private.commit_action(p_m, case when v_idle = 'A' then p_m.player_a else p_m.player_b end,
                                         v_idle, v_action, v_res, false);
end
$$;

-- Lock a match row and check the caller takes part in it.
create or replace function checkline_private.lock_my_match(p_match_id uuid, p_uid uuid)
returns public.cl_matches language plpgsql set search_path = '' as $$
declare v_m public.cl_matches;
begin
  select * into v_m from public.cl_matches where id = p_match_id for update;
  if not found or p_uid not in (v_m.player_a, coalesce(v_m.player_b, '00000000-0000-0000-0000-000000000000'::uuid)) then
    raise exception 'CL:match_not_found';
  end if;
  return v_m;
end
$$;

-- Apply a validated engine result to a locked match row: store state, log the move, keep the
-- turn timer and finish + score the match when the engine says it is over.
create or replace function checkline_private.commit_action(p_m public.cl_matches, p_actor uuid, p_team text, p_action jsonb, p_res jsonb, p_present boolean default true)
returns public.cl_matches language plpgsql set search_path = '' as $$
declare
  v_m public.cl_matches;
  v_state jsonb := p_res -> 'state';
begin
  update public.cl_matches set
    state = v_state, version = version + 1,
    last_action = p_action, last_events = p_res -> 'events', last_actor = p_actor,
    a_seen_at = case when p_present and p_team = 'A' then now() else a_seen_at end,
    b_seen_at = case when p_present and p_team = 'B' then now() else b_seen_at end,
    turn_started_at = case when v_state ->> 'turn' is distinct from p_m.state ->> 'turn'
                           or (v_state ->> 'turnNumber') is distinct from (p_m.state ->> 'turnNumber')
                           then now() else turn_started_at end,
    updated_at = now()
  where id = p_m.id returning * into v_m;

  insert into public.cl_match_moves (match_id, seq, player_id, team, action, events)
  values (v_m.id, v_m.version, case when p_team = 'A' then v_m.player_a else v_m.player_b end, p_team, p_action, p_res -> 'events');

  if v_state ->> 'phase' = 'finished' then
    update public.cl_matches set status = 'finished', finished_at = now(),
      winner_id = case v_state ->> 'winner' when 'A' then player_a when 'B' then player_b else null end,
      end_reason = case
        when v_state ->> 'winner' is null then 'draw'
        when exists (select 1 from jsonb_array_elements(p_res -> 'events') e where e ->> 'type' = 'win') then 'goals'
        else 'clock' end
    where id = v_m.id returning * into v_m;
    perform checkline_private.finalize_match(v_m);
  end if;
  return v_m;
end
$$;

-- Coins, items and equipped cosmetics of one player, plus the live price list.
create or replace function checkline_private.wallet_json(p_uid uuid)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'coins', u.coins, 'matches', u.games, 'wins', u.wins,
    'floor', u.equipped_floor, 'skin', u.equipped_skin, 'ball', u.equipped_ball,
    'owned', coalesce((select jsonb_agg(c.kind || ':' || c.item_id order by c.kind, c.item_id)
                       from public.user_cosmetics c where c.user_id = u.id), '[]'::jsonb),
    'prices', coalesce((select jsonb_object_agg(k.kind || ':' || k.id, k.price)
                        from public.cosmetics k where k.active), '{}'::jsonb)
              || coalesce((select jsonb_object_agg('bundle:' || b.id, b.price)
                           from public.bundles b where b.active), '{}'::jsonb))
  from public."user" u where u.id = p_uid
$$;

-- -------------------------------------------------------------------------------------
-- 4. Client API (RPC). Errors are raised as 'CL:<code>' and translated by the client.
-- -------------------------------------------------------------------------------------

-- Is a username free? Used by the sign-up form before the account exists.
create or replace function public.cl_name_available(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select not exists (
    select 1 from public."user" p
    where lower(btrim(p.username)) = lower(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')))
      and p.id is distinct from auth.uid())
$$;

-- Create or rename your own player row. Only the username can be set by the player.
create or replace function public.cl_upsert_profile(p_display_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := checkline_private.require_uid();
  v_name text := btrim(regexp_replace(coalesce(p_display_name, ''), '\s+', ' ', 'g'));
begin
  if char_length(v_name) < 2 or char_length(v_name) > 24 or v_name ~ '[[:cntrl:]]' then
    raise exception 'CL:invalid_name';
  end if;
  begin
    insert into public."user" (id, username, email, is_guest)
    select a.id, v_name, a.email, coalesce(a.is_anonymous, false) from auth.users a where a.id = v_uid
    on conflict (id) do update set username = excluded.username;
  exception when unique_violation then
    raise exception 'CL:name_taken';
  end;
  if not found then raise exception 'CL:not_signed_in'; end if;
  return checkline_private.profile_json(v_uid, true);
end
$$;

create or replace function public.cl_get_my_profile()
returns jsonb language sql stable security definer set search_path = '' as $$
  select checkline_private.profile_json(auth.uid(), true)
$$;

-- Open a match. Public matches are listed in the lobby; private ones are joined by code only.
-- A player has at most one waiting match; calling again returns it.
create or replace function public.cl_create_match(p_is_public boolean default true)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := checkline_private.require_uid();
  v_m public.cl_matches;
  v_code text;
begin
  if not exists (select 1 from public."user" where id = v_uid) then raise exception 'CL:profile_required'; end if;
  select * into v_m from public.cl_matches
    where player_a = v_uid and status = 'waiting' order by created_at desc limit 1 for update;
  if found then
    update public.cl_matches set is_public = coalesce(p_is_public, true), a_seen_at = now(),
           created_at = now(), updated_at = now(), rules_version = 3
     where id = v_m.id returning * into v_m;
    return checkline_private.match_view(v_m);
  end if;
  for v_attempt in 1..20 loop
    v_code := '';
    for v_i in 1..6 loop
      v_code := v_code || substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + floor(random() * 32)::integer, 1);
    end loop;
    begin
      insert into public.cl_matches (code, is_public, player_a, rules_version)
      values (v_code, coalesce(p_is_public, true), v_uid, 3) returning * into v_m;
      return checkline_private.match_view(v_m);
    exception when unique_violation then
      -- code collision: try another
    end;
  end loop;
  raise exception 'CL:try_again';
end
$$;

-- Join by invite code (also used for lobby joins). Rejoining your own active match is allowed.
create or replace function public.cl_join_match(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := checkline_private.require_uid();
  v_m public.cl_matches;
  v_first text;
begin
  if not exists (select 1 from public."user" where id = v_uid) then raise exception 'CL:profile_required'; end if;
  select * into v_m from public.cl_matches where code = upper(btrim(coalesce(p_code, ''))) for update;
  if not found then raise exception 'CL:match_not_found'; end if;
  if v_m.player_a = v_uid or v_m.player_b = v_uid then
    if v_m.status = 'waiting' then raise exception 'CL:own_match'; end if;
    return checkline_private.match_view(v_m);
  end if;
  if v_m.status <> 'waiting' then raise exception 'CL:match_unavailable'; end if;
  if v_m.created_at < now() - interval '24 hours' then raise exception 'CL:match_expired'; end if;
  v_first := case when random() < 0.5 then 'A' else 'B' end;   -- coin toss for the opening kickoff
  update public.cl_matches set
    player_b = v_uid, status = 'active', state = checkline_private.initial_state(v_first), version = 1,
    rules_version = 3, last_action = null, last_actor = null,
    last_events = jsonb_build_array(jsonb_build_object('type', 'kickoff', 'team', v_first, 'carrierId', v_first || '-Q')),
    started_at = now(), b_seen_at = now(), turn_started_at = now(), updated_at = now()
  where id = v_m.id returning * into v_m;
  return checkline_private.match_view(v_m);
end
$$;

-- Also ends a turn whose deadline has passed, so a player who reconnects (or whose opponent
-- left) always sees the same, up-to-date match.
create or replace function public.cl_get_match(p_match_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := checkline_private.require_uid();
  v_m public.cl_matches;
begin
  select * into v_m from public.cl_matches where id = p_match_id;
  if not found or not (v_uid in (v_m.player_a, coalesce(v_m.player_b, v_m.player_a))
                       or (v_m.status = 'waiting' and v_m.is_public)) then
    raise exception 'CL:match_not_found';
  end if;
  if v_m.status = 'active' and now() >= checkline_private.turn_deadline(v_m) then
    v_m := checkline_private.expire_turn(checkline_private.lock_my_match(p_match_id, v_uid));
  end if;
  return checkline_private.match_view(v_m);
end
$$;

create or replace function public.cl_list_open_matches()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(checkline_private.match_view(m) order by m.created_at desc), '[]'::jsonb)
  from (select * from public.cl_matches
        where status = 'waiting' and is_public and player_a <> checkline_private.require_uid()
          and created_at > now() - interval '2 hours'
        order by created_at desc limit 20) m
$$;

create or replace function public.cl_list_my_matches()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(checkline_private.match_view(m) order by m.updated_at desc), '[]'::jsonb)
  from (select * from public.cl_matches
        where checkline_private.require_uid() in (player_a, player_b) and status in ('waiting', 'active')
        order by updated_at desc limit 10) m
$$;

-- Submit one game action. Checks: participant, active match, current rules, expected version
-- (no overwrites), caller's turn, the turn deadline (server clock: an action cannot extend a
-- turn), and full rule validation. Finishes and rates the match.
create or replace function public.cl_submit_action(p_match_id uuid, p_expected_version integer, p_action jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := checkline_private.require_uid();
  v_m public.cl_matches;
  v_team text;
  v_res jsonb;
begin
  v_m := checkline_private.lock_my_match(p_match_id, v_uid);
  if v_m.status <> 'active' then raise exception 'CL:match_not_active'; end if;
  if v_m.rules_version <> 3 then raise exception 'CL:match_outdated'; end if;
  if p_expected_version is distinct from v_m.version then raise exception 'CL:stale_state'; end if;
  v_team := case when v_uid = v_m.player_a then 'A' else 'B' end;
  if v_m.state ->> 'turn' <> v_team then raise exception 'CL:not_your_turn'; end if;
  if now() >= checkline_private.turn_deadline(v_m) then raise exception 'CL:turn_expired'; end if;
  if jsonb_typeof(p_action) is distinct from 'object' or pg_column_size(p_action) > 1024 then
    raise exception 'CL:bad_action';
  end if;
  v_res := checkline_private.apply_action(v_m.state, p_action);
  if not (v_res ->> 'ok')::boolean then
    raise exception 'CL:illegal:%', v_res -> 'why' ->> 'code';
  end if;
  v_m := checkline_private.commit_action(v_m, v_uid, v_team, p_action, v_res);
  return checkline_private.match_view(v_m);
end
$$;

-- Turn clock: once the current turn's deadline (25 s + 3 s grace) has passed, either player
-- may ask the server to end it; the game does this automatically. p_expected_version must be
-- the match version the caller saw, so a repeated or late request can never end a second turn
-- (it gets CL:stale_state). Before the deadline: CL:turn_time_left.
drop function if exists public.cl_claim_timeout(uuid);
create or replace function public.cl_claim_timeout(p_match_id uuid, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := checkline_private.require_uid();
  v_m public.cl_matches;
  v_version integer;
begin
  v_m := checkline_private.lock_my_match(p_match_id, v_uid);
  if v_m.status <> 'active' or v_m.rules_version <> 3 then raise exception 'CL:match_not_active'; end if;
  if p_expected_version is distinct from v_m.version then raise exception 'CL:stale_state'; end if;
  v_version := v_m.version;
  v_m := checkline_private.expire_turn(v_m);
  if v_m.version = v_version then raise exception 'CL:turn_time_left'; end if;
  return checkline_private.match_view(v_m);
end
$$;

-- Heartbeat: marks you as present in the match (used for "opponent away" and forfeits).
create or replace function public.cl_touch_match(p_match_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := checkline_private.require_uid();
  v_m public.cl_matches;
begin
  v_m := checkline_private.expire_turn(checkline_private.lock_my_match(p_match_id, v_uid));
  if v_m.status in ('waiting', 'active') then
    update public.cl_matches set
      a_seen_at = case when v_uid = player_a then now() else a_seen_at end,
      b_seen_at = case when v_uid = player_b then now() else b_seen_at end
    where id = v_m.id returning * into v_m;
  end if;
  return jsonb_build_object('serverNow', now(), 'status', v_m.status, 'version', v_m.version,
                            'aSeenAt', v_m.a_seen_at, 'bSeenAt', v_m.b_seen_at);
end
$$;

create or replace function public.cl_resign(p_match_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := checkline_private.require_uid();
  v_m public.cl_matches;
begin
  v_m := checkline_private.lock_my_match(p_match_id, v_uid);
  if v_m.status <> 'active' then raise exception 'CL:match_not_active'; end if;
  update public.cl_matches set status = 'finished', end_reason = 'resign', finished_at = now(), updated_at = now(),
    winner_id = case when v_uid = player_a then player_b else player_a end
  where id = v_m.id returning * into v_m;
  perform checkline_private.finalize_match(v_m);
  return checkline_private.match_view(v_m);
end
$$;

-- Claim the win when the opponent has not been seen for 90 seconds.
create or replace function public.cl_claim_forfeit(p_match_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := checkline_private.require_uid();
  v_m public.cl_matches;
  v_opp_seen timestamptz;
begin
  v_m := checkline_private.lock_my_match(p_match_id, v_uid);
  if v_m.status <> 'active' then raise exception 'CL:match_not_active'; end if;
  v_opp_seen := case when v_uid = v_m.player_a then v_m.b_seen_at else v_m.a_seen_at end;
  if v_opp_seen is not null and v_opp_seen > now() - interval '90 seconds' then
    raise exception 'CL:opponent_still_connected';
  end if;
  update public.cl_matches set status = 'finished', end_reason = 'forfeit', finished_at = now(), updated_at = now(),
    winner_id = v_uid
  where id = v_m.id returning * into v_m;
  perform checkline_private.finalize_match(v_m);
  return checkline_private.match_view(v_m);
end
$$;

create or replace function public.cl_cancel_match(p_match_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := checkline_private.require_uid();
  v_m public.cl_matches;
begin
  v_m := checkline_private.lock_my_match(p_match_id, v_uid);
  if v_m.status <> 'waiting' or v_m.player_a <> v_uid then raise exception 'CL:match_not_active'; end if;
  update public.cl_matches set status = 'cancelled', updated_at = now() where id = v_m.id returning * into v_m;
  return checkline_private.match_view(v_m);
end
$$;

-- Leaderboard page (public: anyone can read it, but it only ever contains public fields -
-- no email, no coins). Ranked by Elo as in v0.3; each row also shows the C-rank tier.
-- Order (deterministic): rating desc, wins desc, losses asc, earliest to reach the rating, id.
create or replace function public.cl_get_leaderboard(p_offset integer default 0, p_limit integer default 20)
returns jsonb language sql stable security definer set search_path = '' as $$
  with ranked as (
    select p.id, p.username, p.rating, p.wins, p.draws, p.losses, p.games, p.rank_points,
           row_number() over (order by p.rating desc, p.wins desc, p.losses asc, p.rating_updated_at asc, p.id asc) as rank
    from public."user" p
    where p.games > 0
  ), page as (
    select * from ranked order by rank
    offset greatest(coalesce(p_offset, 0), 0)
    limit least(greatest(coalesce(p_limit, 20), 1), 50)
  )
  select jsonb_build_object(
    'total', (select count(*) from ranked),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
               'rank', rank, 'id', id, 'displayName', username, 'rating', rating,
               'wins', wins, 'draws', draws, 'losses', losses, 'games', games,
               'tier', checkline_private.rank_json(rank_points) ->> 'tier', 'rankPoints', rank_points) order by rank) from page), '[]'::jsonb),
    'me', (select jsonb_build_object('rank', rank, 'id', id, 'displayName', username, 'rating', rating,
                                     'wins', wins, 'draws', draws, 'losses', losses, 'games', games,
                                     'tier', checkline_private.rank_json(rank_points) ->> 'tier', 'rankPoints', rank_points)
           from ranked where id = auth.uid()))
$$;

-- Your coins, items and equipped cosmetics.
create or replace function public.cl_get_wallet()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := checkline_private.require_uid();
begin
  if not exists (select 1 from public."user" where id = v_uid) then raise exception 'CL:profile_required'; end if;
  return checkline_private.wallet_json(v_uid);
end
$$;

-- Buy (if not owned yet) and equip a floor, skin or ball. One transaction: the price is read from
-- public.cosmetics, coins are taken with a ledger row, the item is added and equipped.
-- Not enough coins -> CL:too_poor and nothing changes.
create or replace function public.cl_buy_item(p_kind text, p_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := checkline_private.require_uid();
  v_item public.cosmetics;
  v_owned boolean;
begin
  if not exists (select 1 from public."user" where id = v_uid) then raise exception 'CL:profile_required'; end if;
  perform 1 from public."user" where id = v_uid for update;
  select * into v_item from public.cosmetics where kind = p_kind and id = p_id;
  if not found then raise exception 'CL:unknown_item'; end if;
  v_owned := exists (select 1 from public.user_cosmetics where user_id = v_uid and kind = p_kind and item_id = p_id);
  if not v_owned then
    if not v_item.active then raise exception 'CL:unknown_item'; end if;
    perform checkline_private.change_coins(v_uid, -v_item.price, 'purchase', null, p_kind || ':' || p_id, null, 'player');
    insert into public.user_cosmetics (user_id, kind, item_id, source, price_paid)
    values (v_uid, p_kind, p_id, 'purchase', v_item.price);
  end if;
  update public."user" set
    equipped_floor = case when p_kind = 'floor' then p_id else equipped_floor end,
    equipped_skin = case when p_kind = 'skin' then p_id else equipped_skin end,
    equipped_ball = case when p_kind = 'ball' then p_id else equipped_ball end
  where id = v_uid;
  return checkline_private.wallet_json(v_uid);
end
$$;

-- Buy (if needed) and equip a full set. One transaction, all or nothing:
--   * the price comes from public.bundles; a player who already owns some of the items pays
--     the lower of the set price and what the missing items cost one by one (never more);
--   * owning the whole set already costs nothing (the set is just equipped);
--   * not enough coins -> CL:too_poor and nothing changes;
--   * one coin_transactions row (kind 'purchase', item 'bundle:<id>'), the missing items are
--     added to user_cosmetics (source 'bundle') and all three are equipped.
create or replace function public.cl_buy_bundle(p_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := checkline_private.require_uid();
  v_bundle public.bundles;
  v_missing_sum integer;
  v_missing integer;
  v_cost integer;
begin
  if not exists (select 1 from public."user" where id = v_uid) then raise exception 'CL:profile_required'; end if;
  perform 1 from public."user" where id = v_uid for update;
  select * into v_bundle from public.bundles where id = p_id and active;
  if not found or (select count(*) from public.bundle_items where bundle_id = p_id) = 0 then raise exception 'CL:unknown_item'; end if;
  select coalesce(sum(c.price), 0), count(*) into v_missing_sum, v_missing
  from public.bundle_items i
  join public.cosmetics c on c.kind = i.kind and c.id = i.item_id
  where i.bundle_id = p_id
    and not exists (select 1 from public.user_cosmetics o where o.user_id = v_uid and o.kind = i.kind and o.item_id = i.item_id);
  v_cost := case when v_missing = 0 then 0 else least(v_bundle.price, v_missing_sum) end;
  if v_cost > 0 then
    perform checkline_private.change_coins(v_uid, -v_cost, 'purchase', null, 'bundle:' || p_id,
      (select string_agg(i.kind || ':' || i.item_id, ', ' order by i.kind) from public.bundle_items i where i.bundle_id = p_id), 'player');
  end if;
  insert into public.user_cosmetics (user_id, kind, item_id, source, price_paid)
  select v_uid, i.kind, i.item_id, 'bundle', 0 from public.bundle_items i where i.bundle_id = p_id
  on conflict do nothing;
  update public."user" u set
    equipped_floor = coalesce((select i.item_id from public.bundle_items i where i.bundle_id = p_id and i.kind = 'floor'), u.equipped_floor),
    equipped_skin = coalesce((select i.item_id from public.bundle_items i where i.bundle_id = p_id and i.kind = 'skin'), u.equipped_skin),
    equipped_ball = coalesce((select i.item_id from public.bundle_items i where i.bundle_id = p_id and i.kind = 'ball'), u.equipped_ball)
  where u.id = v_uid;
  return checkline_private.wallet_json(v_uid);
end
$$;

-- ADMIN ONLY: give or take coins, with a required note. Recorded in public.coin_transactions.
-- Callable from the SQL Editor or a server holding the service-role key; players cannot call it.
--   select public.cl_admin_adjust_coins('ORVD', 100, 'Tournament prize');
--   select public.cl_admin_adjust_coins('player@example.com', -20, 'Refund reversal');
-- p_player may be a username, an email or a user id. Taking more than the player has is refused.
create or replace function public.cl_admin_adjust_coins(p_player text, p_amount integer, p_note text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user public."user";
  v_balance integer;
  v_key text := btrim(coalesce(p_player, ''));
begin
  if coalesce(p_amount, 0) = 0 then raise exception 'CL:bad_amount'; end if;
  if char_length(btrim(coalesce(p_note, ''))) < 3 then raise exception 'CL:note_required'; end if;
  select * into v_user from public."user" u
  where u.id::text = v_key or lower(btrim(u.username)) = lower(v_key) or lower(u.email) = lower(v_key)
  limit 1;
  if not found then raise exception 'CL:player_not_found'; end if;
  v_balance := checkline_private.change_coins(v_user.id, p_amount,
    case when p_amount > 0 then 'admin_grant' else 'admin_remove' end, null, null, btrim(p_note),
    coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), session_user::text));
  return jsonb_build_object('player', v_user.username, 'amount', p_amount, 'coins', v_balance);
end
$$;

-- -------------------------------------------------------------------------------------
-- 5. Triggers: player rows follow Supabase Auth; inventory, equipped items and coin audit
-- -------------------------------------------------------------------------------------

-- Sign-up: create the player row from the username typed on the sign-up form. If it is
-- missing, invalid or taken, no row is made and the game asks for a name on first login -
-- sign-up itself never fails because of this. Guests choose their name in the game.
create or replace function checkline_private.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_name text := btrim(regexp_replace(coalesce(new.raw_user_meta_data ->> 'display_name', ''), '\s+', ' ', 'g'));
begin
  if char_length(v_name) between 2 and 24 and v_name !~ '[[:cntrl:]]' then
    begin
      insert into public."user" (id, username, email, is_guest)
      values (new.id, v_name, new.email, coalesce(new.is_anonymous, false))
      on conflict do nothing;
    exception when others then
      null;  -- never block a sign-up
    end;
  end if;
  return new;
end
$$;
drop trigger if exists cl_on_auth_user_created on auth.users;
create trigger cl_on_auth_user_created after insert on auth.users
  for each row execute function checkline_private.handle_new_user();

-- Email changed (or a guest upgraded to an email account) in Auth -> update the player row.
create or replace function checkline_private.sync_auth_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public."user" set email = new.email, is_guest = coalesce(new.is_anonymous, false)
  where id = new.id and (email is distinct from new.email or is_guest is distinct from coalesce(new.is_anonymous, false));
  return new;
end
$$;
drop trigger if exists cl_on_auth_user_updated on auth.users;
create trigger cl_on_auth_user_updated after update of email, is_anonymous on auth.users
  for each row execute function checkline_private.sync_auth_user();

-- New player -> owns the free Classic floor and skin.
create or replace function checkline_private.give_starter_items()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.user_cosmetics (user_id, kind, item_id, source)
  select new.id, c.kind, c.id, 'starter' from public.cosmetics c where c.price = 0 and c.id = 'classic'
  on conflict do nothing;
  return new;
end
$$;
drop trigger if exists user_starter_items on public."user";
create trigger user_starter_items after insert on public."user"
  for each row execute function checkline_private.give_starter_items();

-- Equipped floor / skin / ball must be owned (Classic is always allowed). Also stamps updated_at.
create or replace function checkline_private.check_user_row()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.equipped_floor <> 'classic' and not exists (
       select 1 from public.user_cosmetics c where c.user_id = new.id and c.kind = 'floor' and c.item_id = new.equipped_floor) then
    raise exception 'CL:not_owned' using detail = 'Give the player that floor in public.user_cosmetics first.';
  end if;
  if new.equipped_skin <> 'classic' and not exists (
       select 1 from public.user_cosmetics c where c.user_id = new.id and c.kind = 'skin' and c.item_id = new.equipped_skin) then
    raise exception 'CL:not_owned' using detail = 'Give the player that skin in public.user_cosmetics first.';
  end if;
  if new.equipped_ball <> 'classic' and not exists (
       select 1 from public.user_cosmetics c where c.user_id = new.id and c.kind = 'ball' and c.item_id = new.equipped_ball) then
    raise exception 'CL:not_owned' using detail = 'Give the player that ball in public.user_cosmetics first.';
  end if;
  new.updated_at := now();
  return new;
end
$$;
drop trigger if exists user_check_row on public."user";
create trigger user_check_row before insert or update on public."user"
  for each row execute function checkline_private.check_user_row();

-- Coins edited directly (e.g. in Table Editor) instead of through change_coins: keep the
-- audit trail complete by logging the difference as a 'manual_edit'.
create or replace function checkline_private.audit_coin_edit()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.coins is distinct from old.coins
     and coalesce(current_setting('checkline.coin_ledger', true), 'off') <> 'on' then
    insert into public.coin_transactions (user_id, amount, balance_after, kind, note, actor)
    values (new.id, new.coins - old.coins, new.coins, 'manual_edit', 'Edited directly in the database',
            coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), session_user::text));
  end if;
  return new;
end
$$;
drop trigger if exists user_audit_coins on public."user";
create trigger user_audit_coins after update of coins on public."user"
  for each row execute function checkline_private.audit_coin_edit();

-- Every existing player owns the Classic items.
insert into public.user_cosmetics (user_id, kind, item_id, source)
select u.id, c.kind, c.id, 'starter' from public."user" u cross join public.cosmetics c
where c.id = 'classic'
on conflict do nothing;

-- -------------------------------------------------------------------------------------
-- 6. Upgrades: move coins and items from earlier tables (never lost), retire old objects
-- -------------------------------------------------------------------------------------

-- Old triggers and functions that pointed at the earlier tables.
drop trigger if exists cl_on_result_pay on public.cl_match_results;
drop function if exists public.cl_report_match(text, boolean);   -- client-reported results are no longer paid

create or replace function checkline_private.migrate_wallet(p_uid uuid, p_coins integer, p_owned text[],
  p_floor text, p_skin text, p_from text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public."user" where id = p_uid) then return; end if;
  insert into public.user_cosmetics (user_id, kind, item_id, source)
  select p_uid, c.kind, c.id, 'migration'
  from unnest(coalesce(p_owned, '{}'::text[])) o
  join public.cosmetics c on c.kind || ':' || c.id = o
  on conflict do nothing;
  if coalesce(p_coins, 0) > 0 then
    perform checkline_private.change_coins(p_uid, p_coins, 'migration', null, null, 'Moved from ' || p_from, 'setup.sql');
  end if;
  update public."user" set
    equipped_floor = case when exists (select 1 from public.user_cosmetics c where c.user_id = p_uid and c.kind = 'floor' and c.item_id = p_floor) then p_floor else equipped_floor end,
    equipped_skin = case when exists (select 1 from public.user_cosmetics c where c.user_id = p_uid and c.kind = 'skin' and c.item_id = p_skin) then p_skin else equipped_skin end
  where id = p_uid;
end
$$;

-- An old public table whose data has been copied: removed if empty, otherwise kept as a
-- private backup (checkline_private.legacy_<name>) that the API cannot reach.
create or replace function checkline_private.retire_table(p_name text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_rows bigint;
  v_new text := 'legacy_' || p_name;
begin
  execute format('select count(*) from public.%I', p_name) into v_rows;
  if v_rows = 0 then
    execute format('drop table public.%I', p_name);
    raise notice 'Checkline: removed empty table public.%', p_name;
  else
    if to_regclass('checkline_private.' || v_new) is not null then
      v_new := v_new || '_' || to_char(now(), 'YYYYMMDDHH24MISS');
    end if;
    execute format('alter table public.%I set schema checkline_private', p_name);
    execute format('alter table checkline_private.%I rename to %I', p_name, v_new);
    raise notice 'Checkline: % rows copied; old table kept as checkline_private.%', v_rows, v_new;
  end if;
end
$$;

do $$
declare
  v_src text;
  r record;
  v_name text;
begin
  -- v0.3 coins tables (cl_wallets from 003_wallets.sql, cl_users from 004_users_table.sql).
  foreach v_src in array array['cl_wallets', 'cl_users'] loop
    if to_regclass('public.' || v_src) is not null then
      execute format('drop trigger if exists cl_users_before_update on public.%I', v_src);
      execute format('drop trigger if exists cl_users_after_rename on public.%I', v_src);
      for r in execute format(
        'select w.user_id, w.coins, w.owned, w.floor, w.skin from public.%I w', v_src) loop
        perform checkline_private.migrate_wallet(r.user_id, r.coins, r.owned, r.floor, r.skin, v_src);
      end loop;
      perform checkline_private.retire_table(v_src);
    end if;
  end loop;

  -- The step-by-step test table public.users (id, username, email, coins, skins, pitch_colors ...).
  if to_regclass('public.users') is not null and exists (
       select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'users' and column_name = 'pitch_colors') then
    execute 'drop trigger if exists users_touch on public.users';
    for r in execute 'select id, username, coins, skins, skin, pitch_colors, pitch_color from public.users' loop
      if not exists (select 1 from public."user" where id = r.id) and exists (select 1 from auth.users where id = r.id) then
        v_name := left(btrim(r.username), 24);
        if char_length(v_name) < 2 or exists (select 1 from public."user" where lower(btrim(username)) = lower(v_name)) then
          v_name := 'player-' || left(replace(r.id::text, '-', ''), 6);
        end if;
        insert into public."user" (id, username, email, is_guest)
        select a.id, v_name, a.email, coalesce(a.is_anonymous, false) from auth.users a where a.id = r.id;
      end if;
      perform checkline_private.migrate_wallet(r.id, r.coins,
        array(select 'skin:' || s from unnest(r.skins) s) || array(select 'floor:' || f from unnest(r.pitch_colors) f),
        r.pitch_color, r.skin, 'users');
    end loop;
    perform checkline_private.retire_table('users');
  end if;
end
$$;

drop function if exists checkline_private.pay_online_result();
drop function if exists checkline_private.pay_match(uuid, text, boolean);
drop function if exists checkline_private.create_wallet();
drop function if exists checkline_private.profile_renamed();
drop function if exists checkline_private.auth_email_changed();
drop function if exists checkline_private.users_before_update();
drop function if exists checkline_private.users_renamed();
drop function if exists checkline_private.shop_price(text, text);
drop function if exists checkline_private.on_sign_up();
drop function if exists checkline_private.on_email_change();
drop function if exists checkline_private.touch_updated_at();

-- -------------------------------------------------------------------------------------
-- 7. Row-level security and privileges
-- -------------------------------------------------------------------------------------

alter table public."user" enable row level security;
alter table public.rank_tiers enable row level security;
alter table public.cosmetics enable row level security;
alter table public.bundles enable row level security;
alter table public.bundle_items enable row level security;
alter table public.user_cosmetics enable row level security;
alter table public.coin_transactions enable row level security;
alter table public.cl_matches enable row level security;
alter table public.cl_match_moves enable row level security;
alter table public.cl_match_results enable row level security;

-- Tables are read-only for players; every change goes through the functions above.
revoke all on table public."user", public.rank_tiers, public.cosmetics, public.bundles, public.bundle_items, public.user_cosmetics,
  public.coin_transactions, public.cl_matches, public.cl_match_moves, public.cl_match_results
  from public, anon, authenticated;
grant select on table public.rank_tiers, public.cosmetics, public.bundles, public.bundle_items to anon, authenticated;
grant select on table public."user", public.user_cosmetics, public.coin_transactions,
  public.cl_matches, public.cl_match_moves, public.cl_match_results to authenticated;

-- Players: only your own row (it has your email and coins). Public player info (name, rating,
-- tier, record) is served by cl_get_leaderboard and the match functions instead.
drop policy if exists "cl_profiles_read_all" on public."user";
drop policy if exists "user_read_own" on public."user";
create policy "user_read_own" on public."user"
  for select to authenticated using ((select auth.uid()) = id);

drop policy if exists "rank_tiers_read_all" on public.rank_tiers;
create policy "rank_tiers_read_all" on public.rank_tiers for select to anon, authenticated using (true);

drop policy if exists "cosmetics_read_all" on public.cosmetics;
create policy "cosmetics_read_all" on public.cosmetics for select to anon, authenticated using (true);

drop policy if exists "bundles_read_all" on public.bundles;
create policy "bundles_read_all" on public.bundles for select to anon, authenticated using (true);
drop policy if exists "bundle_items_read_all" on public.bundle_items;
create policy "bundle_items_read_all" on public.bundle_items for select to anon, authenticated using (true);

drop policy if exists "user_cosmetics_read_own" on public.user_cosmetics;
create policy "user_cosmetics_read_own" on public.user_cosmetics
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "coin_transactions_read_own" on public.coin_transactions;
create policy "coin_transactions_read_own" on public.coin_transactions
  for select to authenticated using ((select auth.uid()) = user_id);

-- Matches: participants see their own; signed-in players also see public matches waiting for an opponent.
drop policy if exists "cl_matches_read_participant_or_open" on public.cl_matches;
create policy "cl_matches_read_participant_or_open" on public.cl_matches
  for select to authenticated
  using ((select auth.uid()) in (player_a, player_b) or (status = 'waiting' and is_public));

drop policy if exists "cl_match_moves_read_participant" on public.cl_match_moves;
create policy "cl_match_moves_read_participant" on public.cl_match_moves
  for select to authenticated
  using (exists (select 1 from public.cl_matches m
                 where m.id = match_id and (select auth.uid()) in (m.player_a, m.player_b)));

drop policy if exists "cl_match_results_read_participant" on public.cl_match_results;
create policy "cl_match_results_read_participant" on public.cl_match_results
  for select to authenticated
  using ((select auth.uid()) in (player_a, player_b));

-- Private schema: never callable by API roles.
revoke all on all functions in schema checkline_private from public, anon, authenticated;

-- Public RPCs: signed-in players only (email accounts and guests both have the `authenticated` role).
do $$
declare v_fn text;
begin
  foreach v_fn in array array[
    'public.cl_upsert_profile(text)', 'public.cl_get_my_profile()', 'public.cl_create_match(boolean)',
    'public.cl_join_match(text)', 'public.cl_get_match(uuid)', 'public.cl_list_open_matches()',
    'public.cl_list_my_matches()', 'public.cl_submit_action(uuid, integer, jsonb)', 'public.cl_claim_timeout(uuid, integer)',
    'public.cl_touch_match(uuid)', 'public.cl_resign(uuid)', 'public.cl_claim_forfeit(uuid)',
    'public.cl_cancel_match(uuid)', 'public.cl_get_wallet()', 'public.cl_buy_item(text, text)', 'public.cl_buy_bundle(text)'] loop
    execute format('revoke all on function %s from public, anon', v_fn);
    execute format('grant execute on function %s to authenticated', v_fn);
  end loop;
end
$$;
revoke all on function public.cl_get_leaderboard(integer, integer) from public;
grant execute on function public.cl_get_leaderboard(integer, integer) to anon, authenticated;
revoke all on function public.cl_name_available(text) from public;
grant execute on function public.cl_name_available(text) to anon, authenticated;

-- Admin coins: nobody but the database owner (SQL Editor) and the service role.
revoke all on function public.cl_admin_adjust_coins(text, integer, text) from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.cl_admin_adjust_coins(text, integer, text) to service_role;
  end if;
end
$$;

-- -------------------------------------------------------------------------------------
-- 8. Realtime: stream match row changes to subscribed players (RLS applies to each subscriber).
-- -------------------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'cl_matches') then
    alter publication supabase_realtime add table public.cl_matches;
  end if;
end
$$;

commit;
