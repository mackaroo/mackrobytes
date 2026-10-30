-- MackroBytes: run this once in Supabase → SQL Editor → New query → Run.
-- Everything (items, settings, expenses, sorting, donations) lives in one
-- table of JSON documents, grouped by collection name.

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
