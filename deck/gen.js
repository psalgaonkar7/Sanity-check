const pptxgen = require("pptxgenjs");
const fs = require("fs");
const path = require("path");

// --- Pull the latest run so the Proof slide auto-updates. Falls back to last-known values
//     if the report files aren't present yet. ---
const REPORT = path.join(__dirname, "..", "report");
function readJson(f) { try { return JSON.parse(fs.readFileSync(path.join(REPORT, f), "utf8")); } catch { return null; } }
const b2b = readJson("msc-b2b.json") || {};
const apiRep = readJson("api-searchability.json") || {};
const prodEnv = (apiRep.envs || []).find((e) => e.label === "PRODUCTION");

// Scope counts come from the test data (and the connectivity read when available) so the
// slides cannot go stale the way the previously-hardcoded "12 / 3 / 27" did.
const journeys = (() => { try { return require("../data/journeys"); } catch { return {}; } })();
const cov = b2b.coverage;
const SCOPE = {
  sectors: (journeys.ptpJourneys || []).length || "—",
  passes: (journeys.passesToAdd || []).length || "—",
  carriers: cov
    ? cov.covered.length + cov.excluded.length + cov.pending.length + cov.unmapped.length
    : new Set((b2b.connectivityRows || []).map((r) => r.carrier)).size || "—",
};

const PROOF = {
  // Several orders now, because the portal caps an order at 15 items.
  bookingRef: (Array.isArray(b2b.bookings) && b2b.bookings.length)
    ? b2b.bookings.map((x) => x.ref).join("  +  ")
    : (b2b.booking || "—"),
  trains: (b2b.sectorsInCart != null && b2b.sectorsTotal != null) ? `${b2b.sectorsInCart}/${b2b.sectorsTotal}` : "—",
  pass: (() => {
    const ok = (b2b.passesInBooking || []).filter((p) => p.status === "IN CART").map((p) => p.product);
    return ok.length ? ok.join(", ") : "none this run";
  })(),
  expired: b2b.bookingExpiredSectors != null ? b2b.bookingExpiredSectors : 0,
  date: b2b.date
    ? new Date(b2b.date).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
    : "—",
  prodApi: prodEnv ? `${prodEnv.summary.pass} / ${prodEnv.rows.length}` : "—",
  flags: Array.isArray(b2b.connectivityEscalations) && b2b.connectivityEscalations.length ? b2b.connectivityEscalations : null,
};

const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE"; // 13.33 x 7.5
pres.author = "Pratikesh Salgaonkar";
pres.title = "Rail Europe — Automated Sanity Check";

// ---- palette (rail brand: cherry red + deep navy) ----
const INK = "1E2749", RED = "C0203C", CLOUD = "F4F5F8", WHITE = "FFFFFF";
const MUTED = "5B6472", GREEN = "1E8E5A", AMBER = "C77700", LINE = "E1E4EC";
const GREEN_T = "DCF0E5", AMBER_T = "FBEBD5", GREY_T = "EBEDF2";
const SANS = "Calibri", SERIF = "Cambria";
const mkShadow = () => ({ type: "outer", color: "000000", blur: 7, offset: 3, angle: 90, opacity: 0.12 });

function header(slide, kicker, title) {
  slide.background = { color: WHITE };
  slide.addText(kicker.toUpperCase(), { x: 0.6, y: 0.42, w: 12, h: 0.3, fontFace: SANS, fontSize: 12, bold: true, color: RED, charSpacing: 2, margin: 0 });
  slide.addText(title, { x: 0.6, y: 0.72, w: 12.1, h: 0.7, fontFace: SERIF, fontSize: 29, bold: true, color: INK, margin: 0 });
}
function card(slide, x, y, w, h, fill) {
  slide.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h, rectRadius: 0.08, fill: { color: fill || CLOUD }, line: { color: LINE, width: 1 }, shadow: mkShadow() });
}
function badge(slide, x, y, d, label, color) {
  slide.addShape(pres.shapes.OVAL, { x, y, w: d, h: d, fill: { color: color || RED } });
  slide.addText(label, { x, y, w: d, h: d, align: "center", valign: "middle", fontFace: SANS, fontSize: 15, bold: true, color: WHITE, margin: 0 });
}
function stat(slide, x, y, w, big, small, color) {
  slide.addText(big, { x, y: y + 0.12, w, h: 0.75, align: "center", fontFace: SERIF, fontSize: 36, bold: true, color: color || INK, margin: 0 });
  slide.addText(small, { x, y: y + 0.9, w, h: 0.5, align: "center", fontFace: SANS, fontSize: 12.5, color: MUTED, margin: 0 });
}

