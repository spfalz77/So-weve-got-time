// End-to-end: simulated phones play real games.
//
// Two backends:
//   * Local Supabase (CI): set SUPABASE_URL + SUPABASE_ANON_KEY (from
//     `supabase status -o env`). Each phone is its own browser context —
//     separate storage, separate network — exactly like separate devices,
//     talking to a real database with the real migrations and RLS.
//   * Demo mode (no env vars): the game lives in localStorage, so all
//     phones share one context and each gets its own saved-session slot.
//
// Covers: instant room code, hide-answers mask, joining by QR link,
// escaping of player names, every round type, closing a tab mid-game and
// rejoining, a late joiner, final scoreboard, photos wiped at the end,
// and the RPS ready / best-of-three / bracket flow.

const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const FACE = path.join(__dirname, 'fixtures', 'face.png');
const OBJECT = path.join(__dirname, 'fixtures', 'object.png');
const ROUND_TYPES = ['trivia', 'rps', 'guesswho', 'photo', 'object'];
const SUPABASE_JS = path.join(__dirname, '..', 'node_modules', '@supabase', 'supabase-js', 'dist', 'umd', 'supabase.js');

const LIVE_URL = process.env.SUPABASE_URL || '';
const LIVE_KEY = process.env.SUPABASE_ANON_KEY || '';
const LIVE = !!(LIVE_URL && LIVE_KEY);
if (/xesylbmpeewicgxxiruo/.test(LIVE_URL)) throw new Error('Tests must not run against the production project');

const SB_PROXY = 'http://localhost:8765/__sb';

test.setTimeout(240_000);

async function routeApp(context) {
  // Hermetic: serve the app pointed at the test backend, serve supabase-js
  // from node_modules, allow the local Supabase, block everything else
  // (fonts, QR image service).
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.includes('cdn.jsdelivr.net/npm/@supabase/supabase-js')) {
      return route.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(SUPABASE_JS, 'utf8') });
    }
    // the app talks to Supabase via a same-origin path, which we forward to
    // the local stack — no CORS/private-network rules differ between engines
    if (LIVE && url.startsWith(SB_PROXY)) {
      const target = LIVE_URL + url.slice(SB_PROXY.length);
      try {
        const res = await route.fetch({ url: target });
        return route.fulfill({ response: res });
      } catch (e) {
        console.log(`[proxy] ${route.request().method()} ${target} failed: ${e.message}`);
        return route.abort();
      }
    }
    if (!url.startsWith('http://localhost')) return route.abort();
    if (url.includes('index.html') || url.endsWith('/') || url.includes('/?')) {
      const res = await route.fetch();
      let body = await res.text();
      if (LIVE) {
        body = body
          .replace(/const SUPABASE_URL = "[^"]*";/, `const SUPABASE_URL = "${SB_PROXY}";`)
          .replace(/const SUPABASE_ANON_KEY = "[^"]*";/, `const SUPABASE_ANON_KEY = "${LIVE_KEY}";`);
      } else {
        body = body.replace(/const SUPABASE_URL = "[^"]*";/, 'const SUPABASE_URL = "YOUR_TEST";');
      }
      return route.fulfill({ response: res, body });
    }
    return route.continue();
  });
}

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

async function setupContext(browser) {
  const world = { browser, contexts: [], shared: null };
  if (!LIVE) {
    world.shared = await browser.newContext(PHONE);
    await routeApp(world.shared);
    world.contexts.push(world.shared);
  }
  world.close = async () => { for (const c of world.contexts) await c.close().catch(() => {}); };
  return world;
}

function makePhoneFactory(world, errors) {
  const contexts = {}; // live: one context per phone name, reused when that phone "reopens"
  return async function phone(name) {
    let page;
    if (LIVE) {
      let ctx = contexts[name];
      if (!ctx) {
        ctx = contexts[name] = await world.browser.newContext(PHONE);
        await routeApp(ctx);
        world.contexts.push(ctx);
      }
      page = await ctx.newPage();
    } else {
      page = await world.shared.newPage();
      // give each phone its own saved session slot
      await page.addInitScript((slot) => {
        const g = Storage.prototype.getItem, s = Storage.prototype.setItem, r = Storage.prototype.removeItem;
        const map = (k) => (k === 'swgt_session' ? `${k}_${slot}` : k);
        Storage.prototype.getItem = function (k) { return g.call(this, map(k)); };
        Storage.prototype.setItem = function (k, v) { return s.call(this, map(k), v); };
        Storage.prototype.removeItem = function (k) { return r.call(this, map(k)); };
      }, name);
    }
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    // diagnostics in the CI log if a backend request fails
    page.on('requestfailed', (r) => { if (r.url().includes('__sb') || r.url().includes('supabase')) console.log(`[${name}] request failed: ${r.method()} ${r.url()} — ${r.failure()?.errorText}`); });
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) console.log(`[${name}] console: ${m.text()}`); });
    return page;
  };
}

