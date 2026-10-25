import { test, expect } from '@playwright/test';

const VIEWPORT = { width: 390, height: 844 };

async function open(browser, baseURL, label, errors) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${label} console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${label} pageerror: ${e.message}`));
  await page.goto(`${baseURL}/?mock=1`);
  return { context, page };
}

const session = (page) => page.evaluate(() => ({
  code: localStorage.getItem('gringo.code'),
  playerId: localStorage.getItem('gringo.playerId'),
  token: localStorage.getItem('gringo.token'),
}));

async function noHScroll(page) {
  const w = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(w.sw, 'horizontal scroll').toBeLessThanOrEqual(w.cw);
}

const GLYPH = { S: '♠', H: '♥', D: '♦', C: '♣' };
// Faces of the host's peeked slots 0 and 1 as the UI prints them, e.g. '5♠'.
const hostFaces = (cards) => cards.hands[0].slice(0, 2).map((c) => `${c.slice(0, -1)}${GLYPH[c.slice(-1)]}`);

const slot = (page, ownerId, n) => page.locator(`.slot[data-owner="${ownerId}"][data-slot="${n}"]`);

async function stack(request, code, body) {
  const r = await request.post('/__test/stack', { data: { code, ...body } });
  expect(r.ok()).toBeTruthy();
}

// Creates a room, joins a guest, starts, stacks the cards, and has both peek slots 0 and 1.
async function setupGame(browser, baseURL, request, errors, cards) {
  const host = await open(browser, baseURL, 'host', errors);
  const guest = await open(browser, baseURL, 'guest', errors);
  await host.page.fill('#name', 'Hanna');
  await host.page.click('[data-act=create]');
  await expect(host.page.locator('#roomcode')).toHaveText(/^[A-Z]{4}$/);
  const code = (await host.page.locator('#roomcode').textContent()).trim();
  await guest.page.fill('#name', 'Gus');
  await guest.page.fill('#code', code);
  await guest.page.click('[data-act=join]');
  await expect(host.page.locator('.plist li')).toHaveCount(2);
  await expect(guest.page.locator('.plist li')).toHaveCount(2);
  await host.page.click('[data-act=start]');
  await expect(host.page.getByText('Peek at 2 of your 4 cards')).toBeVisible();
  await expect(guest.page.getByText('Peek at 2 of your 4 cards')).toBeVisible();
  await stack(request, code, cards);
  const hs = await session(host.page);
  const gs = await session(guest.page);
  for (const [p, s] of [[host.page, hs], [guest.page, gs]]) {
    await slot(p, s.playerId, 0).click();
    await slot(p, s.playerId, 1).click();
    await p.click('[data-act=peek]');
    // The peeked faces show briefly (sanity: later "no face" assertions are not vacuous)...
    await expect(p.locator(`.slot[data-owner="${s.playerId}"] .face`)).toHaveCount(2);
  }
  // ...then turn face down after about 3 s and never come back from the view.
  for (const p of [host.page, guest.page]) {
    await expect(p.locator('.slot .face')).toHaveCount(0, { timeout: 6000 });
  }
  const hostHtml = await host.page.content();
  for (const f of hostFaces(cards)) expect(hostHtml, `host still shows ${f} after the peek`).not.toContain(f);
  await host.page.reload();
  await expect(host.page.locator('.slot[data-owner]')).toHaveCount(8);
  await expect(host.page.locator('.slot .face')).toHaveCount(0);
  await expect(host.page.locator('#hint')).toContainText('Your turn');
  await expect(guest.page.locator('#hint')).toContainText("Hanna's turn");
  return { host, guest, hs, gs, code };
}

test('full game: wrong slap grows hand, gringo, final round, result, hidden info', async ({ browser, baseURL, request }) => {
  const errors = [];
  const { host, guest, hs, gs, code } = await setupGame(browser, baseURL, request, errors, {
    hands: { 0: ['5S', '6S', '7S', '8S'], 1: ['9H', '10H', '2C', '3C'] },
    discard: ['4D'],
    deck: ['4C', '5D', '6D', '7D', '8D', 'AC', 'AD', 'AH'],
  });
  const guestFaces = ['9♥', '10♥', '2♣', '3♣'];

  // The guest peeked 9H and 10H; the host's page must contain none of the guest's faces.
  async function assertHostBlind() {
    const html = await host.page.content();
    for (const f of guestFaces) expect(html, `host DOM leaks ${f}`).not.toContain(f);
    await expect(host.page.locator(`.seat[data-player="${gs.playerId}"] .face`)).toHaveCount(0);
    const r = await request.post('/functions/v1/room', { data: { action: 'view', code, token: hs.token } });
    const v = (await r.json()).view;
    const g = v.players.find((p) => p.id === gs.playerId);
    expect(g.hand.every((s) => s.card === undefined)).toBe(true);
    expect(JSON.stringify(v)).not.toMatch(/"uid":(1004|1005|1006|1007)\b/);
  }
  await assertHostBlind();

  // Host draws 4C and discards it.
  await host.page.click('[data-act=draw]');
  await expect(host.page.locator('#drawn')).toContainText('4♣');
  await assertHostBlind();
  await host.page.click('[data-act=discard]');
  await expect(guest.page.locator('#hint')).toContainText('Your turn');
  await noHScroll(host.page);

  // Guest slaps their own 2C against a 4: wrong, hand grows 4 -> 5.
  await expect(guest.page.locator(`.seat[data-player="${gs.playerId}"] .slot`)).toHaveCount(4);
  await guest.page.click('[data-act=slap]');
  await slot(guest.page, gs.playerId, 2).click();
  await expect(guest.page.locator(`.seat[data-player="${gs.playerId}"] .slot`)).toHaveCount(5);
  await expect(guest.page.locator('#toast')).toContainText('Missed');
  await expect(host.page.locator(`.seat[data-player="${gs.playerId}"] .slot`)).toHaveCount(5);
  await assertHostBlind();
  await noHScroll(guest.page);

  // Guest draws and discards, then the host calls Gringo.
  await guest.page.click('[data-act=draw]');
  await guest.page.click('[data-act=discard]');
  await expect(host.page.locator('#hint')).toContainText('Your turn');
  await host.page.click('[data-act=gringo]');
  await expect(host.page.locator('#final-banner')).toContainText('You called Gringo. Last turns: Gus.');
  await expect(guest.page.locator('#final-banner')).toContainText('Hanna called Gringo. Last turns: You.');
  await expect(guest.page.locator('#hint')).toContainText('Your turn');
  await assertHostBlind();

  // Guest takes the last turn; both land on the result screen.
  await guest.page.click('[data-act=draw]');
  await guest.page.click('[data-act=discard]');
  for (const { page } of [host, guest]) {
    await expect(page.locator('#result')).toBeVisible();
    await expect(page.locator('.total')).toHaveText(['Total 26', 'Total 29']);
    await noHScroll(page);
  }
  await expect(host.page.locator('#result')).toContainText('You win!');
  await expect(guest.page.locator('#result')).toContainText('Hanna wins');
  expect(errors).toEqual([]);
  await host.context.close();
  await guest.context.close();
});

test('successful slap on an opponent card gives a card into the vacated slot', async ({ browser, baseURL, request }) => {
  const errors = [];
  const { host, guest, hs, gs, code } = await setupGame(browser, baseURL, request, errors, {
    hands: { 0: ['9S', '6S', '7S', '8S'], 1: ['9H', '10H', '2C', '3C'] },
    discard: ['4D'],
    deck: ['9C', '5D', '6D', '7D'],
  });
  await host.page.click('[data-act=draw]');
  await host.page.click('[data-act=discard]');
  await expect(guest.page.locator('#discard')).toContainText('9♣');
  await expect(guest.page.locator('#claimed')).toHaveCount(0);

  // Guest slaps the host's 9S; then must pick which own card to give (their 3C, slot 3).
  await guest.page.click('[data-act=slap]');
  await slot(guest.page, hs.playerId, 0).click();
  await expect(guest.page.locator('#hint')).toContainText('Pick which of YOUR cards to give');
  await slot(guest.page, gs.playerId, 3).click();
  await expect(guest.page.locator('#toast')).toContainText('Slap! Card played.');
  await expect(guest.page.locator('#discard')).toContainText('9♠');
  await expect(guest.page.locator('#claimed')).toBeVisible();
  await expect(guest.page.locator(`.slot[data-owner="${gs.playerId}"][data-slot="3"] .gap`)).toHaveCount(1);
  await expect(guest.page.locator(`.slot[data-owner="${hs.playerId}"][data-slot="0"] .back`)).toHaveCount(1);

  // The host sees the same state, and the slot is not empty for them (it holds the given card).
  await expect(host.page.locator('#discard')).toContainText('9♠');
  await expect(host.page.locator(`.slot[data-owner="${gs.playerId}"][data-slot="3"] .gap`)).toHaveCount(1);
  await expect(host.page.locator(`.slot[data-owner="${hs.playerId}"][data-slot="0"] .back`)).toHaveCount(1);
  const html = await host.page.content();
  for (const f of ['10♥', '2♣', '3♣']) expect(html).not.toContain(f);
  const v = (await (await request.post('/functions/v1/room', { data: { action: 'view', code, token: gs.token } })).json()).view;
  expect(v.players.find((p) => p.id === hs.playerId).hand[0].empty).toBe(false);
  await noHScroll(host.page);
  await noHScroll(guest.page);
  expect(errors).toEqual([]);
  await host.context.close();
  await guest.context.close();
});

const CARDS = {
  hands: { 0: ['5S', '6S', '7S', '8S'], 1: ['9H', '10H', '2C', '3C'] },
  discard: ['4D'],
  deck: ['4C', '5D', '6D', '7D', '8D', 'AC', 'AD', 'AH'],
};

test('a player who closes the tab ends the game for the others', async ({ browser, baseURL, request }) => {
  const errors = [];
  const { host, guest } = await setupGame(browser, baseURL, request, errors, CARDS);
  await guest.context.close();
  await expect(host.page.locator('#result')).toBeVisible({ timeout: 15_000 });
  await expect(host.page.locator('#result')).toContainText('You win!');
  await expect(host.page.locator('#result')).toContainText('Gus left, so the game ended');
  await noHScroll(host.page);
  expect(errors).toEqual([]);
  await host.context.close();
});

test('the Leave button asks twice, then ends the game for the other player', async ({ browser, baseURL, request }) => {
  const errors = [];
  const { host, guest } = await setupGame(browser, baseURL, request, errors, CARDS);
  const leave = guest.page.locator('[data-act=exit]');
  await expect(leave).toHaveText('Leave');
  await leave.click();
  await expect(leave).toHaveText('End game?');
  await leave.click();
  await expect(guest.page.locator('input#name')).toBeVisible();
  await expect(host.page.locator('#result')).toContainText('Gus left, so the game ended', { timeout: 10_000 });
  await expect(host.page.locator('#result')).toContainText('You win!');
  await expect(host.page.locator('[data-act=exit]')).toHaveCount(0);
  expect(errors).toEqual([]);
  await host.context.close();
  await guest.context.close();
});

test('reloading a page does not count as leaving', async ({ browser, baseURL, request }) => {
  const errors = [];
  const { host, guest } = await setupGame(browser, baseURL, request, errors, CARDS);
  await guest.page.reload();
  await expect(guest.page.locator('#hint')).toBeVisible();
  await host.page.waitForTimeout(3000);
  await expect(host.page.locator('#result')).toHaveCount(0);
  expect(errors).toEqual([]);
  await host.context.close();
  await guest.context.close();
});
