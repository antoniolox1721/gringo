-- Heartbeat per player ({playerId: epoch ms}), written by the `view` poll, never by clients.
alter table public.games add column seen jsonb not null default '{}';

-- Rooms created before presence tracking cannot notice an abandoned player: end them all.
delete from public.games;
