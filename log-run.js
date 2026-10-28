// Append one line summarising the latest run to run-history.jsonl (durable, survives sessions).
// Called automatically at the end of run-sanity.js so the weekly report has complete data.
const fs = require('fs');
const path = require('path');
const REPORT = path.join(__dirname, 'report');
const HIST = path.join(__dirname, 'run-history.jsonl');
function readJson(f) { try { return JSON.parse(fs.readFileSync(path.join(REPORT, f), 'utf8')); } catch { return null; } }

const b2b = readJson('msc-b2b.json') || {};
const api = readJson('api-searchability.json') || {};
const env = (label) => (api.envs || []).find((e) => e.label === label);
const prod = env('PRODUCTION');

// LocoHub staging and the connectivity-page flags are no longer part of the sanity (removed
// 2026-10-28), so new history lines carry neither `apiStaging` nor `flags`. Older lines keep them.
const dropped = (b2b.sectors || []).filter((s) => s.status !== 'IN CART' && s.id !== 'PASS').map((s) => `#${s.id} ${s.carrier}`);

const entry = {
  ts: new Date().toISOString(),
  booking: b2b.booking || null,
  trains: (b2b.sectorsInCart != null && b2b.sectorsTotal != null) ? `${b2b.sectorsInCart}/${b2b.sectorsTotal}` : null,
  passes: (b2b.passesInBooking || []).filter((p) => p.status === 'IN CART').map((p) => p.product),
  expired: b2b.bookingExpiredSectors != null ? b2b.bookingExpiredSectors : null,
  apiProd: prod ? `${prod.summary.pass}/${prod.rows.length}` : null,
  dropped,
};
fs.appendFileSync(HIST, JSON.stringify(entry) + '\n');
console.log(`[history] logged: booking=${entry.booking || '(none)'} trains=${entry.trains || 'n/a'} apiProd=${entry.apiProd || 'n/a'} dropped=${dropped.length}`);
