# RE/ASC — Rail Europe Automated Sanity Check automation

Deterministic Playwright replacement for driving the MSC by hand (~28 min, non-deterministic)
— covers every carrier on the connectivity page in about 7 minutes (longer when a carrier's
search times out) and produces booking references
as evidence. Git remote: `github.com/psalgaonkar7/Sanity-check.git` (renamed from `MSC.git`,
itself renamed from `Local.git`; GitHub still redirects both old names). **Local folder
renamed `RE/MSC` → `RE/ASC` on 2026-10-01**, matching the GitHub repo rename the same day.

## Running it

Two lines, from the folder this file is in:

```
cd <your clone of this repo>      # on Pratikesh's machine: C:\Claude\RE\ASC
npm run sanity
```

Check `node -v` first. On Pratikesh's machine node is already on the system PATH, so **CMD,
PowerShell and Git Bash all work with no PATH setup**. If `node -v` fails on yours, prepend
your Node folder for that shell — the syntax differs, so use the one matching the shell you
are actually in (paths below are this machine's portable build, substitute your own):

```
:: CMD
set "PATH=C:\Users\PSalgaonkar\AppData\Local\nodejs-portable\node-v24.18.0-win-x64;%PATH%"
:: PowerShell
$env:PATH = "C:\Users\PSalgaonkar\AppData\Local\nodejs-portable\node-v24.18.0-win-x64;$env:PATH"
:: Git Bash
export PATH="C:/Users/PSalgaonkar/AppData/Local/nodejs-portable/node-v24.18.0-win-x64:$PATH"
```

`export` is Git-Bash-only — in CMD it fails with `'export' is not recognized`.

**If every check times out, the login has expired** — it does not look like a login error.
Run `node check-login.js` (10s) before blaming the code; see Troubleshooting in `README.md`.

Other entry points: `npm run auth` (AWS SSO + B2B), `npm run auth:portals` (the 4 other
portals' saved logins), `npm run china-full` (opt-in full China booking), `node notify.js
--dry-run` (mail + DM text, sends nothing), `npm run deck` (regenerates the manager deck into
`RE/docs/Rail-Europe-MSC-Automation-Overview.pptx`). `run-sanity.ps1` / `run-auth.ps1` find
Node on any machine (`-CheckOnly` to test) and must stay ASCII-only.

## ⚠ Rules that have already cost us

- **One run at a time.** Every check shares one B2B account, one cart, one POS. A second
  `npm run sanity` (or `npm run auth`) corrupts both runs — this caused two misdiagnoses.
  Check first: `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'run-sanity|playwright' }`
- Killing the wrapper does **not** stop Playwright children — they orphan and keep driving the
  account. Kill the whole process tree.
- **Never pays.** The flow stops at Traveler Details, status `Created`, to capture the booking
  ref. It must not fill traveler details or reach Hold & Payment — that submits a real order to
  the carrier. Seeing `Prebooked` or a real carrier PNR means a regression; fix it back rather
  than relabelling the result. **One approved exception (2026-10-20, Pratikesh's call):** the
  opt-in payment-page probe, `MSC_PAYMENT_PROBE=1` — ONE item taken to Hold & Payment, never
  paid, which holds one real seat at the carrier (ROW pilot: SNCF PNR VLK5CY, whether it
  lapses on its own is unverified). It is OFF by default; only that probe may reach `Prebooked`.
  The China part of the probe is not working yet (traveler form timeout).
- **Full China booking is opt-in** (`npm run china-full`, ~9 min, Z… refs). `npm run sanity`
  books only ONE China train (~45 s). Do not add the full China booking to the default run:
  the run has to stay about 7-10 min.
- **No team-channel posts.** The result goes only to Pratikesh as a Slack DM through the
  Pratikesh Assistant webhook (`SLACK_ALERT_WEBHOOK`, `notify.js`). The #sd_24-7 "Sanity Bot"
  post is retired; never bring back `SLACK_WEBHOOK_URL` or `check-slack`. The paste-ready
  "Sanity done" line is only offered for a complete run (`bookingIssues()` empty).

## Layout

- `lib/helpers.js` — reusable browser helpers (`switchPOS`, `selectStation`, `setDate`,
  `continueToTravelerDetails`). Reuse these for one-off reproduction scripts instead of
  driving Claude-in-Chrome by hand.
- `tests/` — the Playwright specs. `report/`, `test-results/` — generated output.
- `deck/gen.js` — builds the manager deck. Output path is self-locating via `__dirname`; do
  not hardcode it again.
- `api-searchability.js` — read-only API check (staging + production). Reads `POSTMAN_DIR`,
  falling back to the current user's `OneDrive - RAILEUROPE\Desktop\Training Material\Postman
  Collections\LH` (then the older `Notes\Training\Postman json files\LH`).
- `notify.js` — the mail draft + the result DM. `extra-checks.js` — Primer, AppFlow, dropfile,
  SF count and the 4 portal checks (`lib/portals.js`, `lib/portal-list.js`). `lib/env.js` —
  the shared `.env` loader. `china-full.js` — the opt-in full China booking.

## Memory

`raileurope-msc-automation`, `raileurope-msc-learnings`, `raileurope-sanity-reporting-prefs`
(omit deck status from results; surface only what needs attention).

Skill: `.claude/skills/raileurope-msc-automation/`.
