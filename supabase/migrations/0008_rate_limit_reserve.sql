-- Misses are now reserved before a request runs and released when it succeeds, so a burst of
-- concurrent guesses cannot all slip past a check that only counted afterwards.
create or replace function public.rate_bump(p_key text, p_now_ms bigint, p_window_ms bigint, p_inc integer default 1)
returns integer
language plpgsql
as $$
declare h integer;
begin
  insert into public.rate_hits as r (key, window_start, hits) values (p_key, p_now_ms, greatest(p_inc, 0))
  on conflict (key) do update set
    window_start = case when r.window_start + p_window_ms <= p_now_ms then p_now_ms else r.window_start end,
    hits = greatest(0, case when r.window_start + p_window_ms <= p_now_ms then p_inc else r.hits + p_inc end)
  returning r.hits into h;
  return h;
end;
$$;

-- Counts the request overall and under p_kind, and reserves one "miss" for it (included in the answer).
create or replace function public.rate_gate(p_ip text, p_kind text, p_now_ms bigint, p_window_ms bigint)
returns jsonb
language plpgsql
as $$
declare a integer; k integer := 0; m integer;
begin
  a := public.rate_bump('all:' || p_ip, p_now_ms, p_window_ms, 1);
  if p_kind <> '' then k := public.rate_bump(p_kind || ':' || p_ip, p_now_ms, p_window_ms, 1); end if;
  m := public.rate_bump('miss:' || p_ip, p_now_ms, p_window_ms, 1);
  if random() < 0.01 then delete from public.rate_hits where window_start < p_now_ms - 3600000; end if;
  return jsonb_build_object('all', a, 'kind', k, 'miss', m);
end;
$$;

-- Gives the reservation back: the request named a room and token that exist.
create or replace function public.rate_release(p_ip text, p_now_ms bigint, p_window_ms bigint)
returns void
language sql
as $$
  select public.rate_bump('miss:' || p_ip, p_now_ms, p_window_ms, -1);
$$;

drop function if exists public.rate_miss(text, bigint, bigint);

revoke all on function public.rate_bump(text, bigint, bigint, integer) from public, anon, authenticated;
revoke all on function public.rate_gate(text, text, bigint, bigint) from public, anon, authenticated;
revoke all on function public.rate_release(text, bigint, bigint) from public, anon, authenticated;
grant execute on function public.rate_bump(text, bigint, bigint, integer) to service_role;
grant execute on function public.rate_gate(text, text, bigint, bigint) to service_role;
grant execute on function public.rate_release(text, bigint, bigint) to service_role;
