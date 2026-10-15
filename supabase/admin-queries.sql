-- =====================================================================================
-- Checkline: handy queries for the Supabase SQL Editor (run setup.sql first).
-- Run one block at a time. Blocks 1-7 only READ data. Blocks 8+ CHANGE data: read them first.
-- Players and accounts are created by the game itself (Sign up / Continue as guest);
-- do not insert into auth.users by hand. Passwords are never stored in these tables.
-- =====================================================================================

-- 1. Every player: name, email, coins, C-rank, Elo and record.
select u.username, u.email, u.is_guest, u.coins,
       (select t.code from public.rank_tiers t where t.min_points <= u.rank_points order by t.min_points desc limit 1) as rank,
       u.rank_points, u.rating as elo, u.wins, u.draws, u.losses, u.games,
       u.equipped_floor, u.equipped_skin, u.created_at
from public."user" u
order by u.rank_points desc, u.rating desc;

-- 2. Accounts in Authentication without a player row yet (signed up but no username chosen).
select a.id, a.email, a.is_anonymous as guest, a.created_at
from auth.users a
left join public."user" u on u.id = a.id
where u.id is null
order by a.created_at desc;

-- 3. Coin history of one player (newest first). Replace the name.
select t.created_at, t.kind, t.amount, t.balance_after, t.item, t.note, t.actor, t.match_id
from public.coin_transactions t
join public."user" u on u.id = t.user_id
where lower(u.username) = lower('ORVD')
order by t.id desc;

-- 4. What each player owns.
select u.username, c.kind, c.item_id, c.source, c.price_paid, c.acquired_at
from public.user_cosmetics c
join public."user" u on u.id = c.user_id
order by u.username, c.kind, c.item_id;

-- 5. Leaderboard exactly as the game shows it (first 50).
select public.cl_get_leaderboard(0, 50);

-- 6. Matches, newest first, with player names and score.
select m.code, m.status, m.is_public,
       pa.username as ivory, pb.username as ebony,
       (m.state -> 'score' ->> 'A') || ' - ' || (m.state -> 'score' ->> 'B') as score,
       (m.state ->> 'turnNumber')::int as turn_number,
       w.username as winner, m.end_reason, m.created_at, m.finished_at
from public.cl_matches m
join public."user" pa on pa.id = m.player_a
left join public."user" pb on pb.id = m.player_b
left join public."user" w on w.id = m.winner_id
order by m.created_at desc;

-- 7. Finished results with Elo, C-rank points and coins.
select r.created_at, pa.username as ivory, pb.username as ebony, r.score_a || ' - ' || r.score_b as score,
       coalesce(w.username, 'draw') as winner, r.reason,
       r.ranked, r.rank_note,
       r.a_points_before || ' -> ' || r.a_points_after as ivory_points,
       r.b_points_before || ' -> ' || r.b_points_after as ebony_points,
       r.a_rating_before || ' -> ' || r.a_rating_after as ivory_elo,
       r.b_rating_before || ' -> ' || r.b_rating_after as ebony_elo,
       r.a_coins as ivory_coins, r.b_coins as ebony_coins
from public.cl_match_results r
join public."user" pa on pa.id = r.player_a
join public."user" pb on pb.id = r.player_b
left join public."user" w on w.id = r.winner_id
order by r.created_at desc;

-- 8. GIVE or TAKE coins (CHANGES DATA). Recorded in coin_transactions with your note.
--    Works with a username, an email or a user id. Taking more than the player has is refused.
-- select public.cl_admin_adjust_coins('ORVD', 100, 'Tournament prize');
-- select public.cl_admin_adjust_coins('player@example.com', -20, 'Correction');

-- 9. Give an item for free (CHANGES DATA). Items: floor midnight / sunset / neon, skin obsidian / neon / gold.
-- insert into public.user_cosmetics (user_id, kind, item_id, source)
-- select id, 'skin', 'gold', 'admin' from public."user" where lower(username) = lower('ORVD')
-- on conflict do nothing;

-- 10. Change a price (CHANGES DATA). The shop shows the new price to signed-in players.
-- update public.cosmetics set price = 30 where kind = 'skin' and id = 'gold';

-- 11. Set a player's rank points (CHANGES DATA). The tier (C5..C1) follows automatically.
-- update public."user" set rank_points = 300 where lower(username) = lower('ORVD');

-- 12. Housekeeping (CHANGES DATA). Cancels invites nobody joined within 24 hours.
-- update public.cl_matches set status = 'cancelled', updated_at = now()
-- where status = 'waiting' and created_at < now() - interval '24 hours';

-- Passwords: Supabase keeps them only as a one-way hash in Authentication; nobody can read
-- them. To help a player: Authentication -> Users -> the player -> "Send password recovery".
