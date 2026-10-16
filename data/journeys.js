// Test data for the MSC. `q` = what to type into the autocomplete; `opt` = the exact
// suggestion text to click. Adjust `opt` strings if the portal's wording changes.
//
// COVERAGE MODEL — read this before adding a journey.
// The goal is that every carrier on the B2B connectivity (health-center) page is genuinely
// exercised. Three fields make that provable rather than assumed:
//
//   connectivityNames  the EXACT health-center names this journey proves. Nothing is inferred
//                      from the `carrier` label any more — fuzzy matching used to make
//                      "EUROPEAN SLEEPER" match nothing and "DBSNCF" match both DB and SNCF.
//   carrierSlug        prefix of the results-page `data-select="ptp-carrier-logo-<slug>"`.
//                      Used to add THAT carrier's fare instead of whatever is listed first —
//                      without it, Barcelona->Madrid only ever tested one of RENFE/IRYO/OUIGO.
//                      Matched as a PREFIX so sub-brands are picked up automatically
//                      (rdg_avanti_west_coast / rdg_lumo / rdg_scotrail all satisfy `rdg`).
//   fromCode/toCode    LocoHub station codes, so api-searchability.js can derive its route
//                      list from here instead of keeping a second hand-maintained copy.
//
// Slugs below were observed live via `node tools/discover-carriers.js` — not guessed.
// Several carriers are brand-labelled rather than operator-labelled (SNCF sells as
// `tgvinoui`, DB as `dbahn`, TRENITALIA as `trenitalia_frecciarossa`); prefix matching is
// what makes those provable.

// Shorthand for a fallback route. `opt` is matched as a case-insensitive SUBSTRING of the
// autocomplete suggestion, so short city names here match e.g. "Salzburg Hbf, Austria".
const R = (fq, fo, fc, tq, to_, tc) => ({ from: { q: fq, opt: fo }, to: { q: tq, opt: to_ }, fromCode: fc, toCode: tc });

