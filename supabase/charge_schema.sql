-- Run this once in Supabase SQL Editor.
-- It creates a simple JSON state table used by the Vercel API patch.

create table if not exists public.charge_state (
  user_key text primary key,
  state jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.charge_state enable row level security;

-- For MVP server-side access only. The service role key bypasses RLS.
-- Do not expose service role key in the browser.

create index if not exists charge_state_updated_at_idx on public.charge_state (updated_at desc);
