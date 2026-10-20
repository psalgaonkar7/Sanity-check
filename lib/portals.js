// The B2B portals the sanity check proves are working — not just "the page loads" but
// "a logged-in user can search and get trains back".
//
// Why: on 12-14 Oct 2026 China-region search was broken for ~40 h (`/products/suppliers` 500,
// SR-23406) while the old China check — which only waited for the sign-in page — kept reading
// OK. A sign-in page proves the web server is up; it says nothing about search.
//
// customercare.raileurope.com is not listed here: the booking run already searches, carts and
// references 22 items on it every run, which is a far stronger proof than one search.
//
// Every portal is the same ERA app with its own login per domain (verified 2026-10-14: same
// sign-in form, no shared login host), so each needs its own saved session. The person running
// the check signs in once per portal with `npm run auth:portals`; no password is ever typed or
// stored by code. Sessions live in auth/<key>.json (git-ignored, like storageState.json).
const fs = require('fs');
const path = require('path');
const H = require('./helpers');
const data = require('../data/journeys');

const { PORTALS } = require('./portal-list');

const AUTH_DIR = path.join(__dirname, '..', 'auth');
const sessionFile = (key) => path.join(AUTH_DIR, `${key}.json`);
const hasSession = (key) => fs.existsSync(sessionFile(key));

function searchRoutes() {
  return data.portalSearchJourneyIds.map((id) => data.ptpJourneys.find((j) => j.id === id)).filter(Boolean);
}

/**
 * Empty this portal's cart. The .cn cart keeps re-rendering for several seconds after its
 * "Delete all" button first shows, and one long click in that window waited out its whole 30 s
 * timeout (seen 2026-10-20), while the same click 15 s later worked. So: several short click
 * attempts, then the confirm button INSIDE the "Are you sure…" dialog, then wait until no item
 * (Expiry line) is left. Throws if the cart could not be emptied.
 */
