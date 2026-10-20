// Tiny .env loader (no dependency): KEY=value lines, # comments, optional quotes. A value that is
// already set in the real environment always wins. Shared by run-sanity.js (so every child
// process inherits it), notify.js, extra-checks.js and api-searchability.js, so a setting in
// .env (AWS_CLI, SF_ORG_ALIAS, MAIL_TO, POSTMAN_DIR, SLACK_ALERT_WEBHOOK, ...) works the same
// whichever script reads it. Safe to call more than once.
const fs = require('fs');
const path = require('path');

function loadEnv() {
  const f = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(f)) return;
  for (const raw of fs.readFileSync(f, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const m = raw.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m || raw.trim().startsWith('#')) continue;
    const v = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] == null) process.env[m[1]] = v;
  }
}

module.exports = { loadEnv };
