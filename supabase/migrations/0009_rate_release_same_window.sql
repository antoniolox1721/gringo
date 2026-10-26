-- A released reservation only counts back if the window it was made in is still the current one.
-- Otherwise (the window rolled over meanwhile) the release is ignored, so a request that straddles a
-- boundary cannot take a miss away from the next window.
create or replace function public.rate_release(p_ip text, p_now_ms bigint, p_window_ms bigint)
returns void
language sql
as $$
  update public.rate_hits
     set hits = greatest(0, hits - 1)
   where key = 'miss:' || p_ip
     and window_start <= p_now_ms
     and window_start + p_window_ms > p_now_ms;
$$;

revoke all on function public.rate_release(text, bigint, bigint) from public, anon, authenticated;
grant execute on function public.rate_release(text, bigint, bigint) to service_role;
