-- Atomic heartbeat: merges only the caller's entry (p_caller) and defaults for players with no entry
-- yet (p_missing, never overriding an existing one), so concurrent polls cannot overwrite each other.
create or replace function public.touch_seen(p_code text, p_missing jsonb, p_caller jsonb)
returns void
language sql
as $$
  update public.games
     set seen = p_missing || seen || p_caller, updated_at = now()
   where code = p_code;
$$;

-- Only the Edge Functions (service role) may call it; clients must never write presence directly.
revoke all on function public.touch_seen(text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.touch_seen(text, jsonb, jsonb) to service_role;
