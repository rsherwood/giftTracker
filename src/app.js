'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { STATUSES } = require('./db');
const { hashPassword, verifyPassword, DUMMY_HASH, sha256, createAuth, createRateLimiter } = require('./auth');
const { createBilling } = require('./billing');
const { createAdminStats } = require('./admin');
const images = require('./images');

const CURRENCIES = ['USD', 'GBP', 'EUR', 'CAD', 'AUD', 'NZD', 'JPY', 'INR'];
const SPENT_STATUSES = new Set(['purchased', 'received', 'wrapped']);
const MAX_CENTS = 100_000_000; // 1,000,000.00
const RESET_TTL_MS = 60 * 60 * 1000;
const LEGAL_UPDATED = '10 October 2026';
const LEGAL_PAGES = { terms: 'Terms of Service', privacy: 'Privacy Policy' };

// "Christmas 2026" until mid-year, so gifts archived in January still count for the last Christmas.
function defaultOccasion(now = new Date()) {
  const year = now.getMonth() < 6 ? now.getFullYear() - 1 : now.getFullYear();
  return `Christmas ${year}`;
}

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function text(value, field, { max, required = false } = {}) {
  const s = typeof value === 'string' ? value.trim() : value == null ? '' : null;
  if (s === null) throw new HttpError(400, `${field} must be text.`);
  if (required && !s) throw new HttpError(400, `${field} is required.`);
  if (s.length > max) throw new HttpError(400, `${field} must be at most ${max} characters.`);
  return s;
}

function money(value, field) {
  if (value === '' || value == null) return 0;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[,\s]/g, '').replace(/^[$£€¥₹]/, ''));
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `${field} must be a positive number.`);
  const cents = Math.round(n * 100);
  if (cents > MAX_CENTS) throw new HttpError(400, `${field} is too large.`);
  return cents;
}