const DATA = {
  // ~45 days out keeps us well inside every carrier's booking horizon and your ">=7 days" rule.
  // Overridable with env var MSC_DAYS_AHEAD.
  daysAhead: Number(process.env.MSC_DAYS_AHEAD || 45),

  pos: {
    default: 'ERA-INTERNAL-TEST',     // account 556680 (the default Test Profile)
    sncfConnect: '832072551',          // KA-RESAS-EUROPE-FRANCE (SNCF Connect agency)
  },

  ptpJourneys: [
    { id: 1,  carrier: 'OBB',              connectivityNames: ['OBB'],              carrierSlug: 'obb',
      fromCode: 'AT:vienna', toCode: 'DE:munich',
      from: { q: 'Vienna',    opt: 'Vienna, Austria' },                       to: { q: 'Munich',    opt: 'Munich Hbf, Germany' } },
    { id: 2,  carrier: 'DB',               connectivityNames: ['DB'],               carrierSlug: 'dbahn',
      fromCode: 'DE:berlin', toCode: 'DE:munich',
      from: { q: 'Berlin',    opt: 'Berlin, Germany' },                       to: { q: 'Munich',    opt: 'Munich Hbf, Germany' } },
    // Paris->Stuttgart is the Alleo (DB/SNCF joint venture) route. Discovery showed slugs
    // dbahn, dbahn_intercity_express, dbsncf and tgvinoui here — but NOT `ter`, so TER needs
    // its own sector (id 18) rather than riding along on this one as the old label implied.
    { id: 3,  carrier: 'DBSNCF (Alleo)',   connectivityNames: ['DBSNCF'],           carrierSlug: 'dbsncf',
      fromCode: 'FR:paris', toCode: 'DE:stuttgart',
      from: { q: 'Paris',     opt: 'Paris (All stations), France' },          to: { q: 'Stuttgart', opt: 'Stuttgart, Germany' } },
    { id: 4,  carrier: 'EUROSTAR',         connectivityNames: ['EUROSTAR'],         carrierSlug: 'eurostar',
      fromCode: 'GB:london', toCode: 'FR:paris',
      from: { q: 'London',    opt: 'London St. Pancras International, UK' },  to: { q: 'Paris',     opt: 'Paris (All stations), France' } },
    { id: 5,  carrier: 'LYRIA',            connectivityNames: ['LYRIA'],            carrierSlug: 'lyria',
      fromCode: 'CH:geneva', toCode: 'FR:paris',
      from: { q: 'Geneva',    opt: 'Geneva, Switzerland' },                   to: { q: 'Paris',     opt: 'Paris (All stations), France' } },
    { id: 6,  carrier: 'RDG',              connectivityNames: ['RDG'],              carrierSlug: 'rdg',
      fromCode: 'GB:edinburgh', toCode: 'GB:london',
      from: { q: 'Edinburgh', opt: 'Edinburgh (Waverley, city centre), UK' }, to: { q: 'London',    opt: 'London (All stations), UK' } },
    { id: 7,  carrier: 'SNCB',             connectivityNames: ['SNCB'],             carrierSlug: 'sncb',
      fromCode: 'BE:brussels_midi', toCode: 'BE:mons',
      from: { q: 'Bruxelles', opt: 'Bruxelles/Brussels-Midi, Belgium' },      to: { q: 'Mons',      opt: 'Mons, Belgium' } },
    // Barcelona->Madrid genuinely returns THREE carriers. One entry each so all three are
    // actually added to the cart; previously the first-listed fare won and two went untested.
    { id: 8,  carrier: 'RENFE',            connectivityNames: ['RENFE'],            carrierSlug: 'renfe',
      fromCode: 'ES:barcelona_sants', toCode: 'ES:madrid_atocha',
      from: { q: 'Barcelona', opt: 'Barcelona Sants, Spain' },                to: { q: 'Madrid',    opt: 'Madrid-Puerta De Atocha, Spain' } },
    { id: 9,  carrier: 'IRYO',             connectivityNames: ['IRYO'],             carrierSlug: 'iryo',
      fromCode: 'ES:barcelona_sants', toCode: 'ES:madrid_atocha',
      from: { q: 'Barcelona', opt: 'Barcelona Sants, Spain' },                to: { q: 'Madrid',    opt: 'Madrid-Puerta De Atocha, Spain' } },
    { id: 10, carrier: 'OUIGO',            connectivityNames: ['OUIGO'],            carrierSlug: 'ouigo',
      fromCode: 'ES:barcelona_sants', toCode: 'ES:madrid_atocha',
      from: { q: 'Barcelona', opt: 'Barcelona Sants, Spain' },                to: { q: 'Madrid',    opt: 'Madrid-Puerta De Atocha, Spain' } },
    // Zermatt->Chur was replaced: it returns ZERO results (verified live under a real login —
    // the portal answers "Sorry, there is no result corresponding to your search"), so it could
    // never prove anything. St Moritz->Chur is the RhB core line and does return inventory.
    //
    // carrierSlug is 'sbb', NOT 'rhb', deliberately: this portal has no `rhb` slug at all.
    // Four RhB-operated routes were checked (Zermatt->Chur, St Moritz->Chur, Chur->Tirano and
    // St Moritz->Tirano, the last two being the Bernina line) and every one returns SBB-branded
    // inventory — sbb_regioexpress / sbb_interregio / sbb_regio / sbb_panoramaexpress. So RHB is
    // covered only INDIRECTLY: we prove the RhB-operated route sells, not that an "RHB" carrier
    // is distinguishable. Do not "fix" this by inventing an rhb slug — there isn't one.
    //
    // apiSkipEnvs: STAGING holds NO Swiss domestic inventory whatsoever — verified directly,
    // Zurich->Bern, Geneva->Zurich, Basel->Zurich, Chur->Tirano and Zermatt->Chur all return 0
    // products there, while Geneva->Paris (international) passes. So the API check skips this
    // OD on staging with that reason instead of reporting a permanent red that says nothing
    // about whether search works. Production still tests it properly (5 products).
    { id: 11, carrier: 'RHB/SBB',          connectivityNames: ['RHB', 'SBB'],       carrierSlug: 'sbb',
      apiSkipEnvs: ['STAGING'],
      fromCode: 'CH:st_moritz', toCode: 'CH:chur',
      from: { q: 'Saint Moritz', opt: 'Saint Moritz, Switzerland' },          to: { q: 'Chur',      opt: 'Chur, Switzerland' } },
    // REJE and RJET are two RegioJet connectors that the results page renders with the SAME
    // `regiojet` logo — but the LocoHub API distinguishes them by route (Prague->Brno returns
    // REJE, Wien->Gyor returns RJET), so keeping both ODs is what actually covers both.
    { id: 12, carrier: 'RegioJet (REJE)',  connectivityNames: ['REJE'],             carrierSlug: 'regiojet',
      fromCode: 'CZ:prague', toCode: 'CZ:brno',
      from: { q: 'Prague',    opt: 'Praha hl.n, Czechia' },                   to: { q: 'Brno',      opt: 'Brno hl.n., Czechia' } },
    { id: 13, carrier: 'RegioJet (RJET)',  connectivityNames: ['RJET'],             carrierSlug: 'regiojet',
      fromCode: 'AT:wien_hbf', toCode: 'HU:gyor',
      from: { q: 'Wien',      opt: 'Wien Hbf, Austria' },                     to: { q: 'Gyor',      opt: 'Gyor, Hungary' } },
    { id: 14, carrier: 'TRENITALIA',       connectivityNames: ['TRENITALIA'],       carrierSlug: 'trenitalia',
      fromCode: 'IT:rome', toCode: 'IT:milan',
      from: { q: 'Rome',      opt: 'Rome, Italy' },                           to: { q: 'Milan',     opt: 'Milano Centrale, Italy' } },
    { id: 15, carrier: 'ITALO',            connectivityNames: ['ITALO'],            carrierSlug: 'italo',
      fromCode: 'IT:rome', toCode: 'IT:milan',
      from: { q: 'Rome',      opt: 'Rome, Italy' },                           to: { q: 'Milan',     opt: 'Milano Centrale, Italy' } },

    // ---- added to close connectivity-page coverage gaps (slugs confirmed by discovery) ----
    // Bruxelles->Amsterdam was replaced: it returns results but never the european_sleeper logo
    // (only sncb + eurostar), so the sector always failed as "carrier not offered". European
    // Sleeper's Brussels-Amsterdam-Berlin night train IS sold on the Berlin leg — verified live:
    // Bruxelles->Berlin returns 19 results including the european_sleeper logo.
    // nonDaily: this is a night train that does NOT run every night — on the Brussels-Berlin
    // axis it does not run on Saturdays. Verified 2026-09-16 against production over 14
    // consecutive dates: offered on 12, and the only two misses were both Saturdays. All three
    // routes below DO sell it on a service day (re-verified on Mon/Wed/Fri), so an alternate
    // ROUTE is no help here — when the service is not running they all fail together, which is
    // exactly what dropped this sector on 2026-09-16 (travel date landed on Sat 31 Oct).
    // The booking test therefore retries the whole route list on the next 2 days for nonDaily
    // carriers. Do not "fix" this by adding more routes; the axis is not the problem.
    { id: 16, carrier: 'EUROPEAN SLEEPER', connectivityNames: ['EUROPEAN SLEEPER'], carrierSlug: 'european_sleeper',
      nonDaily: true,
      fromCode: 'BE:brussels_midi', toCode: 'DE:berlin',
      from: { q: 'Bruxelles', opt: 'Bruxelles/Brussels-Midi, Belgium' },      to: { q: 'Berlin',    opt: 'Berlin, Germany' } },
    { id: 17, carrier: 'LEO EXPRESS',      connectivityNames: ['LEO EXPRESS'],      carrierSlug: 'leo_express',
      fromCode: 'CZ:prague', toCode: 'CZ:ostrava',
      from: { q: 'Prague',    opt: 'Praha hl.n, Czechia' },                   to: { q: 'Ostrava',   opt: 'Ostrava, Czechia' } },
    // carrierSlug is null because French regional services carry NO carrier logo in the results
    // at all. Checked live: Paris->Rouen and Lyon->Grenoble both return real fares with an empty
    // logo set, and Marseille->Nice shows only tgvinoui. The `ter` slug seen once during
    // discovery (on Geneva->Paris, a Lyria route) does not reappear on domestic TER routes.
    // So this sector proves the route sells; it does NOT prove a carrier called TER served it.
    // Treat TER's coverage as indirect, the same as RHB above, and do not claim otherwise.
    //
    // apiSkipEnvs: STAGING carries no French REGIONAL inventory either — Paris->Rouen and
    // Lyon->Grenoble both return 0 products there while Paris->Bordeaux (TGV, same country)
    // returns 9, and production returns 6 for both TER routes. Same class of environment data
    // gap as the Swiss domestic one above, so it is declared rather than reported as a failure.
    { id: 18, carrier: 'TER (regional, unbranded)', connectivityNames: ['TER'],      carrierSlug: null,
      apiSkipEnvs: ['STAGING'],
      // FR:rouen does not exist as a searchable code (LocoHub answers HTTP 422); the real
      // station is FR:rouen_rive_droite, matching the browser's "Rouen-Rive-Droite" option.
      fromCode: 'FR:paris', toCode: 'FR:rouen_rive_droite',
      from: { q: 'Paris',     opt: 'Paris (All stations), France' },          to: { q: 'Rouen',     opt: 'Rouen-Rive-Droite, France' } },
    // SNCF has no `sncf` logo — it sells as TGV INOUI, so that brand slug is the proof.
    { id: 19, carrier: 'SNCF (TGV INOUI)', connectivityNames: ['SNCF'],             carrierSlug: 'tgvinoui',
      fromCode: 'FR:paris', toCode: 'FR:bordeaux',
      from: { q: 'Paris',     opt: 'Paris (All stations), France' },          to: { q: 'Bordeaux',  opt: 'Bordeaux, France' } },
  ],

  // Carriers on the connectivity page that are deliberately NOT booked, with the reason.
  // Listed explicitly so the coverage check can tell "knowingly excluded" from "we forgot".
  connectivityOnly: [
    { carrier: 'HEPSTAR', reason: 'insurance service, not a bookable rail product' },
  ],

  // Carriers still awaiting a confirmed origin-destination. They were down, unknown, or simply
  // did not appear on the route tried during discovery, so no OD is asserted rather than
  // guessing one. Re-run `node tools/discover-carriers.js` once they are up.
  pendingDiscovery: [
    { carrier: 'ARENAWAYS',        note: 'no logo on Torino->Milan or Torino->Savona (both return trenitalia/italo only). May not be sold on this portal at all — worth confirming with the provider team before hunting more routes.' },
    { carrier: 'CAMPANIA EXPRESS', note: 'Napoli Centrale->Sorrento returns a genuine zero-result; Napoli Centrale->Pompei returns only a trenitalia logo. No campania* slug seen on any route tried.' },
    { carrier: 'SJ',               note: 'Stockholm->Gothenburg Central and Stockholm->Malmo both return a genuine zero-result (correct stations selected, verified live). No sj slug seen yet.' },
  ],

  // Rail passes to validate (search-only). The PASSES tab is destination-based:
  //  - "Europe" returns both Eurail AND Interrail Global Passes (brand shown depends on market/POS).
  //  - "Switzerland" returns the Swiss Travel Pass family.
  //  - "United Kingdom" returns the BritRail family (the dropdown has no "Great Britain" entry —
  //    that guess is what made the first BritRail attempt time out).
  passChecks: [
    // Eurail expectation removed 2026-09-13. The Eurail BRAND was retired and replaced by
    // Interrail in era-offers-passes 1.642.0 (prod 2026-09-10 07:23 UTC) — confirmed intended
    // by Gaëtan Guillet, who owns the release. Do NOT add /eurail global/i back: it is not a
    // missing product, it no longer exists. See the Eurail note in README.md.
    { destination: 'Europe',        label: 'Interrail Global Pass',          mustInclude: [/interrail global/i] },
    { destination: 'Switzerland',   label: 'Swiss Travel Pass',              mustInclude: [/swiss travel pass/i] },
    { destination: 'United Kingdom', label: 'BritRail Pass',                  mustInclude: [/britrail/i] },
  ],

  // Rail passes added to the SAME B2B cart alongside every sector (used by the booking test,
  // not the search-only passChecks above). productMatch picks the specific product out of a
  // destination's multiple results (Continuous/Flex variants) — first match wins.
  // `connectivityNames` ties each pass back to the Passes inventories section of the
  // health-center page, whose SBB/TRENITALIA entries are separate from the point-to-point ones.
  passesToAdd: [
    // The Eurail Global Pass entry was removed 2026-09-13: the brand is retired, not broken.
    // `EURAIL` still has its own line in the Passes inventories section of the health-center
    // page (reporting "is up"), so its coverage moves HERE rather than being deleted —
    // otherwise the coverage guard would correctly report EURAIL as UNMAPPED. The Interrail
    // Global Pass is what that inventory line now actually sells, so buying it is what proves
    // the line works. Remove `EURAIL` from here only once it stops appearing on that page.
    { destination: 'Europe',        productMatch: /interrail global/i,  label: 'Interrail Global Pass', connectivityNames: ['EURAIL'] },
    { destination: 'Switzerland',   productMatch: /swiss travel pass/i, label: 'Swiss Travel Pass',     connectivityNames: ['SBB'] },
    { destination: 'United Kingdom', productMatch: /britrail/i,          label: 'BritRail Pass',         connectivityNames: ['BRITRAIL'] },
  ],

  // SNCF Connect POS test: search-only validation (no booking) for these 3 ODs.
  // `connectivityNames` is carried here too so a POS failure caused by a carrier that is
  // ALREADY flagged down (Zermatt->Chur whenever SBB is out) is reported as an expected
  // outage rather than failing the POS check and reading as an SNCF-Connect regression.
  // `alternates` here work the same way as for the sectors: the POS check only reports a
  // failure once every route for that OD has failed. Zermatt->Chur is kept as the primary
  // because it mirrors the official MSC sheet, but it returns a genuine zero-result, so the
  // St Moritz->Chur fallback is what actually proves SNCF Connect can sell Swiss rail.
  sncfPosJourneys: [
    { connectivityNames: ['DB'],          from: { q: 'Berlin',  opt: 'Berlin, Germany' },              to: { q: 'Munich',    opt: 'Munich Hbf, Germany' },
      alternates: [R('Frankfurt', 'Frankfurt', 'DE:frankfurt_am_main_hbf', 'Berlin', 'Berlin', 'DE:berlin')] },
    { connectivityNames: ['RHB', 'SBB'],  from: { q: 'Zermatt', opt: 'Zermatt, Switzerland' },         to: { q: 'Chur',      opt: 'Chur, Switzerland' },
      alternates: [R('Saint Moritz', 'Saint Moritz', 'CH:st_moritz', 'Chur', 'Chur', 'CH:chur'),
                   R('Chur', 'Chur', 'CH:chur', 'Tirano', 'Tirano', 'IT:tirano')] },
    { connectivityNames: ['DBSNCF'],      from: { q: 'Paris',   opt: 'Paris (All stations), France' }, to: { q: 'Stuttgart', opt: 'Stuttgart, Germany' },
      alternates: [R('Paris', 'Paris (All stations)', 'FR:paris', 'Frankfurt', 'Frankfurt', 'DE:frankfurt_am_main_hbf')] },
  ],
};

