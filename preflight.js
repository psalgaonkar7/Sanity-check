// Pre-flight for `npm run sanity` (~15-30 s). Catches the problems that otherwise only show up
// minutes later as a wrong or stuck result, and says how to fix each one:
//
//   code version   which commit is running, local edits, and whether this copy is behind GitHub
//   B2B login      storageState.json still logged in            -> BLOCKS the run if expired
//   VPN            LocoHub reachable (API check needs it)       -> warn (API step is skipped fast)
//   AWS login      era SSO valid (Salesforce sync + dropfile)   -> warn ([check manually] lines)
//   Portal logins  saved logins for the portal search checks    -> warn ([check manually] lines)
//   Slack          webhook configured                           -> warn (no "Sanity done" post)
//
// Exit 2 = do not start (B2B login expired). Writes report/preflight.json. Runnable alone:
// `npm run preflight`.
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');

const checks = [];
const add = (name, status, detail) => { checks.push({ name, status, detail }); console.log(`  [${status.padEnd(5)}] ${name.padEnd(14)} ${detail}`); };

function sh(cmd, args, timeout = 15000) {
  const r = spawnSync(cmd, args, { cwd: __dirname, encoding: 'utf8', timeout, shell: false });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), error: r.error };
}

function version() {
  const head = sh('git', ['rev-parse', '--short', 'HEAD']);
  if (head.code !== 0) return add('Code version', 'WARN', 'not a git clone — cannot tell which version is running');
  const edits = sh('git', ['status', '--porcelain', '--untracked-files=no']).out.split('\n').filter(Boolean).length;
  const fetched = sh('git', ['fetch', '--quiet'], 15000).code === 0;
  const cmp = fetched ? sh('git', ['rev-list', '--count', 'HEAD..@{u}']) : null;
  const behind = cmp && cmp.code === 0 && cmp.out !== '' ? Number(cmp.out) : NaN;   // NaN = no upstream / unknown
  const parts = [`commit ${head.out}`];
  if (edits) parts.push(`${edits} locally edited file(s)`);
  if (!fetched || !Number.isFinite(behind)) parts.push('could not compare with GitHub (offline or no upstream branch)');
  else if (behind > 0) parts.push(`${behind} commit(s) BEHIND GitHub — run: git pull`);
  else parts.push('up to date with GitHub');
  add('Code version', behind > 0 || edits ? 'WARN' : 'OK', parts.join(' · '));
  return { commit: head.out, edits, behind: Number.isFinite(behind) ? behind : null };
}

async function b2bLogin() {
  if (!fs.existsSync(path.join(__dirname, 'storageState.json'))) {
    add('B2B login', 'STOP', 'no saved login — run: npm run auth');
    return false;
  }
  const { chromium } = require('@playwright/test');
  const H = require('./lib/helpers');
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ storageState: path.join(__dirname, 'storageState.json') });
    await H.blockNoise(ctx);
    const page = await ctx.newPage();
    await page.goto('https://customercare.raileurope.com/home', { waitUntil: 'domcontentloaded', timeout: 45000 });
    const state = await H.loginState(page, 45000);
    if (state === 'in') {
      const who = (await page.locator(H.SEL.userName).first().innerText().catch(() => '')).trim();
      add('B2B login', 'OK', `logged in${who ? ' as ' + who : ''}`);
      return true;
    }
    if (state === 'out') { add('B2B login', 'STOP', 'login expired — run: npm run auth'); return false; }
    add('B2B login', 'WARN', 'portal did not finish loading — the run will show what is wrong');
    return true;
  } catch (e) {
    add('B2B login', 'WARN', 'could not check: ' + String(e).split('\n')[0].slice(0, 100));
    return true;
  } finally {
    await browser.close();
  }
}

function tcp(host, port, ms) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(ms, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

async function vpn() {
  const host = 'production.locohub-prod.aws.raileurope.com';
  if (await tcp(host, 443, 5000)) add('VPN / LocoHub', 'OK', `${host} reachable`);
  else add('VPN / LocoHub', 'WARN', 'LocoHub not reachable — connect the VPN, or the API check (mail point 1, B2C half) is skipped');
}

function awsLogin() {
  const cli = process.env.AWS_CLI || (fs.existsSync(path.join(os.homedir(), 'aws-cli', 'Amazon', 'AWSCLIV2', 'aws.exe'))
    ? path.join(os.homedir(), 'aws-cli', 'Amazon', 'AWSCLIV2', 'aws.exe') : 'aws');
  const r = sh(cli, ['sts', 'get-caller-identity', '--profile', 'era-prod', '--region', 'eu-west-1', '--output', 'json'], 30000);
  if (r.code === 0) add('AWS login', 'OK', 'era SSO valid (Salesforce sync + dropfile checks)');
  else if (r.error) add('AWS login', 'WARN', 'AWS CLI not found — Salesforce sync + dropfile will read [check manually]');
  else add('AWS login', 'WARN', 'expired — Salesforce sync + dropfile will read [check manually]. Fix: aws sso login --sso-session era');
}

function portalLogins() {
  const P = require('./lib/portals');
  const missing = P.PORTALS.filter((p) => !P.hasSession(p.key)).map((p) => p.label);
  if (!missing.length) add('Portal logins', 'OK', `saved for all ${P.PORTALS.length} portals (validity is checked during the run)`);
  else add('Portal logins', 'WARN', `none saved for: ${missing.join(', ')} — those lines read [check manually]. Fix: npm run auth:portals`);
}

function slack() {
  let env = '';
  try { env = fs.readFileSync(path.join(__dirname, '.env'), 'utf8'); } catch {}
  if (/^\s*SLACK_WEBHOOK_URL\s*=\s*['"]?https:\/\/hooks\.slack\.com\//m.test(env) || /^https:\/\/hooks\.slack\.com\//.test(process.env.SLACK_WEBHOOK_URL || '')) add('Slack', 'OK', 'webhook configured');
  else add('Slack', 'WARN', 'no SLACK_WEBHOOK_URL in .env — the "Sanity done" line will not be posted');
}

(async () => {
  console.log('\nPre-flight\n');
  const ver = version();
  const b2bOk = await b2bLogin();
  await vpn();
  awsLogin();
  portalLogins();
  slack();
  fs.mkdirSync(path.join(__dirname, 'report'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'report', 'preflight.json'),
    JSON.stringify({ at: new Date().toISOString(), runId: process.env.MSC_RUN_ID || null, version: ver || null, checks }, null, 2));
  if (!b2bOk) {
    console.log('\n  ✋ Not starting: the B2B login is needed for every browser check. Run `npm run auth`, then `npm run sanity` again.\n');
    process.exitCode = 2;
  }
})();
