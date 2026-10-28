// Compile run-history.jsonl into a weekly Markdown report. Reads the durable history log,
// keeps the last 7 days (override with DAYS env), and writes weekly-report.md.
// Run: npm run weekly
const fs = require('fs');
const path = require('path');
const HIST = path.join(__dirname, 'run-history.jsonl');
const OUT = path.join(__dirname, 'weekly-report.md');
const DAYS = Number(process.env.DAYS || 7);

if (!fs.existsSync(HIST)) { console.log('No run-history.jsonl yet — run `npm run sanity` first.'); process.exit(0); }
const cutoff = Date.now() - DAYS * 24 * 3600 * 1000;
const rows = fs.readFileSync(HIST, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean).filter((r) => new Date(r.ts).getTime() >= cutoff);

const d = (ts) => { const x = new Date(ts); return `${x.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })} ${x.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`; };
const trainsN = (t) => (t && /^(\d+)/.test(t)) ? Number(t.match(/^(\d+)/)[1]) : null;

const total = rows.length;
const withBooking = rows.filter((r) => r.booking);
// Compare the two halves of an "x/y" ratio rather than the literal string "12/12": the sector
// count is data-driven (it went 12 -> 19 when coverage was expanded to the whole connectivity
// page), so a hardcoded string silently mis-buckets every run the moment that number changes.
const isFull = (s) => { const m = /^(\d+)\/(\d+)$/.exec(s || ''); return !!m && m[1] === m[2]; };
const cleanFull = rows.filter((r) => isFull(r.trains));
const partial = rows.filter((r) => r.booking && r.trains && !isFull(r.trains));
const failed = rows.filter((r) => !r.booking);
const prodPass = rows.filter((r) => isFull(r.apiProd)).length;
const prodRuns = rows.filter((r) => r.apiProd).length;

const carrierFlagCount = {};
rows.forEach((r) => (r.flags || []).forEach((c) => { carrierFlagCount[c] = (carrierFlagCount[c] || 0) + 1; }));
const dropCount = {};
rows.forEach((r) => (r.dropped || []).forEach((s) => { dropCount[s] = (dropCount[s] || 0) + 1; }));
const topFlags = Object.entries(carrierFlagCount).sort((a, b) => b[1] - a[1]).slice(0, 8);
const topDrops = Object.entries(dropCount).sort((a, b) => b[1] - a[1]).slice(0, 8);

let md = `# Rail Europe MSC — Weekly Sanity Report\n\n`;
md += `Window: last ${DAYS} days · Generated from ${total} logged run${total === 1 ? '' : 's'}.\n\n`;
md += `## Summary\n\n`;
md += `| Metric | Value |\n|---|---|\n`;
md += `| Total runs | ${total} |\n`;
md += `| Booking reference captured | ${withBooking.length} / ${total} |\n`;
md += `| Clean full-cart runs (all sectors) | ${cleanFull.length} |\n`;
md += `| Partial cart (some sectors dropped) | ${partial.length} |\n`;
md += `| Failed (no booking) | ${failed.length} |\n`;
md += `| API Production all routes PASS | ${prodPass} / ${prodRuns} runs |\n\n`;

md += `## Every run\n\n`;
md += `| When | Booking | Trains | Pass | API Prod | Dropped |\n|---|---|---|---|---|---|\n`;
for (const r of rows) {
  md += `| ${d(r.ts)} | ${r.booking || '—'} | ${r.trains || '—'} | ${r.pass ? r.pass.replace('Global Mobile ', '') : '—'} | ${r.apiProd || '—'} | ${(r.dropped || []).join(', ') || '—'} |\n`;
}

md += `\n## Observations & recurring issues\n\n`;
if (topDrops.length) md += `- **Sectors that dropped from the cart:** ${topDrops.map(([s, n]) => `${s} (${n}×)`).join(', ')}\n`;
else md += `- No sectors dropped this week — every run built the full cart.\n`;
if (failed.length) md += `- **⚠ ${failed.length} run(s) captured no booking** — investigate (network/login/portal at that time).\n`;
if (prodRuns && prodPass < prodRuns) md += `- **API production was not all-PASS on ${prodRuns - prodPass} run(s)** — check for transient timeouts vs. real gaps.\n`;
md += `\n_Note: reflects only runs recorded in run-history.jsonl. Runs done outside \`npm run sanity\` are logged only if \`node log-run.js\` was called._\n`;

fs.writeFileSync(OUT, md);
console.log(`Weekly report written: ${OUT}  (${total} runs over last ${DAYS} days)`);