// ---------------------------------------------------------------------------------------
// FALLBACK ROUTES, keyed by journey id and tried IN ORDER when the primary route fails.
//
// Why: a single route can be empty for reasons that say nothing about whether the carrier or
// the search works — a seasonal gap, a timetable change, engineering works on that specific
// day. Before this, one such route turned the whole run red (Zermatt->Chur did exactly that
// for weeks). Now a sector is only reported as failed once EVERY route for that carrier has
// failed, which is the honest signal: "this carrier is not sellable anywhere we know to look".
//
// Every OD below was verified against the LocoHub production API and returned products; the
// carrier names in the comments are the ones the API actually reported, not assumptions.
// `opt` is matched as a case-insensitive SUBSTRING of the autocomplete suggestion, so the
// short city names here match e.g. "Salzburg Hbf, Austria".
// ---------------------------------------------------------------------------------------

const ALTERNATES = {
  1:  [R('Vienna','Vienna','AT:vienna','Salzburg','Salzburg','AT:salzburg'),                       // Railjet/Intercity
       R('Vienna','Vienna','AT:vienna','Graz','Graz','AT:graz')],
  2:  [R('Frankfurt','Frankfurt','DE:frankfurt_am_main_hbf','Berlin','Berlin','DE:berlin'),
       R('Hamburg','Hamburg','DE:hamburg','Munich','Munich','DE:munich')],
  3:  [R('Paris','Paris (All stations)','FR:paris','Frankfurt','Frankfurt','DE:frankfurt_am_main_hbf'), // TGV INOUI + ICE
       R('Paris','Paris (All stations)','FR:paris','Munich','Munich','DE:munich')],
  4:  [R('London','London','GB:london','Bruxelles','Bruxelles','BE:brussels_midi'),
       R('London','London','GB:london','Amsterdam','Amsterdam','NL:amsterdam')],
  5:  [R('Lausanne','Lausanne','CH:lausanne','Paris','Paris (All stations)','FR:paris'),           // Lyria
       R('Basel','Basel','CH:basel','Paris','Paris (All stations)','FR:paris')],                   // Lyria
  6:  [R('London','London','GB:london','Manchester','Manchester','GB:manchester'),                 // Avanti West Coast
       R('London','London','GB:london','Birmingham','Birmingham','GB:birmingham')],
  7:  [R('Bruxelles','Bruxelles','BE:brussels_midi','Antwerp','Antwerp','BE:antwerpen_centraal'),
       R('Bruxelles','Bruxelles','BE:brussels_midi','Liege','Liege','BE:liege_guillemins')],
  8:  [R('Madrid','Madrid','ES:madrid','Seville','Sevilla','ES:sevilla_santa_justa'),              // Renfe
       R('Madrid','Madrid','ES:madrid','Valencia','Valencia','ES:valencia')],
  9:  [R('Madrid','Madrid','ES:madrid','Seville','Sevilla','ES:sevilla_santa_justa'),              // IRYO
       R('Madrid','Madrid','ES:madrid','Valencia','Valencia','ES:valencia')],
  10: [R('Madrid','Madrid','ES:madrid','Seville','Sevilla','ES:sevilla_santa_justa')],             // OUIGO ESP
  11: [R('Chur','Chur','CH:chur','Tirano','Tirano','IT:tirano'),                                   // Bernina line
       R('Saint Moritz','Saint Moritz','CH:st_moritz','Tirano','Tirano','IT:tirano')],
  12: [R('Brno','Brno hl.n.','CZ:brno_hl_n','Ostrava','Ostrava','CZ:ostrava')],                               // REJE
  13: [R('Wien','Wien Hbf','AT:wien_hbf','Budapest','Budapest','HU:budapest'),                     // RJET
       R('Wien','Wien Hbf','AT:wien_hbf','Brno','Brno hl.n.','CZ:brno_hl_n')],                                // RJET
  14: [R('Milan','Milano Centrale','IT:milano_centrale','Naples','Napoli Centrale','IT:napoli_centrale'), // Trenitalia
       R('Rome','Rome','IT:rome','Florence','Florence','IT:florence')],
  15: [R('Milan','Milano Centrale','IT:milano_centrale','Naples','Napoli Centrale','IT:napoli_centrale'), // Italo
       R('Rome','Rome','IT:rome','Florence','Florence','IT:florence')],
  16: [R('Amsterdam','Amsterdam','NL:amsterdam','Berlin','Berlin','DE:berlin'),
       R('Bruxelles','Bruxelles','BE:brussels_midi','Prague','Praha','CZ:prague')],
  17: [R('Prague','Praha','CZ:prague','Olomouc','Olomouc','CZ:olomouc_hl_n'),                      // LEXP
       R('Prague','Praha','CZ:prague','Bohumin','Bohumin','CZ:bohumin')],                          // LEXP
  18: [R('Lyon','Lyon','FR:lyon','Grenoble','Grenoble','FR:grenoble'),                             // TER
       R('Paris','Paris (All stations)','FR:paris','Chartres','Chartres','FR:chartres')],          // TER
  19: [R('Paris','Paris (All stations)','FR:paris','Lyon','Lyon','FR:lyon'),                       // TGV INOUI
       R('Paris','Paris (All stations)','FR:paris','Marseille','Marseille','FR:marseille')],
};

