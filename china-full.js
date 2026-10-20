// `npm run china-full` — the FULL booking (19 sectors + 3 passes, 2 orders) on customer care
// China, on its own. Opt-in: ~9 min, so it is not part of `npm run sanity` (which books one
// China train inside the normal run, ~45 s). Stops at Traveler Details, never pays.
// Writes report/msc-b2b-chinaCustomerCare.json (+ its own test-results folder); the main
// sanity report is not touched. Needs the saved login: `npm run auth:portals`.
// Optional: pass another portal key, e.g. `node china-full.js rowAgent`.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { PORTALS } = require('./lib/portal-list');

const key = process.argv[2] || 'chinaCustomerCare';
const p = PORTALS.find((x) => x.key === key);
if (!p) { console.log(`Unknown portal "${key}". Choose one of: ${PORTALS.map((x) => x.key).join(', ')}`); process.exit(1); }
if (!fs.existsSync(path.join(__dirname, 'auth', `${key}.json`))) {
  console.log(`No saved login for ${p.label}. Run: npm run auth:portals`);
  process.exit(1);
}
// Same rule as the sanity: one run at a time on a shared account/cart.
const live = spawnSync('powershell', ['-NoProfile', '-Command',
  "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'run-sanity|playwright' } | Measure-Object | Select-Object -ExpandProperty Count"],
{ encoding: 'utf8' });
if (Number((live.stdout || '0').trim()) > 0) {
  console.log('Another sanity/playwright run is going. Wait for it to finish — two runs at once corrupt each other.');
  process.exit(3);
}
console.log(`Full booking on ${p.label} (${p.url}) — about 9 min, never pays.\n`);
const t0 = Date.now();
const r = spawnSync('npx', ['playwright', 'test', '--project=portal'], {
  stdio: 'inherit', shell: true, cwd: __dirname,
  env: { ...process.env, PORTAL: key, MSC_RUN_ID: `portal-${key}-${new Date().toISOString()}`, MSC_PAYMENT_PROBE: '' },
});
let rep = null;
try { rep = JSON.parse(fs.readFileSync(path.join(__dirname, 'report', `msc-b2b-${key}.json`), 'utf8')); } catch {}
if (rep) {
  const miss = (rep.sectors || []).filter((s) => s.status !== 'IN CART');
  console.log(`\n${p.label}: ${(rep.bookings || []).map((b) => `${b.ref}(${b.items})`).join(', ') || 'no booking reference'}`
    + ` · ${(rep.sectors || []).length - miss.length}/${(rep.sectors || []).length} items in cart`
    + (miss.length ? ` · not added: ${miss.map((s) => s.carrier).join(', ')}` : '')
    + ` · ${((Date.now() - t0) / 60000).toFixed(1)} min`);
}
process.exitCode = r.status == null ? 1 : r.status;