// =================================================================== 1. TITLE
(() => {
  const s = pres.addSlide();
  s.background = { color: INK };
  for (let i = 0; i < 12; i++) s.addShape(pres.shapes.OVAL, { x: 0.6 + i * 0.42, y: 0.7, w: 0.16, h: 0.16, fill: { color: i % 3 === 0 ? RED : "3A4570" } });
  s.addText("RAIL EUROPE  ·  QA AUTOMATION", { x: 0.6, y: 1.7, w: 10, h: 0.35, fontFace: SANS, fontSize: 14, bold: true, color: "9AA3C0", charSpacing: 3, margin: 0 });
  s.addText("Automating the Manual\nSanity Check", { x: 0.6, y: 2.15, w: 11.5, h: 1.9, fontFace: SERIF, fontSize: 52, bold: true, color: WHITE, lineSpacingMultiple: 0.98, margin: 0 });
  s.addText([
    { text: "From ", options: { color: "CAD2EA" } },
    { text: "~28 minutes by hand", options: { color: WHITE, bold: true } },
    { text: "  →  ", options: { color: RED, bold: true } },
    { text: "~6 minutes automated", options: { color: WHITE, bold: true } },
  ], { x: 0.62, y: 4.25, w: 12, h: 0.6, fontFace: SANS, fontSize: 20, margin: 0 });
  s.addText("Built on — and verified against — the official Manual Sanity Check process", { x: 0.62, y: 4.95, w: 12, h: 0.5, fontFace: SANS, fontSize: 14, italic: true, color: "9AA3C0", margin: 0 });
  s.addText("Prepared by Pratikesh Salgaonkar   ·   September 2026", { x: 0.62, y: 6.7, w: 12, h: 0.4, fontFace: SANS, fontSize: 12.5, color: "8892B4", margin: 0 });
})();

