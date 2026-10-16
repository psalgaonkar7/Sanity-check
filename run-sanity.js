// Full sanity runner. Runs the B2B browser suite AND the API searchability check —
// the API ALWAYS runs, even if a browser test fails, so a transient portal hiccup can
// never hide the (bot-proof) search signal. Then it auto-refreshes the manager deck from
// the fresh report data. Exits non-zero if the browser or API part failed.
const { spawnSync, spawn } = require('child_process');

// One id for the whole run, inherited by every Playwright worker. The b2b spec merges its
// report with the on-disk copy only when the ids match, so a worker that Playwright replaces
// mid-run can't lose the earlier worker's results or pick up a previous run's.
process.env.MSC_RUN_ID = `${new Date().toISOString()}-${process.pid}`;

function run(cmd) {
  const r = spawnSync(cmd, { stdio: 'inherit', shell: true, cwd: __dirname });
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

(async () => {
  // The API check runs CONCURRENTLY with the browser suite: it is a separate read-only process
  // that never touches the B2B account, cart or POS, so it cannot interfere. The browser tests
  // themselves must stay strictly serial — they all share ONE account/cart/POS, which is why
  // playwright.config.js pins `workers: 1`. Overlapping them corrupts the run.
  // Its output is buffered and printed in order afterwards, so the logs stay readable.
  // The extra checks (Primer, AppFlow, China portals, SF cases) are also independent of the
  // B2B account — the China check uses its own browser on the .cn domains — so they run in
  // parallel too, and add no time to the run.
  console.log('\n=== 1/5 · B2B browser suite (serial — shared account)  ‖  API searchability + extra checks (in parallel) ===\n');
  const apiPromise = startBackground('node api-searchability.js');
  const extrasPromise = startBackground('node extra-checks.js');
  const b2b = run('npx playwright test --project=b2b');

  console.log('\n=== 2/5 · API searchability (all ODs · staging + production) ===\n');
  const apiRes = await apiPromise;
  process.stdout.write(apiRes.out);
  const api = apiRes.code;

  console.log('\n=== 3/5 · Extra checks (Primer · AppFlow · China portals · SF cases) ===\n');
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

  console.log(`=== sanity done · browser ${b2b === 0 ? 'PASS' : 'FAIL'} · api ${api === 0 ? 'PASS' : 'FAIL'} ===${deckNote}`);
  process.exit(b2b || api ? 1 : 0);
})();
