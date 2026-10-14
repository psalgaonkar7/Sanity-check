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
            return {
              status: 'OK', url: p.url, user, route: od, results: n,
              detail: `logged in${user ? ' as ' + user : ''}; search ${od} returned ${n} result(s) (${secs()}s)`
                + (tried.length ? ` after: ${tried.join(' | ')}` : ''),
            };
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