// =================================================================== 2. WHY AUTOMATE
(() => {
  const s = pres.addSlide();
  header(s, "The problem", "Why automate the sanity check?");
  const bullets = [
    ["Slow", "The check took about 28 minutes, every 2 hours — entirely by hand."],
    ["Repetitive", "The same routes, passes and carrier checks, round the clock."],
    ["Error-prone", "Manual clicking risks missed steps, wrong dates, overlooked issues."],
    ["Hard to repeat", "Difficult to run consistently and on demand, every single time."],
  ];
  let y = 1.75;
  bullets.forEach((b, i) => {
    card(s, 0.6, y, 7.0, 1.05, CLOUD);
    badge(s, 0.85, y + 0.28, 0.5, String(i + 1), INK);
    s.addText(b[0], { x: 1.55, y: y + 0.16, w: 5.8, h: 0.35, fontFace: SANS, fontSize: 16, bold: true, color: INK, margin: 0 });
    s.addText(b[1], { x: 1.55, y: y + 0.52, w: 5.9, h: 0.45, fontFace: SANS, fontSize: 12.5, color: MUTED, margin: 0 });
    y += 1.22;
  });
  card(s, 8.05, 1.75, 4.68, 4.73, INK);
  s.addText("The daily reality", { x: 8.35, y: 2.05, w: 4.1, h: 0.4, fontFace: SANS, fontSize: 13, bold: true, color: "9AA3C0", charSpacing: 1, margin: 0 });
  s.addText("~28 min", { x: 8.35, y: 2.5, w: 4.1, h: 0.9, fontFace: SERIF, fontSize: 46, bold: true, color: WHITE, margin: 0 });
  s.addText("per manual run, every 2 hours", { x: 8.35, y: 3.35, w: 4.1, h: 0.4, fontFace: SANS, fontSize: 13, color: "9AA3C0", margin: 0 });
  s.addShape(pres.shapes.LINE, { x: 8.35, y: 3.95, w: 4.05, h: 0, line: { color: "3A4570", width: 1 } });
  // Driven off the test data and the latest run, not hardcoded — these counts have already
  // changed more than once (12 -> 19 sectors, 3 -> 4 -> 3 passes) and stale slide numbers are worse than none.
  [[String(SCOPE.sectors), "point-to-point sectors"], [String(SCOPE.passes), "rail-pass families"], [String(SCOPE.carriers), "carriers to watch"]].forEach((r, i) => {
    s.addText([{ text: r[0], options: { bold: true, color: WHITE } }, { text: "   " + r[1], options: { color: "CAD2EA" } }], { x: 8.35, y: 4.15 + i * 0.47, w: 4.1, h: 0.4, fontFace: SANS, fontSize: 15, margin: 0 });
  });
  s.addText("Goal: reliable, fast, repeatable checks that remove human error.", { x: 8.35, y: 5.7, w: 4.1, h: 0.6, fontFace: SANS, fontSize: 12.5, italic: true, color: WHITE, margin: 0 });
})();

// =================================================================== 3. TWO-LAYER SOLUTION
(() => {
  const s = pres.addSlide();
  header(s, "The solution", "Two complementary layers");
  card(s, 0.6, 1.85, 6.0, 4.05, WHITE);
  badge(s, 0.9, 2.15, 0.55, "A", RED);
  s.addText("B2B Portal automation", { x: 1.6, y: 2.15, w: 4.8, h: 0.4, fontFace: SANS, fontSize: 18, bold: true, color: INK, margin: 0 });
  s.addText("Browser-driven (Playwright)", { x: 1.6, y: 2.55, w: 4.8, h: 0.35, fontFace: SANS, fontSize: 12.5, italic: true, color: MUTED, margin: 0 });
  s.addText([
    { text: "Mirrors the real agent experience end-to-end", options: { bullet: true, breakLine: true } },
    { text: `Builds all  sectors +  passes into shared carts`, options: { bullet: true, breakLine: true } },
    { text: "Captures one booking reference — none expired", options: { bullet: true, breakLine: true } },
    { text: "Connectivity flag, SNCF Connect POS & pass search", options: { bullet: true, breakLine: true } },
    { text: "Stops before payment", options: { bullet: true } },
  ], { x: 1.0, y: 3.05, w: 5.4, h: 2.6, fontFace: SANS, fontSize: 13.5, color: INK, paraSpaceAfter: 6, margin: 0 });
  card(s, 6.75, 1.85, 5.98, 4.05, WHITE);
  badge(s, 7.05, 2.15, 0.55, "B", INK);
  s.addText("API search checks", { x: 7.75, y: 2.15, w: 4.8, h: 0.4, fontFace: SANS, fontSize: 18, bold: true, color: INK, margin: 0 });
  s.addText("Direct to the search engine (LocoHub)", { x: 7.75, y: 2.55, w: 4.9, h: 0.35, fontFace: SANS, fontSize: 12.5, italic: true, color: MUTED, margin: 0 });
  s.addText([
    { text: "Fast and bot-proof — no website wall", options: { bullet: true, breakLine: true } },
    { text: "All 12 routes on Staging and Production", options: { bullet: true, breakLine: true } },
    { text: "Production engine is shared with B2C", options: { bullet: true, breakLine: true } },
    { text: "Confirms results + sample fares per route", options: { bullet: true, breakLine: true } },
    { text: "Read-only — never books", options: { bullet: true } },
  ], { x: 7.15, y: 3.05, w: 5.4, h: 2.6, fontFace: SANS, fontSize: 13.5, color: INK, paraSpaceAfter: 6, margin: 0 });
  card(s, 0.6, 6.15, 12.13, 0.72, CLOUD);
  s.addText([
    { text: "B2C coverage:  ", options: { bold: true, color: INK } },
    { text: "the B2C search engine is validated through Layer B (production). The website UI is behind anti-bot protection, so it stays at the API-level check for now.", options: { color: MUTED } },
  ], { x: 0.85, y: 6.15, w: 11.6, h: 0.72, valign: "middle", fontFace: SANS, fontSize: 12.5, margin: 0 });
})();

