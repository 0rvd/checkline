-- =====================================================================================
-- Checkline: DELETE EVERYTHING (all game tables, all game functions, ALL user accounts).
-- This cannot be undone. Afterwards run supabase/setup.sql to build everything fresh.
-- Only touches Checkline objects (the tables listed below, cl_* functions, the checkline_private schema)
-- plus the accounts in Authentication -> Users.
-- =====================================================================================
begin;

-- 1. Triggers Checkline added to Supabase's own auth.users table (current and earlier versions).
drop trigger if exists cl_on_auth_user_created on auth.users;
drop trigger if exists cl_on_auth_user_updated on auth.users;
drop trigger if exists cl_on_auth_email_changed on auth.users;
drop trigger if exists users_on_sign_up on auth.users;
drop trigger if exists users_on_email_change on auth.users;

-- 2. Game tables (their data, policies and triggers go with them).
drop table if exists public.coin_transactions cascade;
drop table if exists public.user_cosmetics cascade;
drop table if exists public.cosmetics cascade;
drop table if exists public.rank_tiers cascade;
drop table if exists public.cl_users cascade;
drop table if exists public.cl_wallets cascade;
drop table if exists public.cl_match_results cascade;
drop table if exists public.cl_match_moves cascade;
drop table if exists public.cl_matches cascade;
drop table if exists public.cl_profiles cascade;
drop table if exists public."user" cascade;
-- The step-by-step test table (only if it is Checkline's: it has a pitch_colors column).
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'users' and column_name = 'pitch_colors') then
    drop table public.users cascade;
  end if;
end
$$;

-- 3. Game functions in public (cl_...) and the private helper schema.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'cl\_%'
  loop
    execute 'drop function if exists ' || f.sig || ' cascade';
  end loop;
end
$$;
drop schema if exists checkline_private cascade;

-- 4. All user accounts (Authentication -> Users).
delete from auth.users;

commit;
