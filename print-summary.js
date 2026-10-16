// Prints a human-readable summary of the latest sanity run to the console — the same kind
// of detailed breakdown given in chat (booking ref, per-check table, sector list, connectivity
// flags with affected routes, API detail). Reads only the report files already on disk;
// makes no network calls. Run standalone: node print-summary.js
const fs = require('fs');
const path = require('path');
const REPORT = path.join(__dirname, 'report');
const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(REPORT, f), 'utf8')); } catch { return null; } };

const b2b = read('msc-b2b.json') || {};
const api = read('api-searchability.json') || {};
const env = (label) => (api.envs || []).find((e) => e.label === label);
const prod = env('PRODUCTION');
const stg = env('STAGING');

const line = (ch = '─') => ch.repeat(72);
const check = (ok) => (ok ? '[PASS]' : ok === false ? '[FAIL]' : '[ -- ]');

console.log('\n' + line('='));
console.log(' RAIL EUROPE MSC — SANITY RUN SUMMARY');
console.log(line('='));

if (b2b.booking) {
  const trains = (b2b.sectorsInCart != null && b2b.sectorsTotal != null) ? `${b2b.sectorsInCart}/${b2b.sectorsTotal}` : '?/?';
  const passesOk = (b2b.passesInBooking || []).filter((p) => p.status === 'IN CART');
  const passNote = passesOk.length ? ` + passes: ${passesOk.map((p) => p.product).join(', ')}` : '';
  const status = b2b.bookingStatus || 'Created';
  const refs = Array.isArray(b2b.bookings) && b2b.bookings.length ? b2b.bookings : [{ ref: b2b.booking, items: null }];
  // The B2B order caps at 15 items, so full coverage is split across several orders — each
  // gets its own reference and all of them are proof of the run.
  if (refs.length === 1) {
    console.log(`\n BOOKING REFERENCE: ${refs[0].ref}   STATUS: ${status} [PASS]`);
  } else {
    console.log(`\n BOOKING REFERENCES (${refs.length} orders — the portal caps an order at 15 items):`);
    refs.forEach((r) => console.log(`   ${r.ref}   STATUS: ${status} [PASS]${r.items != null ? `   (${r.items} items)` : ''}`));
  }
  console.log(` ${trains} sectors in cart${passNote}  ·  expired: ${b2b.bookingExpiredSectors ?? 0}  ·  stopped at Traveler Details (never proceeds to Hold & Payment, never submitted to the carrier)`);
} else {
  console.log('\n BOOKING REFERENCE: none captured this run (browser suite likely failed — check login with `npm run auth`)');
}

console.log('\n' + line());
console.log(' CHECK                          RESULT');
console.log(line());
// A carrier that was already flagged down is an expected outage, not a POS regression.
const sncfOk = Array.isArray(b2b.sncfPos) && b2b.sncfPos.length > 0 && b2b.sncfPos.every((r) => r.result !== 'ERROR');
const cov = b2b.coverage;
console.log(` Connectivity read              ${check(Array.isArray(b2b.connectivity) && b2b.connectivity.length > 0)} ${b2b.connectivity ? b2b.connectivity.length + ' status lines' : ''}`);
if (cov) {
  const total = cov.covered.length + cov.excluded.length + cov.pending.length + cov.unmapped.length;
  console.log(` Carrier coverage               ${check(cov.unmapped.length === 0)} ${cov.covered.length}/${total} covered`
    + (cov.pending.length ? `, ${cov.pending.length} pending OD` : '')
    + (cov.excluded.length ? `, ${cov.excluded.length} excluded` : '')
    + (cov.unmapped.length ? `, ${cov.unmapped.length} UNMAPPED` : ''));
}
console.log(` SNCF Connect POS               ${check(b2b.sncfPos && b2b.sncfPos.length ? sncfOk : null)} ${(b2b.sncfPos || []).map((r) => `${r.od}:${r.result}${r.count != null ? '(' + r.count + ')' : ''}`).join(', ')}`);
console.log(` Booking reference              ${check(!!b2b.booking)} ${b2b.bookingStatus || ''}`);
const testable = (e) => (e.summary.testable != null ? e.summary.testable : e.rows.length);
const skipNote = (e) => (e.summary.skipped ? ` (+${e.summary.skipped} skipped — no inventory there)` : '');
console.log(` API — Production               ${check(prod ? prod.summary.pass === testable(prod) : null)} ${prod ? `${prod.summary.pass}/${testable(prod)}${skipNote(prod)}` : 'n/a'}`);
console.log(` API — Staging                  ${check(stg ? stg.summary.pass === testable(stg) : null)} ${stg ? `${stg.summary.pass}/${testable(stg)}${skipNote(stg)}` : 'n/a'}`);

