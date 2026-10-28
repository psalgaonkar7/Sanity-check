// ONE login command, all in this window (Pratikesh 2026-10-27: "all login process in cmd only", "add aws sso in
// all too of row and china both").
//
//   npm run auth:all              everything that is missing or expired: the 5 portals + AWS EU + AWS China
//   npm run auth:all -- --all     sign in to everything again
//   npm run auth:all -- --portals only the 5 portals        npm run auth:all -- --aws   only AWS (EU, then China)
//   npm run auth                  the same command (it used to open browser windows)
//
// PORTALS (B2B ROW, Key account ROW, Agents ROW, Key account China, Customer care China - same account on all 5):
//   checks each saved login headless (B2B = storageState.json, the 4 others = auth/<key>.json); if any is expired it asks
//   ONCE for username (remembered, not secret) + password (hidden, never stored) and signs in headless, no browser window.
//   B2B goes first and alone: a refused password stops there (one retype), so a typo is never tried on 5 portals.
//   The password lives only in this process's memory: never written to a file, log, env var or command line, never sent
//   anywhere but the portals' own sign-in forms, cleared after use. A failed portal saves a screenshot to auth/last-fail-<key>.png.
//
// AWS SSO (era = EU/Ireland, era-cn = China): since 2026-10-28 the old style again: `aws sso login` opens your browser by itself, click Allow. (Earlier device-code version: printed a
//   link and a short code here; you open the link in any browser (already signed in to the company directory = one Allow
//   click) and enter the code. AWS signs in through the company's own page (and MFA), so a password typed here cannot be
//   used for it - that is why this step prints a code instead of asking for a password.
//   AWS China asks first (Enter = yes, S = skip, auto-yes after 10 s): it is only needed for the China alarms.
//
// Browser fallbacks: npm run auth:b2b / npm run auth:portals (you type in the portal yourself), aws sso login --sso-session era.
// Exit code: 0 all signed in / valid, 1 something failed, 2 skipped by you.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { chromium } = require('@playwright/test');
const H = require('./lib/helpers');
const P = require('./lib/portals');

const ALL = process.argv.includes('--all');
const AWS_ONLY = process.argv.includes('--aws');
const PORTALS_ONLY = process.argv.includes('--portals');
// Test hook (2026-10-27 stub test): a local fake portal + a scratch folder for the session files,
// so a test can never touch the real logins. Both must be set; ignored otherwise.
const TEST_BASE = process.env.ASC_AUTH_TEST_BASE && process.env.ASC_AUTH_TEST_OUT ? process.env.ASC_AUTH_TEST_BASE : null;
const OUT_DIR = TEST_BASE ? process.env.ASC_AUTH_TEST_OUT : null;
// Test hook for AWS (needs the same two settings): run `node <stub> <aws args>` instead of the real AWS CLI.
const AWS_STUB = TEST_BASE && process.env.ASC_AWS_STUB ? process.env.ASC_AWS_STUB : null;

const TARGETS = [{ key: 'b2b', label: 'B2B ROW (customercare)', url: 'https://customercare.raileurope.com', file: path.join(__dirname, 'storageState.json') }]
  .concat(P.PORTALS.map((p) => ({ key: p.key, label: p.label, url: p.url, china: !!p.china, file: P.sessionFile(p.key) })))
  .map((t) => (TEST_BASE ? Object.assign({}, t, { url: TEST_BASE + '/' + t.key, file: path.join(OUT_DIR, t.key + '.json') }) : t));
const USER_FILE = path.join(TEST_BASE ? OUT_DIR : P.AUTH_DIR, '.username');
const SHOT_DIR = TEST_BASE ? OUT_DIR : P.AUTH_DIR;
const wait = (t, ms) => (t.china ? ms * 2 : ms);

/* ------------------------------------------------------------------ AWS --- */

