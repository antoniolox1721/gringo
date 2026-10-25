alter table public.games add column created_at timestamptz not null default now();

-- Clears rooms older than p_lonely_ms where fewer than two players have polled within that time.
-- Mirrors engine.lonelyRoom; `seen` holds epoch-ms heartbeats per player.
create or replace function public.purge_lonely_rooms(p_now_ms bigint, p_lonely_ms bigint)
returns void
language sql
as $$
  delete from public.games g
   where g.created_at < now() - make_interval(secs => p_lonely_ms / 1000.0)
     and (select count(*) from jsonb_each_text(g.seen) e where e.value::numeric > p_now_ms - p_lonely_ms) < 2;
$$;

revoke all on function public.purge_lonely_rooms(bigint, bigint) from public, anon, authenticated;
grant execute on function public.purge_lonely_rooms(bigint, bigint) to service_role;
