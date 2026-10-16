---
name: raileurope-msc-automation
description: Run the Rail Europe B2B Manual Sanity Check (MSC) via this repo's Playwright automation instead of manually driving a browser — section-aware connectivity read, carrier-coverage guard, 19 point-to-point sectors + 3 rail passes built into batched carts, SNCF Connect POS check, and read-only API searchability on staging + production. Use whenever asked to "run the sanity check", "run the MSC", or check Rail Europe B2B/carrier health, and this repo (RE\ASC in the C:\Claude workspace) is present.
---

# Rail Europe MSC Automation

Deterministic Playwright replacement for the old "AI drives a live browser" approach
(~28 min, token-heavy, non-deterministic). This repo covers **every carrier on the
connectivity page** in **~6 minutes** and produces booking references as evidence.

Repo: https://github.com/psalgaonkar7/Sanity-check.git — renamed from `MSC.git`, itself
renamed from `Local.git`; GitHub still redirects both old names (primary copy: `RE\ASC` in
the `C:\Claude` workspace — local folder renamed from `RE\MSC` on 2026-10-01, matching the
GitHub repo rename the same day)

**Safety, always:** never pays, never uses agency allowance, never clicks
"CONTINUE TO PAY". The flow stops at the **Traveler Details** page — status
**Created** — to capture the booking reference. It deliberately does **not** fill
traveler details or proceed to Hold & Payment: that step submits the order to the
carrier's own booking system and holds a real reservation there, confirmed via a
LocoHub admin lookup showing a real provider PNR for a sector that reached it.
`Created` is the correct stopping point — if you ever see a real-looking PNR in a
carrier admin panel, or the status reads `Prebooked`, something has regressed back to
advancing past Traveler Details. Fix it back to stopping there; don't relabel the result.

## ⚠️ Run only ONE instance at a time

Every browser check shares **one B2B account, one cart, one POS**. Never start a run
while another `npm run sanity` (or `npm run auth`) is going — they corrupt each other.
This has already caused two misdiagnoses. Before starting, check nothing is running:

```bash
# PowerShell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'run-sanity|playwright' }
```

Also note: killing a run's wrapper does **not** stop its Playwright children — they
orphan and keep driving the account. Kill the whole process tree by walking descendants.

## Running it

Node is on this machine's system PATH, so **CMD, PowerShell and Git Bash all work with the
same two lines** — no PATH setup needed:

```
cd C:\Claude\RE\ASC
npm run sanity
```

Do **not** hand the user an `export PATH=...` line: that is Git-Bash-only and fails in CMD
with `'export' is not recognized`. If `node -v` ever fails, the CMD form is
`set "PATH=C:\Users\PSalgaonkar\AppData\Local\nodejs-portable\node-v24.18.0-win-x64;%PATH%"`
and the PowerShell form uses `$env:PATH`.

Takes ~6 min. Running it in the background is fine — it's a real Playwright process,
not something driven through the browser-pane MCP tools, so don't use `Claude_Browser`
tools for this: they're unnecessary and burn tokens. Only reach for a manual browser
flow if this automation is unavailable.

Useful env vars: `MSC_MAX_SECTORS=4` (validate on a subset first — do this before any
full run after changing selectors), `MSC_MAX_ITEMS_PER_ORDER`, `MSC_DAYS_AHEAD`,
`HEADED=1`, `LH_ONLY=production`.

### If login has expired

`storageState.json` holds the saved B2B session. If the browser suite fails early with
auth/redirect-to-login errors, the session has expired. Do **not** attempt to log in
yourself (credential entry is off-limits) — tell the user to run `npm run auth`, which
opens a headed browser for **them**. Their password is never typed by or stored in any
script you run. Note `npm auth` is not a valid command; it must be `npm run auth`.

`npm run auth` now also opens a browser step for AWS SSO (`era`) first, since that check
in `extra-checks.js` needs its own separate login — skipping/cancelling that step is fine,
it never blocks the B2B login that follows. If only the B2B session needs refreshing, tell
them `npm run auth:b2b` instead, which skips the AWS step entirely.

## What it checks

1. **B2B browser suite** (`tests/b2b-msc.spec.js`, `tests/b2b-passes.spec.js`):
   - **section-aware** connectivity read (Point-to-point / Passes / Services) — flags any
     carrier RED/unstable >15 min per SOP rule #1
   - **carrier-coverage guard** — every carrier on the page must be booked, passed,
     knowingly excluded, or explicitly pending a route, else `UNMAPPED CARRIER`
   - SNCF Connect POS search-only validation (3 ODs), then switches POS **back explicitly**
   - **19 sectors + 3 passes** built into batched carts → one booking reference per order
2. **API searchability** (`api-searchability.js`): LocoHub API on staging + production.
   Runs **in parallel** with the browser suite. Also how B2C's engine is validated, since
   B2C itself is anti-bot blocked.
3. **Manager deck** (`deck/gen.js`) and **run history** (`log-run.js` → `npm run weekly`).
4. **Extra checks** (`extra-checks.js`, in parallel): Primer status API, AppFlow
   `tf-era-prod-shared-salesforce-flow` (Group Bookings–SF sync), both China portals, and the
   SF *Technical HD view* case count. Each degrades to SKIPPED with a fix when a login lapses.
5. **Slack + mail** (`notify.js`, last step): posts `Sanity done HH:MM IST- <refs>` to
   #sd_24-7 via `SLACK_WEBHOOK_URL` in `.env`, and opens the sanity mail as an Outlook draft.

