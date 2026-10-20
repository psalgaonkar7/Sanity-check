// Non-browser-suite sanity items from the team's sanity mail — run in PARALLEL with the B2B
// suite by run-sanity.js, and runnable on their own: `node extra-checks.js`.
//
//   Primer status page            public Statuspage API
//   Group Bookings – SF sync      AWS AppFlow, via the AWS CLI (era-prod SSO profile)
//   Key account / Agents ROW,     logged in with a saved session, a real search returns trains
//   Key account / Customer care   (lib/portals.js; sessions saved by `npm run auth:portals`)
//   China
//   SF cases not linked with SR   Salesforce "Technical HD view" list view, via the sf CLI
//
// All read-only. Nothing here touches the B2B .com account, cart or POS, which is why it is
// safe to run alongside the browser suite. Each check degrades to SKIPPED with a one-line fix
// (never a false OK, never a false NOT OK) when a login it depends on has expired.
// Writes report/msc-extras.json.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPORT = path.join(__dirname, 'report');
const OUT = path.join(REPORT, 'msc-extras.json');
const T = (ms) => AbortSignal.timeout(ms);

// ---------------------------------------------------------------------------------------
// Primer — status.primer.io is an Atlassian Statuspage, so it exposes summary.json.
// OK = overall indicator "none", every component operational, no unresolved incident.
// Scheduled maintenance is NOT a failure; it is surfaced as a note so it can be mentioned.
// ---------------------------------------------------------------------------------------
async function checkPrimer() {
  try {
    // One retry: a single dropped connection to a public status API is noise from this
    // network, not signal about Primer, and used to mark the whole item [check manually] for
    // the run. Confirmed transient 2026-09-27 — a timeout here, then three clean sub-second
    // replies moments later with no change on Primer's side.
    let r;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try { r = await fetch('https://status.primer.io/api/v2/summary.json', { signal: T(15000) }); break; }
      catch (e) { if (attempt === 2) throw e; }
    }
    if (!r.ok) return { status: 'NOT OK', detail: `status API returned HTTP ${r.status}` };
    const j = await r.json();
    const broken = (j.components || []).filter((c) => c.status !== 'operational' && !c.group);
    const incidents = (j.incidents || []).filter((i) => i.status !== 'resolved' && i.status !== 'postmortem');
    const soon = Date.now() + 24 * 3600 * 1000;
    const maint = (j.scheduled_maintenances || [])
      .filter((m) => m.status === 'in_progress' || new Date(m.scheduled_for).getTime() < soon)
      .map((m) => `${m.name} (${m.status === 'in_progress' ? 'IN PROGRESS' : new Date(m.scheduled_for).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'})`);
    const ok = (j.status && j.status.indicator === 'none') && !broken.length && !incidents.length;
    const bits = [];
    if (broken.length) bits.push('degraded: ' + broken.map((c) => `${c.name}=${c.status}`).join(', '));
    if (incidents.length) bits.push('incident: ' + incidents.map((i) => i.name).join('; '));
    return {
      status: ok ? 'OK' : 'NOT OK',
      detail: ok ? (j.status && j.status.description) : bits.join(' | ') || (j.status && j.status.description),
      maintenance: maint,
    };
  } catch (e) {
    return { status: 'SKIPPED', detail: 'could not reach status.primer.io: ' + String(e.cause && e.cause.code || e).slice(0, 80) };
  }
}

// ---------------------------------------------------------------------------------------
// AppFlow — tf-era-prod-shared-salesforce-flow is EVENT-triggered (Salesforce platform
// event Case_And_Itinerary__e), not scheduled. A long gap between runs therefore just means no
// group-booking events arrived — it is not a fault. The honest rule is: flow Active, and no
// FAILED execution since the previous sanity run.
// ---------------------------------------------------------------------------------------
const FLOW = 'tf-era-prod-shared-salesforce-flow';

function awsCli() {
  if (process.env.AWS_CLI) return process.env.AWS_CLI;
  const guess = path.join(os.homedir(), 'aws-cli', 'Amazon', 'AWSCLIV2', 'aws.exe');
  return fs.existsSync(guess) ? guess : 'aws';
}

function aws(args, profile = process.env.AWS_PROFILE_SANITY || 'era-prod') {
  const r = spawnSync(awsCli(), [...args, '--region', 'eu-west-1', '--profile', profile, '--output', 'json'],
    { encoding: 'utf8', timeout: 60000 });
  if (r.error) return { err: String(r.error.code || r.error.message) };
  if (r.status !== 0) return { err: (r.stderr || r.stdout || '').trim() };
  try { return { json: JSON.parse(r.stdout) }; } catch { return { err: 'unparseable AWS CLI output' }; }
}

function previousRunTime() {
  try {
    const lines = fs.readFileSync(path.join(__dirname, 'run-history.jsonl'), 'utf8').trim().split('\n');
    const t = new Date(JSON.parse(lines[lines.length - 1]).ts).getTime();
    return Number.isFinite(t) ? t : null;
  } catch { return null; }
}

