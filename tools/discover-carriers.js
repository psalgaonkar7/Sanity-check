// ============================================================================
// Rail Europe MSC — carrier coverage DISCOVERY (read-only, not part of `npm run sanity`)
// ----------------------------------------------------------------------------
// Answers: "which origin-destination should each connectivity-page carrier be tested with,
// and what selector identifies that carrier in the results?"
//
//   1. Reads /health-center SECTION-AWARE, so the point-to-point SBB/TRENITALIA entries stay
//      distinct from the passes ones (they can and do report different statuses).
//   2. For each candidate OD, runs a real BROWSER search and records:
//        - the autocomplete option text actually chosen (this becomes `from.opt` / `to.opt`)
//        - every `data-select="ptp-carrier-logo-<slug>"` present in the results
//
// Why the browser and not the API: the LocoHub API reports train BRANDS
// ("Railjet Xpress", "ICE", "TGV INOUI", "Avanti West Coast", "Intercity"), which do not map
// cleanly onto the connectivity page's operator codes (OBB, DB, SNCF, RDG, SNCB). The
// results page instead tags every row with the operator slug we need to select that
// carrier's fare for the cart, so it is both the authoritative and the actionable signal.
// It also avoids LocoHub station-code resolution entirely by reusing the same autocomplete
// the suite already drives.
//
// SEARCH ONLY — nothing is added to a cart, booked, or written to the portal.
//
// Run:  node tools/discover-carriers.js
//       MSC_ONLY_NEW=1 node tools/discover-carriers.js   (skip the already-covered ODs)
// ============================================================================
const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');
const H = require('../lib/helpers');

const ROOT = path.join(__dirname, '..');
const DAYS_AHEAD = Number(process.env.MSC_DAYS_AHEAD || 45);

// Candidate ODs typed into the autocomplete. `expect` is a hypothesis to confirm or refute,
// never an assumption. `existing` marks the routes already in data/journeys.js — they are
// probed too, because bundled routes need their FULL carrier list (Barcelona->Madrid is
// RENFE *and* IRYO *and* OUIGO, but the suite currently only ever adds the first fare).
const CANDIDATES = [
  { from: 'Vienna', to: 'Munich', expect: 'OBB', existing: true },
  { from: 'Berlin', to: 'Munich', expect: 'DB', existing: true },
  { from: 'Paris', to: 'Stuttgart', expect: 'TER / SNCF / DBSNCF', existing: true },
  { from: 'London', to: 'Paris', expect: 'EUROSTAR', existing: true },
  { from: 'Geneva', to: 'Paris', expect: 'LYRIA', existing: true },
  { from: 'Edinburgh', to: 'London', expect: 'RDG', existing: true },
  { from: 'Bruxelles', to: 'Mons', expect: 'SNCB', existing: true },
  { from: 'Barcelona', to: 'Madrid', expect: 'RENFE / IRYO / OUIGO', existing: true },
  { from: 'Zermatt', to: 'Chur', expect: 'RHB / SBB', existing: true },
  { from: 'Prague', to: 'Brno', expect: 'REJE / RJET / LEO EXPRESS', existing: true },
  { from: 'Wien', to: 'Gyor', expect: 'RJET', existing: true },
  { from: 'Rome', to: 'Milan', expect: 'TRENITALIA / ITALO', existing: true },
  // --- candidates for the currently-uncovered carriers ---
  { from: 'Bruxelles', to: 'Amsterdam', expect: 'EUROPEAN SLEEPER' },
  { from: 'Prague', to: 'Ostrava', expect: 'LEO EXPRESS' },
  { from: 'Torino', to: 'Milan', expect: 'ARENAWAYS' },
  { from: 'Napoli', to: 'Sorrento', expect: 'CAMPANIA EXPRESS' },
  { from: 'Stockholm', to: 'Goteborg', expect: 'SJ' },
  { from: 'Paris', to: 'Bordeaux', expect: 'OUIGO (FR) / SNCF' },
  { from: 'Paris', to: 'Lyon', expect: 'SNCF / OUIGO' },
  { from: 'Paris', to: 'Rouen', expect: 'TER' },
  { from: 'London', to: 'Manchester', expect: 'RDG (Avanti)' },
];