async function clearCart(page, p, loadWait) {
  await page.goto(`${p.url}/cart`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const delAll = page.getByRole('button', { name: /^delete all$/i });
  const hasItems = await delAll.first().waitFor({ state: 'visible', timeout: Math.min(loadWait, 30000) }).then(() => true).catch(() => false);
  if (!hasItems) return;
  let opened = false;
  for (let i = 0; i < 5 && !opened; i++) {
    opened = await delAll.first().click({ timeout: 8000 }).then(() => true).catch(() => false);
    if (!opened) await page.waitForTimeout(3000);
  }
  if (!opened) throw new Error('"Delete all" could not be clicked');
  const dialog = page.getByRole('dialog');
  const inDialog = await dialog.first().waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
  const confirmBtn = inDialog ? dialog.getByRole('button', { name: /^delete all$/i }).first() : delAll.last();
  await confirmBtn.click({ timeout: 15000 });
  await page.getByText(/Expiry\s+\d{2}:\d{2}:\d{2}/).first().waitFor({ state: 'hidden', timeout: 20000 }).catch(() => {});
}

/**
 * From a results page: cart the first available Standard fare and capture a booking reference
 * on Traveler Details — then STOP (status Created). Never fills traveler data, never goes on to
 * Hold & Payment (that submits the order to the carrier), never pays.
 */
async function bookOne(page) {
  await H.addFirstStandardToCart(page);
  // The China portal cannot remove an EXPIRED item from the cart through the site ("Delete all"
  // and the trash do nothing on it — seen on the .cn portals since 2026-10-14), so a leftover
  // from an earlier run can sit next to the train we just added. Only the new item has to be
  // live; leftovers are reported, not treated as a failure.
  const expiries = await H.cartExpiries(page);
  const live = expiries.filter((t) => t !== '00:00:00').length;
  const leftover = expiries.length - live;
  if (!live) throw new Error('the carted item was already expired');
  // Seen 2026-10-20: with an expired leftover in the cart, "Delete all" times out AND the site
  // will not open Traveler Details, so the booking cannot be made until the leftover is gone
  // (that day it disappeared by itself within about 15 minutes). Say so instead of a bare timeout.
  try {
    return await bookOneFromCart(page, leftover);
  } catch (e) {
    if (!leftover) throw e;
    throw new Error(`${String(e).split('\n')[0].slice(0, 100)} — the cart still held ${leftover} expired item(s) from an earlier run, which the site would not remove; that blocks Traveler Details. Run again later`);
  }
}

async function bookOneFromCart(page, leftover) {
  // MSC_PAYMENT_PROBE=1: fill dummy traveler details and go on to the Hold & Payment page (never
  // pays; holds the seat at the carrier — see reachPaymentPage in lib/helpers.js).
  if (process.env.MSC_PAYMENT_PROBE === '1') {
    const r = await H.reachPaymentPage(page);
    if (!r.reachedPayment) throw new Error(`payment page not reached (ref ${r.ref || '?'}, status ${r.status || '?'}, on ${r.url})`);
    await page.screenshot({ path: require('path').join(__dirname, '..', 'report', 'payment-probe-china.png'), fullPage: true }).catch(() => {});
    return { ref: r.ref, status: r.status || 'Prebooked?', reachedPayment: true, expired: 0, leftover };
  }
  const ref = await H.continueToTravelerDetails(page);
  if (!ref) throw new Error('Traveler Details opened but no booking reference was shown');
  const body = await page.locator('body').innerText().catch(() => '');
  // Empty the cart again while the item is still live, so it cannot expire there and block the
  // NEXT run (an expired item can't be removed through the site). Same as the main run, which
  // clears the cart right after capturing each order's reference; the reference stays valid.
  let cleaned = true;
  await clearCart(page, { url: new URL(page.url()).origin }, 30000).catch(() => { cleaned = false; });
  return { ref, status: 'Created', expired: (body.match(/00:00:00/g) || []).length, leftover, cleaned };
}

// What the page says when a search breaks, so a KO names the cause instead of just "failed".
async function visibleError(page) {
  const body = await page.locator('body').innerText().catch(() => '');
  const m = body.match(/.{0,80}(unexpected error|something unexpected|try again later|technical error|era-[a-z-]+-error|service unavailable).{0,80}/i);
  return m ? m[0].replace(/\s+/g, ' ').trim().slice(0, 140) : '';
}

/**
 * Check one portal. Returns { status, detail, ... } in the same shape as the other extra checks:
 *  OK      logged in, a search returned trains
 *  NOT OK  portal did not load, or logged in but every search route failed / returned nothing
 *  SKIPPED no saved login (or it expired) — the sign-in page is up but search was NOT tested
 */
async function checkPortal(browser, p, dateStr) {
  const t0 = Date.now();
  const secs = () => ((Date.now() - t0) / 1000).toFixed(1);
  const session = hasSession(p.key);
  let ctx;
  try {
    ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, ...(session ? { storageState: sessionFile(p.key) } : {}) });
  } catch (e) {
    const why = String(e).split('\n')[0].slice(0, 80);
    return { status: 'SKIPPED', login: 'unreadable', url: p.url, detail: `the saved login file is unreadable (${why}), so search was not tested — run: npm run auth:portals -- --all` };
  }
  if (!p.china) await H.blockNoise(ctx);
  const page = await ctx.newPage();
  const loadWait = p.china ? 120000 : 45000;
  try {
    await page.goto(`${p.url}/home`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const state = await H.loginState(page, loadWait);
    if (state === 'none') {
      const title = await page.title().catch(() => '');
      return { status: 'NOT OK', detail: `portal did not finish loading within ${loadWait / 1000}s (title "${title}")`, url: p.url };
    }
    if (state !== 'in') {
      return {
        status: 'SKIPPED', login: session ? 'expired' : 'missing', url: p.url,
        detail: `sign-in page is up (${secs()}s) but ${session ? 'the saved login has expired' : 'there is no saved login'}, so search was not tested — run: npm run auth:portals`,
      };
    }
    await H.dismissCookies(page);
    const user = (await page.locator(H.SEL.userName).first().innerText().catch(() => '')).trim();
    // A booking portal starts from an empty cart, so the reference covers only this run's item.
    let cartNote = '';
    if (p.book) {
      await clearCart(page, p, loadWait).catch((e) => { cartNote = ` (could not empty the cart first: ${String(e).split('\n')[0].slice(0, 80)})`; });
      await page.goto(`${p.url}/home`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }
    const tried = [];
    const routes = searchRoutes();
    // Each route gets two attempts: on 2026-10-14 the key-account portal's station suggestions
    // were slow once and three routes in a row timed out at 12 s, which read as a KO although
    // the portal was fine (it searched in 5-17 s on every other run). A route only counts as
    // failed after a second try with a longer wait; an empty result is final (no retry).
    const optionTimeout = p.china ? 45000 : 30000;
    let first = true;
    for (let i = 0; i < routes.length; i++) {
      const j = routes[i];
      const od = `${j.from.q}->${j.to.q}`;
      let lastErr = '';
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          if (!first) await page.goto(`${p.url}/home`, { waitUntil: 'domcontentloaded', timeout: 60000 });
          first = false;
          await page.locator(H.SEL.from).first().waitFor({ state: 'visible', timeout: loadWait });
          await H.searchJourney(page, j, dateStr, { optionTimeout });
          const n = await H.resultCount(page);
          if (n > 0) {
            const found = `logged in${user ? ' as ' + user : ''}; search ${od} returned ${n} result(s) (${secs()}s)`
              + (tried.length ? ` after: ${tried.join(' | ')}` : '');
            if (!p.book) return { status: 'OK', url: p.url, user, route: od, results: n, detail: found };
            // Booking portal: the search worked; now the booking must work too, or it is a KO.
            try {
              const booking = await bookOne(page);
              return {
                status: 'OK', url: p.url, user, route: od, results: n, booking,
                detail: `${found}; booked ${od}, ref ${booking.ref} (${booking.status}, stopped at Traveler Details) (${secs()}s)${cartNote}`
                  + (booking.leftover ? ` — note: ${booking.leftover} expired item(s) from an earlier run are still in this portal's cart (the site cannot remove expired items)` : ''),
              };
            } catch (e) {
              const shown = await visibleError(page);
              return {
                status: 'NOT OK', url: p.url, user, route: od, results: n,
                detail: `${found}, but the booking failed: ${shown || String(e).split('\n')[0].slice(0, 120)}${cartNote}`,
              };
            }
          }
          lastErr = 'no results';
          break;
        } catch (e) {
          const shown = await visibleError(page);
          lastErr = shown || String(e).split('\n')[0].slice(0, 110);
        }
      }
      tried.push(`${od}: ${lastErr}`);
    }
    return { status: 'NOT OK', url: p.url, user, detail: `logged in but search failed on all ${routes.length} routes — ${tried.join(' | ')}` };
  } catch (e) {
    return { status: 'NOT OK', url: p.url, detail: `could not open the portal: ${String(e).split('\n')[0].slice(0, 120)}` };
  } finally {
    await ctx.close().catch(() => {});
  }
}

module.exports = { PORTALS, AUTH_DIR, sessionFile, hasSession, checkPortal, searchRoutes };
