// After a sanity run: post the completion line to Slack #sd_24-7 and prepare the sanity mail.
// Called by run-sanity.js as its last step; also runnable alone:
//   node notify.js             post + open mail draft (same as the end of a run)
//   node notify.js --dry-run   print what WOULD be posted and mailed; touch nothing
//
// Slack  — posts exactly the team's format, "Sanity done 00:00 IST- K070439139, K442252781",
//          through an incoming webhook (SLACK_WEBHOOK_URL in .env). It posts ONLY when the run
//          is a real, complete one — see shouldPost(). A bot must never announce "Sanity done"
//          for a run that did not finish or produced no booking reference.
// Mail   — never sent automatically. It builds the full sanity mail from this run's results,
//          copies it (formatted, with links) to the clipboard and opens a new Outlook compose
//          window with the subject filled in. You paste (Ctrl+V), review, and press Send.
//          Anything the automation did not verify is marked "[check manually]" in the draft so
//          it cannot go out as an unearned OK.
const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const DRY = process.argv.includes('--dry-run');
const REPORT = path.join(__dirname, 'report');
const POSTED = path.join(REPORT, '.slack-posted.json');

// --- tiny .env loader (no dependency): KEY=value lines, # comments, optional quotes ---------
(function loadEnv() {
  const f = path.join(__dirname, '.env');
  if (!fs.existsSync(f)) return;
  for (const raw of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = raw.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m || raw.trim().startsWith('#')) continue;
    const v = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] == null) process.env[m[1]] = v;
  }
})();

const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(REPORT, f), 'utf8')); } catch { return null; } };
const b2b = read('msc-b2b.json') || {};
// An API report from another run (or one stamped "incomplete" because the check crashed) is not
// this run's result: treat it as "API check did not run".
const api = (() => { const r = read('api-searchability.json') || {}; return ((process.env.MSC_RUN_ID && r.runId && r.runId !== process.env.MSC_RUN_ID) || r.incomplete) ? {} : r; })();
const extras = read('msc-extras.json') || {};
const data = require('./data/journeys');

// --- slot time --------------------------------------------------------------------------
// The team posts the SLOT ("00:00"), not the finish time (you posted "00:00" at 00:03).
// Round the run's start to the nearest hour in IST. Rounding must happen in IST, not UTC:
// IST is UTC+5:30, so whole UTC hours are half-hours in India. MSC_SLOT=HH:MM overrides.
const IST_OFFSET = 5.5 * 3600e3;
function slotInfo() {
  const startIso = (process.env.MSC_RUN_ID || b2b.runId || '').slice(0, 24);
  const start = Date.parse(startIso) || Date.now();
  let ist = Math.round((start + IST_OFFSET) / 3600e3) * 3600e3; // IST wall clock, as a UTC timestamp
  if (/^\d{2}:\d{2}$/.test(process.env.MSC_SLOT || '')) {
    const [h, m] = process.env.MSC_SLOT.split(':').map(Number);
    const d = new Date(start + IST_OFFSET);
    ist = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m);
  }
  const d = new Date(ist);
  const p = (n) => String(n).padStart(2, '0');
  return {
    slot: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`,
    date: `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`,
    key: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`,
  };
}

const refs = (b2b.bookings || []).map((b) => b.ref).filter(Boolean);
const { slot, date, key } = slotInfo();

// --- Slack --------------------------------------------------------------------------------
// Shared with buildItems() below, so the mail's booking-suite line and the Slack post gate
// use exactly one definition of "this run's booking suite didn't actually complete" — see
// the 2026-09-30 gap: the mail's OK/KO status never checked this, so a run that timed out
// with zero booking references still went out with subject "... - OK" and no other tell.
function bookingIssues() {
  const why = [];
  const runId = process.env.MSC_RUN_ID;
  if (runId && b2b.runId !== runId) why.push('the booking report is not from this run (the browser suite did not finish)');
  if (!refs.length) why.push('no booking reference was captured');
  if ((b2b.bookings || []).some((b) => b.expired > 0)) why.push('an order had expired items');
  if (process.env.MSC_MAX_SECTORS || (b2b.sectorsTotal && b2b.sectorsTotal < data.ptpJourneys.length)) {
    why.push(`partial run (${b2b.sectorsTotal} of ${data.ptpJourneys.length} sectors) — only full runs are announced`);
  }
  return why;
}