const AWS_TARGETS = [
  { key: 'aws', label: 'AWS EU (era)', profile: 'era-prod', session: 'era', optional: false },
  { key: 'awsCn', label: 'AWS China (era-cn)', profile: 'era-prod-cn', session: 'era-cn', optional: true },
];
function awsRun(args, opts) {
  const env = Object.assign({}, process.env, { MSYS_NO_PATHCONV: '1' });
  if (AWS_STUB) return spawnSync(process.execPath, [AWS_STUB].concat(args), Object.assign({ env }, opts));
  const portable = path.join(os.homedir(), 'aws-cli', 'Amazon', 'AWSCLIV2', 'aws.exe');
  return spawnSync(fs.existsSync(portable) ? portable : 'aws', args, Object.assign({ env }, opts));
}
function awsWorks(t) {
  const r = awsRun(['sts', 'get-caller-identity', '--profile', t.profile, '--output', 'json'], { encoding: 'utf8', timeout: 60000 });
  return r.status === 0;
}
// The old style (Pratikesh 2026-10-28: "aws like same old style in browser is fine"): `aws sso login` opens your browser by
// itself; you click Allow there. Only the 5 portals are done fully in cmd.
function awsLogin(t) {
  console.log('\n  ' + t.label + ': your browser opens for the AWS sign-in - click Allow there. Waiting...\n');
  awsRun(['sso', 'login', '--sso-session', t.session], { stdio: 'inherit', timeout: 11 * 60000 });
  return awsWorks(t);
}

async function awsStep() {
  console.log('\n=== AWS SSO (EU and China) ===');
  const valid = ALL ? AWS_TARGETS.map(() => false) : AWS_TARGETS.map(awsWorks);
  AWS_TARGETS.forEach((t, i) => console.log('  ' + (valid[i] ? 'OK       ' : 'expired  ') + t.label));
  let code = 0;
  for (let i = 0; i < AWS_TARGETS.length; i++) {
    const t = AWS_TARGETS[i];
    if (valid[i]) continue;
    if (t.optional) {
      const a = (await prompt('\n  ' + t.label + ' is only needed for the China alarms. Sign in now? Enter = yes, S = skip (auto-yes in 10 s): ', false, 10000)).trim().toUpperCase();
      if (a === 'S') { console.log('  ' + t.label + ' skipped.'); if (code === 0) code = 2; continue; }
    }
    const ok = awsLogin(t);
    console.log('  ' + (ok ? 'signed in  ' : 'FAILED     ') + t.label);
    if (!ok) code = 1;
  }
  if (AWS_TARGETS.every((t, i) => valid[i])) console.log('  Both AWS logins are valid - nothing to do.');
  return code;
}

/* -------------------------------------------------------------- portals --- */

async function savedLoginWorks(browser, t) {
  if (!fs.existsSync(t.file)) return false;
  let ctx;
  try { ctx = await browser.newContext({ storageState: t.file }); } catch { return false; }   // unreadable = needs a fresh login
  const page = await ctx.newPage();
  try {
    await page.goto(t.url + '/home', { waitUntil: 'domcontentloaded', timeout: wait(t, 60000) });
    return (await H.loginState(page, wait(t, 45000))) === 'in';
  } catch { return false; } finally { await ctx.close().catch(() => {}); }
}

// One line of input; hidden (one * per key) when this is a real console. timeoutMs: resolves '' when nobody answers.
let pipeBuf = '', pipeEnded = false;   // piped input (tests): text read past one line belongs to the next prompt
function prompt(question, hidden, timeoutMs) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    if (!stdin.isTTY) {
      const take = () => {
        const i = pipeBuf.indexOf('\n');
        if (i < 0 && !pipeEnded) return false;
        const line = i < 0 ? pipeBuf : pipeBuf.slice(0, i);
        pipeBuf = i < 0 ? '' : pipeBuf.slice(i + 1);
        process.stdout.write('\n'); resolve(line.replace(/\r$/, ''));
        return true;
      };
      if (take()) return;
      const onData = (d) => { pipeBuf += d.toString('utf8'); if (take()) { stdin.removeListener('data', onData); stdin.removeListener('end', onEnd); stdin.pause(); } };
      const onEnd = () => { pipeEnded = true; stdin.removeListener('data', onData); take(); };
      stdin.resume(); stdin.on('data', onData); stdin.once('end', onEnd);
      return;
    }
    let value = '', timer = null;
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    const onKey = (s) => {
      for (const ch of s) {
        if (ch === '\r' || ch === '\n') { done(); return; }
        if (ch === '\u0003') { stdin.setRawMode(false); process.stdout.write('\n'); process.exit(2); }   // Ctrl+C = skip everything
        if (ch === '\b' || ch === '\u007f') { if (value.length) { value = value.slice(0, -1); process.stdout.write('\b \b'); } continue; }
        if (ch < ' ') continue;
        value += ch; process.stdout.write(hidden ? '*' : ch);
      }
    };
    function done() { if (timer) clearTimeout(timer); stdin.removeListener('data', onKey); stdin.setRawMode(false); stdin.pause(); process.stdout.write('\n'); resolve(value); }
    if (timeoutMs) timer = setTimeout(() => { value = ''; done(); }, timeoutMs);
    stdin.on('data', onKey);
  });
}