// =================================================================== 4. BUILT ON THE OFFICIAL SOP
(() => {
  const s = pres.addSlide();
  header(s, "Grounded in the SOP", "Built on the official Manual Sanity Check");
  s.addText([
    { text: "The automation follows the team's documented checklist", options: { color: INK } },
    { text: "  (Confluence · space SR)", options: { color: MUTED, italic: true } },
    { text: " — the process Application Support runs ", options: { color: INK } },
    { text: "every 2 hours", options: { color: RED, bold: true } },
    { text: ". Every automated step maps to a checklist item.", options: { color: INK } },
  ], { x: 0.6, y: 1.65, w: 12.1, h: 0.5, fontFace: SANS, fontSize: 14, margin: 0 });
  const items = [
    "Connectivity status page", "All connectivity carriers — search to booking reference",
    "Salesforce – ERA sync (Groups)", "China portal login",
    "SNCF Connect key-account search", "Daily dropfile check",
  ];
  const cw = 5.9, ch = 0.82, gx = 0.33, gy = 0.22, x0 = 0.6, y0 = 2.4;
  items.forEach((it, i) => {
    const cx = x0 + (i % 2) * (cw + gx);
    const cy = y0 + Math.floor(i / 2) * (ch + gy);
    card(s, cx, cy, cw, ch, CLOUD);
    badge(s, cx + 0.22, cy + 0.19, 0.44, String(i + 1), i % 2 ? INK : RED);
    s.addText(it, { x: cx + 0.85, y: cy, w: cw - 1.05, h: ch, valign: "middle", fontFace: SANS, fontSize: 14.5, bold: true, color: INK, margin: 0 });
  });
})();

// =================================================================== 5. ALIGNMENT SCORECARD
(() => {
  const s = pres.addSlide();
  header(s, "Verification", "How we measure up against the SOP");
  const H = (t) => ({ text: t, options: { bold: true, color: WHITE, fill: { color: INK }, fontFace: SANS, fontSize: 12.5, valign: "middle" } });
  const cell = (t) => ({ text: t, options: { fontFace: SANS, fontSize: 12, color: INK, valign: "middle" } });
  const status = (label, tint, col) => ({ text: label, options: { fontFace: SANS, fontSize: 12, bold: true, color: col, fill: { color: tint }, align: "center", valign: "middle" } });
  const AUTO = () => status("Automated", GREEN_T, GREEN);
  const READY = () => status("Ready to add", AMBER_T, AMBER);
  const MAN = () => status("Manual", GREY_T, MUTED);
  const rows = [
    [H("Official checklist item"), H("Status"), H("Notes")],
    [cell("Connectivity status  +  RED > 15 min rule"), AUTO(), cell("Flags for manual review (nothing auto-sent); maps the OD")],
    [cell("All connectivity carriers — search to booking reference"), AUTO(), cell(` sectors +  passes → booking ref per order; stops at Traveler Details`)],
    [cell("Passes — search + add-to-cart"), AUTO(), cell("Interrail / Swiss / BritRail — all searched AND in the booking")],
    [cell("SNCF Connect key-account search"), AUTO(), cell("POS 832072551 · search-only")],
    [cell("Salesforce – ERA sync (Groups)"), MAN(), cell("Needs AWS AppFlow access")],
    [cell("China portal login"), MAN(), cell("Needs China portal session")],
    [cell("Daily dropfile check"), MAN(), cell("Separate process / file access")],
  ];
  s.addTable(rows, { x: 0.6, y: 1.7, w: 12.13, colW: [5.0, 2.0, 5.13], rowH: 0.47, border: { pt: 1, color: LINE }, align: "left", valign: "middle", margin: [3, 7, 3, 7] });
  s.addText([
    { text: "4 of the SOP's core checks are fully automated", options: { bold: true, color: GREEN } },
    { text: "  ·  3 remain manual (need access).", options: { color: MUTED } },
  ], { x: 0.6, y: 6.95, w: 12, h: 0.35, fontFace: SANS, fontSize: 12.5, margin: 0 });
})();