// ---------------------------------------------------------------------------------------
// TIER-2 fallbacks — appended after the ALTERNATES above, so the try-order per carrier is:
//   primary -> ALTERNATES -> VERIFIED_EXTRA
//
// Every OD here was validated against LocoHub PRODUCTION on 2026-09-10 and kept ONLY when the
// response carried that carrier's OWN BRAND (search_connection.transport_name). Matching on
// `provider` is NOT enough: it names the aggregator, not the carrier — SNCF sells through PAO,
// RDG through Atomised, Trenitalia through PICO, RegioJet and Leo Express BOTH through
// Distribusion. `attributes.carrier` is null on most responses; do not use it.
//
// Rejected by that same check, so deliberately absent (re-test before ever adding):
//   #3  Paris->Strasbourg   domestic TGV INOUI only, no DB leg — not an Alleo route
//   #11 St Moritz->Zermatt, Chur->Zermatt   0 products (Glacier Express not sold this way)
//   #13 Wien->Bratislava    OBB Regional Express only, no RegioJet
//   #16 EUROPEAN SLEEPER    Amsterdam->Prague / ->Dresden / Bruxelles->Dresden all return
//                           DBahn day trains, never the sleeper. No verified 4th route yet.
//   #17 Prague->Kosice      RegioJet only, no Leo Express
//   CAMPANIA EXPRESS        Naples->Sorrento and Porta Nolana->Sorrento return 0 products;
//                           Naples->Pompei is Trenitalia. Stays in pendingDiscovery.
//
// Accented/renamed stations (Malaga, Koln) are avoided on purpose: the browser autocomplete
// matches `opt` as a substring, so "Malaga" never matches "Malaga-Maria Zambrano".
// ---------------------------------------------------------------------------------------
const VERIFIED_EXTRA = {
  1:  [R('Vienna','Vienna','AT:vienna','Innsbruck','Innsbruck Hbf','AT:innsbruck_hbf'),                // Railjet Xpress
       R('Vienna','Vienna','AT:vienna','Linz','Linz Hbf','AT:linz_hbf'),                               // Railjet Xpress / IC
       R('Salzburg','Salzburg','AT:salzburg','Innsbruck','Innsbruck Hbf','AT:innsbruck_hbf')],         // Railjet Xpress
  2:  [R('Munich','Munich','DE:munich','Frankfurt','Frankfurt','DE:frankfurt_am_main_hbf'),        // ICE
       R('Berlin','Berlin','DE:berlin','Hamburg','Hamburg','DE:hamburg')],                         // ICE
  3:  [R('Frankfurt','Frankfurt','DE:frankfurt_am_main_hbf','Paris','Paris (All stations)','FR:paris'), // ICE + TGV (Alleo)
       R('Stuttgart','Stuttgart','DE:stuttgart','Paris','Paris (All stations)','FR:paris')],       // TGV INOUI + ICE
  4:  [R('London','London','GB:london','Rotterdam','Rotterdam','NL:rotterdam'),                    // Eurostar
       R('Paris','Paris (All stations)','FR:paris','London','London','GB:london'),                 // Eurostar
       R('London','London','GB:london','Lille','Lille','FR:lille_europe')],                        // Eurostar
  5:  [R('Zurich','Zurich','CH:zurich','Paris','Paris (All stations)','FR:paris'),                 // Lyria
       R('Paris','Paris (All stations)','FR:paris','Geneva','Geneva','CH:geneva'),                 // Lyria
       R('Paris','Paris (All stations)','FR:paris','Lausanne','Lausanne','CH:lausanne')],          // Lyria
  6:  [R('London','London','GB:london','Glasgow','Glasgow','GB:glasgow'),                          // Avanti West Coast
       R('London','London','GB:london','York','York','GB:york'),                                   // LNER / Hull Trains
       R('Manchester','Manchester','GB:manchester','London','London','GB:london')],                // Avanti West Coast
  7:  [R('Bruxelles','Bruxelles','BE:brussels_midi','Gent','Gent','BE:gent_st_pieters'),           // SNCB Intercity
       R('Bruxelles','Bruxelles','BE:brussels_midi','Bruges','Bruges','BE:brugge_st_pieters'),     // SNCB Intercity
       R('Antwerp','Antwerp','BE:antwerpen_centraal','Bruxelles','Bruxelles','BE:brussels_midi')], // SNCB Intercity
  8:  [R('Madrid','Madrid','ES:madrid_atocha','Barcelona','Barcelona','ES:barcelona_sants'),       // AVE
       R('Barcelona','Barcelona','ES:barcelona_sants','Valencia','Valencia','ES:valencia')],       // Euromed / Intercity
  9:  [R('Madrid','Madrid','ES:madrid_atocha','Barcelona','Barcelona','ES:barcelona_sants'),       // Iryo
       R('Madrid','Madrid','ES:madrid','Zaragoza','Zaragoza','ES:zaragoza_delicias')],             // Iryo
  10: [R('Madrid','Madrid','ES:madrid','Valencia','Valencia','ES:valencia_joaquin_sorolla'),       // OUIGO ESP
       R('Madrid','Madrid','ES:madrid_atocha','Barcelona','Barcelona','ES:barcelona_sants'),       // OUIGO ESP
       R('Madrid','Madrid','ES:madrid','Alicante','Alicante','ES:alicante')],                      // OUIGO ESP
  11: [R('Chur','Chur','CH:chur','Saint Moritz','Saint Moritz','CH:st_moritz')],                     // RhB (sold as SBB)
  12: [R('Prague','Praha','CZ:prague','Ostrava','Ostrava','CZ:ostrava_hl_n'),                      // RegioJet
       R('Prague','Praha','CZ:prague','Olomouc','Olomouc','CZ:olomouc_hl_n'),                      // RegioJet
       R('Brno','Brno hl.n.','CZ:brno_hl_n','Prague','Praha','CZ:prague')],                              // RegioJet
  13: [R('Budapest','Budapest','HU:budapest','Wien','Wien Hbf','AT:wien_hbf'),                     // RegioJet
       R('Wien','Wien Hbf','AT:wien_hbf','Prague','Praha','CZ:prague')],                           // RegioJet
  14: [R('Milan','Milano Centrale','IT:milano_centrale','Rome','Rome','IT:rome'),                                     // Frecciarossa
       R('Rome','Rome','IT:rome','Naples','Napoli Centrale','IT:napoli_centrale'),                 // Frecciarossa
       R('Florence','Florence','IT:florence','Venice','Venice','IT:venezia_s_lucia')],   // Regionale / Frecciarossa
  15: [R('Milan','Milano Centrale','IT:milano_centrale','Rome','Rome','IT:rome'),                                     // Italo
       R('Rome','Rome','IT:rome','Naples','Napoli Centrale','IT:napoli_centrale'),                 // Italo
       R('Milan','Milano Centrale','IT:milano_centrale','Florence','Florence','IT:florence')],                        // Italo
  17: [R('Prague','Praha','CZ:prague','Pardubice','Pardubice','CZ:pardubice_hl_n'),                // Leo Express
       R('Ostrava','Ostrava','CZ:ostrava_hl_n','Prague','Praha','CZ:prague')],                     // Leo Express
  18: [R('Marseille','Marseille','FR:marseille','Nice','Nice','FR:nice'),                          // TER (TRAIN ZOU)
       R('Paris','Paris (All stations)','FR:paris','Amiens','Amiens','FR:amiens'),                 // TER HDF
       R('Lyon','Lyon','FR:lyon','Marseille','Marseille','FR:marseille')],                         // TER
  19: [R('Paris','Paris (All stations)','FR:paris','Nantes','Nantes','FR:nantes'),                 // TGV INOUI
       R('Paris','Paris (All stations)','FR:paris','Lille','Lille','FR:lille'),                    // TGV INOUI
       R('Paris','Paris (All stations)','FR:paris','Strasbourg','Strasbourg','FR:strasbourg')],    // TGV INOUI
};

DATA.ptpJourneys.forEach((j) => {
  j.alternates = [...(ALTERNATES[j.id] || []), ...(VERIFIED_EXTRA[j.id] || [])];
});

module.exports = DATA;
