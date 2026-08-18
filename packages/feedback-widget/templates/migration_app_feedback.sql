-- 全社標準 アプリ内フィードバック。繰り返し実行可能。
create table if not exists public.app_feedback (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'bug' check (kind in ('bug','request')),
  title text not null,
  body text not null,
  page_path text,
  submitter text,
  submitter_email text,
  status text not null default 'new' check (status in ('new','triaged','in_progress','done','rejected')),
  priority text not null default 'normal' check (priority in ('low','normal','high')),
  admin_note text,
  resolved_ref text,
  screenshot_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.app_feedback add column if not exists screenshot_path text;
alter table public.app_feedback enable row level security;
create index if not exists app_feedback_status_idx on public.app_feedback (status, created_at desc);

insert into storage.buckets (id, name, public)
values ('feedback-screenshots', 'feedback-screenshots', false)
on conflict (id) do nothing;

drop policy if exists "auth read feedback-screenshots" on storage.objects;
create policy "auth read feedback-screenshots" on storage.objects
  for select to authenticated using (bucket_id = 'feedback-screenshots');
drop policy if exists "auth write feedback-screenshots" on storage.objects;
create policy "auth write feedback-screenshots" on storage.objects
  for insert to authenticated with check (bucket_id = 'feedback-screenshots');
drop policy if exists "auth modify feedback-screenshots" on storage.objects;
create policy "auth modify feedback-screenshots" on storage.objects
  for update to authenticated using (bucket_id = 'feedback-screenshots')
  with check (bucket_id = 'feedback-screenshots');