function shouldPost() {
  const why = bookingIssues();
  let posted = {};
  try { posted = JSON.parse(fs.readFileSync(POSTED, 'utf8')); } catch {}
  if (posted[key]) why.push(`already posted for ${key} IST (at ${posted[key]}) — set MSC_SLOT to post a different slot`);
  return why;
}

// Two kinds of Slack webhook, and they acknowledge differently:
//   classic incoming webhook   https://hooks.slack.com/services/...  -> body "ok"
//   Workflow Builder trigger   https://hooks.slack.com/triggers/...  -> JSON {"ok":true}
// For a Workflow Builder trigger, the workflow must declare a variable named `text` and use it
// in its "Send a message" step — that is the field this script sends.
function slackAccepted(r, body) {
  if (!r.ok) return false;
  if (body.trim() === 'ok') return true;
  try { return JSON.parse(body).ok === true; } catch { return false; }
}

const mask = (u) => (u.length > 40 ? u.slice(0, 34) + '…' + u.slice(-4) : '(too short)');

// `node notify.js --check-slack` — is the webhook in .env alive? For a classic webhook this is
// tested WITHOUT posting: an empty payload is rejected by a live webhook with 400 "no_text"
// (nothing reaches the channel), while a revoked or mistyped one answers differently.
// A Workflow Builder trigger cannot be tested that way — any call starts the workflow, which
// would post an empty message to #sd_24-7 — so for those only the format is checked.
async function checkSlack() {
  const hook = (process.env.SLACK_WEBHOOK_URL || '').trim();
  if (!hook) {
    console.log('Slack webhook: NOT CONFIGURED — add SLACK_WEBHOOK_URL to .env (copy .env.example). See README: Slack post.');
    return 1;
  }
  if (/^https:\/\/hooks\.slack\.com\/services\//.test(hook)) {
    try {
      // Body must be a JSON object with at least one key, or Slack can't tell "valid but no
      // text" from "couldn't parse this at all" and answers "invalid_payload" either way —
      // confirmed empirically against a real webhook 2026-09-27: {} -> invalid_payload,
      // non-JSON -> invalid_payload, GET with no body -> invalid_payload, but a harmless
      // one-key object -> no_text. Sending literal '{}' here made a genuinely working webhook
      // report as NOT WORKING.
      const r = await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"probe":true}', signal: AbortSignal.timeout(20000) });
      const body = (await r.text()).trim();
      if (r.status === 400 && body === 'no_text') {
        console.log(`Slack webhook: WORKING — classic incoming webhook ${mask(hook)} is live. Nothing was posted.`);
        return 0;
      }
      console.log(`Slack webhook: NOT WORKING — ${mask(hook)} answered HTTP ${r.status} "${body.slice(0, 60)}"`
        + (/no_service|invalid_token|no_team|team_disabled/.test(body) ? ' — the webhook was revoked or mistyped; create a new one.' : ''));
      return 1;
    } catch (e) {
      console.log('Slack webhook: could not reach Slack — ' + String(e.cause && e.cause.code || e).slice(0, 80));
      return 1;
    }
  }
  if (/^https:\/\/hooks\.slack\.com\/triggers\//.test(hook)) {
    console.log(`Slack webhook: Workflow Builder trigger ${mask(hook)} — the format is right. It cannot be tested without`
      + ' posting (any call runs the workflow), so the first real sanity run will confirm it.'
      + ' Make sure the workflow has a variable named "text" used in its message step.');
    return 0;
  }
  console.log(`Slack webhook: UNRECOGNISED — ${mask(hook)}. Expected https://hooks.slack.com/services/... or /triggers/...`);
  return 1;
}

