-- Minimal stand-in for the parts of Supabase that setup.sql relies on, so the script can be
-- exercised on a plain local PostgreSQL by scripts/verify-sql.mjs. Never run this on Supabase.
create role anon nologin;
create role authenticated nologin;
create schema auth;
create table auth.users (id uuid primary key, is_anonymous boolean not null default true);
-- Same contract as Supabase's auth.uid(): the `sub` claim of the caller's JWT.
create function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(current_setting('request.jwt.claim.sub', true), ''), '')::uuid
$$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
grant usage on schema public to anon, authenticated;
create publication supabase_realtime;
