// Prints a human-readable summary of the latest sanity run to the console — the same kind
// of detailed breakdown given in chat (booking ref, per-check table, sector list, API detail).
// The carrier-connectivity page and the LocoHub staging check are NOT part of this summary any
// more (removed from the sanity on 2026-10-28). Reads only the report files already on disk;
// makes no network calls. Run standalone: node print-summary.js
const fs = require('fs');
const path = require('path');
const REPORT = path.join(__dirname, 'report');
const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(REPORT, f), 'utf8')); } catch { return null; } };

const b2b = read('msc-b2b.json') || {};
const api = read('api-searchability.json') || {};
const env = (label) => (api.envs || []).find((e) => e.label === label);
const prod = env('PRODUCTION');

const line = (ch = '─') => ch.repeat(72);
const check = (ok) => (ok ? '[PASS]' : ok === false ? '[FAIL]' : '[ -- ]');

console.log('\n' + line('='));
console.log(' RAIL EUROPE ASC — SANITY RUN SUMMARY');
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
  // The opt-in payment-page probe (MSC_PAYMENT_PROBE=1) is the one item that does go further.
  const pp = b2b.paymentProbe;
  if (pp) {
    console.log(` Payment-page probe (1 item, opt-in): ${pp.reachedPayment ? `reached Hold & Payment, ref ${pp.ref || '?'} status ${pp.status || '?'} — never paid, holds one real seat at the carrier` : `NOT reached: ${pp.error || 'payment page button never appeared'}`}`);
  }
} else {
  console.log('\n BOOKING REFERENCE: none captured this run (browser suite likely failed — check login with `npm run auth`)');
}

console.log('\n' + line());
console.log(' CHECK                          RESULT');
console.log(line());
// A carrier that was already flagged down is an expected outage, not a POS regression.
const sncfOk = Array.isArray(b2b.sncfPos) && b2b.sncfPos.length > 0 && b2b.sncfPos.every((r) => r.result !== 'ERROR');
console.log(` SNCF Connect POS               ${check(b2b.sncfPos && b2b.sncfPos.length ? sncfOk : null)} ${(b2b.sncfPos || []).map((r) => `${r.od}:${r.result}${r.count != null ? '(' + r.count + ')' : ''}`).join(', ')}`);
console.log(` Booking reference              ${check(!!b2b.booking)} ${b2b.bookingStatus || ''}`);
const testable = (e) => (e.summary.testable != null ? e.summary.testable : e.rows.length);
const skipNote = (e) => (e.summary.skipped ? ` (+${e.summary.skipped} skipped — no inventory there)` : '');
console.log(` API — Production               ${check(prod ? prod.summary.pass === testable(prod) : null)} ${prod ? `${prod.summary.pass}/${testable(prod)}${skipNote(prod)}` : 'n/a'}`);

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
    console.log('\n ℹ EXPECTED — carrier was already known to be down at the start of the run (not a regression):');
    expected.forEach((s) => console.log(`   #${s.id} ${s.carrier}`));
  }
  if (dropped.length) {
    console.log('\n ⚠ DROPPED:');
    dropped.forEach((s) => console.log(`   #${s.id} ${s.carrier} — ${s.status}${s.error ? ': ' + s.error : ''}`));
  }
}

if (prod) {
  console.log('\n' + line());
  console.log(' API DETAIL');
  console.log(line());
  for (const [label, e] of [['Production', prod]]) {
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
