create table if not exists public.charge_state (
  user_key text primary key,
  state jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.charge_state enable row level security;

drop policy if exists "service role can manage charge_state" on public.charge_state;
create policy "service role can manage charge_state"
on public.charge_state
for all
to service_role
using (true)
with check (true);