// how many players in this room still have photos stored on the server
async function photosLeftOnServer(page, code) {
  if (!LIVE) {
    return page.evaluate((c) => demoDB().players.filter((p) => p.game_code === c && (p.avatar || p.object_photo)).length, code);
  }
  const res = await fetch(`${LIVE_URL}/rest/v1/swgt_players?game_code=eq.${code}&or=(avatar.not.is.null,object_photo.not.is.null)&select=id`, {
    headers: { apikey: LIVE_KEY, Authorization: `Bearer ${LIVE_KEY}` },
  });
  return (await res.json()).length;
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
    const ready = document.querySelector('#rps-ready');
    if (ready) { ready.click(); return 'ready'; }
    const throwBtn = ['#rps-rock', '#rps-paper', '#rps-scissors'][Math.floor(Math.random() * 3)];
    const tb = document.querySelector(throwBtn + ':not([disabled])');
    if (tb) { tb.click(); return 'rps'; }
    if (typeof localAnswered !== 'undefined' && localAnswered) return null;
    const opt = document.querySelector('.option-btn:not([disabled])');
    if (opt) { opt.click(); return 'option'; }
    const vote = [...document.querySelectorAll('.vote-item')].find((v) => v.style.pointerEvents !== 'none');
    if (vote) { vote.click(); return 'vote'; }
    return null;
  }).catch(() => null);
}

async function activeScreen(page) {
  return page.evaluate(() => document.querySelector('.screen.active')?.id).catch(() => null);
}

test('a full game plays through every round type', async ({ browser }) => {
  const errors = [];
  const world = await setupContext(browser);
  const phone = makePhoneFactory(world, errors);

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
  await expect.poll(() => photosLeftOnServer(host, code)).toBe(0);

  // finished game: no rejoin offer
  const after = await phone('g1');
  await after.goto('/');
  await after.waitForTimeout(800);
  await expect(after.locator('#rejoin-btn')).toBeHidden();

  expect(errors).toEqual([]);
  await world.close();
});

test('host can close the tab in the lobby and come back to the same room', async ({ browser }) => {
  const errors = [];
  const world = await setupContext(browser);
  const phone = makePhoneFactory(world, errors);

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
  await world.close();
});

