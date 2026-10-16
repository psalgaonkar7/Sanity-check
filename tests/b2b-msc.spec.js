// B2B Manual Sanity Check.
//   1) Pre-flight: read the connectivity (health-center) page and record carrier status.
//   2) SNCF Connect POS test: switch POS to 832072551, search-only validation for 3 ODs, switch back.
//   3) Build one shared cart across the healthy PTP journeys and capture ONE booking reference,
//      asserting that NO sector is expired at capture time. Stops at Traveler details. NEVER pays.
//
// Reuses the saved login (storageState.json). Run `npm run auth` first if it doesn't exist.

const fs = require('fs');
const { test, expect } = require('@playwright/test');
const data = require('../data/journeys');
const H = require('../lib/helpers');

const DATE = H.futureDate(data.daysAhead);
const report = { date: new Date().toISOString(), testDate: DATE, connectivity: [], sncfPos: [], booking: null, sectors: [], issues: [] };

// Prefer a non-empty value from `a` (this worker's own in-memory report), else fall back to `b`
// (whatever's already on disk).
const pick = (a, b) => (Array.isArray(a) ? (a.length ? a : b || []) : (a ?? b ?? null));

// `report` is module-scoped, so it only holds what THIS worker process ran — and Playwright
// replaces the worker mid-file whenever a test fails or times out (it does this even at
// workers:1, to guarantee clean state). The replacement worker re-imports this file and starts
// from a brand-new EMPTY `report`, so a plain overwrite means whichever worker finishes LAST
// wins outright and silently discards the other's data.
//
// Two things make that safe:
//  1) MSC_RUN_ID — run-sanity.js stamps one id for the whole run and every worker inherits it,
//     so we can merge with the on-disk file if and only if it belongs to THIS run. This replaces
//     an earlier "written within the last 30 minutes" heuristic, which was both too loose (two
//     runs close together could cross-contaminate) and too tight — it's what lost the
//     connectivity + SNCF-POS results in a real run: the POS test failed, Playwright swapped in
//     a fresh worker, and by the time that worker persisted, the only file on disk was from an
//     older run and got rejected, so 28 carriers and 3 POS results were overwritten with [].
//  2) persist() runs after EVERY test, not just in afterAll — a worker that is killed mid-file
//     has therefore already flushed everything it completed.
const RUN_ID = process.env.MSC_RUN_ID || `local-${report.date}`;
report.runId = RUN_ID;

function persist() {
  fs.mkdirSync('report', { recursive: true });
  let existing = null;
  try {
    const onDisk = JSON.parse(fs.readFileSync('report/msc-b2b.json', 'utf8'));
    if (onDisk.runId && onDisk.runId === RUN_ID) existing = onDisk;
  } catch {}
  const merged = existing ? {
    runId: RUN_ID,
    date: existing.date,
    testDate: pick(report.testDate, existing.testDate),
    connectivity: pick(report.connectivity, existing.connectivity),
    connectivityRows: pick(report.connectivityRows, existing.connectivityRows),
    coverage: report.coverage || existing.coverage || null,
    connectivityEscalations: pick(report.connectivityEscalations, existing.connectivityEscalations),
    connectivityWatch: pick(report.connectivityWatch, existing.connectivityWatch),
    sncfPos: pick(report.sncfPos, existing.sncfPos),
    booking: report.booking ?? existing.booking ?? null,
    bookings: pick(report.bookings, existing.bookings),
    bookingStatus: report.bookingStatus || existing.bookingStatus,
    bookingExpiredSectors: report.bookingExpiredSectors ?? existing.bookingExpiredSectors ?? null,
    sectors: pick(report.sectors, existing.sectors),
    sectorsInCart: report.sectorsInCart ?? existing.sectorsInCart ?? null,
    sectorsTotal: report.sectorsTotal ?? existing.sectorsTotal ?? null,
    passesInBooking: pick(report.passesInBooking, existing.passesInBooking),
    issues: [...(existing.issues || []), ...report.issues].filter((v, i, arr) =>
      arr.findIndex((x) => JSON.stringify(x) === JSON.stringify(v)) === i),
  } : report;
  fs.writeFileSync('report/msc-b2b.json', JSON.stringify(merged, null, 2));
}