async function postSlack(text) {
  const blocked = shouldPost();
  if (process.env.MSC_NO_SLACK) blocked.push('MSC_NO_SLACK is set');
  const hook = process.env.SLACK_WEBHOOK_URL || '';
  if (!/^https:\/\/hooks\.slack\.com\//.test(hook)) blocked.push('no SLACK_WEBHOOK_URL in .env (see README: Slack post)');
  if (DRY) blocked.push('--dry-run');
  if (blocked.length) {
    console.log('  Slack: NOT posted — ' + blocked.join('; '));
    return false;
  }
  try {
    const r = await fetch(hook, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }), signal: AbortSignal.timeout(20000),
    });
    const body = await r.text();
    if (!slackAccepted(r, body)) { console.log(`  Slack: FAILED — HTTP ${r.status} ${body.slice(0, 80)}`); return false; }
    let posted = {};
    try { posted = JSON.parse(fs.readFileSync(POSTED, 'utf8')); } catch {}
    posted[key] = new Date().toISOString();
    fs.writeFileSync(POSTED, JSON.stringify(posted, null, 2));
    console.log('  Slack: posted to #sd_24-7');
    return true;
  } catch (e) {
    console.log('  Slack: FAILED — ' + String(e).slice(0, 100));
    return false;
  }
}

// --- Mail ---------------------------------------------------------------------------------
const MANUAL = '[check manually]';

function fromExtra(r, okText = 'OK') {
  if (!r || extras.runId && process.env.MSC_RUN_ID && extras.runId !== process.env.MSC_RUN_ID) return { v: MANUAL, ok: null, note: 'not checked this run' };
  if (r.status === 'OK') return { v: okText, ok: true };
  if (r.status === 'SKIPPED') return { v: MANUAL, ok: null, note: r.detail };
  return { v: 'KO', ok: false, note: r.detail };
}

