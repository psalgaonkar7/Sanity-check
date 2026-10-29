// After a sanity run: send the result to Pratikesh as a Slack DM and prepare the sanity mail.
// Called by run-sanity.js as its last step; also runnable alone:
//   node notify.js             DM + open mail draft (same as the end of a run)
//   node notify.js --dry-run   print what WOULD be sent and mailed; touch nothing
//
// DM     — goes through the Pratikesh Assistant's own Workflow Builder webhook
//          (SLACK_ALERT_WEBHOOK, the same one RE/Assistant uses; read from the environment, the
//          Windows user environment or .env), in that workflow's payload shape. Nothing is posted
//          to a team channel any more (the "Sanity Bot" post to #sd_24-7 was retired on
//          2026-10-20). Every run is DMed, a KO included. The team's "Sanity done 00:00 IST- K…"
//          line is in the DM, ready to paste, but ONLY for a complete run with booking
//          references (bookingIssues()): a failed or partial run must never be announced as
//          "Sanity done".
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
const SENT = path.join(REPORT, '.dm-sent.json');
const WIKI = 'https://raileurope.atlassian.net/wiki/pages/viewpage.action?pageId=2411692034';

// --- .env (KEY=value lines) — shared loader, see lib/env.js ---------------------------------
require('./lib/env').loadEnv();

const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(REPORT, f), 'utf8')); } catch { return null; } };
const b2b = read('msc-b2b.json') || {};
const api = read('api-searchability.json') || {};
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

// --- Booking-suite gate ---------------------------------------------------------------------
// Shared with buildItems() below, so the mail's booking-suite line and the "Sanity done" line
// in the DM use exactly one definition of "this run's booking suite didn't actually complete" — see
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

// --- DM to Pratikesh (via the Pratikesh Assistant workflow) -----------------------------------
// The webhook is a Workflow Builder trigger. Its message step is fixed by the workflow template
// (shared with RE/Assistant and SR-Triage/critical-investigate.js):
//   🚨 SR alert: {sr_key} (proposed {severity})  /  {title}  /  {link}  /  {brief}
// so sr_key is always "Pratikesh Assistant" and `severity` carries the headline, exactly as the
// Assistant does. The workflow treats everything as plain text (no Slack markup, no link labels).
// A Workflow Builder trigger answers HTTP 200 + {"ok":true}; anything else is a failed send.
const BRIEF_MAX = 2800;   // Workflow Builder variable cap, same as RE/Assistant

// setx only reaches NEW terminals, so a window opened before the webhook was set still finds it:
// read it from HKCU\Environment like RE/Assistant's userEnv() does.
function dmHook() {
  if (process.env.SLACK_ALERT_WEBHOOK) return process.env.SLACK_ALERT_WEBHOOK.trim();
  try {
    const r = spawnSync('reg', ['query', 'HKCU\\Environment', '/v', 'SLACK_ALERT_WEBHOOK'], { encoding: 'utf8', timeout: 10000 });
    const m = (r.stdout || '').match(/SLACK_ALERT_WEBHOOK\s+REG_(?:SZ|EXPAND_SZ)\s+(\S+)/i);
    return m ? m[1].trim() : '';
  } catch { return ''; }
}

// One DM per run: re-running `node notify.js` for the same run does not DM twice.
const runKey = process.env.MSC_RUN_ID || b2b.runId || key;

