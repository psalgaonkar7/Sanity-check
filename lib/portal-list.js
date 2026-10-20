// The portals the sanity check covers besides customercare.raileurope.com (which is the main
// run). No imports on purpose: playwright.config.js, run-sanity.js and the specs all read this,
// and the config must not pull in Playwright helpers.
//
// Every portal is the same ERA app with its own login per domain (verified 2026-10-14: same
// sign-in form, no shared login host). The .cn portals are slow to start from here (8-30 s, once
// >60 s) and the key-account one never boots with blockNoise() — hence `china`: no noise
// blocking and longer waits.
const PORTALS = [
  { key: 'rowKeyAccount',     label: 'Key account ROW',     url: 'https://era.raileurope.com' },
  { key: 'rowAgent',          label: 'Agents portal ROW',   url: 'https://agent.raileurope.com' },
  { key: 'chinaKeyAccount',   label: 'Key account China',   url: 'https://www.era.raileurope.cn', china: true },
  // `book`: after the search, also cart one train and capture a booking reference (stops at
  // Traveler Details, status Created, like the main run). Its cart is its own (separate
  // /api/carts on the .cn host, checked 2026-10-20), so it can run alongside the main booking.
  { key: 'chinaCustomerCare', label: 'Customer care China', url: 'https://www.customercare.raileurope.cn', china: true, book: true },
];

module.exports = { PORTALS };
