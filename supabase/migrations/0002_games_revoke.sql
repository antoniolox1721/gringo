-- Defence in depth: RLS already denies anon/authenticated (no policies); also drop the table grants.
revoke all on public.games from anon, authenticated;
