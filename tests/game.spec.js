// End-to-end: three "phones" play a full game in demo mode.
//
// Demo mode keeps the whole game in localStorage + BroadcastChannel, so all
// phones share one browser context (= one shared "server"). Each phone gets
// its own saved-session slot so they behave like separate devices.
//
// Covers: instant room code, hide-answers mask, joining by QR link,
// escaping of player names, every round type (single-round debug mode
// plays each enabled type once), closing a tab mid-game and rejoining,
// a late joiner, final scoreboard, and photos wiped when the game ends.

const { test, expect } = require('@playwright/test');
const path = require('path');

const FACE = path.join(__dirname, 'fixtures', 'face.png');
const OBJECT = path.join(__dirname, 'fixtures', 'object.png');
const ROUND_TYPES = ['trivia', 'rps', 'guesswho', 'photo', 'object'];

test.setTimeout(240_000);

async function setupContext(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  // Hermetic: force demo mode and block every external request
  // (fonts, Supabase CDN, QR image service).
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (!url.startsWith('http://localhost')) return route.abort();
    if (url.includes('index.html') || url.endsWith('/') || url.includes('/?')) {
      const res = await route.fetch();
      let body = await res.text();
      body = body.replace(/const SUPABASE_URL = "[^"]*";/, 'const SUPABASE_URL = "YOUR_TEST";');
      return route.fulfill({ response: res, body });
    }
    return route.continue();
  });
  return context;
}

function makePhoneFactory(context, errors) {
  return async function phone(name) {
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    // give each phone its own saved session slot
    await page.addInitScript((slot) => {
      const g = Storage.prototype.getItem, s = Storage.prototype.setItem, r = Storage.prototype.removeItem;
      const map = (k) => (k === 'swgt_session' ? `${k}_${slot}` : k);
      Storage.prototype.getItem = function (k) { return g.call(this, map(k)); };
      Storage.prototype.setItem = function (k, v) { return s.call(this, map(k), v); };
      Storage.prototype.removeItem = function (k) { return r.call(this, map(k)); };
    }, name);
    return page;
  };
}

async function fillProfile(page, containerId, answers) {
  const inputs = page.locator(`#${containerId} input`);
  for (let i = 0; i < answers.length; i++) await inputs.nth(i).fill(answers[i]);
}

async function joinAs(page, code, { name, age, answers, photos = true }) {
  await page.goto(`/?join=${code}`);
  await expect(page.locator('#screen-join')).toHaveClass(/active/);
  await expect(page.locator('#join-code')).toHaveValue(code);
  await page.fill('#join-name', name);
  await page.fill('#join-age', String(age));
  if (photos) {
    await page.setInputFiles('#join-photo-input', FACE);
    await expect(page.locator('#photo-drop')).toHaveText(/Photo added/);
    await page.setInputFiles('#join-object-input', OBJECT);
    await expect(page.locator('#join-object-drop')).toHaveText(/Photo added/);
  }
  await fillProfile(page, 'join-profile-qs', answers);
  await page.click('text=Join room');
}

// One "turn" for a phone: if a round is waiting on this phone, answer it.
async function autoAnswer(page) {
  return page.evaluate(() => {
    if (!document.querySelector('#screen-play.active')) return null;
    if (typeof localAnswered !== 'undefined' && localAnswered) return null;
    const opt = document.querySelector('.option-btn:not([disabled])');
    if (opt) { opt.click(); return 'option'; }
    const vote = [...document.querySelectorAll('.vote-item')].find((v) => v.style.pointerEvents !== 'none');
    if (vote) { vote.click(); return 'vote'; }
    const rps = ['#rps-rock', '#rps-paper', '#rps-scissors'][Math.floor(Math.random() * 3)];
    const btn = document.querySelector(rps + ':not([disabled])');
    if (btn) { btn.click(); return 'rps'; }
    return null;
  }).catch(() => null);
}

async function activeScreen(page) {
  return page.evaluate(() => document.querySelector('.screen.active')?.id).catch(() => null);
}

