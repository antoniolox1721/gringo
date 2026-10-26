import { test, expect } from '@playwright/test';

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'A'];
const hand = (n) => Array.from({ length: n }, (_, i) => `${RANKS[i % RANKS.length]}${'SHDC'[i % 4]}`);

// Smallest slot (long side) and whether any slot sits outside the screen.
const measure = (page) => page.evaluate(() => {
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  let min = Infinity;
  let outside = 0;
  for (const el of document.querySelectorAll('.seat .slot')) {
    const r = el.getBoundingClientRect();
    min = Math.min(min, Math.max(r.width, r.height));
    if (r.left < -1 || r.right > vw + 1 || r.top < -1 || r.bottom > vh + 1) outside += 1;
  }
  return { min, outside, scrollW: document.documentElement.scrollWidth, vw };
});

for (const players of [2, 3, 4]) {
  test(`hands with many penalty cards stay readable with ${players} players`, async ({ browser, baseURL, request }) => {
    const errors = [];
    const pages = [];
    for (let i = 0; i < players; i++) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await context.newPage();
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${baseURL}/?mock=1`);
      pages.push(page);
    }
    await pages[0].fill('#name', 'Ann');
    await pages[0].click('[data-act=create]');
    await expect(pages[0].locator('#roomcode')).toHaveText(/^[A-Z]{4}$/);
    const code = (await pages[0].locator('#roomcode').textContent()).trim();
    for (let i = 1; i < players; i++) {
      await pages[i].fill('#name', `P${i}`);
      await pages[i].fill('#code', code);
      await pages[i].click('[data-act=join]');
    }
    await expect(pages[0].locator('.plist li')).toHaveCount(players);
    await pages[0].click('[data-act=start]');
    await expect(pages[0].locator('.game')).toBeVisible();
    const sizes = [12, 9, 14, 6];
    const hands = {};
    for (let i = 0; i < players; i++) hands[i] = hand(sizes[i]);
    expect((await request.post('/__test/stack', { data: { code, hands } })).ok()).toBeTruthy();
    await expect(pages[0].locator('.slot')).toHaveCount(sizes.slice(0, players).reduce((a, b) => a + b, 0));

    const play = await measure(pages[0]);
    expect(play.min, 'smallest card while playing').toBeGreaterThanOrEqual(26);
    expect(play.outside, 'cards off screen while playing').toBe(0);
    expect(play.scrollW).toBeLessThanOrEqual(play.vw);

    // End the game normally: everyone's cards turn face up in place.
    expect((await request.post('/__test/stack', { data: { code, finish: true } })).ok()).toBeTruthy();
    await expect(pages[0].locator('#result')).toBeVisible({ timeout: 10_000 });
    await expect(pages[0].locator('.total').first()).toBeVisible();
    await pages[0].waitForTimeout(9000);
    const over = await measure(pages[0]);
    expect(over.min, 'smallest card at the reveal').toBeGreaterThanOrEqual(24);
    expect(over.outside, 'cards off screen at the reveal').toBe(0);
    expect(errors).toEqual([]);
  });
}
