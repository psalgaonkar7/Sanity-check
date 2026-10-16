# RE/ASC — Rail Europe Automated Sanity Check automation

Deterministic Playwright replacement for driving the MSC by hand (~28 min, non-deterministic)
— covers every carrier on the connectivity page in ~5.5 minutes and produces booking references
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

Other entry points: `npm run auth`, `npm run deck` (regenerates the manager deck into
`RE/docs/Rail-Europe-MSC-Automation-Overview.pptx`).

## ⚠ Rules that have already cost us

- **One run at a time.** Every check shares one B2B account, one cart, one POS. A second
  `npm run sanity` (or `npm run auth`) corrupts both runs — this caused two misdiagnoses.
  Check first: `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'run-sanity|playwright' }`
- Killing the wrapper does **not** stop Playwright children — they orphan and keep driving the
  account. Kill the whole process tree.
- **Never pays.** The flow stops at Traveler Details, status `Created`, to capture the booking
  ref. It must not fill traveler details or reach Hold & Payment — that submits a real order to
  the carrier. Seeing `Prebooked` or a real carrier PNR means a regression; fix it back rather
  than relabelling the result.

## Layout

- `lib/helpers.js` — reusable browser helpers (`switchPOS`, `selectStation`, `setDate`,
  `continueToTravelerDetails`). Reuse these for one-off reproduction scripts instead of
  driving Claude-in-Chrome by hand.
- `tests/` — the Playwright specs. `report/`, `test-results/` — generated output.
- `deck/gen.js` — builds the manager deck. Output path is self-locating via `__dirname`; do
  not hardcode it again.
- `api-searchability.js` — read-only API check. Reads `POSTMAN_DIR` env var, falling back to
  the Postman export folder under `Desktop\Notes\Training`.

## Memory

`raileurope-msc-automation`, `raileurope-msc-learnings`, `raileurope-sanity-reporting-prefs`
(omit deck status from results; surface only what needs attention).

Skill: `.claude/skills/raileurope-msc-automation/`.