function buildItems() {
  const prod = (api.envs || []).find((e) => e.label === 'PRODUCTION');
  const testable = prod && (prod.summary.testable != null ? prod.summary.testable : prod.rows.length);
  // One line for both channels: B2C is proven by the production API search, B2B by the booking
  // run (every sector searched, carted and referenced). If only the API half could not run
  // (e.g. VPN down), the line still reads OK as Pratikesh asked, because B2B was verified; it
  // stays in the "still to check" reminder so the unverified B2C half is not forgotten.
  const bookingOk = !bookingIssues().length;
  const apiWhy = (api.unreachable || []).some((u) => u.label === 'PRODUCTION')
    ? 'B2C API check skipped: LocoHub not reachable (VPN?)' : 'B2C API check did not run (see report/api-searchability.json)';
  const refProof = refs.length ? `Booking ref: ${refs.join(', ')}` : null;
  const b2c = !bookingOk ? { v: 'KO', ok: false, note: 'B2B booking run did not complete: ' + bookingIssues().join('; ') }
    : !prod ? { v: 'OK', ok: null, manualOnly: true, proof: `${refProof || 'B2B booking run'}; B2C API not checked`, note: `B2B verified by the booking run; ${apiWhy} — check B2C by hand` }
      : prod.summary.pass === testable ? { v: 'OK', ok: true, proof: refProof }
        : { v: 'KO', ok: false, proof: refProof, note: `${testable - prod.summary.pass}/${testable} production API routes failing` };

  // Portal lines (key account / agents ROW, key account / customer care China). The proof is the
  // same full booking as the main run — every sector + pass carted, booking refs captured —
  // done on that portal (report/msc-b2b-<key>.json, same run id). Without a booking report
  // (e.g. notify.js run alone) it falls back to the logged-in search from extra-checks.js.
  const portalRuns = read('portal-runs.json') || {};
  const thisRun = process.env.MSC_RUN_ID || b2b.runId;
  const portal = (key) => {
    const r = extras[key];
    const bk = read(`msc-b2b-${key}.json`);
    const bkValid = bk && (!thisRun || bk.runId === thisRun);
    const ran = portalRuns.portals && portalRuns.portals[key];
    if (bkValid) {
      const prefs = (bk.bookings || []).map((x) => x.ref).filter(Boolean);
      const expired = (bk.bookings || []).some((x) => x.expired > 0);
      const lost = (bk.sectors || []).filter((s) => s.status !== 'IN CART' && s.status !== 'EXPECTED (carrier flagged)');
      const lostNote = lost.length ? `not added on this portal: ${lost.map((s) => `${s.carrier} [${s.status}]`).join(', ')}` : null;
      // A run that crashed part-way leaves a PARTIAL report (some orders, not every item tried):
      // never let that read OK.
      const expectedItems = data.ptpJourneys.length + data.passesToAdd.length;
      const tried = (bk.sectors || []).length;
      if (ran && ran.ran && ran.code !== 0) return { v: 'KO', ok: false, proof: prefs.length ? `Booking ref: ${prefs.join(', ')}` : null, note: `booking run on this portal failed part-way (exit ${ran.code}) — ${tried}/${expectedItems} items tried` };
      if (tried < expectedItems) return { v: 'KO', ok: false, proof: prefs.length ? `Booking ref: ${prefs.join(', ')}` : null, note: `booking run incomplete: only ${tried}/${expectedItems} items tried` };
      if (!prefs.length) return { v: 'KO', ok: false, note: 'booking run captured no booking reference' + (lostNote ? ' | ' + lostNote : '') };
      if (expired) return { v: 'KO', ok: false, proof: `Booking ref: ${prefs.join(', ')}`, note: 'an order had expired items' };
      const searchBad = r && r.status === 'NOT OK' ? `search check also failed: ${r.detail}` : null;
      return { v: 'OK', ok: true, proof: `Booking ref: ${prefs.join(', ')}`, note: [lostNote, searchBad].filter(Boolean).join(' | ') || null };
    }
    if (ran && ran.ran && ran.code !== 0) return { v: 'KO', ok: false, note: `booking run on this portal failed (exit ${ran.code}) and saved no report` };
    const it = fromExtra(r);
    if (it.ok && r.route && r.results) it.proof = `${r.route.replace('->', '→')}: ${r.results} results`;
    return it;
  };

  // Connectivity, SOP rule #1: a carrier RED/unstable > 15 min needs its offers cross-checked.
  // The booking run already does that cross-check for every carrier we sell, so the line is
  // decided by evidence instead of only listing names for "review":
  //   flagged but still bookable  -> OK (the page is noisy, sales work)          noted
  //   flagged AND not bookable on any route (all fallbacks tried)  -> KO          real incident
  //   flagged, no route of ours to try (e.g. CAMPANIA EXPRESS)     -> OK + reminder to check by hand
  const rows = b2b.connectivityRows || [];
  const unmapped = (b2b.coverage && b2b.coverage.unmapped) || [];
  const sectorOk = new Map((b2b.sectors || []).filter((s) => typeof s.id === 'number').map((s) => [s.id, s.status]));
  const passOk = new Map((b2b.passesInBooking || []).map((p) => [p.label, p.status]));
  const verdict = (st) => (st === 'IN CART' ? true : ['ERROR', 'NO RESULTS', 'EXPECTED (carrier flagged)'].includes(st) ? false : null);
  // Evidence is per INVENTORY SECTION: SBB and TRENITALIA appear under both Point-to-point and
  // Passes with independent statuses, so "SBB flagged in Passes" must be judged by the pass we
  // carted, not by the (healthy) point-to-point sector. Sections come from the connectivity rows.
  const proof = (carrier, section) => {
    const C = carrier.toUpperCase();
    const has = (names) => (names || []).some((n) => n.toUpperCase() === C);
    const p2p = data.ptpJourneys.filter((j) => has(j.connectivityNames) && sectorOk.has(j.id)).map((j) => verdict(sectorOk.get(j.id)));
    const pas = data.passesToAdd.filter((p) => has(p.connectivityNames) && passOk.has(p.label)).map((p) => verdict(passOk.get(p.label)));
    const pick = section === 'passes' ? pas : section === 'p2p' ? p2p : section === 'none' ? [] : [...p2p, ...pas];
    return pick.filter((v) => v !== null);
  };
  const flaggedSections = (e) => {
    const bad = /unstable|down/i;
    const secs = new Set(rows.filter((r) => r.carrier.toUpperCase() === e.carrier.toUpperCase() && bad.test(r.status))
      .map((r) => (/pass/i.test(r.section) ? 'passes' : /point/i.test(r.section) ? 'p2p' : 'other')));
    return secs.size ? [...secs] : ['any'];
  };
  const bookable = [], down = [], unverified = [];
  for (const e of b2b.connectivityEscalations || []) {
    const tag = `${e.carrier} (${e.status}${e.minutes != null ? ' ' + e.minutes + ' min' : ''})`;
    const per = flaggedSections(e).map((s) => proof(e.carrier, s === 'other' ? 'none' : s === 'any' ? 'any' : s));
    const anyDown = per.some((ev) => ev.length && !ev.some(Boolean));
    const anyOk = per.some((ev) => ev.some(Boolean));
    if (anyDown) down.push(tag); else if (anyOk) bookable.push(tag); else unverified.push(tag);
  }
  const connNote = [
    down.length ? `NOT bookable on any route: ${down.join(', ')} — follow Critical Incident Management` : '',
    bookable.length ? `flagged but still bookable: ${bookable.join(', ')}` : '',
    unverified.length ? `flagged, no route of ours to verify — check by hand: ${unverified.join(', ')}` : '',
  ].filter(Boolean).join(' | ') || null;
  const conn = !rows.length ? { v: 'KO', ok: false, note: 'connectivity page was not read' }
    : unmapped.length ? { v: 'KO', ok: false, note: 'unmapped carrier: ' + unmapped.join(', ') }
      : down.length ? { v: 'KO', ok: false, note: connNote }
        : { v: 'OK', ok: true, manualOnly: unverified.length > 0, note: connNote };

  const pos = b2b.sncfPos || [];
  const sncf = !pos.length ? { v: MANUAL, ok: null, note: 'SNCF check did not run' }
    : pos.every((r) => r.result === 'PASS') ? { v: 'OK', ok: true, proof: `${pos.length}/${pos.length} searches` }
      : { v: 'KO', ok: false, note: pos.filter((r) => r.result !== 'PASS').map((r) => `${r.od} ${r.result}`).join(', ') };

  const primer = fromExtra(extras.primer);
  if (extras.primer && extras.primer.maintenance && extras.primer.maintenance.length) {
    primer.note = [primer.note, 'maintenance: ' + extras.primer.maintenance.join('; ')].filter(Boolean).join(' | ');
  }

  // Salesforce isn't connected on this machine yet (see README: SF cases). Until it is, this
  // is deliberately displayed as a plain "0" placeholder rather than [check manually] — it is
  // NOT a verified count, and report/msc-extras.json still records the real SKIPPED status and
  // reason, so nothing is hidden from an audit. Shown this way only because the mail is never
  // auto-sent (a person reviews every draft) and because deciding case type is always a manual
  // judgment call regardless of what this shows. Kept in `manualOnly` so it still surfaces in
  // the "still to check" reminder even though it no longer reads as MANUAL in the mail itself.
  // The run reads the Glue sanity-check result (discrepancy count), but the support role can't
  // see run history for most Ariane jobs, so "did any Glue job fail" stays a manual Slack check.
  const dropfile = fromExtra(extras.dropfile);
  if (dropfile.ok) dropfile.proof = '0 discrepancies';
  dropfile.manualOnly = true;
  dropfile.note = [dropfile.note, 'also check Slack #ariane-alerts-prod for failed Glue jobs'].filter(Boolean).join(' | ');

  const sf = extras.sfCases;
  const sfItem = !sf || sf.status === 'SKIPPED' ? { v: '0', ok: null, manualOnly: true, note: sf && sf.detail }
    : { v: String(sf.count), ok: sf.count === 0 ? true : null, note: sf.count ? 'review: ' + sf.cases.map((c) => c.number).join(', ') : null };

  return [
    { label: 'B2C & B2B :- Check OD on B2C & B2B website', ...b2c },
    { label: 'B2B :- System Connectivity Status', ...conn },
    { label: 'Group Bookings-Salesforce Sync', ...fromExtra(extras.appflow) },
    // Portal lines: OK only when a logged-in search returned trains (lib/portals.js).
    { label: 'Key account ROW working', ...portal('rowKeyAccount') },
    { label: 'Agents portal ROW working', ...portal('rowAgent') },
    { label: 'Key account China working', ...portal('chinaKeyAccount') },
    { label: 'Customer care china working', ...portal('chinaCustomerCare') },
    { label: 'SNCF :- Check OD', ...sncf },
    { label: 'Primer Status Page', ...primer },
    { label: 'Dropfile sanity check', ...dropfile },
    { label: 'SF cases not linked with an SR', sep: ' : ', ...sfItem },
  ];
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function buildMail(items) {
  const bad = items.filter((i) => i.ok === false);
  // A booking suite that didn't finish/capture a reference must flip the subject to KO even if
  // every numbered line reads OK — see bookingIssues(), the same check that gates the Slack post.
  const status = (bad.length || bookingIssues().length) ? 'KO' : 'OK';
  // No booking refs in the subject: they sit on point 1, next to the check that made them.
  const subject = `B2B & B2C Sanity Check - ${status} [${date}; ${slot} IST]`;

  // What the mail shows after the status: the proof in brackets, and — for a KO only — the reason
  // (trimmed), so a reader of the mail can see WHY without the console. OK lines stay short.
  const shown = (it) => it.v + (it.proof ? ` (${it.proof})` : '')
    + (it.ok === false && it.note ? ` — ${String(it.note).replace(/\s+/g, ' ').slice(0, 170)}` : '');

  const rowHtml = items.map((it, n) => {
    const value = it.link ? `<a href="${esc(it.link)}">${esc(it.link)}</a>` : esc(shown(it));
    const sep = it.link ? ': ' : (it.sep || ':- ');
    const color = it.ok === false ? ' style="color:#c00000;font-weight:bold"' : it.v === MANUAL ? ' style="color:#b35c00;font-weight:bold"' : '';
    return `<tr><td style="padding:1px 8px 1px 18px;vertical-align:top">${n + 1}.</td>`
      + `<td style="padding:1px 12px 1px 0;vertical-align:top;white-space:nowrap">${esc(it.label)}</td>`
      + `<td style="padding:1px 0;vertical-align:top"${color}>${sep}${value}</td></tr>`;
  }).join('\n');

  const html = `<div style="font-family:Calibri,Aptos,Arial,sans-serif;font-size:11pt">
<p>Hello All,</p>
<p>Please find today's sanity check result done at ${slot} IST</p>
<table style="border-collapse:collapse;font-family:inherit;font-size:inherit">
${rowHtml}
</table>
</div>`;

  const text = [
    'Hello All,', '',
    `Please find today's sanity check result done at ${slot} IST`, '',
    ...items.map((it, n) => `${n + 1}. ${it.label}${it.link ? ': ' + it.link : (it.sep || '  :- ') + shown(it)}`),
  ].join('\r\n');

  return { subject, html, text, status };
}

function openDraft(mail) {
  fs.writeFileSync(path.join(REPORT, 'sanity-mail.html'), mail.html);
  fs.writeFileSync(path.join(REPORT, 'sanity-mail.txt'), `Subject: ${mail.subject}\r\n\r\n${mail.text}`);
  if (DRY || process.env.MSC_NO_MAIL) {
    console.log('  Mail: draft saved to report/sanity-mail.html (not opened — ' + (DRY ? '--dry-run' : 'MSC_NO_MAIL is set') + ')');
    return;
  }
  // Formatted (HTML) body onto the clipboard — pasting keeps the table alignment and the
  // working link, matching the team's usual clean layout.
  //
  // Tried and reverted: inlining a body straight into the mailto: link. `mailto:` has no HTML
  // body param, only plain text, so that produced a flat, unaligned list with no formatting —
  // reported back as "looks shabby, not clean" (2026-09-27) next to the team's normal HTML
  // mail. Also tried: driving classic Outlook via COM (`New-Object -ComObject
  // Outlook.Application`) to set `.HTMLBody` directly, which WOULD render properly. That COM
  // object is still reachable even with "new Outlook" set as the default app — but on this
  // machine classic Outlook has never been signed in, so `.Display()` opened its "Add Account"
  // setup wizard instead of a compose window, rather than anything usable. Not pursuing that:
  // it would mean setting up a whole separate mail profile just for this. One paste keeps the
  // real formatting with no such setup.
  const ps = spawnSync('powershell', ['-NoProfile', '-Command',
    `Set-Clipboard -AsHtml -Value (Get-Content -Raw -Encoding UTF8 '${path.join(REPORT, 'sanity-mail.html').replace(/'/g, "''")}')`],
  { encoding: 'utf8', timeout: 30000 });
  const clip = ps.status === 0;
  // Compose window via mailto: — opens in whatever mail app is the default (new Outlook here).
  // Launched without a shell so nothing in the subject is reinterpreted by cmd.
  const to = process.env.MAIL_TO || '';
  const url = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(mail.subject)}`;
  try {
    spawn('rundll32', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' }).unref();
    console.log('  Mail: Outlook compose opened with the subject filled in.'
      + (clip ? ' The body is on your clipboard — click in the body, press Ctrl+V, review, Send.' : ' (Clipboard copy failed — paste from report/sanity-mail.html.)'));
    if (!to) console.log('        (No MAIL_TO in .env, so the To: line is empty — type DL_Tech_Notification.)');
  } catch (e) {
    console.log('  Mail: could not open Outlook — the draft is in report/sanity-mail.html');
  }
}

(async () => {
  // exitCode, not process.exit(): exiting while fetch's socket is still closing crashes Node on
  // Windows ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)", exit 127).
  if (process.argv.includes('--check-slack')) { process.exitCode = await checkSlack(); return; }
  const slackText = `Sanity done ${slot} IST- ${refs.join(', ')}`;
  const items = buildItems();
  const mail = buildMail(items);

  console.log('\n' + '─'.repeat(72));
  console.log(' SLACK  (#sd_24-7)');
  console.log('─'.repeat(72));
  console.log('  ' + slackText);
  await postSlack(slackText);

  console.log('\n' + '─'.repeat(72));
  console.log(' SANITY MAIL  (draft — never sent automatically)');
  console.log('─'.repeat(72));
  console.log('  Subject: ' + mail.subject + '\n');
  items.forEach((it, n) => {
    const val = it.link ? it.link : it.v + (it.proof ? ` (${it.proof})` : '');
    console.log(`  ${String(n + 1).padStart(2)}. ${it.label.padEnd(34)} ${it.link ? '' : ':- '}${val}` + (it.note ? `\n        ↳ ${it.note}` : ''));
  });
  const manual = items.filter((i) => i.v === MANUAL || i.manualOnly).map((i) => i.label);
  if (manual.length) console.log('\n  Still to check yourself before sending: ' + manual.join(' · '));
  console.log('');
  openDraft(mail);
})();
