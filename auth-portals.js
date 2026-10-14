// Save a login for each portal the sanity check searches on (lib/portals.js): key account ROW,
// agents ROW, key account China, customer care China.
//
//   npm run auth:portals            only portals whose saved login is missing or expired
//   npm run auth:portals -- --all   sign in to every portal again
//
// Deliberately NOT part of `npm run auth` (which stays AWS SSO + the B2B login only): no portal
// accepts another portal's login (tested 2026-10-14), but each saved login carries a refresh
// token, so this should be needed rarely — only when the sanity mail says a portal's saved
// login has expired.
//
// For each one that needs it, a real browser window opens on that portal's sign-in page and
// YOU sign in. Nothing here types or stores a password: once the logged-in page shows, the
// session is saved to auth/<portal>.json (git-ignored) and the window closes. Close the window
// yourself to skip a portal; its mail line then reads [check manually] until you sign in.
const fs = require('fs');
const { chromium } = require('@playwright/test');
const H = require('./lib/helpers');
const P = require('./lib/portals');

const ALL = process.argv.includes('--all');
const SIGN_IN_WAIT = 5 * 60 * 1000;

async function savedLoginWorks(browser, p) {
  if (!P.hasSession(p.key)) return false;
  let ctx;
  try { ctx = await browser.newContext({ storageState: P.sessionFile(p.key) }); } catch { return false; }   // unreadable file = needs a fresh login
  const page = await ctx.newPage();
  try {
    await page.goto(`${p.url}/home`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    return (await H.loginState(page, p.china ? 120000 : 45000)) === 'in';
  } catch { return false; } finally { await ctx.close().catch(() => {}); }
}

(async () => {
  fs.mkdirSync(P.AUTH_DIR, { recursive: true });
  const headless = await chromium.launch();
  const summary = [];
  for (const p of P.PORTALS) {
    if (!ALL && await savedLoginWorks(headless, p)) {
      console.log(`  ✓ ${p.label.padEnd(22)} saved login still valid`);
      summary.push(`${p.label}: valid`);
      continue;
    }
    console.log(`\n  → ${p.label} (${p.url})`);
    console.log('    A browser window is opening — sign in there yourself. Close the window to skip this portal.');
    const browser = await chromium.launch({ headless: false });
    const ctx = await browser.newContext({ viewport: null });
    const page = await ctx.newPage();
    let result = 'skipped';
    try {
      await page.goto(`${p.url}/home`, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
      await H.dismissCookies(page).catch(() => {});
      // Keep checking while you sign in; stop on success, when you close the window, or after 5 min.
      let state = 'out';
      const end = Date.now() + SIGN_IN_WAIT;
      while (Date.now() < end && !page.isClosed()) {
        state = await H.loginState(page, 3000);
        if (state === 'in' || state === 'closed') break;
        await page.waitForTimeout(1000).catch(() => {});
      }
      if (state === 'in') {
        await page.waitForTimeout(1500);                       // let the session cookies settle
        await ctx.storageState({ path: P.sessionFile(p.key) });
        result = 'saved';
      } else if (!page.isClosed()) {
        result = 'not signed in within 5 min — skipped';
      }
    } catch { /* window closed = skip */ }
    await browser.close().catch(() => {});
    console.log(`    ${result === 'saved' ? '✓ login saved' : '– ' + result}`);
    summary.push(`${p.label}: ${result}`);
  }
  await headless.close();
  console.log(`\n=== portal logins · ${summary.join(' · ')} ===`);
})();
