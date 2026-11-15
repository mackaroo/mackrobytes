-- MackroBytes: run this once in Supabase → SQL Editor → New query → Run.
-- Everything (items and shop settings) lives in one table of JSON documents,
-- grouped by collection name.

create table if not exists public.docs (
  coll        text not null,
  id          text not null,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  primary key (coll, id)
);

-- Only signed-in users can see or change anything. Turn off public sign-ups
-- (Authentication → Sign In / Providers → "Allow new users to sign up") so
-- only the account you create yourself can sign in.
alter table public.docs enable row level security;

drop policy if exists "signed-in users manage docs" on public.docs;
create policy "signed-in users manage docs" on public.docs
  for all to authenticated using (true) with check (true);

-- Live sync between your iPhone, Mac and PC.
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;

-- Private photo bucket.
insert into storage.buckets (id, name, public)
values ('photos', 'photos', false)
on conflict (id) do nothing;

drop policy if exists "signed-in users read photos" on storage.objects;
create policy "signed-in users read photos" on storage.objects
  for select to authenticated using (bucket_id = 'photos');

drop policy if exists "signed-in users upload photos" on storage.objects;
create policy "signed-in users upload photos" on storage.objects
  for insert to authenticated with check (bucket_id = 'photos');

drop policy if exists "signed-in users delete photos" on storage.objects;
create policy "signed-in users delete photos" on storage.objects
  for delete to authenticated using (bucket_id = 'photos');

-- ===== eBay auto-sync (optional; see SETUP.md → "eBay auto-sync") =====
-- Run this part once, after the ebay-sync Edge Function exists.

-- Private storage for the eBay sign-in token and sync bookkeeping.
-- Row security is on with no policies, so only the Edge Function (service role) can read it, never the app.
create table if not exists public.private_kv (
  key         text primary key,
  value       jsonb,
  updated_at  timestamptz not null default now()
);
alter table public.private_kv enable row level security;
revoke all on public.private_kv from anon, authenticated;

-- Runs the sync every 15 minutes. Before running this, store the same SYNC_SECRET you gave the function:
--   select vault.create_secret('PASTE-YOUR-SYNC-SECRET', 'ebay_sync_secret');
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.unschedule('ebay-sync') where exists (select 1 from cron.job where jobname = 'ebay-sync');
select cron.schedule('ebay-sync', '*/15 * * * *', $$
  select net.http_post(
    url := 'https://vjxoovvddupxzxmxrspl.supabase.co/functions/v1/ebay-sync',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'ebay_sync_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000);
$$);

-- Depop auto-sync: reads Depop sale emails (Gmail, read-only) every 15 minutes.
-- The job proves itself with a random token made here in the database (nobody copies a secret).
create extension if not exists pgcrypto;
insert into public.private_kv (key, value) values ('cron_token', jsonb_build_object('token', encode(extensions.gen_random_bytes(32), 'hex')))
  on conflict (key) do nothing;
select cron.unschedule('depop-sync') where exists (select 1 from cron.job where jobname = 'depop-sync');
select cron.schedule('depop-sync', '*/15 * * * *', $$
  select net.http_post(
    url := 'https://vjxoovvddupxzxmxrspl.supabase.co/functions/v1/depop-sync',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-token', (select value->>'token' from public.private_kv where key = 'cron_token')),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000);
$$);
