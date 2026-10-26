import { test, expect } from '@playwright/test';

async function open(browser, baseURL, errors, label) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${label} console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${label} pageerror: ${e.message}`));
  await page.goto(`${baseURL}/?mock=1`);
  return { context, page };
}

const deck = (page) => page.locator('.pile.deck small b');

test('a player who leaves forfeits: the others play on, their cards go back in the deck', async ({ browser, baseURL }) => {
  const errors = [];
  const names = ['Ann', 'Bo', 'Cy'];
  const people = [];
  for (const n of names) people.push(await open(browser, baseURL, errors, n));
  const [ann, bo, cy] = people;
  await ann.page.fill('#name', 'Ann');
  await ann.page.click('[data-act=create]');
  await expect(ann.page.locator('#roomcode')).toHaveText(/^[A-Z]{4}$/);
  const code = (await ann.page.locator('#roomcode').textContent()).trim();
  for (const [p, n] of [[bo, 'Bo'], [cy, 'Cy']]) {
    await p.page.fill('#name', n);
    await p.page.fill('#code', code);
    await p.page.click('[data-act=join]');
  }
  await expect(ann.page.locator('.plist li')).toHaveCount(3);
  await ann.page.click('[data-act=start]');
  await expect(ann.page.locator('.game')).toBeVisible();
  await expect(deck(ann.page)).toHaveText('42');

  // Bo leaves mid-game (two clicks: it asks first).
  await bo.page.locator('[data-act=exit]').click();
  await expect(bo.page.locator('[data-act=exit]')).toHaveText('Forfeit?');
  await bo.page.locator('[data-act=exit]').click();
  await expect(bo.page.locator('#name')).toBeVisible(); // Bo is back at the start screen

  // The game goes on for Ann and Cy: Bo's four cards are back in the deck and Bo shows as forfeited.
  await expect(deck(ann.page)).toHaveText('46');
  await expect(ann.page.locator('.seat.offline .badge')).toHaveText('forfeited'); // and nothing else, like "peeking"
  await expect(ann.page.locator('.game')).toBeVisible();
  await expect(ann.page.locator('#result')).toHaveCount(0);
  await expect(ann.page.locator('.seat .hand .slot')).toHaveCount(8);
  await expect(cy.page.locator('.badge.off')).toHaveText('forfeited');

  // Cy leaves too: one player is left, so the game is over and Ann wins.
  await cy.page.locator('[data-act=exit]').click();
  await cy.page.locator('[data-act=exit]').click();
  await expect(ann.page.locator('#result')).toBeVisible({ timeout: 10_000 });
  await expect(ann.page.locator('#result h2')).toHaveText('You win!');
  await expect(ann.page.locator('#result')).toContainText('forfeited');
  expect(errors).toEqual([]);
  for (const p of people) await p.context.close();
});
