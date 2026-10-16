// Reusable building blocks for the MSC. These encode the exact flow behaviour we
// observed on customercare.raileurope.com (B2B). Selectors prefer accessible roles
// and stable attributes (`data-select`, button text) so they survive layout/zoom changes.
// Do NOT select on `id` — the portal generates a fresh random id per page load. The 3-4
// selectors most likely to need first-run tuning are marked with  // TUNE:
//
// NOTE: setStandardFareToCart picks the FIRST "Standard" fare in the results, which is
// the cheapest-listed for that train. The goal is sanity coverage, not fare optimisation.

const { expect } = require('@playwright/test');
const fs = require('fs');

// Point-to-point search-form selectors, in ONE place because the portal has now broken them
// twice over. As of the 2026-09-01 front end:
//   * every element gets a RANDOM per-page-load `id` (e.g. "a05bdfad8586c0-a05bdfad851600-…"),
//     so any `#id` selector is permanently dead — including the old
//     `#datetime-selector-date-departureDate`, whose value simply MOVED to `data-select`;
//   * form inputs are namespaced: `name="from"` is now `name="ng.form1.from"`.
// `data-select` is the stable contract (the passes/results helpers below already rely on it,
// which is exactly why those kept passing while every point-to-point search broke). The legacy
// `name=` forms are kept as fallbacks so a portal rollback doesn't break us again; `name$=".from"`
// also covers a future re-namespacing (ng.form2.from, …).
const SEL = {
  from: '[data-select="era-pointToPointSearchFrom-input"], input[name="from"], input[name$=".from"]',
  to: '[data-select="era-pointToPointSearchTo-input"], input[name="to"], input[name$=".to"]',
  departureDate: '[data-select="datetime-selector-date-departureDate"], #datetime-selector-date-departureDate',
  searchButton: '[data-select="pointToPoint-search-form-search-button"]',
  adultsInput: '[data-select="pax-selector-adults-input"]',
  adultsMore: '[data-select="pax-selector-adults-more"]',
};

/**
 * Block third-party A/B-testing and analytics hosts that are unreachable from this network.
 *
 * `https://9mob5dt8n0.kameleoon.io/engine.js` was measured hanging for 37.9s before
 * ERR_CONNECTION_RESET. Nothing in the MSC depends on it, but every page load pays that cost,
 * and any `waitForLoadState('networkidle')` cannot settle while it is pending — which is what
 * made a 3-search POS check take 4.7 minutes.
 *
 * Aborting (rather than waiting) is safe here: these are experimentation/telemetry scripts,
 * not booking functionality. Call once per BrowserContext.
 */
const NOISE_HOSTS = /(^|\.)(kameleoon\.(io|eu)|quantummetric\.com)/i;
async function blockNoise(context) {
  await context.route('**/*', (route) => {
    let host = '';
    try { host = new URL(route.request().url()).hostname; } catch { /* non-URL scheme */ }
    if (host && NOISE_HOSTS.test(host)) return route.abort();
    return route.fallback ? route.fallback() : route.continue();
  });
}

/** Dismiss the cookie consent banner (privacy-preserving: decline non-essential). */
async function dismissCookies(page) {
  for (const name of [/continue without accepting/i, /reject all/i]) {
    const b = page.getByRole('button', { name }).first();
    if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); return; }
  }
}

/** True if the page is the anti-bot "Access is temporarily restricted" wall. */
async function isBotWall(page) {
  return await page.getByText(/access is temporarily restricted|unusual activity/i)
    .first().isVisible().catch(() => false);
}

/** Returns a YYYY-MM-DD date `daysAhead` from today. */
function futureDate(daysAhead = 45) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return d.toISOString().slice(0, 10);
}

/** Type into the From/To autocomplete and click the matching suggestion. */
async function selectStation(page, fieldName, query, optionText) {
  const input = page.locator(SEL[fieldName]).first();
  await input.click();
  await input.fill('');                          // clear any retained value
  await input.pressSequentially(query, { delay: 25 }); // real keystrokes trigger the suggestions API
  const option = page.getByRole('option', { name: optionText, exact: false }).first(); // TUNE: option role/text
  await option.waitFor({ state: 'visible', timeout: 12000 });
  await option.click();
  // Confirm a station was selected. Don't compare to the typed query — the portal may
  // resolve it to a different display name (e.g. "Prague" -> "Praha hl.n").
  await expect(input).not.toHaveValue('');
}