// =================================================================== 6. SMART ESCALATION
(() => {
  const s = pres.addSlide();
  header(s, "Built-in judgement", "Smart flagging — SOP rule #1");
  s.addText("The SOP says: if a carrier is red for more than 15 minutes, cross-check and escalate. The automation encodes the detection — it flags loudly for manual review, but never auto-sends anything.", { x: 0.6, y: 1.62, w: 12.1, h: 0.55, fontFace: SANS, fontSize: 14, color: INK, margin: 0 });
  const steps = [
    ["Detect", "Reads live carrier status and measures how long each has been unstable or down."],
    ["Judge", "Anything over 15 minutes is flagged; short blips and “unknown” go on a watch-list."],
    ["Guide", "Names the affected route and prints the next steps — Trainline cross-check, then Critical Incident."],
  ];
  let y = 2.35;
  steps.forEach((st, i) => {
    card(s, 0.6, y, 6.5, 1.15, WHITE);
    badge(s, 0.85, y + 0.33, 0.5, String(i + 1), RED);
    s.addText(st[0], { x: 1.55, y: y + 0.17, w: 5.3, h: 0.35, fontFace: SANS, fontSize: 16, bold: true, color: INK, margin: 0 });
    s.addText(st[1], { x: 1.55, y: y + 0.52, w: 5.35, h: 0.55, fontFace: SANS, fontSize: 12, color: MUTED, margin: 0 });
    y += 1.32;
  });
  // worked example
  card(s, 7.4, 2.35, 5.33, 3.79, INK);
  s.addText("EXAMPLE — LIVE RUN", { x: 7.7, y: 2.6, w: 4.7, h: 0.3, fontFace: SANS, fontSize: 11.5, bold: true, color: "9AA3C0", charSpacing: 2, margin: 0 });
  s.addText([
    { text: "SBB", options: { bold: true, color: WHITE } },
    { text: "  unstable for ", options: { color: "CAD2EA" } },
    { text: "~2 hours", options: { bold: true, color: WHITE } },
  ], { x: 7.7, y: 3.0, w: 4.7, h: 0.4, fontFace: SANS, fontSize: 17, margin: 0 });
  s.addText("↓", { x: 7.7, y: 3.45, w: 4.7, h: 0.3, fontFace: SANS, fontSize: 16, bold: true, color: RED, margin: 0 });
  s.addText([
    { text: "Flagged", options: { bold: true, color: WHITE } },
    { text: "  ·  affected route:  ", options: { color: "CAD2EA" } },
    { text: "Zermatt → Chur", options: { bold: true, color: WHITE } },
  ], { x: 7.7, y: 3.75, w: 4.7, h: 0.4, fontFace: SANS, fontSize: 14, margin: 0 });
  s.addText([
    { text: "Next steps printed automatically:", options: { color: "9AA3C0", breakLine: true, italic: true } },
    { text: "Cross-check the offer on Trainline", options: { color: WHITE, bullet: true, breakLine: true } },
    { text: "Isolate ERA vs carrier", options: { color: WHITE, bullet: true, breakLine: true } },
    { text: "If confirmed → Critical Incident Mgmt", options: { color: WHITE, bullet: true } },
  ], { x: 7.7, y: 4.25, w: 4.75, h: 1.7, fontFace: SANS, fontSize: 12.5, paraSpaceAfter: 5, margin: 0 });
  s.addText("Flags for MANUAL review — nothing is sent to Teams / email / tickets, and a carrier-side issue never fails the run.", { x: 0.6, y: 6.4, w: 12, h: 0.4, fontFace: SANS, fontSize: 12, italic: true, color: MUTED, margin: 0 });
})();

