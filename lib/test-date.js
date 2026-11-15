// The test date for a search: today + N days, but never a day with (almost) no train service.
//
// The default date moves with the calendar (+45 days), so it walks across the holidays. On 2026-11-10 it landed
// on 25 December: Eurostar and National Rail (RDG) run nothing that day, so every route of both carriers came
// back empty (HTTP 200, 0 products) in the API check AND in the browser, and both were reported as dropped.
// The run before (+45 = 24 December) lost Leo Express and the Saint Moritz-Chur route the same way.
// Measured with read-only LocoHub searches on 2026-11-10:
//   24 Dec: no Leo Express            25 Dec: no Eurostar, no RDG (26 Dec: no RDG either)
// So these days are skipped: the test date moves EARLIER to the last service day before the block (a date earlier than
// planned is always inside every carrier's booking window). Extend NO_SERVICE only for a day MEASURED empty.
// 1 January was in this list at first, unmeasured, and it was wrong: on 2026-11-15 it folded the third retry date of the
// non-daily European Sleeper (30 Dec, 31 Dec, 1 Jan) back onto 31 Dec, so the only day with trains was never tried and the
// sector was reported KO. Measured 2026-11-16: every carrier has trains on 1 Jan (European Sleeper 30/31 Dec and 2 Jan do not).
const NO_SERVICE = new Set(['12-24', '12-25', '12-26']);   // MM-DD, UTC date as used everywhere in this tool

/** YYYY-MM-DD, `daysAhead` from today, moved earlier while it falls on a no-service day. */
function testDate(daysAhead) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  let iso = d.toISOString().slice(0, 10);
  while (NO_SERVICE.has(iso.slice(5))) {
    d.setDate(d.getDate() - 1);
    iso = d.toISOString().slice(0, 10);
  }
  return iso;
}

module.exports = { testDate, NO_SERVICE };
