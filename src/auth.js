'use strict';

const crypto = require('node:crypto');

const SESSION_COOKIE = 'gt_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64, SCRYPT_PARAMS);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltB64, keyB64] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, SCRYPT_PARAMS);
  return crypto.timingSafeEqual(expected, actual);
}

// A real hash to compare against when the email doesn't exist, so a failed
// login takes the same time whether or not the account is registered.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (key) out[key] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createAuth(db, { secureCookies }) {
  const stmts = {
    insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
    findSession: db.prepare(`
      SELECT u.id, u.email, u.name, u.currency, s.expires_at
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    purgeExpired: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
  };

  function cookie(value, maxAgeSeconds) {
    return [
      `${SESSION_COOKIE}=${value}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${maxAgeSeconds}`,
      secureCookies ? 'Secure' : null,
    ].filter(Boolean).join('; ');
  }

  function startSession(res, userId) {
    stmts.purgeExpired.run(Date.now());
    const token = crypto.randomBytes(32).toString('base64url');
    stmts.insertSession.run(sha256(token), userId, Date.now() + SESSION_TTL_MS);
    res.setHeader('Set-Cookie', cookie(token, SESSION_TTL_MS / 1000));
  }

  function endSession(req, res) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) stmts.deleteSession.run(sha256(token));
    res.setHeader('Set-Cookie', cookie('', 0));
  }

  // Populates req.user when a valid session cookie is present.
  function loadUser(req, _res, next) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) {
      const row = stmts.findSession.get(sha256(token));
      if (row && row.expires_at > Date.now()) {
        req.user = { id: row.id, email: row.email, name: row.name, currency: row.currency };
      }
    }
    next();
  }

  function requireUser(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Please log in.' });
    next();
  }

  return { startSession, endSession, loadUser, requireUser };
}

// Very small fixed-window limiter for login/register attempts, keyed by IP.
function createRateLimiter({ windowMs, max }) {
  const hits = new Map();
  return function rateLimit(req, res, next) {
    const now = Date.now();
    const key = req.ip;
    let entry = hits.get(key);
    if (!entry || entry.reset < now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (hits.size > 10000) {
      for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    }
    if (entry.count > max) {
      return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
    }
    next();
  };
}

module.exports = { hashPassword, verifyPassword, DUMMY_HASH, createAuth, createRateLimiter };
