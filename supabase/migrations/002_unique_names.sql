-- =====================================================================================
-- Checkline: unique display names + automatic player profile on sign-up.
-- Safe to run more than once. Emails are already unique: Supabase Auth enforces that.
-- =====================================================================================

-- 1. Existing duplicate names (ignoring upper/lower case and outer spaces): the oldest
--    profile keeps the name; later ones get " 2", " 3", ... so the unique rule can apply.
with ranked as (
  select id, display_name,
         row_number() over (partition by lower(btrim(display_name)) order by created_at, id) as n
  from public.cl_profiles
)
update public.cl_profiles p
   set display_name = left(btrim(r.display_name), 21) || ' ' || r.n, updated_at = now()
  from ranked r
 where p.id = r.id and r.n > 1;

-- 2. The rule itself: no two players may share a display name ("Ali" = "ali" = " ALI ").
create unique index if not exists cl_profiles_display_name_unique
  on public.cl_profiles (lower(btrim(display_name)));

-- 3. Is a name free? Used by the sign-up form before the account is created.
create or replace function public.cl_name_available(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select not exists (
    select 1 from public.cl_profiles p
    where lower(btrim(p.display_name)) = lower(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')))
      and p.id is distinct from auth.uid())
$$;
revoke all on function public.cl_name_available(text) from public;
grant execute on function public.cl_name_available(text) to anon, authenticated;

-- 4. Create / rename a profile; a taken name is refused with CL:name_taken.
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
    insert into public.cl_profiles (id, display_name) values (v_uid, v_name)
    on conflict (id) do update set display_name = excluded.display_name, updated_at = now();
  exception when unique_violation then
    raise exception 'CL:name_taken';
  end;
  return checkline_private.profile_json(v_uid);
end
$$;

-- 5. When someone signs up, create their player profile straight away from the name they
--    chose. If the name is missing, invalid or taken, no profile is made and the game asks
--    for a name on first login - sign-up itself never fails because of this.
create or replace function checkline_private.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_name text := btrim(regexp_replace(coalesce(new.raw_user_meta_data ->> 'display_name', ''), '\s+', ' ', 'g'));
begin
  if char_length(v_name) between 2 and 24 and v_name !~ '[[:cntrl:]]' then
    begin
      insert into public.cl_profiles (id, display_name) values (new.id, v_name)
      on conflict do nothing;
    exception when others then
      null;  -- never block a sign-up
    end;
  end if;
  return new;
end
$$;
revoke all on function checkline_private.handle_new_user() from public, anon, authenticated;

drop trigger if exists cl_on_auth_user_created on auth.users;
create trigger cl_on_auth_user_created
  after insert on auth.users
  for each row execute function checkline_private.handle_new_user();
