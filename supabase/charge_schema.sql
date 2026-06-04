create table if not exists public.charge_state (
  session_id text primary key,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists charge_state_updated_at_idx on public.charge_state(updated_at desc);
create index if not exists charge_state_user_email_idx on public.charge_state ((state->'user'->>'email'));

-- Storage bucket must exist in Supabase UI as private bucket named: resumes