/**
 * Ensure the adult traveller count is at least `n` — IDEMPOTENT, so it's safe (and expected)
 * to call before every search.
 *
 * The old version blind-clicked "+" exactly n times and was called only once per session, on
 * the assumption the count then sticks. It doesn't: a full page load of /home resets the count
 * to 0 (verified — a fresh /home reads "0 Traveler"). Clicking SEARCH with 0 travellers makes
 * the form silently refuse to submit — no validation message, no navigation, so it surfaced as
 * an opaque 35s waitForURL timeout. Any code path that reloads /home rather than using the
 * in-app ADD NEW PRODUCTS link (notably the sector-error recovery in b2b-msc.spec.js) therefore
 * poisoned every subsequent sector. Reading the count and topping it up fixes both the reset and
 * the double-increment risk of calling this more than once.
 */
async function setAdults(page, n = 1) {
  const input = page.locator(SEL.adultsInput).first();
  const inc = page.locator(SEL.adultsMore).first();
  await input.waitFor({ state: 'visible', timeout: 15000 });
  for (let guard = 0; guard < 10; guard++) {
    const current = Number(await input.inputValue().catch(() => '')) || 0;
    if (current >= n) return;
    await inc.click();
    await page.waitForTimeout(150);   // the counter re-renders after each click
  }
  throw new Error(`could not raise the adult traveller count to ${n} (stuck at ${await input.inputValue().catch(() => '?')})`);
}

/** Inject the departure date into the Angular date field (it ignores plain typing). */
async function setDate(page, dateStr) {
  await page.locator(SEL.departureDate).first().evaluate((el, v) => {
    el.focus();
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  }, dateStr);
}

/** Click the main SEARCH button and wait for the point-to-point results to render. */
async function clickSearchPTP(page) {
  // There are 3 "search" controls (main form button + 2 sidebar magnifier icons). The icon
  // buttons have no visible text, so filter to the visible button whose TEXT is "SEARCH".
  // Target the stable data-select rather than button-text + .first(): text-plus-ordinal is
  // exactly the kind of positional selector that broke in the 2026-09-01 portal change.
  await page.locator(SEL.searchButton).first().click();
  // Name the step and the URL we're stuck on. Both this and addFirstStandardToCart used a bare
  // 35s waitForURL, so a timeout from either was indistinguishable in the dropped-sector report.
  const reachedResultsPage = await page.waitForURL(/\/search\/point-to-point/, { timeout: 35000 })
    .then(() => true)
    .catch(async () => {
      // Staying on /home is not always a submit failure: a search with a GENUINELY EMPTY
      // result set renders its message INLINE on /home ("Sorry, there is no result
      // corresponding to your search. Please modify it.") rather than navigating to
      // /search/point-to-point at all. The old code treated every non-navigation the same —
      // an actual stuck-form error — which misreported real zero-results outcomes as ERROR.
      // Confirmed by direct reproduction on three separate routes (SNCF POS Zermatt->Chur,
      // SJ Stockholm->Gothenburg, Campania Express Napoli->Sorrento): all three showed this
      // exact message, correct station selections, no validation error — a real "no result",
      // not a bug. Return false so the caller skips waiting for the results-page heading below
      // (it will never appear on /home) and resultCount() correctly reads 0.
      const body = await page.locator('body').innerText().catch(() => '');
      if (/sorry, there is no result corresponding to your search/i.test(body)) return false;

      // Anything else staying on /home means the form refused to submit — report WHY: the
      // most likely causes are a silently-reset traveller count or a validation message.
      const travellers = (body.match(/(\d+)\s+Traveler/i) || [])[0] || '(traveller count not found)';
      const from = await page.locator(SEL.from).first().inputValue().catch(() => '(unreadable)');
      const to = await page.locator(SEL.to).first().inputValue().catch(() => '(unreadable)');
      const date = await page.locator(SEL.departureDate).first().inputValue().catch(() => '(unreadable)');
      const validation = (body.match(/.{0,70}(required|invalid|please (select|enter|choose)|must be).{0,70}/i) || [])[0] || '(none)';
      throw new Error(
        `SEARCH did not reach the results page within 35s (still on ${page.url()}). ` +
        `form: from="${from}" to="${to}" date="${date}" | ${travellers} | validation: ${validation}`
      );
    });
  if (!reachedResultsPage) return;   // genuine zero-result search, nothing more to wait for

  // NOTE: a plain text match on "select your outbound trip" is ambiguous — the sidebar cart
  // panel shows an identically-worded placeholder ("Please select your outbound trip") while
  // no fare is picked yet for this sector. Under slow page loads (e.g. a carrier being
  // unstable) both can be present at once, causing a Playwright strict-mode violation. Scope
  // to the actual results-page heading's stable data-select attribute instead.
  await page.locator('[data-select="offerSearch-labelTitle"]').waitFor({ timeout: 35000 });
}