// Drop unreachable third-party analytics/AB hosts; they add ~38s per page load here.
test.beforeEach(async ({ context }) => { await H.blockNoise(context); });

test.afterEach(persist);   // flush as we go, so a worker swap can't lose completed work
test.afterAll(persist);

test('Pre-flight: connectivity status', async ({ page }) => {
  await page.goto('/health-center');
  await H.dismissCookies(page);
  await page.getByText(/Systems connectivity status/i).waitFor({ timeout: 30000 });
  // Carrier cards load asynchronously (skeleton placeholders first) — wait for real status text.
  await page.getByText(/\b(is up|has been unstable|is unknown|is down)\b/i).first().waitFor({ timeout: 30000 });
  const body = await page.locator('body').innerText();
  // Section-aware parse: the page groups carriers under "Point-to-point / Passes / Services
  // inventories", and TRENITALIA and SBB appear in TWO sections with independent statuses.
  const connRows = H.parseConnectivity(body);
  report.connectivityRows = connRows;                      // {section, carrier, status}
  report.connectivity = connRows.map((r) => `${r.carrier} ${r.status}`);   // legacy flat view
  console.log('[connectivity]', report.connectivity.join(' | '));

  // Coverage guard: every carrier on the page must be booked, passed, knowingly excluded, or
  // explicitly pending an OD. Without this the suite drifts silently as carriers are added —
  // which is how a third of the estate ended up untested.
  const cov = H.coverageGaps(connRows, data);
  report.coverage = cov;
  console.log(`[coverage] covered ${cov.covered.length} | excluded ${cov.excluded.length} (${cov.excluded.join(', ') || '-'}) | pending ${cov.pending.length} (${cov.pending.join(', ') || '-'}) | UNMAPPED ${cov.unmapped.length}`);
  if (cov.unmapped.length) {
    report.issues.push({ type: 'unmapped-carriers', detail: cov.unmapped });
    console.log(`⚠️  UNMAPPED CARRIERS (on the connectivity page but tested nowhere): ${cov.unmapped.join(', ')}`);
  }

  // MSC checklist #1: flag any carrier RED/unstable/down for > 15 min for manual cross-check.
  const { escalate, watch } = H.flagConnectivity(report.connectivity, 15);
  escalate.forEach((e) => { e.affectedODs = H.affectedODs(e.carrier, data.ptpJourneys); });
  report.connectivityEscalations = escalate;
  report.connectivityWatch = watch;
  if (escalate.length) {
    report.issues.push({ type: 'connectivity-flag', detail: escalate });
    // NOTE: this only FLAGS to the console/report. Nothing is sent anywhere — no Teams, no email,
    // no ticket. Actually escalating is a manual human step (per SOP rule #1).
    console.log('\n⚠️  CONNECTIVITY FLAG — carriers RED/unstable > 15 min (SOP rule #1). Nothing is auto-sent; these need MANUAL review:');
    for (const e of escalate) {
      const dur = e.minutes != null ? `~${e.minutes} min` : 'duration not stated';
      const ods = e.affectedODs.length ? ` | our ODs: ${e.affectedODs.join(', ')}` : '';
      console.log(`   - ${e.carrier}: ${e.status} (${dur})${ods}`);
    }
    console.log('   SUGGESTED MANUAL STEPS: cross-check offers/products for the affected OD(s); compare on Trainline');
    console.log('           (https://thetrainline.com) to isolate ERA vs carrier; if confirmed, follow');
    console.log('           Critical Incident Management: https://wiki.vsct.fr/display/SR/Critical+Incident+Management');
  }
  if (watch.length) console.log('[watch <=15min / unknown]', watch.map((w) => `${w.carrier}:${w.status}${w.minutes != null ? '(' + w.minutes + 'm)' : ''}`).join(', '));

  expect(report.connectivity.length).toBeGreaterThan(0);
});