if (Array.isArray(b2b.sectors) && b2b.sectors.length) {
  const EXPECTED = 'EXPECTED (carrier flagged)';
  const inCart = b2b.sectors.filter((s) => s.status === 'IN CART').map((s) => `#${s.id} ${s.carrier}`);
  const expected = b2b.sectors.filter((s) => s.status === EXPECTED);
  const dropped = b2b.sectors.filter((s) => s.status !== 'IN CART' && s.status !== EXPECTED);
  console.log('\n' + line());
  console.log(' SECTORS');
  console.log(line());
  // One per line once coverage grows past ~20 entries — a single joined line stopped being readable.
  console.log(' In cart:');
  if (inCart.length) inCart.forEach((s) => console.log('   ' + s)); else console.log('   (none)');
  if (expected.length) {
    console.log('\n ℹ EXPECTED — carrier already flagged on the connectivity page (not a regression):');
    expected.forEach((s) => console.log(`   #${s.id} ${s.carrier}`));
  }
  if (dropped.length) {
    console.log('\n ⚠ DROPPED:');
    dropped.forEach((s) => console.log(`   #${s.id} ${s.carrier} — ${s.status}${s.error ? ': ' + s.error : ''}`));
  }
}

if (cov && (cov.pending.length || cov.excluded.length || cov.unmapped.length)) {
  console.log('\n' + line());
  console.log(' CARRIER COVERAGE');
  console.log(line());
  if (cov.unmapped.length) console.log('  ⚠ UNMAPPED (on the connectivity page, tested nowhere): ' + cov.unmapped.join(', '));
  if (cov.pending.length) console.log('  Pending an origin-destination: ' + cov.pending.join(', '));
  if (cov.excluded.length) console.log('  Knowingly excluded: ' + cov.excluded.join(', '));
}

const esc = b2b.connectivityEscalations || [];
const watch = b2b.connectivityWatch || [];
console.log('\n' + line());
console.log(' CONNECTIVITY FLAG  (SOP rule #1 — nothing auto-sent, manual review only)');
console.log(line());
if (esc.length) {
  esc.forEach((e) => {
    const dur = e.minutes != null ? `~${e.minutes} min` : 'duration not stated';
    const ods = e.affectedODs && e.affectedODs.length ? `  ->  ${e.affectedODs.join(', ')}` : '';
    console.log(`  ${e.carrier} — ${e.status} (${dur})${ods}`);
  });
} else {
  console.log('  No carriers currently flagged (all under 15 min / stable).');
}
if (watch.length) {
  console.log('\n  Watch-list (<=15 min or unknown, not escalated):');
  console.log('   ' + watch.map((w) => `${w.carrier}:${w.status}${w.minutes != null ? '(' + w.minutes + 'm)' : ''}`).join(', '));
}

if (prod || stg) {
  console.log('\n' + line());
  console.log(' API DETAIL');
  console.log(line());
  for (const [label, e] of [['Production', prod], ['Staging', stg]]) {
    if (!e) continue;
    const issues = e.rows.filter((r) => r.status !== 'PASS');
    console.log(`  ${label}: ${e.summary.pass}/${(e.summary.testable != null ? e.summary.testable : e.rows.length)} PASS` + (e.summary.skipped ? `  (+${e.summary.skipped} skipped — no inventory there)` : '') + (issues.length ? '' : '  (clean)'));
    issues.forEach((r) => console.log(`    #${r.id} ${r.route} — ${r.status}${r.rechecked ? (r.status === 'ERROR' ? ' (re-checked, still failing)' : ' (recovered on re-check)') : ''}`));
  }
}

console.log('\n' + line('='));
console.log(` Reports: report/msc-b2b.json, report/api-searchability.json, report/msc-api-searchability.md`);
console.log(` Deck:    Rail-Europe-MSC-Automation-Overview.pptx (auto-refreshed)`);
console.log(line('=') + '\n');