function dmBlocked() {
  const why = [];
  if (process.env.MSC_NO_DM || process.env.MSC_NO_SLACK) why.push(process.env.MSC_NO_DM ? 'MSC_NO_DM is set' : 'MSC_NO_SLACK is set');
  if (!/^https:\/\/hooks\.slack\.com\//.test(dmHook())) why.push('SLACK_ALERT_WEBHOOK is not set (the Pratikesh Assistant webhook — see README: Result DM)');
  let sent = {};
  try { sent = JSON.parse(fs.readFileSync(SENT, 'utf8')); } catch {}
  if (sent[runKey]) why.push(`already sent for this run (at ${sent[runKey]})`);
  if (DRY) why.push('--dry-run');
  return why;
}

function buildDm(items, mail) {
  const startMs = Date.parse(String(process.env.MSC_RUN_ID || '').slice(0, 24));
  const took = Number.isFinite(startMs) ? ` · took ${((Date.now() - startMs) / 60000).toFixed(1)} min` : '';
  const bad = items.filter((i) => i.ok === false);
  const manual = items.filter((i) => i.v === MANUAL || i.manualOnly);
  const one = (s) => String(s).replace(/\s+/g, ' ').slice(0, 220);
  const lab = (it) => it.label.replace(/\s*:-\s*/, ' - ');
  const lines = [];
  lines.push((mail.status === 'OK' ? `🟢 Sanity OK - ${slot} IST`
    : bad.length ? `🔴 Sanity KO - ${bad.length} ${bad.length === 1 ? 'check' : 'checks'} failed - ${slot} IST`
      : `🔴 Sanity KO - the booking run did not complete - ${slot} IST`) + took);
  lines.push('');
  if (bad.length || bookingIssues().length) {
    lines.push('👉 NEEDS YOU');
    bad.forEach((it) => lines.push(`- ${items.indexOf(it) + 1}. ${lab(it)}: KO${it.note ? ' - ' + one(it.note) : ''}`));
    if (bookingIssues().length && !bad.length) lines.push('- Booking run: ' + one(bookingIssues().join('; ')));
    lines.push('');
  }
  if (manual.length) {
    lines.push('👉 CHECK YOURSELF BEFORE SENDING THE MAIL');
    manual.forEach((it) => lines.push(`- ${lab(it)}${it.note ? ': ' + one(it.note) : ''}`));
    lines.push('');
  }
  lines.push('✅ RESULT (same as the mail)');
  items.forEach((it, n) => lines.push(`${n + 1}. ${lab(it)}: ${it.v}${it.proof ? ' (' + it.proof + ')' : ''}`));
  lines.push('');
  lines.push('📎 The mail ends with the Sanity Tracker link (Sanity Tracker.xlsx).');
  lines.push('');
  if (!bookingIssues().length) {
    lines.push('📋 For the team channel, if you want to post it:');
    const cn = extras.chinaCustomerCare && extras.chinaCustomerCare.status === 'OK' && extras.chinaCustomerCare.booking;
    lines.push(`Sanity done ${slot} IST- ${refs.join(', ')}${cn ? ' | China: ' + cn.ref : ''}`);
  } else {
    lines.push('⛔ Do not post "Sanity done": the booking run did not complete.');
  }
  lines.push('');
  lines.push(DRY || process.env.MSC_NO_MAIL ? '📧 Mail draft saved in report/sanity-mail.html.'
    : '📧 Mail draft is open in Outlook: click in the body, Ctrl+V, review, Send.');
  let brief = lines.join('\n').trim();
  if (brief.length > BRIEF_MAX) brief = brief.slice(0, BRIEF_MAX) + '\n... (full detail: the run window / report/sanity-mail.txt)';
  const title = `Sanity ${mail.status} · ${date} ${slot} IST`;
  return { text: title + '\n\n' + brief, sr_key: 'Pratikesh Assistant', severity: `Sanity ${mail.status} ${slot} IST`, title, brief, link: WIKI };
}

async function sendDm(payload) {
  const blocked = dmBlocked();
  if (blocked.length) { console.log('  DM: NOT sent — ' + blocked.join('; ')); return false; }
  try {
    const r = await fetch(dmHook(), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(20000),
    });
    const body = (await r.text()).trim();
    let ok = r.status === 200;
    if (ok && body && body !== 'ok') { try { ok = JSON.parse(body).ok === true; } catch { ok = false; } }
    if (!ok) { console.log(`  DM: FAILED — HTTP ${r.status} ${body.slice(0, 80)}`); return false; }
    let sent = {};
    try { sent = JSON.parse(fs.readFileSync(SENT, 'utf8')); } catch {}
    sent[runKey] = new Date().toISOString();
    const keys = Object.keys(sent);
    if (keys.length > 200) keys.slice(0, keys.length - 200).forEach((k) => delete sent[k]);
    fs.writeFileSync(SENT, JSON.stringify(sent, null, 2));
    console.log('  DM: sent to you via Pratikesh Assistant');
    return true;
  } catch (e) {
    console.log('  DM: FAILED — ' + String(e.cause && e.cause.code || e).slice(0, 100));
    return false;
  }
}
// --- Mail ---------------------------------------------------------------------------------
const MANUAL = '[check manually]';
// Sanity Tracker link at the bottom of the mail (re-added 2026-10-20, as in commit 3146d77^).
const TRACKER = process.env.SANITY_TRACKER_URL
  || 'https://raileuropegroupe.sharepoint.com/:x:/r/sites/msteams_a1643b/_layouts/15/Doc.aspx?sourcedoc=%7B249BB009-BF41-4D32-8AA2-83A53B899359%7D&file=Sanity%20Tracker.xlsx&action=default&mobileredirect=true';

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
  // Booking refs sit on the line of the portal that made them (customer care ROW here, China on
  // its own line), not in the subject.
  // Payment-page probe (MSC_PAYMENT_PROBE=1): one item taken to Hold & Payment, never paid.
  const pp = b2b.paymentProbe;
  const ppNote = pp && pp.reachedPayment ? `; payment page reached (${pp.ref || '?'})` : '';
  const refProof = refs.length ? `Booking ref: ${refs.join(', ')}${ppNote}` : null;
  const b2c = !bookingOk ? { v: 'KO', ok: false, proof: refProof, note: 'B2B booking run did not complete: ' + bookingIssues().join('; ') }
    : pp && !pp.reachedPayment ? { v: 'KO', ok: false, proof: refProof, note: `payment page not reached (${pp.route}): ${pp.error || 'pay button never appeared'}` }
    : !prod ? { v: 'OK', ok: null, manualOnly: true, proof: refProof, note: 'B2B verified by the booking run; B2C API check did not run, check B2C by hand' }
      : prod.summary.pass === testable ? { v: 'OK', ok: true, proof: refProof }
        : { v: 'KO', ok: false, proof: refProof, note: `${testable - prod.summary.pass}/${testable} production API routes failing` };

  const ccChina = fromExtra(extras.chinaCustomerCare);
  if (ccChina.ok && extras.chinaCustomerCare.booking) {
    const bk = extras.chinaCustomerCare.booking;
    ccChina.proof = `Booking ref: ${bk.ref}${bk.reachedPayment ? '; payment page reached' : ''}`;
  }

  // The "B2B :- System Connectivity Status" line was REMOVED from the mail and the DM on
  // 2026-10-28 (Pratikesh: it must be excluded from the sanity run — it read KO on a carrier or
  // page problem that the booking run already shows). The mail is now 9 points.

  const pos = b2b.sncfPos || [];
  const sncf = !pos.length ? { v: MANUAL, ok: null, note: 'SNCF check did not run' }
    : pos.every((r) => r.result === 'PASS') ? { v: 'OK', ok: true }
      : { v: 'KO', ok: false, note: pos.filter((r) => r.result !== 'PASS').map((r) => `${r.od} ${r.result}`).join(', ') };

  const primer = fromExtra(extras.primer);
  if (extras.primer && extras.primer.notices && extras.primer.notices.length) {
    primer.note = [primer.note, 'info notice on the status page (impact none): ' + extras.primer.notices.join('; ')].filter(Boolean).join(' | ');
  }
  if (extras.primer && extras.primer.maintenance && extras.primer.maintenance.length) {
    primer.note = [primer.note, 'maintenance: ' + extras.primer.maintenance.join('; ')].filter(Boolean).join(' | ');
  }

  // "SF cases not linked with an SR" is NOT a line of the mail or the DM any more (Pratikesh,
  // 2026-10-29: it only ever showed a "0" placeholder because Salesforce isn't connected here).
  // extra-checks.js still records the real status in report/msc-extras.json (sfCases).
  // The run reads the Glue sanity-check result (discrepancy count), but the support role can't
  // see run history for most Ariane jobs, so "did any Glue job fail" stays a manual Slack check.
  const dropfile = fromExtra(extras.dropfile);
  dropfile.manualOnly = true;
  dropfile.note = [dropfile.note, 'also check Slack #ariane-alerts-prod for failed Glue jobs'].filter(Boolean).join(' | ');

  return [
    { label: 'B2C & B2B :- Check OD on B2C & B2B website', ...b2c },
    { label: 'Group Bookings-Salesforce Sync', ...fromExtra(extras.appflow) },
    // Account lines: OK only when that portal's saved login got a logged-in train search that
    // returned results (lib/portals.js). An expired login reads [check manually], never a false OK.
    { label: 'Key account ROW working', ...fromExtra(extras.rowKeyAccount) },
    { label: 'Agents portal ROW working', ...fromExtra(extras.rowAgent) },
    { label: 'Key account China working', ...fromExtra(extras.chinaKeyAccount) },
    { label: 'Customer care china working', ...ccChina },   // search + one booking (lib/portals.js)
    { label: 'SNCF :- Check OD', ...sncf },
    { label: 'Primer Status Page', ...primer },
    { label: 'Dropfile sanity check', ...dropfile },
  ];
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// A line's value as shown in the mail: the status, then its booking ref(s) in brackets if any.
const shown = (it) => it.v + (it.proof ? ` (${it.proof})` : '');