test('SNCF Connect POS: search-only validation', async ({ page }) => {
  await page.goto('/home');
  await H.dismissCookies(page);
  // Re-select the SNCF Connect POS before EACH OD: selecting the POS reloads a clean search
  // form (and keeps the POS), which is far more robust than the EDIT SEARCH modify-panel.
  for (const j of data.sncfPosJourneys) {
    let rec = null;
    let lastErr = null;
    // Primary route first, then each verified fallback. Same reasoning as the sectors: one
    // empty OD says nothing about whether SNCF Connect can sell — only every route failing
    // does. Zermatt->Chur in particular returns a genuine zero-result, and reporting that as
    // a POS failure was misleading.
    const routes = [
      { ...j, routeLabel: 'primary' },
      ...(j.alternates || []).map((a, i) => ({ ...j, ...a, routeLabel: `fallback ${i + 1}` })),
    ];
    for (const route of routes) {
      // Retry each route once: a single transient timeout shouldn't discard it.
      for (let attempt = 1; attempt <= 2 && !rec; attempt++) {
        try {
          await page.goto('/home');            // clean start each OD (resets POS to default)...
          await H.switchPOS(page, data.pos.sncfConnect); // ...then re-apply SNCF Connect
          await page.locator(H.SEL.from).first().waitFor({ state: 'visible', timeout: 30000 });
          // No waitForLoadState('networkidle') here. The page keeps a third-party request open
          // for ~38s (kameleoon.io, ERR_CONNECTION_RESET), so networkidle could never settle and
          // simply burned that time on EVERY OD — it is what made this 3-search check take 4.7
          // minutes. Waiting for the actual form input above is the real readiness signal.
          await H.searchJourney(page, route, DATE, { withAdult: true }); // form reloads each time
          const n = await H.resultCount(page);
          if (n > 0) {
            rec = { od: `${route.from.q}->${route.to.q}`, result: 'PASS', count: n };
            if (route.routeLabel !== 'primary') {
              rec.usedFallback = route.routeLabel;
              rec.primaryOd = `${j.from.q}->${j.to.q}`;
              console.log(`[sncf-pos] ${rec.primaryOd} was empty; ${route.routeLabel} ${rec.od} returned ${n}`);
            }
          } else {
            lastErr = 'NO RESULTS';
            break;                              // empty is a final answer for this route
          }
        } catch (e) {
          lastErr = String(e).split('\n')[0];
          await page.goto('/home').catch(() => {}); // recover before retry / next route
        }
      }
      if (rec) break;
    }
    if (!rec) {
      // Every route failed — now it means something. A carrier the pre-flight already flagged
      // as down will obviously fail here too; that is a carrier outage, not a POS regression.
      const flaggedNow = new Set((report.connectivityEscalations || []).map((x) => x.carrier.toUpperCase()));
      const expectedOutage = (j.connectivityNames || []).some((n) => flaggedNow.has(n.toUpperCase()));
      const tried = routes.map((r) => `${r.from.q}->${r.to.q}`).join(' | ');
      rec = {
        od: `${j.from.q}->${j.to.q}`,
        result: expectedOutage ? 'EXPECTED (carrier flagged)' : (lastErr === 'NO RESULTS' ? 'NO RESULTS' : 'ERROR'),
        error: `all ${routes.length} route(s) failed (${tried}); last: ${lastErr}`,
      };
    }
    report.sncfPos.push(rec);
  }
  // Revert POS to default. NOTE: `page.goto('/home')` alone does NOT do this — the switched
  // POS is an account/session-level setting, not local page state, so it silently carries over
  // into the NEXT test's fresh page (same login session) even though that test never touched
  // POS itself. Confirmed by reproduction: every point-to-point search in the booking test timed
  // out identically right after this test ran, because it was searching under SNCF Connect's
  // key-account POS instead of the default Test Profile. Must explicitly switch back.
  await H.switchPOS(page, data.pos.default);
  console.log('[sncf-pos]', JSON.stringify(report.sncfPos));
  const posExpected = report.sncfPos.filter((r) => r.result === 'EXPECTED (carrier flagged)');
  if (posExpected.length) {
    console.log(`[sncf-pos] ℹ️  ${posExpected.map((r) => r.od).join(', ')} failed because the carrier is already flagged down — not counted as a POS regression.`);
  }
  // Only genuine ERRORs fail the POS check; a known carrier outage must not mask or masquerade
  // as an SNCF Connect problem.
  expect(report.sncfPos.every((r) => r.result !== 'ERROR')).toBeTruthy();
});