// Sign in on one portal's own form. Returns { ok } or { ok:false, why, refused? }; `refused` = the portal said no.
async function signIn(browser, t, user, pass) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  // A screenshot of where it got stuck (the password box only shows dots), so a failure can be diagnosed afterwards.
  const shot = async () => { try { fs.mkdirSync(SHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(SHOT_DIR, 'last-fail-' + t.key + '.png') }); } catch { /* best effort */ } };
  try {
    await page.goto(t.url + '/sign-in', { waitUntil: 'domcontentloaded', timeout: wait(t, 90000) });
    await H.dismissCookies(page).catch(() => {});
    // The real portals label the box with aria-label "Enter username (...)" (no placeholder: found 2026-10-28 when the first
    // real run timed out); the stub test page uses a placeholder. Accept both, then fall back to the first text box.
    const userBox = page.locator('input[aria-label*="username" i], input[placeholder*="username" i], input[type="text"], input[type="email"]').first();
    const passBox = page.locator('input[type="password"]').first();
    await passBox.waitFor({ state: 'visible', timeout: wait(t, 90000) });
    await H.dismissCookies(page).catch(() => {});
    await userBox.fill(user);
    await passBox.fill(pass);
    await page.getByRole('button', { name: /sign in/i }).first().click();
    // Logged in = the header user name shows. Refused = still on the form with an error message.
    const end = Date.now() + wait(t, 90000);
    while (Date.now() < end) {
      if (await page.locator(H.SEL.userName).first().isVisible().catch(() => false)) {
        await page.waitForTimeout(1500);                      // let the session cookies settle
        fs.mkdirSync(path.dirname(t.file), { recursive: true });
        await ctx.storageState({ path: t.file });
        return { ok: true };
      }
      const err = page.locator('[role="alert"], .error, .alert-danger, mat-error, [class*="error" i]').filter({ hasText: /\S/ }).first();
      if (await err.isVisible().catch(() => false) && /sign-?in/i.test(page.url())) {
        const text = (await err.innerText().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 120);
        if (/incorrect|invalid|wrong|not match|failed|denied|locked|exceeded|try again/i.test(text)) { await shot(); return { ok: false, refused: true, why: text }; }
      }
      await page.waitForTimeout(700);
    }
    await shot();
    return { ok: false, why: 'no logged-in page within ' + Math.round(wait(t, 90000) / 1000) + ' s (screenshot: auth/last-fail-' + t.key + '.png)' };
  } catch (e) {
    await shot();
    return { ok: false, why: String(e.message || e).split('\n')[0].slice(0, 120) };
  } finally { await ctx.close().catch(() => {}); }
}