function buildMail(items) {
  const bad = items.filter((i) => i.ok === false);
  // Not shown as its own numbered line (kept to the 9 standard points), but a booking suite
  // that didn't finish/capture a reference must still flip the subject to KO — see
  // bookingIssues(), the same check that withholds the "Sanity done" line in the DM.
  const status = (bad.length || bookingIssues().length) ? 'KO' : 'OK';
  // No booking refs in the subject: each sits on its portal's line (point 1 ROW, point 7 China).
  const subject = `B2B & B2C Sanity Check - ${status} [${date}; ${slot} IST]`;

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
<p><br>Details Sanity check result:-</p>
<p><a href="${esc(TRACKER)}">Sanity Tracker.xlsx</a></p>
</div>`;

  const text = [
    'Hello All,', '',
    `Please find today's sanity check result done at ${slot} IST`, '',
    ...items.map((it, n) => `${n + 1}. ${it.label}${it.link ? ': ' + it.link : (it.sep || '  :- ') + shown(it)}`),
    '', 'Details Sanity check result:-', '', 'Sanity Tracker.xlsx (' + TRACKER + ')',
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
  const items = buildItems();
  const mail = buildMail(items);

  console.log('\n' + '─'.repeat(72));
  console.log(' SANITY MAIL  (draft — never sent automatically)');
  console.log('─'.repeat(72));
  console.log('  Subject: ' + mail.subject + '\n');
  items.forEach((it, n) => {
    const val = it.link ? it.link : shown(it);
    console.log(`  ${String(n + 1).padStart(2)}. ${it.label.padEnd(34)} ${it.link ? '' : ':- '}${val}` + (it.note ? `\n        ↳ ${it.note}` : ''));
  });
  console.log('\n  Details Sanity check result:-  Sanity Tracker.xlsx  (link is in the mail body)');
  const manual = items.filter((i) => i.v === MANUAL || i.manualOnly).map((i) => i.label);
  if (manual.length) console.log('\n  Still to check yourself before sending: ' + manual.join(' · '));
  console.log('');
  openDraft(mail);

  // The DM goes last so what it says about the mail draft is already true.
  const dm = buildDm(items, mail);
  console.log('\n' + '─'.repeat(72));
  console.log(' RESULT DM  (to you, via Pratikesh Assistant — nothing goes to a team channel)');
  console.log('─'.repeat(72));
  if (DRY) console.log(dm.brief.split('\n').map((l) => '  ' + l).join('\n') + '\n');
  await sendDm(dm);
  console.log('');
})();
