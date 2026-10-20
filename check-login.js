// Quick B2B login-validity probe: loads /home with the saved session and reports whether
// we're still logged in, so a scheduled/monitored sanity run doesn't fail on an expired session.
const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');
const H = require('./lib/helpers');
(async () => {
  // A fresh machine has no saved login yet: say so plainly instead of crashing.
  if (!fs.existsSync(path.join(__dirname, 'storageState.json'))) {
    console.log('LOGIN: NONE SAVED (run npm run auth)');
    process.exitCode = 1;
    return;
  }
  const browser = await chromium.launch();
  const context = await browser.newContext({ storageState: path.join(__dirname, 'storageState.json') });
  const page = await context.newPage();
  try {
    await page.goto('https://customercare.raileurope.com/home', { waitUntil: 'domcontentloaded' });
    const state = await H.loginState(page, 30000);
    const who = state === 'in' ? (await page.locator(H.SEL.userName).first().innerText().catch(() => '')).trim() : '';
    console.log('LOGIN:', state === 'in' ? `VALID (logged in${who ? ' as ' + who : ''})`
      : state === 'out' ? 'EXPIRED (needs npm run auth)' : 'UNKNOWN (portal did not finish loading)');
  } catch (e) {
    console.log('LOGIN: CHECK-FAILED', String(e).split('\n')[0]);
  } finally {
    await browser.close();
  }
})();