async function portalsStep() {
  const browser = await chromium.launch();
  try {
    console.log('\n=== Portal logins (B2B ROW, Key account ROW, Agents ROW, Key account China, Customer care China) ===');
    const valid = ALL ? TARGETS.map(() => false) : await Promise.all(TARGETS.map((t) => savedLoginWorks(browser, t)));
    TARGETS.forEach((t, i) => console.log('  ' + (valid[i] ? 'OK       ' : 'expired  ') + t.label));
    const todo = TARGETS.filter((t, i) => !valid[i]);
    if (!todo.length) { console.log('  All 5 logins are valid - nothing to do.'); return 0; }

    let last = '';
    try { last = fs.readFileSync(USER_FILE, 'utf8').trim(); } catch { /* first time */ }
    console.log('\n  One login for all ' + todo.length + ' (same account on every portal). Password is hidden and never saved.');
    const user = (await prompt('  Username' + (last ? ' [' + last + ']' : '') + ': ', false)).trim() || last;
    if (!user) { console.log('  No username - skipped. Sign in later: npm run auth:all'); return 2; }
    let pass = await prompt('  Password (Enter = skip): ', true);
    if (!pass) { console.log('  Skipped. Sign in later: npm run auth:all (or the dashboard button).'); return 2; }
    try { fs.mkdirSync(path.dirname(USER_FILE), { recursive: true }); fs.writeFileSync(USER_FILE, user); } catch { /* username memory is a convenience */ }

    // B2B first, alone: a refused password stops here (one retype), so it is never tried 5 times.
    const order = todo.slice().sort((a, b) => (a.key === 'b2b' ? -1 : b.key === 'b2b' ? 1 : 0));
    const first = order[0];
    process.stdout.write('  ' + first.label + ' ... ');
    let r = await signIn(browser, first, user, pass);
    if (!r.ok && r.refused) {
      console.log('REFUSED (' + r.why + ')');
      pass = await prompt('  Password again (Enter = skip): ', true);
      if (!pass) { console.log('  Skipped - no other portal was tried.'); return 1; }
      process.stdout.write('  ' + first.label + ' ... ');
      r = await signIn(browser, first, user, pass);
      if (!r.ok && r.refused) { pass = ''; console.log('REFUSED again (' + r.why + ') - stopping, no other portal tried (account lock safety).'); return 1; }
    }
    console.log(r.ok ? 'signed in' : 'FAILED (' + r.why + ')');
    const results = [[first, r]];
    if (r.ok || !r.refused) {
      const rest = order.slice(1);
      if (rest.length) console.log('  ' + rest.map((t) => t.label).join(', ') + ' ... (in parallel, the China ones take up to 3 min)');
      const rs = await Promise.all(rest.map((t) => signIn(browser, t, user, pass)));
      rest.forEach((t, i) => { console.log('    ' + (rs[i].ok ? 'signed in  ' : 'FAILED     ') + t.label + (rs[i].ok ? '' : ' (' + rs[i].why + ')')); results.push([t, rs[i]]); });
    }
    pass = '';
    const bad = results.filter(([, x]) => !x.ok).length;
    console.log('  ' + (results.length - bad) + ' portal(s) signed in' + (bad ? ', ' + bad + ' failed (browser fallback: npm run auth:b2b / npm run auth:portals)' : ''));
    return bad ? 1 : 0;
  } finally { await browser.close().catch(() => {}); }
}

/* ----------------------------------------------------------------- main --- */

// --check: read-only status of the 4 portals other than B2B (B2B has check-login.js). Never prompts, never signs in.
// Used by the Assistant's login worker (2026-10-27) so an expired portal login is reported BEFORE the sanity mail
// shows 4 [check manually] lines. Last output line:  PORTALS_STATE {"rowKeyAccount":true,...}  (exit 0 all valid, 1 some expired)
if (process.argv.includes('--check')) {
  (async () => {
    const browser = await chromium.launch();
    try {
      const four = TARGETS.filter((t) => t.key !== 'b2b');
      const ok = await Promise.all(four.map((t) => savedLoginWorks(browser, t)));
      const state = {}; four.forEach((t, i) => { state[t.key] = ok[i]; });
      four.forEach((t, i) => console.log('  ' + (ok[i] ? 'OK       ' : 'expired  ') + t.label));
      console.log('PORTALS_STATE ' + JSON.stringify(state));
      process.exitCode = ok.every(Boolean) ? 0 : 1;
    } finally { await browser.close().catch(() => {}); }
  })().catch((e) => { console.error('auth:all --check error: ' + String(e.message || e).split('\n')[0]); process.exitCode = 3; });
} else (async () => {
  // Portals first (the password is typed here and takes a couple of minutes), then AWS (waits for your approval).
  let code = 0;
  if (!AWS_ONLY) code = Math.max(code, await portalsStep());
  if (!PORTALS_ONLY) { const c = await awsStep(); code = code === 1 || c === 1 ? 1 : Math.max(code, c); }
  console.log('\n=== login step done' + (code === 0 ? ': everything signed in / valid' : code === 2 ? ': something was skipped' : ': something FAILED (see above)') + ' ===');
  process.exitCode = code;
})().catch((e) => { console.error('auth:all error: ' + String(e.message || e).split('\n')[0]); process.exitCode = 1; });
