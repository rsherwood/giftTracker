'use strict';

const path = require('node:path');
const Stripe = require('stripe');
const { openDatabase } = require('./db');
const { createApp } = require('./app');
const { createMailer } = require('./mailer');

const env = process.env;
const port = Number(env.PORT) || 3000;
const dbFile = env.DATABASE_FILE || path.join(__dirname, '..', 'data', 'gift-tracker.db');
// Public address of the site, used in emails and Stripe return links.
const appUrl = env.APP_URL || `http://localhost:${port}`;

if (env.STRIPE_SECRET_KEY && !env.APP_URL) {
  console.warn('APP_URL is not set: Stripe and password reset links will point at localhost.');
}

const db = openDatabase(dbFile);
const app = createApp(db, {
  appUrl,
  // Set COOKIE_SECURE=true when serving over HTTPS.
  secureCookies: env.COOKIE_SECURE === 'true',
  // Set TRUST_PROXY=1 behind a reverse proxy so rate limiting sees client IPs.
  trustProxy: env.TRUST_PROXY ? Number(env.TRUST_PROXY) || env.TRUST_PROXY : false,
  // Set FETCH_PRODUCT_IMAGES=false to always use generated artwork.
  fetchRemoteImages: env.FETCH_PRODUCT_IMAGES !== 'false',
  sendMail: createMailer({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    from: env.MAIL_FROM,
  }),
  // Billing is off (everyone unlimited) until the Stripe variables are set.
  billing: {
    stripe: env.STRIPE_SECRET_KEY ? new Stripe(env.STRIPE_SECRET_KEY) : null,
    priceId: env.STRIPE_PRICE_ID,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    priceLabel: env.PRICE_LABEL || '£5/year',
    // Comma-separated emails that get Premium free (e.g. your own account).
    premiumEmails: (env.PREMIUM_EMAILS || '').split(','),
  },
});

app.listen(port, () => {
  console.log(`Gift Tracker running at ${appUrl} (port ${port}, database: ${dbFile})`);
});
