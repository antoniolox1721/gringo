# Gringo Online Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A remote, browser-based, 2–4 player version of the card game Gringo, front end on GitHub Pages and rules enforced server-side on Supabase.

**Architecture:** A pure ES-module rules engine (`engine.js`) holds all game state and rules, with no I/O. Supabase Edge Functions load the state from a private table, apply one action through the engine using optimistic version checking (first request wins), save it, and broadcast `{version}` on a Realtime channel. Clients never receive hidden cards: every response and refetch goes through `viewFor(state, playerId)`. The front end is static HTML/CSS/JS served from GitHub Pages.

**Tech Stack:** Plain JS (ES modules), `node:test` (Node 20), Supabase (Postgres + Edge Functions on Deno + Realtime broadcast), `@supabase/supabase-js` v2 from a CDN, Playwright for the end-to-end check, GitHub Actions for Pages.

**Spec:** the playback agreed in chat on 2026-10-24 (no written design doc, per CLAUDE.md). Every rule below comes from the user unless marked **[call]**, which means it is my decision and open to override.

## Global Constraints

- 2–4 players per room; one standard 52-card deck plus 2 jokers (54 cards).
- Values: A=1, 2–10 face value, J=10, Q=10, K=10, red K (♥♦) = -3, joker = 0.
- Each player starts with 4 face-down cards and may peek at exactly 2 of them, only during setup.
- Turn: draw 1 card, look at it, then either swap it with one own card (the old card goes to the discard pile) or discard it.
- Powers fire when a J/Q/K lands on the discard pile by any route (draw-and-discard, swap-out, slap). J: blind swap one of your cards with one of another player's. Q: look at one card (yours or someone else's). K (any colour): look at another player's card, then choose to swap or not.
- Slap: any player may place a card from their hand onto the discard pile if it matches the top card's rank. Only the first slap per discard card counts (a slapped card inherits the "claimed" flag). A wrong or late slap gives the slapper one penalty card, face down.
- Slapping an opponent's card: the card goes to the pile, and the slapper gives that opponent one of their own cards, blind, into the vacated slot **[call]**. Wrong or late: penalty to the slapper only.
- End: a player reaching 0 cards, or calling "gringo" (own turn, in place of the turn, nothing else that turn), triggers one more full round for everyone else; the gringo caller does not play it. The caller cannot be swapped with (J/K) afterwards but can still be slapped on.
- Winner = lowest total. A 0-card player scores 0 but is still compared. Ties are settled by rock-paper-scissors between the tied players.
- Single hand per room, no cross-hand scoreboard. Discard pile reshuffles into the deck when the deck is empty (top discard card stays).
- Hand slots are positional and never shift: removed cards leave `null`, penalty cards append a new slot **[call]**.
- Pending powers triggered by a slap are resolved by the slapper before the turn player may act, queued in slap order **[call]**.
- No secret ever in the repo or the page except the Supabase URL and anon key, which are public by design. The service-role key lives only in the Edge Function environment (Supabase-managed).
- Authentication: no accounts. A player holds a random `playerToken` (UUID) in `localStorage`; the server stores only its SHA-256 hash.

## Review Focus

1. Two slaps on the same pile card arriving together: only one succeeds, the other gets a penalty card (Task 4, concurrency test in Task 6).
2. Someone drawing when the deck and discard pile are both nearly empty: reshuffle and keep the top discard (Task 3).
3. A player at 0 cards being targeted by J/Q/K or slapped on: no crash, power fizzles gracefully (Task 4).
4. Page refresh or reconnect mid-game: the player rejoins via the stored token and sees the current state, including their own pending peek (Task 7).
5. A player leaving or going offline on their turn: the room does not deadlock forever; the host can kick that player (Task 6, Task 7).

---

## File Structure

```
package.json
supabase/config.toml                        (npx supabase init)
supabase/migrations/0001_games.sql
supabase/functions/_shared/engine.js        pure rules, no imports
supabase/functions/_shared/store.js         load/CAS-save/broadcast helpers
supabase/functions/room/index.ts            create | join | start | kick | view
supabase/functions/act/index.ts             all in-game actions
tests/engine.*.test.js                      node:test, one file per area
tests/helpers.js                            stacked-deck state builders
web/index.html, web/style.css
web/config.js                               SUPABASE_URL, SUPABASE_ANON_KEY (public)
web/api.js                                  fetch wrappers + realtime subscribe
web/ui.js                                   render(view) + event wiring
.github/workflows/pages.yml
e2e/two-players.spec.js
```

