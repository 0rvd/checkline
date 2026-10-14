-- =====================================================================================
-- Checkline online play: Supabase database setup  (rules v3 / app v0.3)
-- =====================================================================================
-- What this creates (all names are prefixed so they cannot collide with your own tables):
--   public.cl_profiles        one row per player (display name, Elo rating, wins/draws/losses)
--   public.cl_matches         online matches and their authoritative game state
--   public.cl_match_moves     append-only move history per match
--   public.cl_match_results   one row per rated result (written exactly once per match)
--   checkline_private.*       server-side copy of the game rules + internal helpers (not exposed)
--   public.cl_* functions     the only way clients can change data (RPC via supabase-js)
--
-- Prerequisites
--   1. A Supabase project (any plan). Run this whole file in Dashboard -> SQL Editor.
--   2. Authentication: players log in with email + password (the Email provider, on by default).
--      Optional: Sign In / Providers -> "Allow anonymous sign-ins" lets people also play as guests.
--      Profiles hold only a display name and the record; emails stay in Supabase Auth.
--
-- Safety
--   * Re-runnable: CREATE ... IF NOT EXISTS / CREATE OR REPLACE / ADD COLUMN IF NOT EXISTS.
--   * Never drops tables or data. DROP statements only remove this script's own RLS policies
--     and its own check constraint on cl_matches.end_reason, so they can be recreated.
--   * Upgrading from the v0.2 script: columns are added in place. Matches started under the
--     old rules are marked rules_version 2 and can no longer be played (players can resign).
--   * Clients get SELECT access through row-level security only. Every write goes through
--     SECURITY DEFINER functions that validate the caller, the turn, the match version and
--     the action itself (with the same rules as the game client, see src/rules/engine.ts).
--
-- Keep in sync: the rule constants below mirror src/rules/config.ts. If you tune the game,
-- update both and run `npm run verify:sql` (needs local PostgreSQL) to check they agree.
--   board 8x12 | 3 AP, Surge +1 once per rally | pass 4, shot 5, shot cost 1 | goal mouth B-G,
--   keeper box B-G x 2 rows | orthogonal marking | first to 3, regulation 30 turns, draw at 40
-- =====================================================================================

begin;

create schema if not exists checkline_private;
revoke all on schema checkline_private from public;

-- -------------------------------------------------------------------------------------
-- 1. Tables (and in-place upgrades from v0.2)
-- -------------------------------------------------------------------------------------

-- Player profile. Rating and record are only ever changed by checkline_private.finalize_match.
create table if not exists public.cl_profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 2 and 24),
  rating integer not null default 1200,
  wins integer not null default 0 check (wins >= 0),
  draws integer not null default 0 check (draws >= 0),
  losses integer not null default 0 check (losses >= 0),
  games integer not null default 0 check (games >= 0),
  -- When the rating last changed; earlier wins a tie on the leaderboard.
  rating_updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.cl_profiles add column if not exists draws integer not null default 0;

create index if not exists cl_profiles_leaderboard_idx
  on public.cl_profiles (rating desc, wins desc, losses asc, rating_updated_at asc, id asc)
  where games > 0;

-- A match. `state` is the authoritative game state (same JSON shape as the client's MatchState
-- minus config). `version` increases by one for every accepted action (optimistic concurrency).
create table if not exists public.cl_matches (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z2-9]{6}$'),
  is_public boolean not null default true,
  status text not null default 'waiting'
    check (status in ('waiting', 'active', 'finished', 'cancelled')),
  player_a uuid not null references public.cl_profiles (id) on delete cascade,  -- Ivory (Team A)
  player_b uuid references public.cl_profiles (id) on delete cascade,           -- Ebony (Team B)
  state jsonb,
  version integer not null default 0,
  rules_version integer not null default 3,
  last_action jsonb,
  last_events jsonb,
  last_actor uuid,
  winner_id uuid references public.cl_profiles (id) on delete cascade,  -- null + finished = draw
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

