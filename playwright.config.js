// Playwright configuration for the Rail Europe MSC automation.
// Three "projects":
//   setup -> one-time (headed) manual login that saves the B2B session to storageState.json
//   b2b   -> the B2B sanity check (connectivity, SNCF POS search test, build cart, capture booking ref). Reuses the saved session.
//   b2c   -> the B2C searchability checks (no login needed).
//
// IMPORTANT: This suite NEVER pays, never confirms a booking. The B2B flow stops at the
// "Traveler details" page (where the booking reference is created) by design.

const { defineConfig } = require('@playwright/test');

// One run id shared by the runner and every worker it spawns. The b2b spec merges its report
// with the on-disk copy only when the ids match, so that a worker Playwright replaces mid-run
// (which it does after any failure) cannot discard the earlier worker's results.
// This is set HERE, not only in run-sanity.js, because workers inherit the runner's env: when
// the suite was invoked directly via `npx playwright test`, MSC_RUN_ID was unset and each
// worker fell back to its own timestamp, so the ids never matched and a failing SNCF-POS test
// silently wiped the connectivity + POS results from the report.
process.env.MSC_RUN_ID = process.env.MSC_RUN_ID || `${new Date().toISOString()}-${process.pid}`;

module.exports = defineConfig({
  testDir: './tests',
  // A whole MSC run is generous; individual actions have their own shorter timeouts.
  timeout: 5 * 60 * 1000,
  expect: { timeout: 15000 },
  fullyParallel: false,         // serialises tests WITHIN a file — see `workers` below for across-file.
  // MUST stay 1. `fullyParallel: false` only serialises tests inside a single file; Playwright
  // still runs different FILES concurrently in separate workers (it defaults to ~half the CPU
  // cores — 11 on this 22-core box). The b2b project matches BOTH b2b-msc.spec.js and
  // b2b-passes.spec.js, and both authenticate with the SAME storageState.json — i.e. the SAME
  // server-side B2B account, cart, and point-of-sale. Running them concurrently corrupts shared
  // server state, most damagingly the POS: switchPOS() changes the point of sale ACCOUNT-WIDE,
  // so the SNCF-Connect POS test silently reassigns the POS underneath whatever the other worker
  // is searching. Confirmed from report/results.json of a failed run: worker 1 ran the pass
  // searches at 06:41:08/06:41:12 while worker 0 switched POS at 06:41:10 — that run had all 3
  // SNCF ODs ERROR and all 12 sectors dropped. This race is timing-dependent, which is why the
  // symptom moved around between runs (a dropped pass, dropped sectors, or a wholesale failure)
  // and why it looked intermittent rather than reproducible.
  workers: 1,
  retries: 0,
  reporter: [
    ['list'],
    // HTML report lives in its own subfolder — the HTML reporter CLEANS its outputFolder on
    // start, so keeping it out of report/ stops it wiping our JSON data files (msc-b2b.json etc).
    ['html', { outputFolder: 'report/html', open: 'never' }],
    ['json', { outputFile: 'report/results.json' }],
  ],
  use: {
    // Default: headless (good for scheduled/CI runs). To WATCH it live, set HEADED=1.
    headless: process.env.HEADED !== '1',
    actionTimeout: 20000,
    navigationTimeout: 45000,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    viewport: { width: 1366, height: 900 },
  },
  projects: [
    {
      name: 'setup',
      testMatch: /auth\.setup\.js/,
      use: { baseURL: 'https://customercare.raileurope.com' },
    },
    {
      name: 'b2b',
      testMatch: /b2b-(msc|passes)\.spec\.js/,
      use: {
        baseURL: 'https://customercare.raileurope.com',
        storageState: 'storageState.json', // created by the `setup` project (run `npm run auth` first)
      },
    },
    {
      name: 'b2c',
      testMatch: /b2c-searchability\.spec\.js/,
      use: { baseURL: 'https://www.raileurope.com' },
    },
  ],
});
