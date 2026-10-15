-- TEST FIXTURE ONLY: an earlier Checkline database script, used by scripts/verify-upgrade.mjs to
-- check that supabase/setup.sql upgrades it without losing data. Never run this on Supabase.
-- =====================================================================================
-- Checkline fresh build, step 1 of 4: the USERS table
-- One row per player: id, username, email, coins, skins and pitch colours.
-- Safe to run more than once.
-- =====================================================================================

-- 1. The table ----------------------------------------------------------------------
create table if not exists public.users (
  id            uuid primary key references auth.users (id) on delete cascade,  -- same id as the login account
  username      text not null check (char_length(btrim(username)) between 2 and 24),
  email         text,                                                    -- copied from Authentication (guests have none)
  coins         integer not null default 0 check (coins >= 0),
  skins         text[] not null default array['classic'],                -- skins the player owns
  skin          text not null default 'classic',                         -- skin in use
  pitch_colors  text[] not null default array['classic'],                -- pitch colours the player owns
  pitch_color   text not null default 'classic',                         -- pitch colour in use
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.users is 'Checkline players. Safe to edit coins, skins and pitch colours by hand. Passwords are kept (hashed) by Supabase Auth only.';
comment on column public.users.skins is 'Owned skins: classic, obsidian, neon, gold';
comment on column public.users.pitch_colors is 'Owned pitch colours: classic, midnight, sunset, neon';

-- No two players can have the same username (ignoring capitals and spaces).
create unique index if not exists users_username_unique on public.users (lower(btrim(username)));
-- No two players can have the same email.
create unique index if not exists users_email_unique on public.users (lower(email));

-- 2. Fill it automatically -------------------------------------------------------------
-- When someone signs up, create their row from the username they typed.
-- (If that name is already taken they get "player-xxxxxx" and can change it later.)
create schema if not exists checkline_private;
revoke all on schema checkline_private from public, anon, authenticated;

create or replace function checkline_private.on_sign_up()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_name text := btrim(coalesce(new.raw_user_meta_data ->> 'display_name', ''));
begin
  if char_length(v_name) not between 2 and 24
     or exists (select 1 from public.users u where lower(btrim(u.username)) = lower(v_name)) then
    v_name := 'player-' || left(replace(new.id::text, '-', ''), 6);
  end if;
  insert into public.users (id, username, email) values (new.id, v_name, new.email)
  on conflict (id) do nothing;
  return new;
end
$$;
drop trigger if exists users_on_sign_up on auth.users;
create trigger users_on_sign_up after insert on auth.users
  for each row execute function checkline_private.on_sign_up();

-- When the email is changed in Authentication, update it here too.
create or replace function checkline_private.on_email_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.users set email = new.email, updated_at = now()
  where id = new.id and email is distinct from new.email;
  return new;
end
$$;
drop trigger if exists users_on_email_change on auth.users;
create trigger users_on_email_change after update of email on auth.users
  for each row execute function checkline_private.on_email_change();

-- Keep updated_at fresh whenever a row is edited (also when you edit it by hand).
create or replace function checkline_private.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end
$$;
drop trigger if exists users_touch on public.users;
create trigger users_touch before update on public.users
  for each row execute function checkline_private.touch_updated_at();

-- 3. Security -----------------------------------------------------------------------
-- Players can READ only their own row and cannot change anything directly
-- (coins and purchases will go through server functions in a later step).
-- You, in the Supabase dashboard, can still see and edit every row.
alter table public.users enable row level security;
revoke all on table public.users from public, anon, authenticated;
grant select on table public.users to authenticated;
drop policy if exists "users_read_own" on public.users;
create policy "users_read_own" on public.users
  for select to authenticated using ((select auth.uid()) = id);

revoke all on function checkline_private.on_sign_up() from public, anon, authenticated;
revoke all on function checkline_private.on_email_change() from public, anon, authenticated;
revoke all on function checkline_private.touch_updated_at() from public, anon, authenticated;