/**
 * The B2B order has a HARD CAP of 15 items — the portal answers the 16th add-to-cart with
 * "You have reached the maximum number of items in your order, please proceed to ...".
 * Full coverage needs 23 items (19 sectors + 4 passes), so the run builds SEVERAL orders and
 * captures a booking reference for each.
 *
 * This cap is also the real cause of a long-running mystery: 12 sectors + 3 passes is exactly
 * 15, so the third pass sat right on the limit and failed intermittently. It looked like an
 * opaque 35s timeout for weeks because nothing read the on-screen error text.
 */
const MAX_ITEMS_PER_ORDER = Number(process.env.MSC_MAX_ITEMS_PER_ORDER || 15);

/** Empty the cart, waiting properly rather than assuming the button is already rendered. */
async function clearCart(page) {
  // The cart page shows loading skeletons before real content — checking isVisible()
  // immediately can catch it mid-skeleton and read as "no button", silently skipping the
  // clear. That is how a stale cart snowballed across runs (one was found at 15 items /
  // EUR2235, all expired) and then made every subsequent sector search time out.
  await page.goto('/cart');
  await H.dismissCookies(page);
  const delAll = page.getByRole('button', { name: /^delete all$/i });
  const hasItems = await delAll.first().waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false);
  if (!hasItems) return;
  await delAll.first().click();
  const confirmBtn = page.getByRole('button', { name: /^delete all$/i }).last();
  await confirmBtn.waitFor({ state: 'visible', timeout: 10000 });
  await confirmBtn.click();
  await delAll.first().waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
}