-- Append-only log of accepted actions (seq = match version after the action).
create table if not exists public.cl_match_moves (
  match_id uuid not null references public.cl_matches (id) on delete cascade,
  seq integer not null,
  player_id uuid not null references public.cl_profiles (id) on delete cascade,
  team text not null check (team in ('A', 'B')),
  action jsonb not null,
  events jsonb not null,
  created_at timestamptz not null default now(),
  primary key (match_id, seq)
);

-- Rated result. The primary key on match_id guarantees a match is rated at most once.
create table if not exists public.cl_match_results (
  match_id uuid primary key references public.cl_matches (id) on delete cascade,
  player_a uuid references public.cl_profiles (id) on delete cascade,
  player_b uuid references public.cl_profiles (id) on delete cascade,
  winner_id uuid references public.cl_profiles (id) on delete cascade,  -- null = draw
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
alter table public.cl_match_results add column if not exists player_a uuid references public.cl_profiles (id) on delete cascade;
alter table public.cl_match_results add column if not exists player_b uuid references public.cl_profiles (id) on delete cascade;
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

create or replace function checkline_private.profile_json(p_id uuid)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', p.id, 'displayName', p.display_name, 'rating', p.rating,
                            'wins', p.wins, 'draws', p.draws, 'losses', p.losses, 'games', p.games)
  from public.cl_profiles p where p.id = p_id
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
    'playerA', (select jsonb_build_object('id', p.id, 'name', p.display_name, 'rating', p.rating)
                from public.cl_profiles p where p.id = p_match.player_a),
    'playerB', (select jsonb_build_object('id', p.id, 'name', p.display_name, 'rating', p.rating)
                from public.cl_profiles p where p.id = p_match.player_b),
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
                 'bRatingBefore', r.b_rating_before, 'bRatingAfter', r.b_rating_after)
               from public.cl_match_results r where r.match_id = p_match.id))
$$;

-- Record a finished match exactly once and update both players' Elo ratings.
-- Elo (K = 32): E_a = 1 / (1 + 10^((R_b - R_a) / 400)); S_a = 1 win, 0.5 draw, 0 loss;
-- change = round(32 * (S_a - E_a)); A gains `change`, B loses the same amount (zero-sum).
create or replace function checkline_private.finalize_match(p_match public.cl_matches)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_a public.cl_profiles;
  v_b public.cl_profiles;
  v_expected numeric;
  v_score numeric;
  v_change integer;
begin
  if p_match.status <> 'finished' or p_match.player_b is null or p_match.end_reason is null then return; end if;
  perform 1 from public.cl_profiles where id in (p_match.player_a, p_match.player_b) order by id for update;
  select * into v_a from public.cl_profiles where id = p_match.player_a;
  select * into v_b from public.cl_profiles where id = p_match.player_b;
  v_expected := 1 / (1 + power(10::numeric, (v_b.rating - v_a.rating)::numeric / 400));
  v_score := case when p_match.winner_id is null then 0.5 when p_match.winner_id = v_a.id then 1 else 0 end;
  v_change := round(32 * (v_score - v_expected));

  insert into public.cl_match_results (match_id, player_a, player_b, winner_id, reason,
    a_rating_before, a_rating_after, b_rating_before, b_rating_after, score_a, score_b)
  values (p_match.id, v_a.id, v_b.id, p_match.winner_id, p_match.end_reason,
    v_a.rating, v_a.rating + v_change, v_b.rating, v_b.rating - v_change,
    coalesce((p_match.state -> 'score' ->> 'A')::integer, 0), coalesce((p_match.state -> 'score' ->> 'B')::integer, 0))
  on conflict (match_id) do nothing;
  if not found then return; end if;  -- already rated

  update public.cl_profiles set
    rating = rating + v_change, games = games + 1,
    wins = wins + case when v_score = 1 then 1 else 0 end,
    draws = draws + case when v_score = 0.5 then 1 else 0 end,
    losses = losses + case when v_score = 0 then 1 else 0 end,
    rating_updated_at = case when v_change <> 0 then now() else rating_updated_at end, updated_at = now()
  where id = v_a.id;
  update public.cl_profiles set
    rating = rating - v_change, games = games + 1,
    wins = wins + case when v_score = 0 then 1 else 0 end,
    draws = draws + case when v_score = 0.5 then 1 else 0 end,
    losses = losses + case when v_score = 1 then 1 else 0 end,
    rating_updated_at = case when v_change <> 0 then now() else rating_updated_at end, updated_at = now()
  where id = v_b.id;
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
-- turn timer and finish + rate the match when the engine says it is over.
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