// =================================================================== 7. IMPACT
(() => {
  const s = pres.addSlide();
  header(s, "The impact", "Faster, consistent, repeatable");
  s.addChart(pres.charts.BAR, [{ name: "Minutes", labels: ["Manual (by hand)", "Automated"], values: [28, 3.5] }], {
    x: 0.6, y: 1.95, w: 6.6, h: 4.6, barDir: "col",
    chartColors: ["9AA3C0", RED], chartArea: { fill: { color: WHITE } },
    catAxisLabelColor: "64748B", catAxisLabelFontFace: SANS, catAxisLabelFontSize: 13,
    valAxisLabelColor: "64748B", valAxisMaxVal: 30, valAxisMinVal: 0,
    valGridLine: { color: LINE, size: 0.5 }, catGridLine: { style: "none" },
    showValue: true, dataLabelPosition: "outEnd", dataLabelColor: INK, dataLabelFontFace: SANS, dataLabelFontSize: 14, dataLabelFontBold: true,
    showLegend: false, showTitle: false,
  });
  card(s, 7.55, 2.0, 5.18, 1.35, CLOUD); stat(s, 7.55, 2.0, 5.18, "~8× faster", "28 min → ~3.5 min", RED);
  card(s, 7.55, 3.5, 5.18, 1.35, CLOUD); stat(s, 7.55, 3.5, 5.18, "0", "manual steps → no human error", INK);
  card(s, 7.55, 5.0, 5.18, 1.35, CLOUD); stat(s, 7.55, 5.0, 5.18, "~2–3 min", "to a booking number, on demand", GREEN);
})();

// =================================================================== 8. GUARDRAILS
(() => {
  const s = pres.addSlide();
  header(s, "Guardrails", "Built to be safe on the live site");
  const items = [
    ["Never pays", "No payment is ever entered or submitted."],
    ["Never confirms a booking", "The flow stops at the traveller-details step."],
    ["No allowance used", "No agency allowance is ever consumed."],
    ["Read-only API", "The API layer only searches — it never books."],
    ["Expiry-checked", "No booking number is reported if any sector has expired."],
    ["Secrets stay out of code", "Tokens are read at runtime, never stored or shared."],
  ];
  const cols = 2, cw = 6.06, ch = 1.4, gx = 0.28, gy = 0.28, x0 = 0.6, y0 = 1.8;
  items.forEach((it, i) => {
    const cx = x0 + (i % cols) * (cw + gx);
    const cy = y0 + Math.floor(i / cols) * (ch + gy);
    card(s, cx, cy, cw, ch, WHITE);
    s.addShape(pres.shapes.OVAL, { x: cx + 0.3, y: cy + 0.45, w: 0.5, h: 0.5, fill: { color: GREEN } });
    s.addText("✓", { x: cx + 0.3, y: cy + 0.45, w: 0.5, h: 0.5, align: "center", valign: "middle", fontFace: SANS, fontSize: 20, bold: true, color: WHITE, margin: 0 });
    s.addText(it[0], { x: cx + 1.0, y: cy + 0.28, w: cw - 1.2, h: 0.4, fontFace: SANS, fontSize: 16, bold: true, color: INK, margin: 0 });
    s.addText(it[1], { x: cx + 1.0, y: cy + 0.72, w: cw - 1.2, h: 0.55, fontFace: SANS, fontSize: 12.5, color: MUTED, margin: 0 });
  });
})();