test('rock-paper-scissors: find your opponent, ready up, best of three', async ({ browser }) => {
  const errors = [];
  const world = await setupContext(browser);
  const phone = makePhoneFactory(world, errors);

  const host = await phone('host');
  await host.goto('/');
  await host.click('text=Start a game');
  await expect(host.locator('#host-code')).toHaveText(/^[A-Z]{4}$/);
  const code = await host.innerText('#host-code');
  await host.fill('#host-name', 'Sam');
  // RPS only, single round
  for (const m of ['trivia', 'guesswho', 'photo', 'object']) await host.click(`#mode-pills .pill[data-mode="${m}"]`);
  await host.click('#duration-pills .pill[data-min="single"]');

  const guest = await phone('guest');
  await joinAs(guest, code, { name: 'Alex', age: 30, answers: [], photos: false });
  await expect(host.locator('#host-start-btn')).toHaveText(/Start game \(2 players\)/, { timeout: 10_000 });
  await host.waitForTimeout(800); // host name autosave
  await host.click('#host-start-btn');

  // 1. ready screen: tells you who to find, shows the bracket, no throw buttons yet
  await expect(host.locator('#round-body')).toContainText('Next up: you vs Alex', { timeout: 10_000 });
  await expect(guest.locator('#round-body')).toContainText('Next up: you vs Sam', { timeout: 10_000 });
  await expect(guest.locator('.bracket')).toContainText('Winners bracket · wave 1');
  await expect(guest.locator('#rps-rock')).toHaveCount(0);

  // match only starts when BOTH are ready
  await host.click('#rps-ready');
  await expect(host.locator('#round-body')).toContainText('waiting for Alex');
  await expect(guest.locator('#round-body')).toContainText('Sam is ready', { timeout: 5_000 });
  await host.waitForTimeout(2500);
  await expect(host.locator('#rps-rock')).toHaveCount(0);
  await guest.click('#rps-ready');
  await expect(host.locator('#rps-rock')).toBeVisible({ timeout: 6_000 });
  await expect(guest.locator('#rps-rock')).toBeVisible({ timeout: 6_000 });

  const score = async (page) => (await page.locator('.match-score').innerText()).replace(/\s+/g, ' ');

  // 2. a tie doesn't count — throw again
  await host.click('#rps-rock'); await guest.click('#rps-rock');
  await expect(guest.locator('#round-body')).toContainText('tie — throw again', { timeout: 6_000 });
  expect(await score(guest)).toMatch(/You 0 – 0 Sam/);

  // Sam takes throw 2
  await expect(host.locator('#rps-rock')).toBeVisible({ timeout: 6_000 });
  await host.click('#rps-rock'); await guest.click('#rps-scissors');
  await expect(guest.locator('#round-body')).toContainText('they win the throw', { timeout: 6_000 });
  await expect(host.locator('#round-body')).toContainText('you win the throw', { timeout: 6_000 });
  expect(await score(host)).toMatch(/You 1 – 0 Alex/);

  // one win isn't enough: still playing
  await expect(host.locator('#rps-rock')).toBeVisible();

  // Alex takes throw 3 → 1–1
  await host.click('#rps-scissors'); await guest.click('#rps-rock');
  await expect(guest.locator('#round-body')).toContainText('you win the throw', { timeout: 6_000 });
  expect(await score(guest)).toMatch(/You 1 – 1 Sam/);

  // Sam takes throw 4 → wins 2–1
  await expect(host.locator('#rps-paper')).toBeVisible({ timeout: 6_000 });
  await host.click('#rps-paper'); await guest.click('#rps-rock');

  // standings show the winner and the bracket with the final score
  await expect(guest.locator('#round-body')).toContainText('Sam wins the RPS tournament', { timeout: 8_000 });
  await expect(guest.locator('.bracket')).toContainText('2–1');

  await expect(host.locator('#screen-results')).toHaveClass(/active/, { timeout: 10_000 });
  const scores = await host.evaluate(() => Object.fromEntries(playersCache.map((p) => [p.name, p.score])));
  expect(scores.Sam).toBe(30);
  expect(scores.Alex).toBe(15);

  expect(errors).toEqual([]);
  await world.close();
});

test('rock-paper-scissors with an odd number: bye, then losers bracket', async ({ browser }) => {
  const errors = [];
  const world = await setupContext(browser);
  const phone = makePhoneFactory(world, errors);

  const host = await phone('host');
  await host.goto('/');
  await host.click('text=Start a game');
  await expect(host.locator('#host-code')).toHaveText(/^[A-Z]{4}$/);
  const code = await host.innerText('#host-code');
  await host.fill('#host-name', 'Sam');
  for (const m of ['trivia', 'guesswho', 'photo', 'object']) await host.click(`#mode-pills .pill[data-mode="${m}"]`);
  await host.click('#duration-pills .pill[data-min="single"]');
  const players = { host };
  for (const n of ['Alex', 'Riley']) {
    const p = await phone(n);
    await joinAs(p, code, { name: n, age: 30, answers: [], photos: false });
    players[n] = p;
  }
  await expect(host.locator('#host-start-btn')).toHaveText(/3 players/, { timeout: 10_000 });
  await host.click('#host-start-btn');

  // someone gets a bye in wave 1
  await expect(host.locator('.bracket')).toContainText('bye', { timeout: 10_000 });
  let sawLosers = false;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    for (const p of Object.values(players)) await autoAnswer(p);
    const txt = await host.locator('#round-body').innerText().catch(() => '');
    if (/Losers bracket/i.test(txt)) sawLosers = true;
    if (await host.locator('#screen-results.active').count()) break;
    await host.waitForTimeout(300);
  }
  await expect(host.locator('#screen-results')).toHaveClass(/active/);
  expect(sawLosers).toBe(true);
  const total = await host.evaluate(() => playersCache.reduce((a, p) => a + (p.score || 0), 0));
  expect(total).toBe(45); // 30 winners champ + 15 losers champ
  expect(errors).toEqual([]);
  await world.close();
});