-- -------------------------------------------------------------------------------------
-- 4. Client API (RPC). Errors are raised as 'CL:<code>' and translated by the client.
-- -------------------------------------------------------------------------------------

create or replace function public.cl_upsert_profile(p_display_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := checkline_private.require_uid();
  v_name text := btrim(regexp_replace(coalesce(p_display_name, ''), '\s+', ' ', 'g'));
begin
  if char_length(v_name) < 2 or char_length(v_name) > 24 or v_name ~ '[[:cntrl:]]' then
    raise exception 'CL:invalid_name';
  end if;
  insert into public.cl_profiles (id, display_name) values (v_uid, v_name)
  on conflict (id) do update set display_name = excluded.display_name, updated_at = now();
  return checkline_private.profile_json(v_uid);
end
$$;

create or replace function public.cl_get_my_profile()
returns jsonb language sql stable security definer set search_path = '' as $$
  select checkline_private.profile_json(auth.uid())
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
  if not exists (select 1 from public.cl_profiles where id = v_uid) then raise exception 'CL:profile_required'; end if;
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
  if not exists (select 1 from public.cl_profiles where id = v_uid) then raise exception 'CL:profile_required'; end if;
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

create or replace function public.cl_get_match(p_match_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := checkline_private.require_uid();
  v_m public.cl_matches;
begin
  select * into v_m from public.cl_matches where id = p_match_id;
  if not found or not (v_uid in (v_m.player_a, coalesce(v_m.player_b, v_m.player_a))
                       or (v_m.status = 'waiting' and v_m.is_public)) then
    raise exception 'CL:match_not_found';
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
-- (no overwrites), caller's turn, and full rule validation. Finishes and rates the match.
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

-- Turn timer: when the side to move has used more than 90 seconds, its opponent may end that
-- turn for it. The server checks the clock; unused AP are lost as with a normal End Turn.
create or replace function public.cl_claim_timeout(p_match_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := checkline_private.require_uid();
  v_m public.cl_matches;
  v_idle_team text;
  v_res jsonb;
  v_action jsonb := jsonb_build_object('type', 'endTurn', 'timeout', true);
begin
  v_m := checkline_private.lock_my_match(p_match_id, v_uid);
  if v_m.status <> 'active' or v_m.rules_version <> 3 then raise exception 'CL:match_not_active'; end if;
  v_idle_team := v_m.state ->> 'turn';
  if (v_idle_team = 'A' and v_uid = v_m.player_a) or (v_idle_team = 'B' and v_uid = v_m.player_b) then
    raise exception 'CL:not_your_turn';
  end if;
  if v_m.turn_started_at is not null and v_m.turn_started_at > now() - interval '90 seconds' then
    raise exception 'CL:turn_time_left';
  end if;
  v_res := checkline_private.apply_action(v_m.state, v_action);
  v_m := checkline_private.commit_action(v_m, case when v_idle_team = 'A' then v_m.player_a else v_m.player_b end,
                                         v_idle_team, v_action, v_res, false);
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
  v_m := checkline_private.lock_my_match(p_match_id, v_uid);
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

-- Leaderboard page. Only players with at least one rated game are ranked.
-- Order (deterministic): rating desc, wins desc, losses asc, earliest to reach the rating, id.
create or replace function public.cl_get_leaderboard(p_offset integer default 0, p_limit integer default 20)
returns jsonb language sql stable security invoker set search_path = '' as $$
  with ranked as (
    select p.id, p.display_name, p.rating, p.wins, p.draws, p.losses, p.games,
           row_number() over (order by p.rating desc, p.wins desc, p.losses asc, p.rating_updated_at asc, p.id asc) as rank
    from public.cl_profiles p
    where p.games > 0
  ), page as (
    select * from ranked order by rank
    offset greatest(coalesce(p_offset, 0), 0)
    limit least(greatest(coalesce(p_limit, 20), 1), 50)
  )
  select jsonb_build_object(
    'total', (select count(*) from ranked),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
               'rank', rank, 'id', id, 'displayName', display_name, 'rating', rating,
               'wins', wins, 'draws', draws, 'losses', losses, 'games', games) order by rank) from page), '[]'::jsonb),
    'me', (select jsonb_build_object('rank', rank, 'id', id, 'displayName', display_name, 'rating', rating,
                                     'wins', wins, 'draws', draws, 'losses', losses, 'games', games)
           from ranked where id = auth.uid()))