// ---------------------------------------------------------------- connectivity page
async function readConnectivity(page) {
  await page.goto('/health-center', { waitUntil: 'domcontentloaded' });
  await page.getByText(/\b(is up|has been unstable|is down|is unknown)\b/i).first().waitFor({ timeout: 60000 });
  await page.waitForTimeout(2000);
  const text = await page.locator('body').innerText();

  const rows = [];
  let section = '(none)';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const sec = line.match(/^(Point-to-point|Passes|Services)\s+inventories$/i);
    if (sec) { section = sec[1]; continue; }
    // Permissive name charset: digits/dots/hyphens/accents all occur in carrier branding.
    // The suite's original [A-Z][A-Za-z ]+? silently dropped anything outside plain letters.
    const m = line.match(/^([\p{Lu}][\p{L}\p{N} .&'\/-]*?)\s+(is up|has been unstable[^\n]*|has been down[^\n]*|is unknown|is down)$/u);
    if (m) rows.push({ section, carrier: m[1].trim(), status: m[2].trim() });
  }
  return rows;
}

// ---------------------------------------------------------------- browser probe
/** Type a city and take the FIRST autocomplete suggestion, returning the text it chose. */
async function pickFirstOption(page, selector, query) {
  const input = page.locator(selector).first();
  await input.click();
  await input.fill('');
  await input.pressSequentially(query, { delay: 25 });
  const opt = page.getByRole('option').first();
  await opt.waitFor({ state: 'visible', timeout: 12000 });
  const text = (await opt.innerText()).trim().replace(/\s+/g, ' ');
  await opt.click();
  return text;
}

async function probeOD(page, cand, dateStr) {
  const out = { route: `${cand.from} -> ${cand.to}`, expect: cand.expect, existing: !!cand.existing };
  await page.goto('/home', { waitUntil: 'domcontentloaded' });
  await page.locator(H.SEL.from).first().waitFor({ state: 'visible', timeout: 60000 });
  out.fromOpt = await pickFirstOption(page, H.SEL.from, cand.from);
  out.toOpt = await pickFirstOption(page, H.SEL.to, cand.to);
  await H.setAdults(page, 1);
  await H.setDate(page, dateStr);
  await H.clickSearchPTP(page);
  await page.waitForTimeout(2500);

  out.results = await H.resultCount(page);
  out.slugs = await page.locator('[data-select^="ptp-carrier-logo-"]').evaluateAll((els) =>
    [...new Set(els.map((e) => (e.getAttribute('data-select') || '').replace('ptp-carrier-logo-', '')))].filter(Boolean).sort());
  return out;
}

// ---------------------------------------------------------------- main
(async () => {
  const dateStr = H.futureDate(DAYS_AHEAD);
  const onlyNew = process.env.MSC_ONLY_NEW === '1';
  console.log(`\nMSC carrier discovery — READ-ONLY (search only) — travel date ${dateStr} (+${DAYS_AHEAD}d)\n`);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    storageState: path.join(ROOT, 'storageState.json'),
    baseURL: 'https://customercare.raileurope.com',
  });
  const page = await ctx.newPage();

  console.log('=== 1/2 · connectivity page (section-aware) ===');
  const conn = await readConnectivity(page);
  const bySection = {};
  conn.forEach((r) => { (bySection[r.section] ||= []).push(r); });
  for (const [sec, rows] of Object.entries(bySection)) {
    console.log(`\n  ${sec} inventories (${rows.length}):`);
    rows.forEach((r) => console.log(`    ${r.carrier.padEnd(20)} ${r.status}`));
  }
  const distinct = [...new Set(conn.map((r) => r.carrier))];
  console.log(`\n  => ${conn.length} status lines, ${distinct.length} distinct carriers\n`);

  console.log('=== 2/2 · carrier logos returned per OD (browser) ===\n');
  const probes = [];
  for (const cand of CANDIDATES) {
    if (onlyNew && cand.existing) continue;
    let row;
    try {
      row = await probeOD(page, cand, dateStr);
      console.log(`  ${row.route.padEnd(24)} results=${String(row.results).padStart(3)}  slugs: ${row.slugs.join(', ') || '(none)'}`);
      console.log(`      chose: "${row.fromOpt}"  ->  "${row.toOpt}"`);
    } catch (e) {
      row = { route: `${cand.from} -> ${cand.to}`, expect: cand.expect, existing: !!cand.existing,
        error: String(e).split('\n')[0].slice(0, 150), slugs: [] };
      console.log(`  ${row.route.padEnd(24)} ERROR: ${row.error}`);
    }
    probes.push(row);
  }

  const allSlugs = [...new Set(probes.flatMap((p) => p.slugs || []))].sort();
  console.log('\n=== distinct carrier slugs seen ===');
  console.log('  ' + (allSlugs.join(', ') || '(none)'));
  console.log('\n=== connectivity carriers, for comparison ===');
  console.log('  ' + distinct.join(', '));

  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const slugNorms = allSlugs.map((s) => ({ slug: s, n: norm(s) }));
  console.log('\n=== connectivity carrier -> slug (exact/prefix name match only) ===');
  const unmatched = [];
  for (const c of distinct) {
    const cn = norm(c);
    const hit = slugNorms.find((s) => s.n === cn) || slugNorms.find((s) => s.n.startsWith(cn) || cn.startsWith(s.n));
    const where = hit ? probes.filter((p) => (p.slugs || []).includes(hit.slug)).map((p) => p.route) : [];
    if (hit) console.log(`  ${c.padEnd(20)} -> ${hit.slug.padEnd(18)} on: ${where.join(' | ')}`);
    else unmatched.push(c);
  }
  if (unmatched.length) {
    console.log('\n  NO SLUG MATCH (needs a human decision — different OD, an alias, a pass, or non-bookable):');
    unmatched.forEach((c) => console.log(`    - ${c}`));
  }

  fs.mkdirSync(path.join(ROOT, 'report'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'report', 'carrier-discovery.json'), JSON.stringify(
    { generatedAt: new Date().toISOString(), dateStr, connectivity: conn, probes, allSlugs, unmatched }, null, 2));
  console.log('\nWritten: report/carrier-discovery.json\n');
  await browser.close();
})().catch((e) => { console.error('DISCOVERY FAILED:', e); process.exit(1); });
