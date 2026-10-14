// Full sanity runner. Runs the B2B browser suite AND the API searchability check —
// the API ALWAYS runs, even if a browser test fails, so a transient portal hiccup can
// never hide the (bot-proof) search signal. Then it auto-refreshes the manager deck from
// the fresh report data. Exits non-zero if the browser or API part failed.
const { spawnSync, spawn } = require('child_process');

// One id for the whole run, inherited by every Playwright worker. The b2b spec merges its
// report with the on-disk copy only when the ids match, so a worker that Playwright replaces
// mid-run can't lose the earlier worker's results or pick up a previous run's.
process.env.MSC_RUN_ID = `${new Date().toISOString()}-${process.pid}`;

function run(cmd, extraEnv) {
  const r = spawnSync(cmd, { stdio: 'inherit', shell: true, cwd: __dirname, env: extraEnv ? { ...process.env, ...extraEnv } : process.env });
  return r.status == null ? 1 : r.status;
}

/** Start a child now, collect its output, and let the caller await it later. */
function startBackground(cmd) {
  let out = '';
  const p = spawn(cmd, { shell: true, cwd: __dirname });
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  return new Promise((resolve) => p.on('close', (code) => resolve({ code: code == null ? 1 : code, out })));
}

// One run at a time, enforced: every check shares one B2B account, cart and POS, and two runs at
// once corrupt each other (this caused two misdiagnoses before it was a written rule). A lock
// file holds the running pid. A lock whose process is gone is stale and is taken over; a lock
// whose process is alive is respected for up to 3 h (a run is 6 min, or ~30 min with the opt-in
// portal bookings — the cap only guards against a recycled pid after a crash).
// Created with the 'wx' flag so two runs starting together cannot both win, and removed on exit
// only if it still holds OUR pid.
const fs = require('fs');
const path = require('path');
const LOCK = path.join(__dirname, 'report', '.run.lock');
function readLock() {
  try { return JSON.parse(fs.readFileSync(LOCK, 'utf8').replace(/^﻿/, '')); } catch { return null; }   // tolerate a BOM
}
function takeLock() {
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }), { flag: 'wx' });
      process.on('exit', () => { const l = readLock(); if (l && l.pid === process.pid) { try { fs.unlinkSync(LOCK); } catch {} } });
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const l = readLock();
      let alive = false;
      if (l && l.pid) { try { process.kill(l.pid, 0); alive = true; } catch {} }
      if (alive && Date.now() - Date.parse(l.started) < 3 * 3600e3) {
        console.log(`\n✋ Another sanity run is already in progress (pid ${l.pid}, started ${l.started}). `
          + 'Wait for it to finish — two runs at once corrupt each other.\n');
        process.exit(3);
      }
      try { fs.unlinkSync(LOCK); } catch {}   // stale (dead pid, unreadable, or very old): take it over
    }
  }
  console.log('\n✋ Could not take the run lock (report/.run.lock) — is another run starting right now?\n');
  process.exit(3);
}