$$;

-- -------------------------------------------------------------------------------------
-- 5. Row-level security and privileges
-- -------------------------------------------------------------------------------------

alter table public.cl_profiles enable row level security;
alter table public.cl_matches enable row level security;
alter table public.cl_match_moves enable row level security;
alter table public.cl_match_results enable row level security;

-- Tables are read-only for clients; all writes go through the functions above.
revoke all on table public.cl_profiles, public.cl_matches, public.cl_match_moves, public.cl_match_results
  from public, anon, authenticated;
grant select on table public.cl_profiles to anon, authenticated;
grant select on table public.cl_matches, public.cl_match_moves, public.cl_match_results to authenticated;

-- Profiles (display name, rating, record) are public: they make up the leaderboard.
drop policy if exists "cl_profiles_read_all" on public.cl_profiles;
create policy "cl_profiles_read_all" on public.cl_profiles
  for select to anon, authenticated using (true);

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
revoke all on function public.cl_upsert_profile(text) from public, anon;
revoke all on function public.cl_get_my_profile() from public, anon;
revoke all on function public.cl_create_match(boolean) from public, anon;
revoke all on function public.cl_join_match(text) from public, anon;
revoke all on function public.cl_get_match(uuid) from public, anon;
revoke all on function public.cl_list_open_matches() from public, anon;
revoke all on function public.cl_list_my_matches() from public, anon;
revoke all on function public.cl_submit_action(uuid, integer, jsonb) from public, anon;
revoke all on function public.cl_claim_timeout(uuid) from public, anon;
revoke all on function public.cl_touch_match(uuid) from public, anon;
revoke all on function public.cl_resign(uuid) from public, anon;
revoke all on function public.cl_claim_forfeit(uuid) from public, anon;
revoke all on function public.cl_cancel_match(uuid) from public, anon;
revoke all on function public.cl_get_leaderboard(integer, integer) from public;

grant execute on function public.cl_upsert_profile(text) to authenticated;
grant execute on function public.cl_get_my_profile() to authenticated;
grant execute on function public.cl_create_match(boolean) to authenticated;
grant execute on function public.cl_join_match(text) to authenticated;
grant execute on function public.cl_get_match(uuid) to authenticated;
grant execute on function public.cl_list_open_matches() to authenticated;
grant execute on function public.cl_list_my_matches() to authenticated;
grant execute on function public.cl_submit_action(uuid, integer, jsonb) to authenticated;
grant execute on function public.cl_claim_timeout(uuid) to authenticated;
grant execute on function public.cl_touch_match(uuid) to authenticated;
grant execute on function public.cl_resign(uuid) to authenticated;
grant execute on function public.cl_claim_forfeit(uuid) to authenticated;
grant execute on function public.cl_cancel_match(uuid) to authenticated;
grant execute on function public.cl_get_leaderboard(integer, integer) to anon, authenticated;

-- -------------------------------------------------------------------------------------
-- 6. Realtime: stream match row changes to subscribed players (RLS applies to each subscriber).
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
