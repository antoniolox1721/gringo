-- Per-client request limits (fixed windows), kept in the database because Edge Functions are stateless.
create table if not exists public.rate_hits (
  key text primary key,
  window_start bigint not null,
  hits integer not null
);
alter table public.rate_hits enable row level security;
revoke all on public.rate_hits from public, anon, authenticated;

-- Adds p_inc to a counter and returns the count inside the current window (p_inc = 0 only reads it).
create or replace function public.rate_bump(p_key text, p_now_ms bigint, p_window_ms bigint, p_inc integer default 1)
returns integer
language plpgsql
as $$
declare h integer;
begin
  insert into public.rate_hits as r (key, window_start, hits) values (p_key, p_now_ms, p_inc)
  on conflict (key) do update set
    window_start = case when r.window_start + p_window_ms <= p_now_ms then p_now_ms else r.window_start end,
    hits = case when r.window_start + p_window_ms <= p_now_ms then p_inc else r.hits + p_inc end
  returning r.hits into h;
  return h;
end;
$$;

-- One round trip per request: counts it overall and under p_kind (if any), and reads the misses so far.
create or replace function public.rate_gate(p_ip text, p_kind text, p_now_ms bigint, p_window_ms bigint)
returns jsonb
language plpgsql
as $$
declare a integer; k integer := 0; m integer;
begin
  a := public.rate_bump('all:' || p_ip, p_now_ms, p_window_ms, 1);
  if p_kind <> '' then k := public.rate_bump(p_kind || ':' || p_ip, p_now_ms, p_window_ms, 1); end if;
  m := public.rate_bump('miss:' || p_ip, p_now_ms, p_window_ms, 0);
  if random() < 0.01 then delete from public.rate_hits where window_start < p_now_ms - 3600000; end if;
  return jsonb_build_object('all', a, 'kind', k, 'miss', m);
end;
$$;

create or replace function public.rate_miss(p_ip text, p_now_ms bigint, p_window_ms bigint)
returns void
language sql
as $$
  select public.rate_bump('miss:' || p_ip, p_now_ms, p_window_ms, 1);
$$;

revoke all on function public.rate_bump(text, bigint, bigint, integer) from public, anon, authenticated;
revoke all on function public.rate_gate(text, text, bigint, bigint) from public, anon, authenticated;
revoke all on function public.rate_miss(text, bigint, bigint) from public, anon, authenticated;
grant execute on function public.rate_bump(text, bigint, bigint, integer) to service_role;
grant execute on function public.rate_gate(text, text, bigint, bigint) to service_role;
grant execute on function public.rate_miss(text, bigint, bigint) to service_role;

-- A lasting record of games started (rooms are deleted when empty, so they cannot be counted afterwards).
-- Only a time and how many players sat down: no names, ids or addresses.
create table if not exists public.play_log (
  id bigint generated always as identity primary key,
  started_at timestamptz not null default now(),
  players integer not null
);
alter table public.play_log enable row level security;
revoke all on public.play_log from public, anon, authenticated;