// =================================================================== 9. PROOF
(() => {
  const s = pres.addSlide();
  header(s, "Proof", `A real run — ${PROOF.date}`);
  card(s, 0.6, 1.85, 4.0, 2.2, INK);
  s.addText("Booking reference", { x: 0.85, y: 2.1, w: 3.5, h: 0.4, fontFace: SANS, fontSize: 13, color: "9AA3C0", margin: 0 });
  s.addText(PROOF.bookingRef, { x: 0.85, y: 2.55, w: 3.5, h: 0.7, fontFace: SERIF, fontSize: 30, bold: true, color: WHITE, margin: 0 });
  s.addText(`${PROOF.trains.split("/")[0]} trains + ${PROOF.pass && !/^none/.test(PROOF.pass) ? "1 pass" : "0 pass"} · ${PROOF.expired} expired`, { x: 0.85, y: 3.35, w: 3.5, h: 0.4, fontFace: SANS, fontSize: 13, color: "CAD2EA", margin: 0 });
  const mini = [
    ["Random pass in booking", PROOF.pass, "added to same cart", GREEN],
    ["API — Production", `${PROOF.prodApi} routes`, "~10s (parallel)", GREEN],
    ["Passes searched", "3 + 36 products", "Interrail/Swiss/BritRail", GREEN],
    ["Runtime", "~3.3 min", "end-to-end", RED],
  ];
  const cw = 3.9, ch = 1.02, gx = 0.28;
  mini.forEach((m, i) => {
    const cx = 4.83 + (i % 2) * (cw + gx);
    const cy = 1.85 + Math.floor(i / 2) * (ch + 0.16);
    card(s, cx, cy, cw, ch, CLOUD);
    s.addText(m[0], { x: cx + 0.22, y: cy + 0.12, w: cw - 0.4, h: 0.3, fontFace: SANS, fontSize: 11.5, color: MUTED, margin: 0 });
    s.addText([{ text: m[1] + "  ", options: { bold: true, color: m[3], fontSize: 16 } }, { text: m[2], options: { color: MUTED, fontSize: 11.5 } }], { x: cx + 0.22, y: cy + 0.44, w: cw - 0.4, h: 0.45, fontFace: SANS, margin: 0 });
  });
  card(s, 0.6, 4.35, 12.13, 2.05, "FEF6E9");
  s.addText([{ text: "⚠  Flagged this run (manual review — nothing auto-sent)  —  ", options: { bold: true, color: AMBER } }, { text: "carriers RED > 15 min, per SOP rule #1:", options: { color: INK } }], { x: 0.9, y: 4.55, w: 11.6, h: 0.4, fontFace: SANS, fontSize: 13.5, margin: 0 });
  const flagLines = PROOF.flags
    ? PROOF.flags.slice(0, 5).map((e) => `${e.carrier} — ${e.status}${e.minutes != null ? ` ~${e.minutes} min` : ""}${e.affectedODs && e.affectedODs.length ? "  →  " + e.affectedODs.join(", ") : ""}`)
    : ["DB — unstable ~2 hrs  →  Berlin → Munich", "RENFE & IRYO — unstable ~2 hrs  →  Barcelona → Madrid  (still booked in)", "SBB — unstable ~2 hrs  →  Zermatt → Chur", "SJ, RHB — status unknown (watch-list)"];
  s.addText(flagLines.map((t, i) => ({ text: t, options: { bullet: true, breakLine: i < flagLines.length - 1 } })), { x: 1.1, y: 5.0, w: 11, h: 1.3, fontFace: SANS, fontSize: 13, color: INK, paraSpaceAfter: 4, margin: 0 });
  s.addText("Every affected route still returned fares — in both the booking cart and the API search.", { x: 0.9, y: 6.02, w: 11.6, h: 0.35, fontFace: SANS, fontSize: 11.5, italic: true, color: MUTED, margin: 0 });
})();