Engine state shape (decided here, used by every task):

```js
state = {
  version: number,
  phase: 'lobby'|'setup'|'turns'|'final'|'rps'|'done',
  players: [{ id, name, hand: (Card|null)[], seenSlots: number[], gringo: boolean, connected: boolean }],
  deck: Card[], discard: Card[], discardClaimed: boolean,
  turn: number,                       // index into players
  drawn: Card|null,                   // card currently held by turn player, unseen by others
  pending: [{ type:'J'|'Q'|'K', by: playerId }],
  finalLeft: playerId[]|null,         // players who still owe one more turn
  endedBy: { id, reason:'empty'|'gringo' }|null,
  result: { totals: Record<id,number>, winners: id[] }|null,
  rps: { players: id[], picks: Record<id,'r'|'p'|'s'> }|null,
}
// Card = { rank: 'A'|'2'..'10'|'J'|'Q'|'K'|'JOKER', suit: 'S'|'H'|'D'|'C'|null, uid: number }
```

---

### Task 1: Project scaffold, deck and scoring

**Files:**
- Create: `package.json` (`"type":"module"`, script `"test":"node --test tests/"`), `supabase/functions/_shared/engine.js`, `tests/helpers.js`, `tests/engine.deck.test.js`

**Interfaces:**
- Produces: `buildDeck(): Card[]` (54 cards, unique `uid`), `shuffle(cards: Card[], rng?: () => number): Card[]` (does not mutate input), `cardValue(card: Card): number`, `handTotal(hand: (Card|null)[]): number`.
- Produces (tests/helpers.js): `stackedGame(opts: { players: string[], hands: Card[][], deck?: Card[], discard?: Card[], turn?: number }): State` returning a `phase:'turns'` state; `c(rank, suit?): Card` shorthand with auto uid.

- [ ] **Step 1: Write failing tests** in `tests/engine.deck.test.js`: `buildDeck has 54 cards incl. exactly 2 jokers and unique uids`; `cardValue` for `A`=1, `7`=7, `10`=10, `J`/`Q`=10, `K♠`=10, `K♥`=-3, `K♦`=-3, `JOKER`=0; `handTotal ignores nulls`; `shuffle keeps all cards and does not mutate input`.
- [ ] **Step 2:** `npm test` → FAIL (module missing).
- [ ] **Step 3:** Implement the four functions in `engine.js`. `shuffle` is Fisher–Yates over a copy.
- [ ] **Step 4:** `npm test` → all PASS.

### Task 2: Room lifecycle and setup peeks

**Files:** Modify `engine.js`; Test `tests/engine.setup.test.js`

