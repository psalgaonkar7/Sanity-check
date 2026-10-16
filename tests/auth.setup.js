// One-time (and whenever the session expires) manual login that captures the B2B
// session into storageState.json, so the daily `npm run msc` runs without handling
// credentials in code.
//
// Run with:  npm run auth        (opens a real browser)
// Then YOU sign in manually in that window. The test waits until it detects you're
// logged in, then saves the session and closes.
//
// We never store or type your password in code — you log in yourself, once.

const { test, expect } = require('@playwright/test');
const H = require('../lib/helpers');

test('capture B2B login session', async ({ page }) => {
  test.setTimeout(5 * 60 * 1000); // up to 5 min for you to sign in

  await page.goto('https://customercare.raileurope.com/home');
  await H.dismissCookies(page); // clear the cookie banner so it doesn't block the login form

  // Wait until the logged-in home shows the account name top-right.
  // (If the session timed out you'll see the Sign in page — just sign in; we keep waiting.)
  await expect(page.getByText(/Salgaonkar/i).first()).toBeVisible({ timeout: 5 * 60 * 1000 });

  await page.context().storageState({ path: 'storageState.json' });
  console.log('\n[auth] Session saved to storageState.json — you can now run `npm run msc`.\n');
});
