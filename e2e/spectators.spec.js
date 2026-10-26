import { test, expect } from '@playwright/test';

const VIEWPORT = { width: 390, height: 844 };

async function open(browser, baseURL, errors, label) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${label} console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${label} pageerror: ${e.message}`));
  await page.goto(`${baseURL}/?mock=1`);
  return { context, page };
}

async function enter(who, name, code) {
  await who.page.fill('#name', name);
  if (code) {
    await who.page.fill('#code', code);
    await who.page.click('[data-act=join]');
  } else {
    await who.page.click('[data-act=create]');
  }
}

async function noHScroll(page) {
  const w = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(w.sw, 'horizontal scroll').toBeLessThanOrEqual(w.cw);
}

test('a full lobby makes spectators, who take a seat when one opens', async ({ browser, baseURL }) => {
  const errors = [];
  const people = [];
  for (const [i, name] of ['Ann', 'Bo', 'Cy', 'Di', 'Ed'].entries()) people.push(await open(browser, baseURL, errors, name));
  await enter(people[0], 'Ann');
  await expect(people[0].page.locator('#roomcode')).toHaveText(/^[A-Z]{4}$/);
  const code = (await people[0].page.locator('#roomcode').textContent()).trim();
  for (const [i, name] of ['Bo', 'Cy', 'Di'].entries()) await enter(people[i + 1], name, code);
  await expect(people[0].page.locator('.plist:not(.rail) li')).toHaveCount(4);

  // The fifth person is watching, not turned away.
  const ed = people[4].page;
  await enter(people[4], 'Ed', code);
  await expect(ed.getByText('The room is full, so you are watching')).toBeVisible();
  await expect(ed.locator('[data-act=sit]')).toHaveCount(0);
  await expect(ed.locator('[data-act=start]')).toHaveCount(0);
  await expect(people[0].page.locator('.rail li')).toHaveCount(1);
  await noHScroll(ed);

  // A player leaves the lobby; Ed can sit.
  await people[3].page.click('[data-act=leave]');
  await expect(ed.locator('[data-act=sit]')).toBeVisible();
  await ed.click('[data-act=sit]');
  await expect(ed.locator('.plist:not(.rail) li')).toHaveCount(4);
  await expect(ed.locator('.rail')).toHaveCount(0);
  await expect(ed.locator('[data-act=start]')).toHaveCount(0);
  expect(errors).toEqual([]);
  for (const p of people) await p.context.close();
});

test('watching a game, then taking a seat in the next one', async ({ browser, baseURL }) => {
  const errors = [];
  const host = await open(browser, baseURL, errors, 'host');
  const guest = await open(browser, baseURL, errors, 'guest');
  const fan = await open(browser, baseURL, errors, 'fan');
  await enter(host, 'Hanna');
  await expect(host.page.locator('#roomcode')).toHaveText(/^[A-Z]{4}$/);
  const code = (await host.page.locator('#roomcode').textContent()).trim();
  await enter(guest, 'Gus', code);
  await expect(host.page.locator('.plist li')).toHaveCount(2);
  await host.page.click('[data-act=start]');
  await expect(host.page.getByText('Peek at 2 of your 4 cards')).toBeVisible();

  // Joining a game in progress puts Fran at the rail.
  await enter(fan, 'Fran', code);
  await expect(fan.page.locator('.game')).toBeVisible();
  await expect(fan.page.locator('#hint')).toContainText('You are watching');
  await expect(host.page.locator('#hint')).toContainText('Watching: Fran');
  await expect(fan.page.locator('.actions button')).toHaveCount(0);
  await expect(fan.page.locator('.slot[data-owner]')).toHaveCount(8);
  await expect(fan.page.locator('.slot .face')).toHaveCount(0);
  await noHScroll(fan.page);
  // Tapping cards does nothing for a spectator.
  await fan.page.locator('.slot[data-owner]').first().click({ force: true });
  await expect(fan.page.locator('.slot .face')).toHaveCount(0);

  // Gus walks away and forfeits; the game is over and Fran asks for a seat.
  await guest.page.click('[data-act=exit]');
  await guest.page.click('[data-act=exit]');
  await expect(fan.page.locator('#result')).toBeVisible({ timeout: 10_000 });
  await expect(fan.page.locator('[data-act=sit]')).toHaveText('Join the next game');
  await fan.page.click('[data-act=sit]');
  await expect(fan.page.locator('[data-act=unsit]')).toBeVisible();
  await expect(host.page.locator('#result')).toContainText('Fran is joining the next game');

  // Hanna is the only one left to agree; Fran gets Gus's seat.
  await host.page.click('[data-act=again]');
  await expect(host.page.getByText('Peek at 2 of your 4 cards')).toBeVisible();
  await expect(fan.page.getByText('Peek at 2 of your 4 cards')).toBeVisible();
  await expect(fan.page.locator('.watchers')).toHaveCount(0);
  await expect(fan.page.locator('.seat.me')).toHaveCount(1);
  await noHScroll(fan.page);
  expect(errors).toEqual([]);
  for (const p of [host, guest, fan]) await p.context.close();
});
