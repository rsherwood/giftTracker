'use strict';

const path = require('node:path');
const { openDatabase } = require('./db');
const { createApp } = require('./app');

const port = Number(process.env.PORT) || 3000;
const dbFile = process.env.DATABASE_FILE || path.join(__dirname, '..', 'data', 'gift-tracker.db');

const db = openDatabase(dbFile);
const app = createApp(db, {
  // Set COOKIE_SECURE=true when serving over HTTPS.
  secureCookies: process.env.COOKIE_SECURE === 'true',
  // Set TRUST_PROXY=1 behind a reverse proxy so rate limiting sees client IPs.
  trustProxy: process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY : false,
  // Set FETCH_PRODUCT_IMAGES=false to always use generated artwork.
  fetchRemoteImages: process.env.FETCH_PRODUCT_IMAGES !== 'false',
});

app.listen(port, () => {
  console.log(`Gift Tracker running at http://localhost:${port} (database: ${dbFile})`);
});
