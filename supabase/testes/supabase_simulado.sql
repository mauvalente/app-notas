-- =====================================================================
-- APP Notas — Supabase simulado num Postgres local (só para testes)
-- Cria o mínimo que as migrations esperam: papéis anon/authenticated,
-- auth.users, auth.uid(), auth.jwt(), schemas extensions e storage e a
-- publicação do tempo real. NÃO rodar no Supabase de verdade.
-- =====================================================================
-- Simula o mínimo do Supabase
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
create schema auth; grant usage on schema auth to anon, authenticated;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
grant execute on all functions in schema auth to anon, authenticated;
create schema extensions; grant usage on schema extensions to anon, authenticated;
create schema storage; create table storage.buckets (id text primary key, name text, public boolean);
create table storage.objects (id serial, bucket_id text, name text); alter table storage.objects enable row level security;
create publication supabase_realtime;