test('a full game plays through every round type', async ({ browser }) => {
  const errors = [];
  const context = await setupContext(browser);
  const phone = makePhoneFactory(context, errors);

  // ---------- host opens a room: code is up immediately ----------
  const host = await phone('host');
  await host.goto('/');
  await host.evaluate(() => localStorage.clear());
  await host.reload();
  await host.click('text=Start a game');
  await expect(host.locator('#host-code')).toHaveText(/^[A-Z]{4}$/);
  const code = await host.innerText('#host-code');

  // mask is on by default: unfocused answers are blurred
  await expect(host.locator('#host-maskable')).toHaveClass(/masked/);

  await host.fill('#host-name', 'Sam');
  await host.fill('#host-age', '34');
  await host.setInputFiles('#host-photo-input', FACE);
  await host.setInputFiles('#host-object-input', OBJECT);
  await fillProfile(host, 'host-profile-qs', ['Hawaii', 'Green', 'Aunt Jo', 'Tacos', 'Juggling']);
  const blur = await host.locator('#host-profile-qs input').first().evaluate((el) => getComputedStyle(el).filter);
  expect(blur).toContain('blur');

  // debug mode: each enabled round type plays exactly once
  await host.click('#duration-pills .pill[data-min="single"]');

  // ---------- two guests join via the QR link ----------
  const g1 = await phone('g1');
  await joinAs(g1, code, { name: '<i>Zed</i>', age: 12, answers: ['Paris', 'Blue', 'Uncle Bo', 'Pizza', 'Whistling'] });
  const g2 = await phone('g2');
  await joinAs(g2, code, { name: 'Alex', age: 40, answers: ['Tokyo', 'Red', 'Aunt May', 'Sushi', 'Yo-yo'] });

  await expect(host.locator('#host-start-btn')).toHaveText(/Start game \(3 players\)/, { timeout: 10_000 });
  // host's typed name reached the shared roster
  await expect(g2.locator('#roster')).toContainText('Sam');

  // a name containing HTML is shown as text, never as markup
  await expect(host.locator('#host-roster')).toContainText('<i>Zed</i>');
  expect(await host.locator('#host-roster i').count()).toBe(0);

  // the polled roster carries no photos (bandwidth)
  const rosterKeys = await host.evaluate(() => Object.keys(playersCache[0]));
  expect(rosterKeys).not.toContain('avatar');
  expect(rosterKeys).not.toContain('object_photo');
  expect(rosterKeys).not.toContain('phone');

  await host.click('#host-start-btn');
  for (const p of [host, g1, g2]) await expect(p.locator('#screen-play')).toHaveClass(/active/, { timeout: 10_000 });

  // ---------- play to the end ----------
  let players = { host, g1, g2 };
  const seenTypes = new Set();
  let roundsSeen = new Set();
  let rejoined = false, lateJoined = false;
  const deadline = Date.now() + 200_000;

  while (Date.now() < deadline) {
    const round = await host.evaluate(() => gameRow && gameRow.state && gameRow.state.round
      ? { id: gameRow.state.round.id, type: gameRow.state.round.type, status: gameRow.status } : null).catch(() => null);
    if (round && round.status === 'playing') { seenTypes.add(round.type); roundsSeen.add(round.id); }

    // after the 2nd round starts: Alex closes the tab and comes back
    if (!rejoined && roundsSeen.size >= 2) {
      rejoined = true;
      const scoreBefore = await host.evaluate(() => (playersCache.find((p) => p.name === 'Alex') || {}).score);
      await players.g2.close();
      const back = await phone('g2');
      await back.goto('/');
      await expect(back.locator('#rejoin-btn')).toBeVisible();
      await expect(back.locator('#rejoin-btn')).toContainText(`Rejoin room ${code} as Alex`);
      await back.click('#rejoin-btn');
      await expect.poll(() => activeScreen(back), { timeout: 10_000 }).toMatch(/screen-(play|results)/);
      expect(await back.evaluate(() => ME.name)).toBe('Alex');
      expect(await back.evaluate(() => playersCache.length)).toBe(3); // reclaimed, not duplicated
      const scoreAfter = await back.evaluate(() => (playersCache.find((p) => p.name === 'Alex') || {}).score);
      expect(scoreAfter).toBeGreaterThanOrEqual(scoreBefore || 0);
      players.g2 = back;
    }

    // after the 3rd round starts: someone new joins mid-game
    if (!lateJoined && roundsSeen.size >= 3) {
      lateJoined = true;
      const late = await phone('late');
      await joinAs(late, code, { name: 'Riley', age: 25, answers: ['Rome', 'Gold', 'Uncle Al', 'Ramen', 'Knitting'], photos: false });
      // must not get stuck in the lobby
      await expect.poll(() => activeScreen(late), { timeout: 10_000 }).toMatch(/screen-(play|results)/);
      players.late = late;
    }

    for (const p of Object.values(players)) await autoAnswer(p);

    const screens = await Promise.all(Object.values(players).map(activeScreen));
    if (screens.every((s) => s === 'screen-results')) break;
    await host.waitForTimeout(400);
  }

  // ---------- results ----------
  for (const p of Object.values(players)) await expect(p.locator('#screen-results')).toHaveClass(/active/);
  expect([...seenTypes].sort()).toEqual([...ROUND_TYPES].sort());
  expect(rejoined).toBe(true);
  expect(lateJoined).toBe(true);

  const rows = host.locator('#final-scoreboard .score-row');
  await expect(rows).toHaveCount(4);
  const total = await host.evaluate(() => playersCache.reduce((a, p) => a + (p.score || 0), 0));
  expect(total).toBeGreaterThan(0);
  expect(await host.locator('#final-scoreboard i').count()).toBe(0);

  // photos are wiped from the "server" once the game ends
  await expect.poll(() => host.evaluate((c) =>
    demoDB().players.filter((p) => p.game_code === c && (p.avatar || p.object_photo)).length, code)).toBe(0);

  // finished game: no rejoin offer
  const after = await phone('g1');
  await after.goto('/');
  await after.waitForTimeout(800);
  await expect(after.locator('#rejoin-btn')).toBeHidden();

  expect(errors).toEqual([]);
  await context.close();
});

test('host can close the tab in the lobby and come back to the same room', async ({ browser }) => {
  const errors = [];
  const context = await setupContext(browser);
  const phone = makePhoneFactory(context, errors);

  let host = await phone('host');
  await host.goto('/');
  await host.click('text=Start a game');
  await expect(host.locator('#host-code')).toHaveText(/^[A-Z]{4}$/);
  const code = await host.innerText('#host-code');
  await host.fill('#host-name', 'Sam');
  await fillProfile(host, 'host-profile-qs', ['Hawaii']);
  await host.waitForTimeout(1200); // details autosave
  await host.close();

  host = await phone('host');
  await host.goto('/');
  await expect(host.locator('#rejoin-btn')).toContainText(`Rejoin room ${code} as Sam`);
  await host.click('#rejoin-btn');
  await expect(host.locator('#screen-host-setup')).toHaveClass(/active/);
  await expect(host.locator('#host-code')).toHaveText(code);
  await expect(host.locator('#host-name')).toHaveValue('Sam');
  await expect(host.locator('#host-profile-qs input').first()).toHaveValue('Hawaii');

  expect(errors).toEqual([]);
  await context.close();
});