/**
 * Fill the whole search form for one journey and run the search.
 * Travellers are ensured on EVERY search (setAdults is idempotent) because the count resets to
 * 0 on any full /home load — the `withAdult`-once-per-session approach silently broke every
 * search after such a reload. The option is accepted for backwards compatibility but ignored.
 */
async function searchJourney(page, journey, dateStr, _opts = {}) {
  await selectStation(page, 'from', journey.from.q, journey.from.opt);
  await selectStation(page, 'to', journey.to.q, journey.to.opt);
  await setAdults(page, 1);
  await setDate(page, dateStr);
  await clickSearchPTP(page);
}

/** How many results did the search return? Reads the "(N results)" label. */
async function resultCount(page) {
  const txt = await page.getByText(/\(\d+ results?\)/i).first().innerText().catch(() => '');
  const m = txt.match(/\((\d+)\s+results?\)/i);
  return m ? Number(m[1]) : 0;
}

/**
 * On a results page: add the Standard fare belonging to a SPECIFIC carrier.
 *
 * Why this exists: several ODs return more than one carrier (Barcelona->Madrid serves RENFE,
 * IRYO and OUIGO; Rome->Milan serves Trenitalia and Italo), and taking whichever fare was
 * listed first meant the other carriers were never actually tested even though the report
 * implied they were.
 *
 * `slugPrefix` matches `data-select="ptp-carrier-logo-<slug>"` as a PREFIX, because operators
 * are labelled by sub-brand — `rdg` covers rdg_avanti_west_coast / rdg_lumo / rdg_scotrail,
 * `trenitalia` covers trenitalia_frecciarossa, `dbahn` covers dbahn_intercity_express.
 *
 * Returns { added, slug } and throws a descriptive error if that carrier is not offered on
 * this route — deliberately rather than quietly adding a different carrier's fare, which
 * would turn a real coverage gap into a false pass.
 */
async function addFareForCarrier(page, slugPrefix) {
  const logo = page.locator(`[data-select^="ptp-carrier-logo-${slugPrefix}"]`).first();
  const present = await logo.waitFor({ state: 'visible', timeout: 12000 }).then(() => true).catch(() => false);
  if (!present) {
    const offered = await page.locator('[data-select^="ptp-carrier-logo-"]').evaluateAll((els) =>
      [...new Set(els.map((e) => (e.getAttribute('data-select') || '').replace('ptp-carrier-logo-', '')))].filter(Boolean));
    throw new Error(`carrier "${slugPrefix}" not offered on this route (offered: ${offered.join(', ') || 'none'})`);
  }
  const slug = (await logo.getAttribute('data-select') || '').replace('ptp-carrier-logo-', '');

  // Walk up from the logo to the result row that also holds the fare buttons, then pick this
  // row's first available Standard fare.
  const row = logo.locator('xpath=ancestor::*[.//button][1]');
  let fare = row.getByRole('button', { name: /standard/i }).filter({ hasNotText: /unavailable/i }).first();
  if (!(await fare.count())) {
    // Fall back to a wider ancestor if the immediate one didn't contain the fare cells.
    fare = logo.locator('xpath=ancestor::*[4]').getByRole('button', { name: /standard/i })
      .filter({ hasNotText: /unavailable/i }).first();
  }
  if (!(await fare.count())) throw new Error(`carrier "${slug}" found but no available Standard fare in its row`);
  await fare.click();

  const addBtn = page.getByRole('button', { name: /add to cart/i });
  await addBtn.waitFor({ state: 'visible', timeout: 12000 });
  await addBtn.click();
  await page.waitForURL(/\/cart/, { timeout: 35000 })
    .catch(() => { throw new Error(`ADD TO CART did not reach /cart within 35s (still on ${page.url()})`); });
  return { added: true, slug };
}

