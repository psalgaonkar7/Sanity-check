// Quick B2B login-validity probe: loads /home with the saved session and reports whether
// we're still logged in, so a scheduled/monitored sanity run doesn't fail on an expired session.
const { chromium } = require('@playwright/test');
(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ storageState: 'storageState.json' });
  const page = await context.newPage();
  try {
    await page.goto('https://customercare.raileurope.com/home', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);
    const body = await page.locator('body').innerText();
    const loggedIn = /Salgaonkar/i.test(body);
    const expired = /session has timed out|please (enter|sign) ?in|sign in/i.test(body);
    console.log('LOGIN:', loggedIn ? 'VALID (logged in)' : expired ? 'EXPIRED (needs npm run auth)' : 'UNKNOWN');
  } catch (e) {
    console.log('LOGIN: CHECK-FAILED', String(e).split('\n')[0]);
  } finally {
    await browser.close();
  }
})();
