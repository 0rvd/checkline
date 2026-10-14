-- =====================================================================================
-- Checkline: handy queries for the Supabase SQL Editor (run setup.sql first).
-- Run one block at a time. Blocks 1-6 only READ data. Block 7 changes data: read it first.
-- Players and their accounts are created by the game itself (Sign up / Continue as guest);
-- do not insert into auth.users by hand.
-- =====================================================================================

-- 1. All accounts (emails live in Supabase Auth) joined with their game profile.
select u.id,
       u.email,
       u.is_anonymous                         as guest,
       u.email_confirmed_at is not null       as email_confirmed,
       u.created_at                           as signed_up,
       u.last_sign_in_at,
       p.display_name, p.rating, p.wins, p.draws, p.losses, p.games
from auth.users u
left join public.cl_profiles p on p.id = u.id
order by u.created_at desc;

-- 2. Player profiles (what the leaderboard and lobby show).
select id, display_name, rating, wins, draws, losses, games, rating_updated_at, created_at
from public.cl_profiles
order by rating desc, wins desc;

-- 3. Leaderboard exactly as the game ranks it (first 50).
select public.cl_get_leaderboard(0, 50);

-- 4. Matches, newest first, with player names and score.
select m.code, m.status, m.is_public,
       pa.display_name as ivory, pb.display_name as ebony,
       (m.state -> 'score' ->> 'A') || ' - ' || (m.state -> 'score' ->> 'B') as score,
       m.state ->> 'turn' as to_move, (m.state ->> 'turnNumber')::int as turn_number,
       w.display_name as winner, m.end_reason, m.version, m.rules_version,
       m.created_at, m.started_at, m.finished_at
from public.cl_matches m
join public.cl_profiles pa on pa.id = m.player_a
left join public.cl_profiles pb on pb.id = m.player_b
left join public.cl_profiles w on w.id = m.winner_id
order by m.created_at desc;

-- 5. Rated results with rating changes.
select r.created_at, pa.display_name as ivory, pb.display_name as ebony,
       r.score_a || ' - ' || r.score_b as score, coalesce(w.display_name, 'draw') as winner, r.reason,
       r.a_rating_before || ' -> ' || r.a_rating_after as ivory_rating,
       r.b_rating_before || ' -> ' || r.b_rating_after as ebony_rating
from public.cl_match_results r
join public.cl_profiles pa on pa.id = r.player_a
join public.cl_profiles pb on pb.id = r.player_b
left join public.cl_profiles w on w.id = r.winner_id
order by r.created_at desc;

-- 6. Move-by-move history of one match (replace the code).
select mv.seq, p.display_name, mv.team, mv.action, mv.events, mv.created_at
from public.cl_match_moves mv
join public.cl_matches m on m.id = mv.match_id
join public.cl_profiles p on p.id = mv.player_id
where m.code = 'K7M2QX'
order by mv.seq;

-- 7. Housekeeping (CHANGES DATA). Cancels invites nobody joined within 24 hours.
-- update public.cl_matches set status = 'cancelled', updated_at = now()
-- where status = 'waiting' and created_at < now() - interval '24 hours';