/** On a results page: open the first Standard fare and add it to the cart. */
async function addFirstStandardToCart(page) {
  // Pick the first AVAILABLE Standard fare. Skipping "Unavailable"/sold-out cells matters for
  // carriers like RENFE where the top train's Standard is often sold out — clicking that dead
  // cell selects nothing and "Add to cart" never appears (the old first-Standard 12s timeout).
  const fare = page.getByRole('button', { name: /standard/i })
    .filter({ hasNotText: /unavailable/i })
    .first();
  await fare.click();
  const addBtn = page.getByRole('button', { name: /add to cart/i });
  await addBtn.waitFor({ state: 'visible', timeout: 12000 });
  await addBtn.click();
  await page.waitForURL(/\/cart/, { timeout: 35000 })
    .catch(() => { throw new Error(`ADD TO CART did not reach /cart within 35s (still on ${page.url()})`); });
}

/**
 * Get back to a usable search form from WHEREVER we are, keeping the cart.
 *
 * The happy path is the cart page's "ADD NEW PRODUCTS" link. But a failed sector attempt
 * leaves the page on a RESULTS page, where that link does not exist at all — so every later
 * attempt in the same order waited the full 20s for a link that could never appear. One
 * failed sector therefore killed every sector after it in that order (7 sectors lost on
 * 2026-09-10, ~6 min of that run spent purely in those timeouts). Navigate back to the cart
 * first when we are not already there, and fall back to /home if the link still will not
 * show. The cart lives server-side, so plain navigation never loses it.
 */
async function addNewProducts(page) {
  if (!page.url().includes('/cart')) {
    await page.goto('/cart', { waitUntil: 'domcontentloaded' }).catch(() => {});
  }
  const btn = page.getByRole('link', { name: /add new products/i }).first(); // it's an <a> link, not a button
  const viaLink = await btn.waitFor({ state: 'visible', timeout: 20000 }) // cart content loads async (skeletons first)
    .then(() => true).catch(() => false);
  if (viaLink) {
    await btn.click();
    await page.waitForURL(/[/]home/, { timeout: 30000 }).catch(() => {});
  }
  if (!page.url().includes('/home')) await page.goto('/home', { waitUntil: 'domcontentloaded' });
  // 40s, not 15s: on a slow-loading day this form has been observed taking just over 20s to
  // become interactive (confirmed via trace on a run where every sector failed identically
  // on this exact readiness check) — give it real headroom instead of a tight budget.
  await page.locator(SEL.from).first().waitFor({ state: 'visible', timeout: 40000 });
}

/** Read every cart item's TTL string, e.g. ["00:27:46", ...]. */
async function cartExpiries(page) {
  const text = await page.locator('body').innerText();
  return [...text.matchAll(/Expiry\s+(\d{2}:\d{2}:\d{2})/g)].map((m) => m[1]);
}

/** Continue to Traveler details and return the created booking reference (K + digits). */
async function continueToTravelerDetails(page) {
  await page.locator('button:visible').filter({ hasText: /continue to traveler details/i }).first().click();
  await page.waitForURL(/traveler-details/, { timeout: 40000 });
  // The page shows skeletons first — wait for the booking reference to actually render.
  await page.getByText(/Booking reference:\s*[A-Z]\d{6,}/i).first().waitFor({ timeout: 40000 });
  const body = await page.locator('body').innerText();
  const m = body.match(/Booking reference:\s*([A-Z]\d{6,})/i) || body.match(/\b([A-Z]\d{9})\b/);
  return m ? m[1] : null;
}