test('B2B: build carts and capture booking references (none expired)', async ({ page }) => {
  // Several orders, each up to 15 items — give the whole thing room rather than being killed
  // mid-batch with only part of the coverage recorded.
  test.setTimeout(30 * 60 * 1000);
  await clearCart(page);
  await page.goto('/home');
  // Wait for the search form to actually be ready before the loop starts hammering it.
  // addNewProducts() already waits for this input before searching sector 2+; the initial
  // /home load before sector 1 didn't, so a genuinely slow load could still bite sector 1.
  // HISTORICAL NOTE: a run where ALL 12 sectors failed identically here was originally blamed
  // on the home page being slow to become interactive. That was WRONG — the page was loading
  // in well under a second. The portal had renamed the field (`name="from"` -> the namespaced
  // `ng.form1.from`, plus random per-load ids), so the old selector matched nothing and every
  // sector simply burned the full 20s actionTimeout. See the SEL map in lib/helpers.js. Keep
  // this readiness wait anyway — it's cheap insurance — but it is NOT what fixed that run.
  await page.locator(H.SEL.from).first().waitFor({ state: 'visible', timeout: 40000 }).catch(() => {});

  // MSC_MAX_SECTORS lets us validate the flow on a small subset (e.g. 2) before the full set.
  let journeys = data.ptpJourneys.slice(0, Number(process.env.MSC_MAX_SECTORS || data.ptpJourneys.length));

  // Carriers the pre-flight already flagged as RED/unstable. Their sectors are STILL tested —
  // an outage should be confirmed, not assumed — but a resulting failure is reported as
  // expected rather than as a regression, and they are ordered last so a known-bad carrier
  // burning its timeouts cannot delay or destabilise the healthy ones.
  //
  // report.connectivityEscalations is normally set by the pre-flight test earlier in THIS
  // module. But Playwright replaces the worker after any test failure, and a replacement
  // worker re-imports this file into a brand-new process with `report` back at its initial
  // empty state — so if the SNCF POS test (which runs between pre-flight and this test) fails,
  // this test can start in a fresh worker that never saw the real escalation list, silently
  // reporting a genuine flagged-carrier outage as ERROR instead of EXPECTED. Confirmed live:
  // EUROPEAN SLEEPER was flagged unstable, its sector failed for exactly that reason, and still
  // got labelled ERROR because the POS test's failure had swapped the worker underneath it.
  // Fall back to the run-id-matched on-disk report (same gate persist() uses) when the
  // in-memory list is empty, so a worker swap can't blind this classification.
  let escalations = report.connectivityEscalations;
  if (!escalations || !escalations.length) {
    try {
      const onDisk = JSON.parse(fs.readFileSync('report/msc-b2b.json', 'utf8'));
      if (onDisk.runId === RUN_ID && Array.isArray(onDisk.connectivityEscalations)) {
        escalations = onDisk.connectivityEscalations;
        console.log(`[sectors] recovered ${escalations.length} connectivity escalation(s) from disk (this worker started fresh after an earlier test failure)`);
      }
    } catch { /* no on-disk report yet, or it's from a different run — leave escalations as-is */ }
  }
  const flagged = new Set((escalations || []).map((e) => e.carrier.toUpperCase()));
  const isFlagged = (j) => (j.connectivityNames || []).some((n) => flagged.has(n.toUpperCase()));
  journeys = [...journeys].sort((a, b) => (isFlagged(a) ? 1 : 0) - (isFlagged(b) ? 1 : 0));
  if (flagged.size) {
    console.log(`[sectors] deferring flagged carriers to the end: ${journeys.filter(isFlagged).map((j) => j.carrier).join(', ') || '(none of ours)'}`);
  }

  // One work list, PASSES FIRST. Passes are a separate inventory on the connectivity page and
  // were silently squeezed out when sectors filled the cart first, so they get the early slots.
  const work = [
    ...data.passesToAdd.map((p) => ({ kind: 'pass', id: 'PASS', label: p.label, carrier: `PASS/${p.label}`, spec: p })),
    ...journeys.map((j) => ({ kind: 'sector', id: j.id, label: j.carrier, carrier: j.carrier, spec: j })),
  ];
  // Split into orders of at most MAX_ITEMS_PER_ORDER; each becomes its own booking reference.
  const batches = [];
  for (let i = 0; i < work.length; i += MAX_ITEMS_PER_ORDER) batches.push(work.slice(i, i + MAX_ITEMS_PER_ORDER));
  console.log(`[booking] ${work.length} items (${data.passesToAdd.length} passes + ${journeys.length} sectors) -> ${batches.length} order(s), max ${MAX_ITEMS_PER_ORDER} each`);

  report.passesInBooking = [];
  report.bookings = [];
  let totalInCart = 0;

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    console.log(`\n[booking] ===== order ${b + 1}/${batches.length} (${batch.length} items) =====`);
    if (b > 0) await clearCart(page);          // previous order is captured; start the next clean
    let inThisCart = 0;

    for (const item of batch) {
      const flaggedItem = item.kind === 'sector' && isFlagged(item.spec);
      try {
        if (item.kind === 'pass') {
          const passName = await H.addPassToCart(page, item.spec.destination, DATE, item.spec.productMatch);
          report.passesInBooking.push({ destination: item.spec.destination, label: item.label, product: passName, status: 'IN CART', order: b + 1 });
          report.sectors.push({ id: 'PASS', carrier: item.carrier, product: passName, status: 'IN CART', order: b + 1 });
          console.log(`[booking] pass added: ${passName} (${item.label})`);
        } else {
          // Try the primary route, then each verified fallback in turn. A single OD can be
          // empty for reasons that say nothing about the carrier or the search — a seasonal
          // gap, a timetable change, engineering works that day — and that used to turn the
          // whole run red (Zermatt->Chur did exactly that for weeks). A sector is only failed
          // once EVERY route for that carrier has failed, which is the honest signal.
          const routes = [
            { ...item.spec, routeLabel: 'primary' },
            ...(item.spec.alternates || []).map((a, i) => ({ ...item.spec, ...a, routeLabel: `fallback ${i + 1}` })),
          ];

          // Some services do not run every night, and for those an alternate ROUTE is no help
          // at all — the whole service is absent that day, so every route fails together.
          // EUROPEAN SLEEPER does not run on Saturdays on the Brussels-Berlin axis: verified
          // 2026-09-16 over 14 consecutive dates, offered on 12, and the only two misses were
          // both Saturdays. Since the run searches a moving target (+45 days), that lands on a
          // non-service day roughly once a week and dropped the sector every time.
          // `nonDaily` carriers therefore retry the WHOLE route list on the next day(s).
          const dates = [DATE];
          if (item.spec.nonDaily) {
            for (let k = 1; k <= 2; k++) dates.push(H.futureDate(data.daysAhead + k));
          }
          const attempts = [];
          for (const d of dates) for (const r of routes) attempts.push({ route: r, date: d });

          let placed = null, lastReason = null;
          for (const [ri, { route, date }] of attempts.entries()) {
            try {
              // Get back to a usable search form before every attempt, not just the first:
              // a failed attempt can leave us on a results page or mid-flow.
              if (inThisCart > 0) await H.addNewProducts(page);
              else if (ri > 0) {
                await page.goto('/home');
                await page.locator(H.SEL.from).first().waitFor({ state: 'visible', timeout: 40000 });
              }
              await H.searchJourney(page, route, date);
              if (await H.resultCount(page) === 0) { lastReason = 'NO RESULTS'; continue; }
              let slug = null;
              if (item.spec.carrierSlug) ({ slug } = await H.addFareForCarrier(page, item.spec.carrierSlug));
              else await H.addFirstStandardToCart(page);
              placed = { slug, route, date };
              break;
            } catch (err) {
              lastReason = String(err).split('\n')[0];
              if (/maximum number of items/i.test(lastReason)) throw err;   // cap: let the outer handler stop the batch
            }
          }

          if (!placed) {
            // Every route failed — now it is a real finding, not a route quirk.
            const tried = routes.map((r) => `${r.from.q}->${r.to.q}`).join(' | ');
            const overDates = dates.length > 1 ? ` on each of ${dates.length} dates (${dates.join(', ')})` : '';
            report.sectors.push({
              id: item.id, carrier: item.carrier,
              status: flaggedItem ? 'EXPECTED (carrier flagged)' : (lastReason === 'NO RESULTS' ? 'NO RESULTS' : 'ERROR'),
              error: `all ${routes.length} route(s) failed${overDates} (${tried}); last: ${lastReason}`,
              routesTried: routes.length, datesTried: dates.length, order: b + 1,
            });
            const st = flaggedItem ? 'EXPECTED (carrier flagged)' : (lastReason === 'NO RESULTS' ? 'NO RESULTS' : 'ERROR');
            console.log(`[booking] ${item.carrier} did NOT add [${st}] after ${routes.length} route(s): ${String(lastReason).slice(0, 100)}`);
            // Recover the page before moving on, same as the catch block below. Without this we
            // stayed stranded wherever the last attempt died (usually a results page, which has
            // no ADD NEW PRODUCTS link) and every remaining item in the order inherited it —
            // that is how one dead sector took 7 down with it on 2026-09-10.
            if (inThisCart > 0) await page.goto('/cart', { waitUntil: 'domcontentloaded' }).catch(() => {});
            else { await page.goto('/home').catch(() => {}); await page.locator(H.SEL.from).first().waitFor({ state: 'visible', timeout: 40000 }).catch(() => {}); }
            continue;
          }

          const usedOtherDate = placed.date !== DATE;
          if (usedOtherDate) {
            console.log(`[booking] ${item.carrier}: no service on ${DATE}, sold on ${placed.date}`);
          }
          const usedFallback = placed.route.routeLabel !== 'primary';
          if (usedFallback) {
            console.log(`[booking] ${item.carrier}: primary route failed, succeeded on ${placed.route.routeLabel} (${placed.route.from.q}->${placed.route.to.q})`);
          }
          report.sectors.push({
            id: item.id, carrier: item.carrier, status: 'IN CART', slug: placed.slug,
            route: `${placed.route.from.q}->${placed.route.to.q}`,
            usedFallback: usedFallback || undefined, usedDate: usedOtherDate ? placed.date : undefined, order: b + 1,
          });
        }
        inThisCart++;
        totalInCart++;
      } catch (e) {
        const err = String(e).split('\n')[0];
        const capHit = /maximum number of items/i.test(err);
        const status = capHit ? 'CART FULL' : (flaggedItem ? 'EXPECTED (carrier flagged)' : 'ERROR');
        if (item.kind === 'pass') report.passesInBooking.push({ destination: item.spec.destination, label: item.label, status, error: err, order: b + 1 });
        report.sectors.push({ id: item.id, carrier: item.carrier, status, error: err, order: b + 1 });
        console.log(`[booking] ${item.carrier} did NOT add [${status}]: ${err.slice(0, 120)}`);
        if (capHit) {
          // Batching should prevent this; if it still happens the real cap is lower than we
          // think, so say so loudly instead of quietly losing the rest of the batch.
          console.log(`[booking] ⚠️  hit the order item cap at ${inThisCart} items — MSC_MAX_ITEMS_PER_ORDER (${MAX_ITEMS_PER_ORDER}) may be too high.`);
          break;
        }
        // Reset to a clean state so the next item isn't dragged down by this failure.
        if (inThisCart > 0) await page.goto('/cart', { waitUntil: 'domcontentloaded' }).catch(() => {});
        else {
          await page.goto('/home').catch(() => {});
          await page.locator(H.SEL.from).first().waitFor({ state: 'visible', timeout: 40000 }).catch(() => {});
        }
      }
    }

    if (inThisCart === 0) { console.log(`[booking] order ${b + 1}: nothing added, skipping checkout`); continue; }

    // Capture this order's booking reference while every item is still live.
    await page.goto('/cart');
    const expiriesBefore = await H.cartExpiries(page);
    expect(expiriesBefore.some((t) => t === '00:00:00'), `no item should be expired before checkout (order ${b + 1})`).toBeFalsy();

    // Capture the booking reference from the Traveler Details page and STOP — do not fill
    // per-item traveler data or proceed to Hold & Payment. That step submits the order to the
    // carrier's own booking system (confirmed via LocoHub admin: a real provider PNR/order gets
    // held on the carrier side, e.g. "Booked. The item has not been purchased."), which is a real
    // side effect on a third-party system. Created status (cart-side only, nothing sent to the
    // carrier) is the correct and sufficient proof.
    const bref = await H.continueToTravelerDetails(page);
    const bodyAfter = await page.locator('body').innerText();
    const bexpired = (bodyAfter.match(/00:00:00/g) || []).length;
    report.bookings.push({ order: b + 1, ref: bref, items: inThisCart, expired: bexpired });
    console.log(`[booking] order ${b + 1}: reference=${bref}  items=${inThisCart}  expired=${bexpired}`);
    expect(bref, `a booking reference should be created for order ${b + 1}`).toMatch(/^[A-Z]\d{6,}$/);
    expect(bexpired, `no item expired in order ${b + 1}`).toBe(0);
  }

  // Primary reference stays `booking` so the summary, deck and history keep working; the full
  // list lives in `bookings`.
  report.booking = report.bookings.length ? report.bookings[0].ref : null;
  report.bookingStatus = 'Created';
  report.bookingExpiredSectors = report.bookings.reduce((n, x) => n + x.expired, 0);
  report.sectorsInCart = report.sectors.filter((s) => s.status === 'IN CART' && s.id !== 'PASS').length;
  report.sectorsTotal = journeys.length;

  const expected = report.sectors.filter((s) => s.status === 'EXPECTED (carrier flagged)');
  const dropped = report.sectors.filter((s) => !['IN CART', 'EXPECTED (carrier flagged)'].includes(s.status));
  const passesOk = report.passesInBooking.filter((p) => p.status === 'IN CART');
  console.log(`\n[booking] refs: ${report.bookings.map((x) => `${x.ref}(${x.items})`).join(', ') || '(none)'}`);
  console.log(`[booking] items in cart: ${totalInCart}/${work.length}  |  sectors ${report.sectorsInCart}/${journeys.length}  |  passes ${passesOk.length}/${data.passesToAdd.length}`);
  if (expected.length) {
    report.issues.push({ type: 'sectors-expected-outage', detail: expected });
    console.log(`[booking] ℹ️  EXPECTED (carrier already flagged), not a regression: ${expected.map((s) => s.carrier).join(', ')}`);
  }
  if (dropped.length) {
    report.issues.push({ type: 'sectors-dropped', detail: dropped });
    console.log(`[booking] ⚠️  DROPPED ${dropped.length}: ` + dropped.map((s) => `${s.carrier} [${s.status}]`).join('  |  '));
  }
  console.log('');
  expect(report.bookings.length, 'at least one booking reference should be created').toBeGreaterThan(0);

  // ⛔ HARD STOP. We are on Traveler Details, status Created. We do NOT fill traveler data,
  // do NOT click "CONTINUE TO HOLD & PAYMENT" (that submits the order to the carrier's own
  // booking system — a real side effect we don't want on every automated run), do NOT touch
  // details. The Prebooked booking reference is the proof of a successful MSC.
});
