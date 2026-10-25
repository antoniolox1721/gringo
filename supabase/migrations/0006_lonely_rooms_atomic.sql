-- The cleanup can now target one room (p_code), so a poll deletes it in the same statement that
-- re-checks who is present, instead of deleting on a stale read.
drop function if exists public.purge_lonely_rooms(bigint, bigint);

create or replace function public.purge_lonely_rooms(p_now_ms bigint, p_lonely_ms bigint, p_code text default null)
returns void
language sql
as $$
  delete from public.games g
   where (p_code is null or g.code = p_code)
     and g.created_at < now() - make_interval(secs => p_lonely_ms / 1000.0)
     and (select count(*) from jsonb_each_text(g.seen) e where e.value::numeric > p_now_ms - p_lonely_ms) < 2;
$$;

revoke all on function public.purge_lonely_rooms(bigint, bigint, text) from public, anon, authenticated;
grant execute on function public.purge_lonely_rooms(bigint, bigint, text) to service_role;