async function checkAppFlow() {
  const desc = aws(['appflow', 'describe-flow', '--flow-name', FLOW]);
  if (desc.err) {
    if (/token.*expired|sso|refresh failed|login/i.test(desc.err)) {
      return { status: 'SKIPPED', detail: 'AWS login expired — run: aws sso login --sso-session era' };
    }
    if (/ENOENT|not recognized|not found/i.test(desc.err)) {
      return { status: 'SKIPPED', detail: 'AWS CLI not found (set AWS_CLI in .env)' };
    }
    return { status: 'SKIPPED', detail: 'AWS CLI error: ' + desc.err.split('\n')[0].slice(0, 120) };
  }
  const flowStatus = desc.json.flowStatus;
  // Window = since the previous sanity run, capped at 72 h; 24 h if there is no history.
  const prev = previousRunTime();
  const since = Math.max(prev || Date.now() - 24 * 3600e3, Date.now() - 72 * 3600e3);
  const ex = aws(['appflow', 'describe-flow-execution-records', '--flow-name', FLOW, '--max-results', '100']);
  if (ex.err) return { status: 'SKIPPED', detail: 'could not read executions: ' + ex.err.split('\n')[0].slice(0, 120) };
  const all = ex.json.flowExecutions || [];
  const inWindow = all.filter((e) => new Date(e.startedAt).getTime() >= since);
  const failed = inWindow.filter((e) => /fail|error/i.test(e.executionStatus));
  const last = all[0];
  const lastTxt = last ? `last run ${new Date(last.startedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC ${last.executionStatus}` : 'no executions on record';
  const ok = flowStatus === 'Active' && failed.length === 0;
  return {
    status: ok ? 'OK' : 'NOT OK',
    detail: `flow ${flowStatus}; ${inWindow.length} run(s) since last sanity, ${failed.length} failed; ${lastTxt}`,
    failed: failed.map((e) => ({ at: e.startedAt, status: e.executionStatus, error: e.executionResult && e.executionResult.errorInfo && e.executionResult.errorInfo.executionMessage })),
  };
}

// ---------------------------------------------------------------------------------------
// Dropfile — the Ariane Glue job tf-ariane-prod-transactions-sanity-check runs by itself every
// day around 14:00 IST and logs "[Check] Discrepancies: N" to /aws-glue/jobs/output (procedure:
// Confluence SR 2223472642). Read through the ariane-prod profile, which shares the `era` SSO
// login. We read the latest result from the last 30 h, so a 02:00 IST run still sees
// yesterday's 14:00 result. This does NOT cover "any Glue job failed": the support role is
// denied run history on most Ariane jobs, so #ariane-alerts-prod is still checked by hand.
// ---------------------------------------------------------------------------------------
const DROPFILE_PROFILE = process.env.AWS_PROFILE_ARIANE || 'ariane-prod';

