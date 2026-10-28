// `npm run auth` = the same single command as `npm run auth:all` (changed 2026-10-27, Pratikesh: "npm run auth still
// opens pop up of browser. I want all login process in cmd only"). It used to open your browser for AWS SSO and a
// Playwright window for the B2B login. Now: the 5 portals with one typed username + password, and AWS EU + China with a
// link + code printed here (no browser is opened by the tool). Details and exit codes: auth-all.js.
//
// Browser fallbacks, if the cmd login ever fails: npm run auth:b2b, npm run auth:portals, aws sso login --sso-session era.
const { spawnSync } = require('child_process');
const path = require('path');
const r = spawnSync(process.execPath, [path.join(__dirname, 'auth-all.js')].concat(process.argv.slice(2)), { stdio: 'inherit', cwd: __dirname });
process.exit(r.status == null ? 1 : r.status);