// NOTE: this suite intentionally stops at "Created" status (see continueToTravelerDetails
// above). A prior version added functions here to fill per-sector traveler details and proceed
// to Hold & Payment to reach "Prebooked" — but that step submits the order to the carrier's own
// booking system (confirmed via LocoHub admin: a real provider PNR/order gets held on the
// carrier side). That's a real side effect on a third-party system, not something this daily
// automation should trigger. Removed rather than left dormant, to avoid it being wired back in
// by accident.

/**
 * Search RAIL PASSES by destination (read-only — never books). The PASSES tab takes a
 * destination region/country (e.g. "Europe" -> Eurail + Interrail Global Passes;
 * "Switzerland" -> Swiss Travel Pass), a 1st-date-of-validity, and traveller counts
 * (defaults to 1 adult). Returns { count, products } for assertions.
 */
async function searchPasses(page, destination, dateStr) {
  await page.goto('/home', { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: /^passes$/i }).click();      // TICKETS | PASSES | GROUPS

  // "Select a destination" is an Era custom <button> select; click it, then click the region.
  await page.getByLabel(/select a destination/i).first().click();
  await page.getByText(destination, { exact: true }).first().click();

  // 1st date of validity (text input, YYYY-MM-DD). Try fill, fall back to JS injection.
  const dateInput = page.getByLabel(/1st date of validity/i).first();
  await dateInput.fill(dateStr).catch(async () => {
    await dateInput.evaluate((el, v) => {
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, dateStr);
  });

  // The page has 3 "search" buttons; the pass form's has a stable data-select.
  await page.locator('[data-select="passes-search-form-search-button"]').click();
  await page.waitForURL(/\/search\/passes/, { timeout: 35000 });
  await page.getByText(/\(\d+ results?\)/i).first().waitFor({ timeout: 35000 });

  const count = await resultCount(page);
  const headings = await page.getByRole('heading').allInnerTexts().catch(() => []);
  const products = [...new Set(headings)]
    .filter((h) => /pass|card|eurail|interrail/i.test(h) && !/^passes:/i.test(h));
  return { count, products };
}

/** Parse a connectivity line's outage duration into minutes (null if not stated). */
function outageMinutes(line) {
  const m = line.match(/for\s+(?:(an?)\s+|(\d+)\s*)(minute|hour|day)/i);
  if (!m) return null;
  const qty = m[1] ? 1 : Number(m[2]);
  const unit = m[3].toLowerCase();
  return unit.startsWith('minute') ? qty : unit.startsWith('hour') ? qty * 60 : qty * 1440;
}

/**
 * Official MSC checklist rule #1: any carrier RED / unstable / down for MORE than
 * `thresholdMin` needs a manual cross-check. Returns { escalate, watch }.
 *  - escalate: unstable/down > threshold (or duration not stated → treat as escalate, safest)
 *  - watch:    unstable <= threshold, or "unknown" status (duration undeterminable)
 */
function flagConnectivity(lines, thresholdMin = 15) {
  const escalate = [], watch = [];
  for (const line of lines) {
    if (/\bis up\b/i.test(line)) continue;
    const carrier = line.replace(/\s+(has been|is)\b.*/i, '').trim();
    // Match "down" in BOTH forms the page uses: the bare "X is down" and the durational
    // "X has been down for 1 hour". Only `is down` was handled before, so a carrier stated as
    // down WITH a duration matched nothing here and was dropped silently — no escalation, and
    // (because it never reached the flagged set) its sector failure was then reported as a
    // regression rather than EXPECTED. Caught on 2026-09-13: the page read "RENFE has been
    // down for 1 hour", RENFE failed all 5 of its routes, and neither the escalation list nor
    // the sector status mentioned that the carrier was down. "Down" is the most severe state
    // the page reports; it was the one state rule #1 was not catching.
    if (/\bdown\b/i.test(line)) {
      const mins = outageMinutes(line);
      (mins === null || mins > thresholdMin ? escalate : watch).push({ carrier, status: 'down', minutes: mins });
      continue;
    }
    if (/unstable/i.test(line)) {
      const mins = outageMinutes(line);
      (mins === null || mins > thresholdMin ? escalate : watch).push({ carrier, status: 'unstable', minutes: mins });
    } else if (/is unknown/i.test(line)) {
      watch.push({ carrier, status: 'unknown', minutes: null });
    }
  }
  return { escalate, watch };
}

/**
 * Which of our test ODs use a given carrier (for the "cross-check the affected OD" step).
 *
 * Matches on each journey's explicit `connectivityNames`, NOT on fuzzy substrings of its
 * display label. The previous version tokenised the label and did a bidirectional
 * `includes`, which was wrong in both directions: multi-word page names such as
 * "EUROPEAN SLEEPER" could never match any single token so they silently mapped to nothing,
 * while "DBSNCF" matched BOTH the DB journey and the TER/SNCF journey because it contains
 * each of their tokens.
 */
function affectedODs(carrier, journeys) {
  const c = carrier.toUpperCase().trim();
  return journeys
    .filter((j) => (j.connectivityNames || []).some((n) => n.toUpperCase().trim() === c))
    .map((j) => `${j.from.q}->${j.to.q}`);
}

/**
 * Parse the health-center page text into `{ section, carrier, status }`, section-aware.
 *
 * Two reasons this is not a flat regex over the whole page any more:
 *  - TRENITALIA and SBB appear under BOTH "Point-to-point inventories" and "Passes
 *    inventories" and can report DIFFERENT statuses at the same time (observed: SBB up for
 *    point-to-point while SBB passes had been unstable for 2 hours). Flattening them made the
 *    escalation list self-contradictory and hid one of the two outages.
 *  - The old carrier charset `[A-Z][A-Za-z ]+?` silently dropped any name containing digits,
 *    hyphens, dots or accents.
 */
function parseConnectivity(bodyText) {
  const rows = [];
  let section = '(none)';
  for (const raw of String(bodyText).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const sec = line.match(/^(Point-to-point|Passes|Services)\s+inventories$/i);
    if (sec) { section = sec[1]; continue; }
    const m = line.match(/^([\p{Lu}][\p{L}\p{N} .&'\/-]*?)\s+(is up|has been unstable[^\n]*|has been down[^\n]*|is unknown|is down)$/u);
    if (m) rows.push({ section, carrier: m[1].trim(), status: m[2].trim() });
  }
  return rows;
}

/**
 * Every carrier on the connectivity page must be accounted for: covered by a booking sector,
 * covered by a rail pass, knowingly excluded, or explicitly pending an OD. Anything else is
 * reported as UNMAPPED so the suite cannot silently drift when Rail Europe adds a carrier —
 * which is exactly how a third of the estate went untested without anyone noticing.
 */
function coverageGaps(connRows, data) {
  const named = new Set();
  (data.ptpJourneys || []).forEach((j) => (j.connectivityNames || []).forEach((n) => named.add(n.toUpperCase())));
  (data.passesToAdd || []).forEach((p) => (p.connectivityNames || []).forEach((n) => named.add(n.toUpperCase())));
  const excluded = new Set((data.connectivityOnly || []).map((x) => x.carrier.toUpperCase()));
  const pending = new Set((data.pendingDiscovery || []).map((x) => x.carrier.toUpperCase()));

  const seen = new Set();
  const out = { covered: [], excluded: [], pending: [], unmapped: [] };
  for (const r of connRows) {
    const key = r.carrier.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (named.has(key)) out.covered.push(r.carrier);
    else if (excluded.has(key)) out.excluded.push(r.carrier);
    else if (pending.has(key)) out.pending.push(r.carrier);
    else out.unmapped.push(r.carrier);
  }
  return out;
}

/**
 * Add ONE rail pass to the current (shared) cart. Deterministic flow discovered on the portal:
 *   PASSES tab -> destination -> validity date -> search -> expand matching price button
 *   -> CONTINUE (passes-result-continue) -> ADD TO CART -> lands on /cart.
 * SEARCH/ADD only — NEVER pays. `destination` e.g. "Europe" (Eurail/Interrail) or "Switzerland".
 * `productMatch` (optional regex) picks a specific product out of a destination's multiple
 * results (e.g. "Europe" returns both Eurail and Interrail, each Continuous/Flex) — titles and
 * price buttons render in the same order, so match on title text then click the same index.
 * Without it, the first result is used (old behaviour). Returns the pass product name added.
 */
async function addPassToCart(page, destination, dateStr, productMatch) {
  await page.goto('/home', { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: /^passes$/i }).click();
  await page.getByLabel(/select a destination/i).first().click();
  await page.getByText(destination, { exact: true }).first().click();
  const di = page.getByLabel(/1st date of validity/i).first();
  await di.fill(dateStr).catch(async () => {
    await di.evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, dateStr);
  });
  await page.locator('[data-select="passes-search-form-search-button"]').click();
  await page.waitForURL(/\/search\/passes/, { timeout: 35000 });
  await page.getByText(/\(\d+ results?\)/i).first().waitFor({ timeout: 35000 });

  const titles = page.locator('[data-select="passesResult-title"]');
  const priceButtons = page.locator('[data-select^="passesResult-priceButton-pass-offer-"]');
  let idx = 0;
  let name = destination;
  if (productMatch) {
    const texts = await titles.allInnerTexts();
    idx = texts.findIndex((t) => productMatch.test(t));
    if (idx === -1) throw new Error(`No pass product matching ${productMatch} in "${destination}" results: ${texts.join(' | ')}`);
    name = texts[idx];
  } else {
    name = await titles.first().innerText().catch(() => destination);
  }
  // The price button is an accordion — expand it, then CONTINUE, then ADD TO CART.
  await priceButtons.nth(idx).click();
  const cont = page.locator('[data-select="passes-result-continue"]').first();
  await cont.waitFor({ state: 'visible', timeout: 12000 });
  await cont.click();
  const addBtn = page.getByRole('button', { name: /add to cart/i }).first();
  await addBtn.waitFor({ state: 'visible', timeout: 12000 });
  await addBtn.click();
  try {
    await page.waitForURL(/\/cart/, { timeout: 35000 });
  } catch (e) {
    // Bumping the timeout alone didn't fix this (still timed out at 75s), so the click isn't
    // just slow to redirect — something is actually blocking it. Capture what's on screen
    // instead of guessing further: current URL, any visible error/modal text, a screenshot.
    const url = page.url();
    const bodyText = await page.locator('body').innerText().catch(() => '(could not read body)');
    const errorish = bodyText.match(/.{0,80}(error|something went wrong|unexpected|sold out|unavailable).{0,80}/i);
    fs.mkdirSync('report', { recursive: true });
    const shotPath = `report/pass-add-fail-${Date.now()}.png`;
    await page.screenshot({ path: shotPath }).catch(() => {});
    throw new Error(
      `Add-to-cart for "${name}" never redirected to /cart (still on ${url}). ` +
      `Visible error-like text: ${errorish ? errorish[0] : '(none found)'}. Screenshot: ${shotPath}. ` +
      `Original: ${e.message}`
    );
  }
  return (name || destination).replace(/\s+/g, ' ').trim();
}

/** Switch the B2B point of sale (e.g. to SNCF Connect 832072551). */
async function switchPOS(page, posNumber) {
  await page.getByText(/Salgaonkar/i).first().click();           // open profile menu (account name, top-right)
  const posInput = page.getByLabel('Switch POS');               // field uses name/aria-label "Switch POS" (not a placeholder)
  await posInput.waitFor({ state: 'visible', timeout: 10000 });
  await posInput.fill(posNumber);
  const opt = page.getByText(new RegExp(posNumber)).first();     // suggestion e.g. "KA-RESAS-EUROPE-FRANCE-832072551"
  await opt.waitFor({ state: 'visible', timeout: 10000 });
  await opt.click();
  // The profile menu stays OPEN with a dimmed backdrop that blocks the form — close it.
  await page.waitForTimeout(1500);                               // let the POS-change reload settle
  await page.getByText(/Salgaonkar/i).first().click().catch(() => {}); // toggle menu closed
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(500);
}

module.exports = {
  SEL,
  blockNoise, dismissCookies, isBotWall,
  futureDate, selectStation, setAdults, setDate, clickSearchPTP, searchJourney,
  resultCount, addFirstStandardToCart, addFareForCarrier, addNewProducts, cartExpiries,
  parseConnectivity, coverageGaps,
  continueToTravelerDetails, switchPOS, searchPasses, addPassToCart,
  outageMinutes, flagConnectivity, affectedODs,
};
