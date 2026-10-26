import { test, expect } from '@playwright/test';

async function open(browser, baseURL, errors, label) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${label} console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${label} pageerror: ${e.message}`));
  await page.goto(`${baseURL}/?mock=1`);
  return { context, page };
}

const sess = (page) => page.evaluate(() => ({ playerId: localStorage.getItem('gringo.playerId') }));
const slot = (page, owner, n) => page.locator(`.slot[data-owner="${owner}"][data-slot="${n}"]`);

test('custom rules are chosen at creation, shown to everyone, and change how the Jack plays', async ({ browser, baseURL, request }) => {
  const errors = [];
  const host = await open(browser, baseURL, errors, 'host');
  const guest = await open(browser, baseURL, errors, 'guest');
  const h = host.page;

  // Standard rooms show no rule chips.
  await expect(h.locator('details.custom')).not.toHaveAttribute('open', '');
  await h.fill('#name', 'Hanna');
  await h.click('details.custom summary');
  await h.locator('input[data-rule=jackAnyPlayers]').check();
  await h.locator('input[data-rule=gringoBlocksSwaps]').check();
  await h.selectOption('select[data-rule=missPenalty]', '2');
  // A failed submit re-renders the form; the choices must survive that.
  await h.fill('#name', '');
  await h.click('[data-act=create]');
  await expect(h.locator('#home-err')).toContainText('name');
  await expect(h.locator('input[data-rule=jackAnyPlayers]')).toBeChecked();
  await expect(h.locator('select[data-rule=missPenalty]')).toHaveValue('2');
  await h.fill('#name', 'Hanna');
  await h.click('[data-act=create]');
  await expect(h.locator('#roomcode')).toHaveText(/^[A-Z]{4}$/);
  const code = (await h.locator('#roomcode').textContent()).trim();
  await expect(h.locator('.house li')).toHaveText(['Swaps still work after Gringo', 'Jack swaps any two players', 'A wrong slap costs 2 cards']);

  const g = guest.page;
  await g.fill('#name', 'Gus');
  await g.fill('#code', code);
  await g.click('[data-act=join]');
  await expect(g.locator('.house li')).toHaveCount(3);
  await h.click('[data-act=start]');
  await expect(h.getByText('Peek at 2 of your 4 cards')).toBeVisible();
  const hs = await sess(h);
  const gs = await sess(g);
  const stack = await request.post('/__test/stack', { data: { code, hands: { 0: ['5S', '6S', '7S', '8S'], 1: ['9H', '10H', '2C', '3C'] }, discard: ['4D'], deck: ['JS', '5D', '6D', '7D'] } });
  expect(stack.ok()).toBeTruthy();
  for (const [p, s] of [[h, hs], [g, gs]]) {
    await slot(p, s.playerId, 0).click();
    await slot(p, s.playerId, 1).click();
    await p.click('[data-act=peek]');
  }
  await expect(h.locator('#hint')).toContainText('Your turn', { timeout: 8000 });

  await h.click('[data-act=draw]');
  await expect(h.locator('#drawn')).toContainText('J');
  await h.click('[data-act=discard]');
  await expect(h.locator('#hint')).toContainText('tap any card to swap away');
  // The first card may be the opponent's.
  await slot(h, gs.playerId, 0).click();
  await expect(h.locator('#hint')).toContainText('a different player');
  await expect(slot(h, gs.playerId, 1)).not.toHaveClass(/tap/);
  await expect(slot(h, hs.playerId, 2)).toHaveClass(/tap/);
  await slot(h, hs.playerId, 2).click();
  await expect(g.locator('#hint')).toContainText('Your turn', { timeout: 8000 });
  // The room carries the rules the host picked.
  const r = await request.post('/functions/v1/room', { data: { action: 'view', code, token: await h.evaluate(() => localStorage.getItem('gringo.token')) } });
  const v = (await r.json()).view;
  expect(v.rules.jackAnyPlayers).toBe(true);
  expect(errors).toEqual([]);
  await host.context.close();
  await guest.context.close();
});