**Interfaces:**
- Consumes: Task 1 functions.
- Produces:
  - `createGame(hostId: string, hostName: string): State` (`phase:'lobby'`)
  - `addPlayer(state, id, name): State` (throws `Error('room full')` at 4, `Error('already started')` after start)
  - `removePlayer(state, id): State` (lobby: removes; in-game: sets `connected:false` and, if it is that player's turn, auto-skips; **[call]** used for kick)
  - `startGame(state, byId, rng?): State` (host only, ≥2 players, deals 4 each, flips first discard, `phase:'setup'`)
  - `peekSetup(state, id, slots: number[]): { state: State, seen: Card[] }` (exactly 2 distinct slots 0–3, once per player; when every connected player has peeked, `phase:'turns'`, `turn` = 0)
  - `viewFor(state, playerId): View` — redacted: others' hands show only `{ slot, empty:boolean }`; own hand shows only slots in the player's current `viewable` set (just-peeked or just-power-revealed, cleared on that player's next action) — never the deck; `drawn` visible only to the turn player.
- All functions are pure: return a new state with `version+1`, never mutate input.

- [ ] **Step 1: Write failing tests:** `third player joins, fifth rejected`; `non-host cannot start`; `start with 1 player throws`; `deal gives 4 cards each and a discard card`; `peekSetup returns the two cards and rejects a second peek`; `phase becomes turns after all peeked`; `viewFor never contains another player's card objects` (JSON-stringify the view and assert no opponent `uid` appears); `viewFor hides deck contents`.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** run → PASS.

### Task 3: Turn — draw, keep or discard, reshuffle

**Files:** Modify `engine.js`; Test `tests/engine.turn.test.js`

**Interfaces:**
- Produces: `draw(state, id): { state, card: Card }` (turn player only; no pending powers; reshuffles discard-minus-top into deck when empty; if still empty throws `Error('no cards')`); `keep(state, id, slot): State` (swaps `drawn` into `slot`, old card to discard, triggers `onDiscard`); `discardDrawn(state, id): State`; internal `onDiscard(state, card, byId): State` which sets `discardClaimed=false`, pushes a `pending` entry for J/Q/K, and advances the turn only when `pending` is empty and the discard was part of a turn action; `nextTurn(state): State` skips disconnected players.
- Convention: after `keep`/`discardDrawn`, the turn advances once all `pending` entries are resolved (Task 4 resolves them).

- [ ] **Step 1: Write failing tests:** `draw then discard moves card to pile and advances turn`; `keep swaps and discards old card`; `keep into an emptied slot (null) is rejected`; `non-turn player cannot draw`; `draw with empty deck reshuffles pile but keeps top discard`; `draw with deck and pile exhausted throws`; `discarding a J queues a pending J and does not advance turn`; `discarding a 5 advances turn`; `disconnected players are skipped`.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** run → PASS.

### Task 4: Powers and slaps

**Files:** Modify `engine.js`; Test `tests/engine.powers.test.js`, `tests/engine.slap.test.js`

**Interfaces:**
- Produces:
  - `usePower(state, id, args): { state, seen?: Card }` — `args`:
    - `{ type:'J', mine:number, targetId:string, theirs:number }` (blind swap, rejected if target has `gringo:true` or the slot is `null`)
    - `{ type:'Q', targetId:string, slot:number }` (reveal one card to `id`, goes in `viewable`)
    - `{ type:'K', targetId:string, slot:number, mine?:number }` (reveal; second call `confirmKing` swaps or declines)
  - `confirmKing(state, id, swapWithSlot: number|null): State`
  - `skipPower(state, id): State` — **[call]** needed when the target is unavailable (0 cards, gringo-protected); the power is lost.
  - `slap(state, id, { ownerId: string, slot: number, giveSlot?: number }): { state, ok: boolean }`:
    - the card is `hand[slot]` of `ownerId` (own or opponent's); matches when `rank` equals the top discard rank (jokers match jokers, suits ignored);
    - ok + unclaimed → card to pile, `discardClaimed=true`, slot becomes `null`; if `ownerId !== id`, `giveSlot` (the slapper's own slot) moves into the vacated slot; triggers `onDiscard` for J/Q/K with `by:id`, but the turn does not advance because of a slap;
    - otherwise → `ok:false`, slapper gets one penalty card appended to their hand from the deck.
  - If a slap empties a hand (all `null`), `endedBy` is set per Task 5.

- [ ] **Step 1: Write failing tests (powers):** `J swaps two slots blindly`; `J on a gringo-called player is rejected`; `Q reveals only to the user, nobody else's view changes`; `K reveal then decline leaves hands unchanged`; `K reveal then swap exchanges`; `power against a player with an all-null hand can be skipped`; `turn advances only after pending is empty`.
- [ ] **Step 2: Write failing tests (slap):** `matching own card removes it`; `second slap on the same pile card is penalised`; `slap of rank mismatch gives penalty card`; `slapping an opponent's matching card moves it, slapper gives a card into the vacated slot`; `wrong slap on an opponent costs only the slapper`; `slapped J/Q/K queues a pending power for the slapper`; `a slapped card inherits claimed so a third player is penalised`; `joker matches joker`; `slap with an empty deck still gives a penalty from the reshuffled pile or is a no-op if none exists` (no crash).
- [ ] **Step 3:** run → FAIL. **Step 4:** implement. **Step 5:** run → PASS.

### Task 5: Endings, scoring, rock-paper-scissors

**Files:** Modify `engine.js`; Test `tests/engine.end.test.js`

**Interfaces:**
- Produces:
  - `callGringo(state, id): State` — turn player only, only before drawing; sets `gringo:true`, `endedBy`, `finalLeft` = all other connected players, turn advances.
  - `checkZero(state, id): State` — called inside `slap`/`keep` after hand changes; if `id` has all-`null` hand and `endedBy` is empty, sets `endedBy:{id,reason:'empty'}`, `finalLeft` = all others.
  - `nextTurn` (Task 3) removes the current player from `finalLeft` after each of their turns; when empty → `finishGame`.
  - `finishGame(state): State` — computes `result.totals` via `handTotal`, `winners` = lowest; if more than one winner → `phase:'rps'` with `rps.players = winners`, else `phase:'done'`.
  - `submitRps(state, id, pick): State` — when all picks are in: a single winner → `phase:'done'`, `result.winners=[w]`; a draw or a 3-way split with no single winner → clears picks (`rps.round+1`) and repeats; a 2-of-3 win eliminates the loser from `rps.players`.
  - `viewFor` reveals all hands when `phase` is `'done'`.
- All rules: the gringo caller takes no further turn; the game ends after every other player has had exactly one turn.

- [ ] **Step 1: Write failing tests:** `gringo gives each other player exactly one more turn and the caller none`; `gringo only on own turn before drawing`; `reaching 0 cards by slap starts the final round`; `0-card player is still compared (red king hand beats 0)`; `lowest total wins`; `tie → rps phase with only tied players`; `rps rock beats scissors ends game`; `rps same pick repeats`; `three-way different picks repeats`; `hands are revealed in view only when done`; `a disconnected player's turn is skipped in the final round and does not block ending`.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** `npm test` → every engine test PASS.

### Task 6: Supabase backend (storage, atomic actions, realtime)

**Files:**
- Create: `supabase/migrations/0001_games.sql`, `supabase/functions/_shared/store.js`, `supabase/functions/room/index.ts`, `supabase/functions/act/index.ts`, `tests/store.test.js`
- Run: `npx supabase init` (creates `supabase/config.toml`)

**Interfaces:**
- DB: `games(code text primary key, state jsonb not null, tokens jsonb not null, version int not null default 0, updated_at timestamptz default now())`. Row-level security on with **no policies** (only the service role used by the Edge Functions can read/write); `tokens` maps `playerId → sha256(token)`.
- `store.js` produces: `loadGame(db, code): { state, tokens, version }`; `saveIfVersion(db, code, expectedVersion, nextState): Promise<boolean>` implemented as `update ... where code=$1 and version=$2` returning whether a row changed; `applyWithRetry(db, code, fn: (state) => State|{state,extra}, tries=5)`; `hashToken(token): Promise<string>`; `broadcast(code, version)` posts `{event:'changed', payload:{version}}` to the Realtime REST broadcast endpoint with the service-role key from `Deno.env`.
- `room` endpoints (POST JSON): `create {name} → {code, playerId, token}`; `join {code, name} → {playerId, token}`; `start {code, token}`; `kick {code, token, targetId}` (host only); `view {code, token} → View`. Codes are 4 uppercase letters, regenerated on collision.
- `act` endpoint: `{code, token, action: 'peekSetup'|'draw'|'keep'|'discard'|'power'|'confirmKing'|'skipPower'|'slap'|'gringo'|'rps', args}` → `{view, seen?}`. Resolves the token to a player id by hash, then calls the matching engine function inside `applyWithRetry`; engine `Error`s become `400 {error}`. After a successful save it broadcasts the new version.
- Both functions deployed with `--no-verify-jwt` (anonymous players); CORS allows `*`.

- [ ] **Step 1: Write failing test** `tests/store.test.js` using an in-memory fake `db` with the same `loadGame`/`saveIfVersion` interface: `two concurrent slaps on the same pile card leave exactly one ok and one penalty` (run both `applyWithRetry` calls with `Promise.all`; final state has `discardClaimed:true`, one slapper hand shorter, the other longer); `applyWithRetry gives up after 5 conflicts`; `a bad token is rejected` (`403`).
- [ ] **Step 2:** run → FAIL. **Step 3:** implement `store.js`, then the migration and both functions.
- [ ] **Step 4:** run → PASS.
- [ ] **Step 5 (user action, auth cannot be done by me):** the user creates a free Supabase project, then runs `! npx supabase login`, `! npx supabase link --project-ref <ref>`, `! npx supabase db push`, `! npx supabase functions deploy room act --no-verify-jwt`. Record the project URL and anon key for Task 7. Verify with `curl -s -X POST $URL/functions/v1/room -H 'content-type: application/json' -d '{"action":"create","name":"t"}'` → JSON containing a 4-letter `code`.

### Task 7: Web client (static, GitHub Pages)

**Files:** Create `web/index.html`, `web/style.css`, `web/config.js`, `web/api.js`, `web/ui.js`

**Interfaces:**
- Consumes: the `room`/`act` JSON endpoints and `View` shape from Tasks 2–6.
- Produces:
  - `api.js`: `call(fn: 'room'|'act', body): Promise<object>`; `subscribe(code, onChange: () => void): () => void` (Realtime broadcast channel `game:<code>` via supabase-js from `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js`; on any change, or on reconnect, it refetches `view`).
  - `ui.js`: `render(view)` for lobby (code, player list, host Start button), setup (tap 2 own slots to peek, then a "Peeking done" wait state), turns (own 4+ slots face down with a transient reveal for `viewable`, deck, discard top, Draw / Keep-in-slot / Discard / Gringo buttons for the turn player, a Slap button that arms slot selection for any player on any hand), pending powers (target pickers), final-round banner, RPS picker, and result screen showing all hands and totals.
  - Rejoin: `localStorage` keys `gringo.code`, `gringo.playerId`, `gringo.token`; on load, if present, call `view` and resume.
- Layout works at phone width (16px gutters, no horizontal scroll); dark/light via `prefers-color-scheme`.

- [ ] **Step 1:** build the pages against the deployed backend (dev `config.js` points to the user's project).
- [ ] **Step 2:** verify manually in two browser profiles: create → join → start → peek → full turn → slap race → gringo → result.
- [ ] **Step 3:** reload mid-game in one tab and confirm the state resumes (Review Focus 4).

### Task 8: End-to-end check and GitHub Pages deploy

**Files:** Create `e2e/two-players.spec.js`, `.github/workflows/pages.yml`

**Interfaces:**
- Consumes: the deployed backend and `web/`.
- The e2e spec uses two Playwright browser contexts (host and guest): host creates a room, guest joins by code, both peek, host draws and discards, guest slaps wrongly and sees their hand grow by 1, host calls gringo on a later turn, the guest takes their last turn, both see the result screen. It asserts, via `page.content()`, that the host's DOM never contains the guest's hidden card faces.
- Workflow: on push to `main`, upload `web/` and deploy with `actions/upload-pages-artifact` and `actions/deploy-pages`.

- [ ] **Step 1:** write the spec; run `npx playwright test e2e/` → PASS against the live backend.
- [ ] **Step 2:** write the workflow. **Step 3 (user action):** the user creates the GitHub repo, enables Pages → "GitHub Actions" source, and pushes. I do not commit or push unless asked.
- [ ] **Step 4:** open the Pages URL on a phone and a PC and play one full round together.

---

## Self-review notes

- Spec coverage: setup/peek (T2), draw/keep/discard/reshuffle (T3), powers incl. off-turn slaps (T4), slap rules incl. opponent and claimed (T4), both endings and RPS (T5), server-first-wins and hidden info (T6), remote UI on Pages (T7, T8), 2–4 players (T2).
- Names used across tasks: `viewFor`, `applyWithRetry`, `callGringo`, `usePower`, `confirmKing`, `skipPower`, `submitRps` — all defined in the task that produces them.
- Known open **[call]** items for the user to veto: slot-stable hands, opponent-slap gives into vacated slot, pending powers queue ahead of the turn player, `skipPower` for unavailable targets, host kick for offline players.