async function checkDropfile() {
  const since = Date.now() - 30 * 3600e3;
  const r = aws(['logs', 'filter-log-events', '--log-group-name', '/aws-glue/jobs/output',
    '--start-time', String(since), '--filter-pattern', '"Discrepancies"'], DROPFILE_PROFILE);
  if (r.err) {
    if (/token.*expired|sso|refresh failed|login/i.test(r.err)) {
      return { status: 'SKIPPED', detail: 'AWS login expired — run: aws sso login --sso-session era' };
    }
    if (/ENOENT|not recognized|not found/i.test(r.err)) return { status: 'SKIPPED', detail: 'AWS CLI not found (set AWS_CLI in .env)' };
    return { status: 'SKIPPED', detail: 'AWS CLI error: ' + r.err.split('\n')[0].slice(0, 120) };
  }
  const hits = (r.json.events || [])
    .map((e) => ({ at: e.timestamp, n: Number((/Discrepancies:\s*(\d+)/.exec(e.message) || [])[1]) }))
    .filter((e) => Number.isFinite(e.n));
  if (!hits.length) return { status: 'SKIPPED', detail: 'no dropfile sanity-check result in the last 30 h (job normally runs ~14:00 IST)' };
  const last = hits.reduce((a, b) => (b.at > a.at ? b : a));
  const when = new Date(last.at + 5.5 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') + ' IST';
  return last.n === 0
    ? { status: 'OK', detail: `0 discrepancies (Glue sanity-check run ${when})` }
    : { status: 'NOT OK', detail: `${last.n} discrepancies (Glue sanity-check run ${when}) — get VerificationLineDropfile.csv, see Confluence SR 2223472642` };
}

// ---------------------------------------------------------------------------------------
// Portals — key account ROW, agents ROW, key account China, customer care China. Each is
// logged in with its own saved session and must return trains for a real search; see
// lib/portals.js for why "the sign-in page loads" is no longer accepted as OK. Run one after
// another in their own browser contexts, so they never touch the B2B account/cart/POS used by
// the booking run.
// ---------------------------------------------------------------------------------------
async function checkPortals() {
  const P = require('./lib/portals');
  const out = {};
  let chromium;
  try { ({ chromium } = require('@playwright/test')); } catch {
    for (const p of P.PORTALS) out[p.key] = { status: 'SKIPPED', detail: 'Playwright not installed' };
    return out;
  }
  const H = require('./lib/helpers');
  const dateStr = H.futureDate(require('./data/journeys').daysAhead);
  const browser = await chromium.launch();
  try {
    for (const p of P.PORTALS) out[p.key] = await P.checkPortal(browser, p, dateStr);
  } finally {
    await browser.close();
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Salesforce — the count the team reports is the number of cases in the "Technical HD view"
// list view. Reading the list view's own results (rather than re-creating its filters in
// SOQL) keeps this exactly in step with what the team sees, even if the view is edited.
// Needs the Salesforce CLI and a one-time `sf org login web` BY THE USER — no password ever
// passes through this script; the access token is used in-process only and never printed.
// Deciding whether a case is a tech issue that needs an SR stays a human call — this only
// counts and lists.
// ---------------------------------------------------------------------------------------
const SF_LIST_VIEW = '00B200000059EwPEAU'; // Case / Technical_HD_view (verified 2026-09-27)

async function checkSalesforce() {
  // Alias comes from .env; restrict it to safe characters since it is passed through a shell.
  const alias = String(process.env.SF_ORG_ALIAS || 're-prod').replace(/[^\w.-]/g, '');
  const disp = spawnSync('sf org display --target-org ' + alias + ' --json', { encoding: 'utf8', timeout: 60000, shell: true });
  if (disp.error || /not recognized|command not found/i.test(disp.stderr || '')) {
    return { status: 'SKIPPED', detail: 'Salesforce CLI not set up (see README: SF cases)' };
  }
  let d;
  try { d = JSON.parse(disp.stdout); } catch { return { status: 'SKIPPED', detail: 'unexpected sf CLI output' }; }
  const token = d.result && d.result.accessToken;
  const instance = d.result && d.result.instanceUrl;
  if (d.status !== 0 || !token || !instance) {
    // On 2026-09-27 the login itself was refused with OAUTH_APPROVAL_ERROR_GENERIC: the org does
    // not (yet) allow the Salesforce CLI connected app, so re-running the login cannot fix it —
    // a Salesforce admin has to approve the app first. Say that, rather than send the user round
    // a loop.
    return { status: 'SKIPPED', detail: `not logged in to Salesforce — needs the Salesforce CLI app approved by a Salesforce admin, then: sf org login web --alias ${alias}` };
  }
  try {
    const r = await fetch(`${instance}/services/data/v64.0/sobjects/Case/listviews/${SF_LIST_VIEW}/results?limit=200`,
      { headers: { Authorization: `Bearer ${token}` }, signal: T(30000) });
    if (r.status === 401) return { status: 'SKIPPED', detail: `Salesforce session expired — run: sf org login web --alias ${alias}` };
    if (!r.ok) return { status: 'SKIPPED', detail: `Salesforce API HTTP ${r.status}` };
    const j = await r.json();
    const col = (rec, name) => ((rec.columns || []).find((c) => c.fieldNameOrPath === name) || {}).value;
    const cases = (j.records || []).map((rec) => ({ number: col(rec, 'CaseNumber'), subject: col(rec, 'Subject') }));
    return { status: cases.length ? 'REVIEW' : 'OK', count: j.size != null ? j.size : cases.length, cases, detail: `${cases.length} case(s) in Technical HD view` };
  } catch (e) {
    return { status: 'SKIPPED', detail: 'Salesforce API error: ' + String(e).slice(0, 100) };
  }
}

// ---------------------------------------------------------------------------------------
async function main() {
  const [primer, appflow, dropfile, portals, sfCases] = await Promise.all([checkPrimer(), checkAppFlow(), checkDropfile(), checkPortals(), checkSalesforce()]);
  const result = { runId: process.env.MSC_RUN_ID || null, at: new Date().toISOString(), primer, appflow, dropfile, ...portals, sfCases };
  fs.mkdirSync(REPORT, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  const rows = [
    ['Primer status page', primer],
    ['Group Bookings–SF sync (AppFlow)', appflow],
    ['Key account ROW (search)', result.rowKeyAccount],
    ['Agents portal ROW (search)', result.rowAgent],
    ['Key account China (search)', result.chinaKeyAccount],
    ['Customer care China (search + booking)', result.chinaCustomerCare],
    ['Dropfile sanity check (Glue)', dropfile],
    ['SF cases not linked with an SR', sfCases],
  ];
  console.log('Extra sanity checks (read-only)\n');
  for (const [label, r] of rows) console.log(`  [${String(r.status).padEnd(7)}] ${label.padEnd(34)} ${r.detail || ''}`);
  if (primer.maintenance && primer.maintenance.length) console.log('\n  Primer maintenance (in progress / next 24h): ' + primer.maintenance.join('; '));
  console.log('\nWritten: report/msc-extras.json');
  // Informational: never fail the sanity run's exit code on these.
  return 0;
}

// exitCode, not process.exit(): exiting while fetch's socket is still closing can crash Node on
// Windows ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)", exit 127).
if (require.main === module) main().then((c) => { process.exitCode = c; });
module.exports = { main };