function link(value) {
  const s = text(value, 'URL', { max: 2000 });
  if (!s) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new HttpError(400, 'URL is not valid.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new HttpError(400, 'URL must start with http:// or https://');
  return url.toString();
}

function newPassword(value) {
  const password = typeof value === 'string' ? value : '';
  if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
  if (password.length > 200) throw new HttpError(400, 'Password is too long.');
  return password;
}

function status(value) {
  if (!STATUSES.includes(value)) throw new HttpError(400, `Status must be one of: ${STATUSES.join(', ')}.`);
  return value;
}

function id(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(404, 'Not found.');
  return n;
}

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// Express 4 doesn't forward rejected promises to the error handler.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

function createApp(db, options = {}) {
  const { secureCookies = false, fetchRemoteImages = true, trustProxy = false } = options;
  const appUrl = String(options.appUrl || '').replace(/\/+$/, '');
  const sendMail = options.sendMail || (async () => {});
  const auth = createAuth(db, { secureCookies });
  const billing = createBilling(db, { ...options.billing, appUrl });
  const contactEmail = options.contactEmail || 'hello@firstwebdev.co.uk';
  const feedbackEmail = options.feedbackEmail || contactEmail;
  const adminEmails = new Set((options.adminEmails || []).map((e) => e.trim().toLowerCase()).filter(Boolean));
  const isAdmin = (user) => Boolean(user && adminEmails.has(user.email.toLowerCase()));
  const withAdmin = (user) => ({ ...user, is_admin: isAdmin(user) });
  const adminStats = createAdminStats(db, { premiumEmails: (options.billing || {}).premiumEmails || [] });
  const feedbackLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: options.feedbackLimit ?? 10 });
  const authLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: options.authAttemptLimit ?? 30 });
  const giftImage = (fields) => images.buildGiftImage(fields, { fetchRemote: fetchRemoteImages });

  const q = {
    insertUser: db.prepare('INSERT INTO users (email, name, password_hash, currency) VALUES (?, ?, ?, ?)'),
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    updateUser: db.prepare('UPDATE users SET name = ?, currency = ? WHERE id = ?'),
    setPassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
    insertReset: db.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
    findReset: db.prepare(`
      SELECT r.user_id, r.expires_at, u.email, u.name, u.currency
      FROM password_resets r JOIN users u ON u.id = r.user_id WHERE r.token_hash = ?`),
    deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    deleteResets: db.prepare('DELETE FROM password_resets WHERE user_id = ? OR expires_at < ?'),

    people: db.prepare(`
      SELECT p.id, p.name, p.budget_cents, p.notes, p.created_at,
        COUNT(g.id) AS gift_count,
        COALESCE(SUM(CASE WHEN g.status IN ('purchased','received','wrapped') THEN g.price_cents END), 0) AS spent_cents,
        COALESCE(SUM(CASE WHEN g.status = 'buy' THEN g.price_cents END), 0) AS planned_cents,
        COALESCE(SUM(g.status = 'idea'), 0)      AS n_idea,
        COALESCE(SUM(g.status = 'buy'), 0)       AS n_buy,
        COALESCE(SUM(g.status = 'purchased'), 0) AS n_purchased,
        COALESCE(SUM(g.status = 'received'), 0)  AS n_received,
        COALESCE(SUM(g.status = 'wrapped'), 0)   AS n_wrapped,
        (SELECT COUNT(*) FROM gifts a WHERE a.person_id = p.id AND a.archived_at IS NOT NULL) AS archived_count
      FROM people p LEFT JOIN gifts g ON g.person_id = p.id AND g.archived_at IS NULL
      WHERE p.user_id = ?
      GROUP BY p.id
      ORDER BY p.name COLLATE NOCASE`),
    person: db.prepare('SELECT id, name, budget_cents, notes, created_at FROM people WHERE id = ? AND user_id = ?'),
    insertPerson: db.prepare('INSERT INTO people (user_id, name, budget_cents, notes) VALUES (?, ?, ?, ?)'),
    updatePerson: db.prepare('UPDATE people SET name = ?, budget_cents = ?, notes = ? WHERE id = ?'),
    deletePerson: db.prepare('DELETE FROM people WHERE id = ?'),

    giftsForPerson: db.prepare(`
      SELECT id, person_id, name, url, price_cents, status, image_source, image_version, created_at, updated_at
      FROM gifts WHERE person_id = ? AND archived_at IS NULL ORDER BY created_at DESC, id DESC`),
    archivedForPerson: db.prepare(`
      SELECT id, person_id, name, url, price_cents, status, image_source, image_version, created_at, updated_at,
             archived_at, archive_label
      FROM gifts WHERE person_id = ? AND archived_at IS NOT NULL ORDER BY archived_at DESC, id DESC`),
    archivedCount: db.prepare('SELECT COUNT(*) AS n FROM gifts WHERE person_id = ? AND archived_at IS NOT NULL'),
    archiveGift: db.prepare('UPDATE gifts SET archived_at = ?, archive_label = ? WHERE id = ?'),
    restoreGift: db.prepare("UPDATE gifts SET archived_at = NULL, archive_label = '' WHERE id = ?"),
    archiveBought: db.prepare(`
      UPDATE gifts SET archived_at = ?, archive_label = ?
      WHERE person_id = ? AND archived_at IS NULL AND status IN ('purchased','received','wrapped')`),
    gift: db.prepare(`
      SELECT g.id, g.person_id, g.name, g.url, g.price_cents, g.status, g.image_source, g.image_version,
             g.created_at, g.updated_at, g.archived_at, g.archive_label
      FROM gifts g JOIN people p ON p.id = g.person_id
      WHERE g.id = ? AND p.user_id = ?`),
    giftImage: db.prepare(`
      SELECT g.image_mime, g.image_data FROM gifts g JOIN people p ON p.id = g.person_id
      WHERE g.id = ? AND p.user_id = ?`),
    insertGift: db.prepare(`
      INSERT INTO gifts (person_id, name, url, price_cents, status, image_mime, image_data, image_source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    updateGift: db.prepare(`
      UPDATE gifts SET name = ?, url = ?, price_cents = ?, status = ?, updated_at = datetime('now')
      WHERE id = ?`),
    updateGiftImage: db.prepare(`
      UPDATE gifts SET image_mime = ?, image_data = ?, image_source = ?, image_version = image_version + 1,
        updated_at = datetime('now')
      WHERE id = ?`),
    deleteGift: db.prepare('DELETE FROM gifts WHERE id = ?'),
  };

  const findPerson = (personId, userId) => {
    const person = q.person.get(id(personId), userId);
    if (!person) throw new HttpError(404, 'Person not found.');
    return person;
  };
  const findGift = (giftId, userId) => {
    const gift = q.gift.get(id(giftId), userId);
    if (!gift) throw new HttpError(404, 'Gift not found.');
    return gift;
  };
  // For changes: the person must also be within the user's plan.
  const editablePerson = (personId, userId) => {
    const person = findPerson(personId, userId);
    if (billing.lockedPeople(userId).has(person.id)) {
      throw new HttpError(
        402,
        `Premium has ended, so only your first ${billing.FREE_PEOPLE_LIMIT} people can be changed. `
          + 'Upgrade again to edit everyone.',
        'upgrade_required',
      );
    }
    return person;
  };
  const editableGift = (giftId, userId) => {
    const gift = findGift(giftId, userId);
    if (gift.archived_at) throw new HttpError(409, 'This gift is in Past gifts. Restore it to change it.', 'archived');
    editablePerson(gift.person_id, userId);
    return gift;
  };
  // Past gifts (the archive) are a Premium feature.
  const requirePremium = (userId) => {
    if (!billing.summary(userId).premium) {
      throw new HttpError(402, 'Past gifts is a Premium feature. Upgrade to archive and look back at old presents.', 'upgrade_required');
    }
  };
  // Full details for the person page: current gifts, plus past gifts for Premium users
  // (others just see how many they have).
  const personDetail = (person, userId) => {
    const premium = billing.summary(userId).premium;
    return {
      ...personJson(person, q.giftsForPerson.all(person.id)),
      locked: billing.lockedPeople(userId).has(person.id),
      archived: premium ? q.archivedForPerson.all(person.id).map(giftJson) : null,
      archived_count: q.archivedCount.get(person.id).n,
    };
  };

  const giftJson = (gift) => ({
    ...gift,
    image_url: `/api/gifts/${gift.id}/image?v=${gift.image_version}`,
  });
  const personJson = (person, gifts) => {
    const spent = gifts.filter((g) => SPENT_STATUSES.has(g.status)).reduce((sum, g) => sum + g.price_cents, 0);
    const planned = gifts.filter((g) => g.status === 'buy').reduce((sum, g) => sum + g.price_cents, 0);
    return { ...person, spent_cents: spent, planned_cents: planned, gifts: gifts.map(giftJson) };
  };

  const app = express();
  app.disable('x-powered-by');
  if (trustProxy) app.set('trust proxy', trustProxy);

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  // Stripe calls this directly, so it sits outside the JSON API (it needs the
  // raw body to check the signature, and it can't send our request header).
  app.post('/api/stripe/webhook', express.raw({ type: '*/*', limit: '1mb' }), wrap(async (req, res) => {
    if (!billing.enabled) throw new HttpError(404, 'Not found.');
    let event;
    try {
      event = options.billing.stripe.webhooks.constructEvent(
        req.body, req.get('Stripe-Signature') || '', options.billing.webhookSecret || '',
      );
    } catch {
      throw new HttpError(400, 'Invalid signature.');
    }
    await billing.handleEvent(event);
    res.json({ received: true });
  }));

  // Legal pages are rendered on the server so they work without JavaScript.
  const legalTemplates = Object.fromEntries(Object.keys(LEGAL_PAGES).map((name) => [
    name, fs.readFileSync(path.join(__dirname, 'legal', `${name}.html`), 'utf8'),
  ]));
  for (const [name, title] of Object.entries(LEGAL_PAGES)) {
    app.get(`/${name}`, (_req, res) => {
      const values = {
        UPDATED: LEGAL_UPDATED,
        APP_URL: appUrl.replace(/^https?:\/\//, ''),
        CONTACT_EMAIL: contactEmail,
        PRICE_LABEL: billing.priceLabel,
        FREE_LIMIT: billing.FREE_PEOPLE_LIMIT,
      };
      const body = legalTemplates[name].replace(/\{\{(\w+)\}\}/g, (_m, key) => escapeHtml(values[key] ?? ''));
      res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} – Giftlist</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <header class="topbar"><a class="brand" href="/"><span class="brand-mark" aria-hidden="true">🎁</span> Giftlist</a></header>
  <main class="container legal">${body}</main>
  <footer class="site-footer"><a href="/#/request-feature">💡 Request a feature</a> · <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a> · © First Impressions App Development Ltd</footer>
</body>
</html>`);
    });
  }

  app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

  const api = express.Router();
  api.use(express.json({ limit: '32kb' }));
  api.use(auth.loadUser);
  // Mutating calls must come from our own script (a cross-site form can't set this header).
  api.use((req, _res, next) => {
    if (!['GET', 'HEAD'].includes(req.method) && req.get('X-Requested-With') !== 'GiftTracker') {
      return next(new HttpError(403, 'Missing request header.'));
    }
    next();
  });

  // --- Auth ---------------------------------------------------------------

  api.post('/auth/register', authLimiter, (req, res) => {
    const body = req.body || {};
    const name = text(body.name, 'Name', { max: 80, required: true });
    const email = text(body.email, 'Email', { max: 254, required: true }).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Please enter a valid email address.');
    const password = newPassword(body.password);
    const currency = CURRENCIES.includes(body.currency) ? body.currency : 'USD';
    if (q.userByEmail.get(email)) throw new HttpError(409, 'An account with that email already exists.');

    const { lastInsertRowid } = q.insertUser.run(email, name, hashPassword(password), currency);
    auth.startSession(res, Number(lastInsertRowid));
    res.status(201).json({ user: withAdmin({ id: Number(lastInsertRowid), email, name, currency }) });
  });

  api.post('/auth/login', authLimiter, (req, res) => {
    const body = req.body || {};
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password.slice(0, 200) : '';
    const user = email ? q.userByEmail.get(email) : null;
    const ok = verifyPassword(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok) throw new HttpError(401, 'Incorrect email or password.');
    auth.startSession(res, user.id);
    res.json({ user: withAdmin({ id: user.id, email: user.email, name: user.name, currency: user.currency }) });
  });

  api.post('/auth/logout', (req, res) => {
    auth.endSession(req, res);
    res.json({ ok: true });
  });

  // Always answers the same way, so it can't be used to discover accounts.
  api.post('/auth/forgot', authLimiter, wrap(async (req, res) => {
    const email = typeof (req.body || {}).email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const user = email ? q.userByEmail.get(email) : null;
    if (user) {
      q.deleteResets.run(user.id, Date.now());
      const token = crypto.randomBytes(32).toString('base64url');
      q.insertReset.run(sha256(token), user.id, Date.now() + RESET_TTL_MS);
      // The token goes after "#" so it never reaches server logs or Referer headers.
      const link = `${appUrl}/#/reset?token=${token}`;
      try {
        await sendMail({
          to: user.email,
          subject: 'Reset your Giftlist password',
          text: `Hi ${user.name},\n\nSomeone (hopefully you) asked to reset your Giftlist password. `
            + `Use this link within the next hour:\n\n${link}\n\n`
            + "If you didn't ask for this, you can ignore this email and your password won't change.\n",
        });
      } catch (err) {
        console.error('Password reset email failed:', err.message);
      }
    }
    res.json({ ok: true });
  }));

  api.post('/auth/reset', authLimiter, (req, res) => {
    const body = req.body || {};
    const token = typeof body.token === 'string' ? body.token : '';
    const reset = token ? q.findReset.get(sha256(token)) : null;
    if (!reset || reset.expires_at < Date.now()) {
      throw new HttpError(400, 'This reset link has expired or already been used. Please request a new one.');
    }
    const password = newPassword(body.password);
    q.setPassword.run(hashPassword(password), reset.user_id);
    q.deleteResets.run(reset.user_id, Date.now());
    auth.endAllSessions(reset.user_id);
    auth.startSession(res, reset.user_id);
    res.json({ user: withAdmin({ id: reset.user_id, email: reset.email, name: reset.name, currency: reset.currency }) });
  });

  api.get('/auth/me', (req, res) => {
    res.json({
      user: req.user ? withAdmin(req.user) : null,
      currencies: CURRENCIES,
      statuses: STATUSES,
      // Lets the sign-up page describe the plans.
      plans: { enabled: billing.enabled, price_label: billing.priceLabel, free_people_limit: billing.FREE_PEOPLE_LIMIT },
    });
  });

  api.patch('/auth/me', auth.requireUser, (req, res) => {
    const body = req.body || {};
    const name = has(body, 'name') ? text(body.name, 'Name', { max: 80, required: true }) : req.user.name;
    const currency = has(body, 'currency') ? body.currency : req.user.currency;
    if (!CURRENCIES.includes(currency)) throw new HttpError(400, 'Unsupported currency.');
    q.updateUser.run(name, currency, req.user.id);
    res.json({ user: withAdmin({ ...req.user, name, currency }) });
  });

  // Permanently deletes the account and everything in it.
  api.delete('/auth/me', auth.requireUser, authLimiter, (req, res) => {
    const user = q.userById.get(req.user.id);
    const password = typeof (req.body || {}).password === 'string' ? req.body.password.slice(0, 200) : '';
    if (!verifyPassword(password, user.password_hash)) throw new HttpError(401, 'That password isn’t right.');
    const sub = billing.summary(user.id).subscription;
    if (sub && ['active', 'trialing', 'past_due'].includes(sub.status) && !sub.cancel_at_period_end) {
      throw new HttpError(
        409,
        'Please cancel your Premium subscription first (Manage subscription), so you aren’t charged again.',
        'cancel_subscription_first',
      );
    }
    q.deleteUser.run(user.id); // Sessions, people, gifts and reset links go with it.
    auth.endSession(req, res);
    res.json({ ok: true });
  });

  // --- Admin (site owner only) ---------------------------------------------

  // Answers "not found" to everyone else, so the page's existence isn't revealed.
  api.get('/admin/stats', (req, res) => {
    if (!isAdmin(req.user)) throw new HttpError(404, 'Not found.');
    res.setHeader('Cache-Control', 'no-store');
    res.json(adminStats());
  });

  // --- Feature requests -----------------------------------------------------

  // Emails a feature request to the site owner. Works logged in or out.
  api.post('/feedback', feedbackLimiter, wrap(async (req, res) => {
    const body = req.body || {};
    // Hidden field that people never see; bots that fill it in get a quiet "thanks".
    if (body.website) return res.json({ ok: true });
    const message = text(body.message, 'Your idea', { max: 3000, required: true });
    if (message.length < 10) throw new HttpError(400, 'Please tell us a little more about your idea.');
    const name = req.user ? req.user.name : text(body.name, 'Name', { max: 80 });
    const email = req.user ? req.user.email : text(body.email, 'Email', { max: 254 }).toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Please enter a valid email address.');

    const plan = req.user ? (billing.summary(req.user.id).premium ? 'Premium' : 'Free') : 'Not logged in';
    const summary = message.replace(/\s+/g, ' ').slice(0, 60);
    try {
      await sendMail({
        to: feedbackEmail,
        replyTo: email || undefined,
        subject: `Giftlist feature request: ${summary}${message.length > 60 ? '…' : ''}`,
        text: `${message}\n\n—\nFrom: ${name || '(no name)'} <${email || 'no email given'}>\nAccount: ${plan}`
          + `${req.user ? ` (user #${req.user.id})` : ''}\nSent: ${new Date().toISOString()}\n`,
      });
    } catch (err) {
      console.error('Feature request email failed:', err.message);
      throw new HttpError(502, `Sorry, we couldn’t send that just now. You can email us at ${contactEmail} instead.`);
    }
    res.json({ ok: true });
  }));

  // --- Billing ------------------------------------------------------------

  api.use(['/billing', '/people', '/gifts'], auth.requireUser);

  api.get('/billing', (req, res) => {
    res.json({ billing: billing.summary(req.user.id) });
  });

  api.post('/billing/checkout', wrap(async (req, res) => {
    if (!billing.enabled) throw new HttpError(400, 'Payments are not set up on this site.');
    if (billing.summary(req.user.id).premium) {
      throw new HttpError(400, 'You already have Premium.');
    }
    res.json({ url: await billing.createCheckout(req.user.id) });
  }));

  api.post('/billing/portal', wrap(async (req, res) => {
    if (!billing.enabled) throw new HttpError(400, 'Payments are not set up on this site.');
    const url = await billing.createPortal(req.user.id);
    if (!url) throw new HttpError(400, 'There is no subscription to manage yet.');
    res.json({ url });
  }));

  // --- People -------------------------------------------------------------

  api.get('/people', (req, res) => {
    const locked = billing.lockedPeople(req.user.id);
    res.json({ people: q.people.all(req.user.id).map((p) => ({ ...p, locked: locked.has(p.id) })) });
  });

  api.post('/people', (req, res) => {
    if (!billing.canAddPerson(req.user.id)) {
      throw new HttpError(
        402,
        `The free plan covers ${billing.FREE_PEOPLE_LIMIT} people. Upgrade to Premium to add as many as you like.`,
        'upgrade_required',
      );
    }
    const body = req.body || {};
    const name = text(body.name, 'Name', { max: 80, required: true });
    const budget = money(body.budget, 'Budget');
    const notes = text(body.notes, 'Notes', { max: 1000 });
    const { lastInsertRowid } = q.insertPerson.run(req.user.id, name, budget, notes);
    res.status(201).json({ person: personJson(findPerson(lastInsertRowid, req.user.id), []) });
  });

  api.get('/people/:id', (req, res) => {
    const person = findPerson(req.params.id, req.user.id);
    res.json({ person: personDetail(person, req.user.id) });
  });

  api.patch('/people/:id', (req, res) => {
    const person = editablePerson(req.params.id, req.user.id);
    const body = req.body || {};
    const name = has(body, 'name') ? text(body.name, 'Name', { max: 80, required: true }) : person.name;
    const budget = has(body, 'budget') ? money(body.budget, 'Budget') : person.budget_cents;
    const notes = has(body, 'notes') ? text(body.notes, 'Notes', { max: 1000 }) : person.notes;
    q.updatePerson.run(name, budget, notes, person.id);
    res.json({ person: personDetail(findPerson(person.id, req.user.id), req.user.id) });
  });

  // Deliberately allowed for read-only people too, so nobody is stuck with
  // data they want gone.
  api.delete('/people/:id', (req, res) => {
    const person = findPerson(req.params.id, req.user.id);
    q.deletePerson.run(person.id);
    res.json({ ok: true });
  });

  // --- Gifts --------------------------------------------------------------

  api.post('/people/:id/gifts', wrap(async (req, res) => {
    const person = editablePerson(req.params.id, req.user.id);
    const body = req.body || {};
    const name = text(body.name, 'Item name', { max: 140, required: true });
    const url = link(body.url);
    const price = money(body.price, 'Price');
    const giftStatus = has(body, 'status') ? status(body.status) : 'idea';

    const image = await giftImage({ name, url });
    const { lastInsertRowid } = q.insertGift.run(
      person.id, name, url, price, giftStatus, image.mime, image.data, image.source,
    );
    res.status(201).json({ gift: giftJson(findGift(lastInsertRowid, req.user.id)) });
  }));

  api.patch('/gifts/:id', wrap(async (req, res) => {
    const gift = editableGift(req.params.id, req.user.id);
    const body = req.body || {};
    const name = has(body, 'name') ? text(body.name, 'Item name', { max: 140, required: true }) : gift.name;
    const url = has(body, 'url') ? link(body.url) : gift.url;
    const price = has(body, 'price') ? money(body.price, 'Price') : gift.price_cents;
    const giftStatus = has(body, 'status') ? status(body.status) : gift.status;

    // Refresh the picture when what it was based on has changed.
    const urlChanged = url !== gift.url;
    const nameChanged = name !== gift.name && gift.image_source === 'generated';
    if (urlChanged || nameChanged) {
      const image = await giftImage({ name, url });
      q.updateGiftImage.run(image.mime, image.data, image.source, gift.id);
    }
    q.updateGift.run(name, url, price, giftStatus, gift.id);
    res.json({ gift: giftJson(findGift(gift.id, req.user.id)) });
  }));

  // Re-create the image: `source: "generated"` forces new artwork, otherwise
  // the product photo is tried first.
  api.post('/gifts/:id/image', wrap(async (req, res) => {
    const gift = editableGift(req.params.id, req.user.id);
    const forceGenerated = (req.body || {}).source === 'generated';
    const image = forceGenerated ? images.generatedImage(gift.name) : await giftImage(gift);
    q.updateGiftImage.run(image.mime, image.data, image.source, gift.id);
    res.json({ gift: giftJson(findGift(gift.id, req.user.id)) });
  }));

  api.get('/gifts/:id/image', (req, res) => {
    const row = q.giftImage.get(id(req.params.id), req.user.id);
    if (!row) throw new HttpError(404, 'Image not found.');
    res.setHeader('Content-Type', row.image_mime);
    // The URL carries a version number, so the browser may cache it privately.
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    res.send(Buffer.from(row.image_data));
  });

  api.delete('/gifts/:id', (req, res) => {
    const gift = findGift(req.params.id, req.user.id);
    if (gift.archived_at) requirePremium(req.user.id);
    else editableGift(gift.id, req.user.id);
    q.deleteGift.run(gift.id);
    res.json({ ok: true });
  });

  // --- Past gifts (Premium) -------------------------------------------------

  const archiveLabel = (value) => text(value, 'Occasion', { max: 60 }) || defaultOccasion();

  api.post('/gifts/:id/archive', (req, res) => {
    requirePremium(req.user.id);
    const gift = editableGift(req.params.id, req.user.id);
    q.archiveGift.run(Date.now(), archiveLabel((req.body || {}).label), gift.id);
    res.json({ gift: giftJson(findGift(gift.id, req.user.id)) });
  });

  api.post('/gifts/:id/restore', (req, res) => {
    requirePremium(req.user.id);
    const gift = findGift(req.params.id, req.user.id);
    editablePerson(gift.person_id, req.user.id);
    q.restoreGift.run(gift.id);
    res.json({ gift: giftJson(findGift(gift.id, req.user.id)) });
  });

  // End of an occasion: move everything already bought into Past gifts in one go.
  api.post('/people/:id/archive-bought', (req, res) => {
    requirePremium(req.user.id);
    const person = editablePerson(req.params.id, req.user.id);
    const { changes } = q.archiveBought.run(Date.now(), archiveLabel((req.body || {}).label), person.id);
    res.json({ archived: Number(changes), person: personDetail(person, req.user.id) });
  });

  api.use((_req, _res, next) => next(new HttpError(404, 'Not found.')));

  app.use('/api', api);

  // Any other path is a client-side route of the single-page app.
  app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });

  return app;
}

module.exports = { createApp };