(async () => {
  takeLock();

  console.log('\n=== 0/5 · Pre-flight (logins, VPN, code version) ===');
  if (run('node preflight.js') === 2) process.exit(1);   // B2B login expired: nothing else can run

  // The API check runs CONCURRENTLY with the browser suite: it is a separate read-only process
  // that never touches the B2B account, cart or POS, so it cannot interfere. The browser tests
  // themselves must stay strictly serial — they all share ONE account/cart/POS, which is why
  // playwright.config.js pins `workers: 1`. Overlapping them corrupts the run.
  // Its output is buffered and printed in order afterwards, so the logs stay readable.
  // The extra checks (Primer, AppFlow, portal searches, dropfile, SF cases) use their own browser
  // contexts and saved portal logins, never the customercare account/cart/POS, so they run in
  // parallel too, and add no time to the run.
  console.log('\n=== 1/5 · B2B browser suite (serial — shared account)  ‖  API searchability + extra checks (in parallel) ===\n');
  const apiPromise = startBackground('node api-searchability.js');
  const extrasPromise = startBackground('node extra-checks.js');
  const b2b = run('npx playwright test --project=b2b');

  // OPT-IN (MSC_PORTAL_BOOKINGS=1): the same full booking (every sector + pass -> carts ->
  // booking refs) on each OTHER portal. OFF by default — each portal adds 4-7 minutes and the
  // whole run went from ~5.5 to ~27.5 min, which is not acceptable for every slot. The default
  // run keeps a fast logged-in SEARCH on every portal instead (extra-checks.js, in parallel, no
  // added time). Turn this on to dig into one suspect portal, e.g. when China search is reported.
  // Strictly one after another and only after the customercare run: the accounts share carts,
  // so overlapping runs would corrupt each other. A portal with no saved login is skipped (its
  // mail line then reads [check manually]); a portal that fails does not stop the others.
  const portalRuns = { runId: process.env.MSC_RUN_ID, portals: {} };
  // The portal searches in the extra checks use the same saved logins as these bookings, so let
  // them finish first rather than overlapping on one session.
  if (process.env.MSC_PORTAL_BOOKINGS === '1') await extrasPromise;
  const wantPortals = process.env.MSC_PORTAL_BOOKINGS === '1'
    ? require('./lib/portal-list').PORTALS.filter((p) => !process.env.MSC_PORTAL_ONLY || process.env.MSC_PORTAL_ONLY.split(',').includes(p.key)) : [];
  for (const p of wantPortals) {
    if (!fs.existsSync(path.join(__dirname, 'auth', `${p.key}.json`))) {
      portalRuns.portals[p.key] = { ran: false, reason: 'no saved login' };
      continue;
    }
    console.log(`\n=== 1b · Booking run on ${p.label} (${p.url}) ===\n`);
    const t0 = Date.now();
    const code = run('npx playwright test --project=portal', { PORTAL: p.key });
    portalRuns.portals[p.key] = { ran: true, code, seconds: Math.round((Date.now() - t0) / 1000) };
    console.log(`\n[portal] ${p.label}: ${code === 0 ? 'PASS' : 'FAIL'} in ${((Date.now() - t0) / 60000).toFixed(1)} min\n`);
  }
  fs.mkdirSync(path.join(__dirname, 'report'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'report', 'portal-runs.json'), JSON.stringify(portalRuns, null, 2));

  console.log('\n=== 2/5 · API searchability (all ODs · staging + production) ===\n');
  const apiRes = await apiPromise;
  process.stdout.write(apiRes.out);
  const api = apiRes.code;

  console.log('\n=== 3/5 · Extra checks (Primer · AppFlow · portal searches ROW + China · dropfile · SF cases) ===\n');
  const extrasRes = await extrasPromise;
  process.stdout.write(extrasRes.out); // informational: never changes the run's exit code

  console.log('\n=== 4/5 · Refresh manager deck from this run ===\n');
  const deck = run('node deck/gen.js'); // never blocks the run result; just a warning if the .pptx is open

  console.log('\n=== 5/5 · Log this run to run-history.jsonl (for the weekly report) ===\n');
  run('node log-run.js'); // always logs — even a failed/partial run — so the weekly report stays complete

  // Human-readable summary (booking refs, per-check table, sectors, connectivity flags, API
  // detail) — the same breakdown given in chat, so this is useful standalone too.
  run('node print-summary.js');

  // Deck refresh is silent on success — only shout if it couldn't update (needs attention).
  const deckNote = deck === 0 ? '' : '  ·  ⚠ DECK NOT UPDATED — close Rail-Europe-MSC-Automation-Overview.pptx and run `npm run deck`';
  // Slack post (#sd_24-7, only for a complete run) + the sanity mail draft (never auto-sent).
  run('node notify.js');

  const portalFail = Object.entries(portalRuns.portals).filter(([, v]) => v.ran && v.code !== 0).map(([k]) => k);
  console.log(`=== sanity done · browser ${b2b === 0 ? 'PASS' : 'FAIL'} · api ${api === 0 ? 'PASS' : 'FAIL'}${portalFail.length ? ' · portal bookings FAILED: ' + portalFail.join(', ') : ''} ===${deckNote}`);
  process.exit(b2b || api || portalFail.length ? 1 : 0);
})();