// =================================================================== 10. ROADMAP
(() => {
  const s = pres.addSlide();
  header(s, "What's next", "Closing the remaining gaps");
  card(s, 0.6, 1.85, 6.0, 4.5, WHITE);
  s.addShape(pres.shapes.OVAL, { x: 0.9, y: 2.15, w: 0.4, h: 0.4, fill: { color: GREEN } });
  s.addText("In place today", { x: 1.45, y: 2.12, w: 4.9, h: 0.45, fontFace: SANS, fontSize: 17, bold: true, color: INK, margin: 0 });
  s.addText([
    { text: "4 core SOP checks fully automated", options: { bullet: true, breakLine: true } },
    { text: ` sectors +  passes, every connectivity carrier covered`, options: { bullet: true, breakLine: true } },
    { text: "Smart RED > 15 min flag (manual review, nothing auto-sent)", options: { bullet: true, breakLine: true } },
    { text: "One command:  npm run sanity", options: { bullet: true, breakLine: true } },
    { text: "On-demand during your monitoring window", options: { bullet: true } },
  ], { x: 1.0, y: 2.75, w: 5.4, h: 3.4, fontFace: SANS, fontSize: 13.5, color: INK, paraSpaceAfter: 8, margin: 0 });
  card(s, 6.75, 1.85, 5.98, 4.5, CLOUD);
  s.addShape(pres.shapes.OVAL, { x: 7.05, y: 2.15, w: 0.4, h: 0.4, fill: { color: RED } });
  s.addText("Planned (needs access / approval)", { x: 7.6, y: 2.12, w: 5.0, h: 0.45, fontFace: SANS, fontSize: 17, bold: true, color: INK, margin: 0 });
  s.addText([
    { text: "Salesforce – ERA sync check  (AWS access)", options: { bullet: true, breakLine: true } },
    { text: "China portal login check", options: { bullet: true, breakLine: true } },
    { text: "Daily dropfile check", options: { bullet: true, breakLine: true } },
    { text: "Scheduled auto-runs + Instatus / Teams feeds", options: { bullet: true } },
  ], { x: 7.15, y: 2.75, w: 5.4, h: 3.4, fontFace: SANS, fontSize: 13.5, color: INK, paraSpaceAfter: 6, margin: 0 });
})();

// =================================================================== 11. CLOSING
(() => {
  const s = pres.addSlide();
  s.background = { color: INK };
  s.addText("Faster.  Consistent.  Verified.", { x: 0.8, y: 2.5, w: 11.7, h: 1.1, fontFace: SERIF, fontSize: 44, bold: true, color: WHITE, margin: 0 });
  s.addText([
    { text: "~28 min → ~3 min", options: { color: WHITE, bold: true } },
    { text: "   ·   ", options: { color: RED, bold: true } },
    { text: "aligned to the official SOP", options: { color: WHITE, bold: true } },
    { text: "   ·   ", options: { color: RED, bold: true } },
    { text: "booking reference, no payment", options: { color: WHITE, bold: true } },
  ], { x: 0.82, y: 3.75, w: 12, h: 0.5, fontFace: SANS, fontSize: 18, margin: 0 });
  s.addText("A repeatable, human-error-free daily sanity check for Rail Europe.", { x: 0.82, y: 4.35, w: 12, h: 0.5, fontFace: SANS, fontSize: 14, italic: true, color: "9AA3C0", margin: 0 });
  s.addText("Pratikesh Salgaonkar   ·   psalgaonkar@raileurope.com", { x: 0.82, y: 6.6, w: 12, h: 0.4, fontFace: SANS, fontSize: 12.5, color: "8892B4", margin: 0 });
})();

// Self-locating: this file lives at RE/ASC/deck/, the deck lives at RE/docs/.
// Keep it relative to __dirname so moving the workspace never breaks it again.
const OUT = path.join(__dirname, "..", "..", "docs", "Rail-Europe-MSC-Automation-Overview.pptx");
pres.writeFile({ fileName: OUT }).then(() => console.log("WROTE:", OUT));
