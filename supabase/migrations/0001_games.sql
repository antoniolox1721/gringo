create table public.games (
  code text primary key,
  state jsonb not null,
  tokens jsonb not null,
  version int not null default 0,
  updated_at timestamptz not null default now()
);

-- RLS on with no policies: only the service role (Edge Functions) can read or write.
alter table public.games enable row level security;