### Rules for the Slack post and the mail — do not weaken these

- The mail is **never sent automatically**. It opens as a compose window; a person sends it.
  Do not add SMTP/Graph sending.
- Slack posts **only** for a complete run with booking references, once per slot. Never loosen
  `shouldPost()` so a failed or partial run announces "Sanity done".
- Never write `OK` for something the run did not verify — it is `[check manually]`.
- When testing, use `node notify.js --dry-run` or set `MSC_NO_SLACK=1` / `MSC_NO_MAIL=1`.
  Do not post test messages to #sd_24-7: it is the team's live channel.
- AppFlow is **event**-triggered — "no recent run" is not a failure; only a failed run is.
- The China check must **not** use `blockNoise()` — the key-account `.cn` portal never boots
  without the hosts it blocks, so it would read as down on every run.

## Fallback routes — read before reporting a sector as failed

Every carrier has verified alternate routes — **101 routes across the 19 sectors** (3 to 6 each),
plus the 3 SNCF POS ODs — tried in order when the primary fails. Try-order per carrier is
`primary → ALTERNATES → VERIFIED_EXTRA`, both maps at the bottom of `data/journeys.js`.
**A sector is only failed once EVERY route has failed.** So a `DROPPED`/`ERROR` line genuinely
means "not sellable on any route we know", not "one route was empty" — report it that way. The
error text names every route tried and the last reason. If a fallback was used, the report says
so (`usedFallback`) — mention it, since a primary route silently degrading is worth knowing.

Adding a route requires **both** gates. Never add a guessed OD.

1. **Does the OD sell that carrier?** LocoHub `POST /searches` must return the carrier's own
   **brand** in `search_connection.transport_name`. Do **not** match on `attributes.carrier`
   (null on most responses) or `provider` — `provider` is the *aggregator*: SNCF sells through
   `PAO`, RDG through `Atomised`, Trenitalia through `PICO`, and RegioJet **and** Leo Express
   both through `Distribusion`.
2. **Can the OD be typed into the portal?** `node tools/verify-station-labels.js` — read-only,
   never searches or books. The autocomplete matches `opt` as a **substring**, so a label can
   match confidently and select the wrong place: `Brugge` → *Brugge (Westf), **Germany***,
   `Linz` → *Linz (Rhein), **Germany***, `Milano` → Milano Nord Cadorna. The tool checks the
   resolved option's **country** against the LocoHub code prefix and prints the exact fix line.
   Run it after **any** edit to `data/journeys.js`.

`ARENAWAYS` and `SJ` have zero searchable stations in the production catalogue (`GET /stations`)
— that is why discovery finds nothing; it is not a search bug. `CAMPANIA EXPRESS` has stations
but Naples→Sorrento returns 0 products. All three stay parked.

## Things that are true and non-obvious

- **An order caps at 15 items.** The 16th add-to-cart returns "You have reached the
  maximum number of items in your order". Coverage needs 22, so the run builds multiple
  orders (passes first) and captures a reference for each. This cap was also the real
  cause of the long-running "Swiss Travel Pass randomly times out" symptom.
- **`workers: 1` is mandatory** in `playwright.config.js`. Only ~13s of the run is
  parallelisable; the POS check mutates the point of sale **account-wide** and the booking
  test owns the shared cart. A run at default workers lost all 3 POS ODs and all 12 sectors.
  Real parallelism needs a second B2B account, not a config change.
- **Never select on `id`** — the portal generates a fresh random `id` per page load.
  `data-select` is the stable contract; the fragile selectors live in the `SEL` map in
  `lib/helpers.js`. A portal rename (`name="from"` → `ng.form1.from`) once made every
  sector fail with opaque 20s timeouts.
- **Travellers reset to 0** on any full `/home` load, and SEARCH then silently refuses to
  submit with no validation message. `setAdults()` is idempotent and runs before every
  search for this reason.
- **Switching POS is account-level** — navigating away does NOT reset it. It must be
  switched back explicitly or it poisons the next test.
- **`blockNoise()`** aborts `kameleoon.io` / `quantummetric.com`; they hang ~38s per page
  load. Never add `waitForLoadState('networkidle')` to this suite — it can never settle.
- A carrier already flagged down is reported as `EXPECTED (carrier flagged)`, not `ERROR`.
  Don't report those as regressions.
- **Pending routes:** `ARENAWAYS`, `CAMPANIA EXPRESS`, `SJ` have no confirmed OD yet.
  Re-run `node tools/discover-carriers.js` when they're up. `HEPSTAR` is excluded by
  design (insurance, not bookable).

## Reporting results

Read `report/msc-b2b.json`, `report/msc-api-searchability.md`, and the console summary
("RAIL EUROPE MSC — SANITY RUN SUMMARY"). Lead with:
- **Booking references** (K + 9 digits, one per order) — status reads `Created`, expected
- Sectors in cart and passes in cart, expired count (must be 0)
- **Carrier coverage** — covered/pending/excluded, and loudly if anything is `UNMAPPED`
- API PASS counts for staging and production
- Any connectivity flags (RED/unstable >15 min) with affected ODs — these need manual
  review (cross-check on Trainline, escalate per Critical Incident Management if
  confirmed); **never auto-escalate yourself**

Do **not** draft or send the daily team email — only report findings back to the user.
Do not treat a `storageState.json` expiry as a site outage. Don't present an unverified
guess as a finding: if something dead-ends, say so.
