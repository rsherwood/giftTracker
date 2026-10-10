'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = 30 * DAY_MS; // Matches auth.js: a session's expiry is its start + 30 days.
const PREMIUM_STATUSES = ['active', 'trialing', 'past_due'];

/**
 * Read-only figures for the site owner. Deliberately limited to accounts and
 * counts: it never exposes the names, notes or gifts people have entered.
 */
function createAdminStats(db, { premiumEmails = [] } = {}) {
  const premiumList = PREMIUM_STATUSES.map((s) => `'${s}'`).join(',');
  const q = {
    totals: db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM users) AS users,
        (SELECT COUNT(*) FROM users WHERE created_at >= datetime('now', '-7 days')) AS users_7d,
        (SELECT COUNT(*) FROM users WHERE created_at >= datetime('now', '-30 days')) AS users_30d,
        (SELECT COUNT(*) FROM users WHERE subscription_status IN (${premiumList})) AS premium,
        (SELECT COUNT(*) FROM users WHERE subscription_status = 'past_due') AS past_due,
        (SELECT COUNT(*) FROM users WHERE subscription_status IN (${premiumList})
           AND subscription_cancel_at_period_end = 1) AS cancelling,
        (SELECT COUNT(*) FROM people) AS people,
        (SELECT COUNT(*) FROM gifts WHERE archived_at IS NULL) AS gifts,
        (SELECT COUNT(*) FROM gifts WHERE archived_at IS NOT NULL) AS archived_gifts`),
    giftsByStatus: db.prepare(`
      SELECT status, COUNT(*) AS n FROM gifts WHERE archived_at IS NULL GROUP BY status`),
    activeSince: db.prepare(`
      SELECT COUNT(DISTINCT user_id) AS n FROM sessions WHERE expires_at - ? >= ?`),
    signupsByWeek: db.prepare(`
      SELECT date(created_at, 'weekday 0', '-6 days') AS week_start, COUNT(*) AS n
      FROM users WHERE created_at >= datetime('now', '-84 days')
      GROUP BY week_start ORDER BY week_start DESC`),
    users: db.prepare(`
      SELECT u.id, u.name, u.email, u.created_at, u.currency,
             u.subscription_status, u.subscription_period_end, u.subscription_cancel_at_period_end,
             (SELECT COUNT(*) FROM people p WHERE p.user_id = u.id) AS people,
             (SELECT COUNT(*) FROM gifts g JOIN people p ON p.id = g.person_id WHERE p.user_id = u.id) AS gifts,
             (SELECT MAX(expires_at) FROM sessions s WHERE s.user_id = u.id) AS last_session_expiry
      FROM users u ORDER BY u.id DESC LIMIT ?`),
  };
  const comped = new Set(premiumEmails.map((e) => e.trim().toLowerCase()).filter(Boolean));
  // Accounts that actually exist for the comped emails (and aren't also paying).
  const compedCount = comped.size
    ? db.prepare(`SELECT COUNT(*) AS n FROM users WHERE lower(email) IN (${[...comped].map(() => '?').join(',')})
                    AND subscription_status NOT IN (${premiumList})`)
    : null;

  return function stats({ limit = 200 } = {}) {
    const now = Date.now();
    const totals = q.totals.get();
    return {
      generated_at: now,
      totals: {
        ...totals,
        comped: compedCount ? compedCount.get(...comped).n : 0,
        active_7d: q.activeSince.get(SESSION_TTL_MS, now - 7 * DAY_MS).n,
        active_30d: q.activeSince.get(SESSION_TTL_MS, now - 30 * DAY_MS).n,
      },
      gifts_by_status: Object.fromEntries(q.giftsByStatus.all().map((r) => [r.status, r.n])),
      signups_by_week: q.signupsByWeek.all(),
      users: q.users.all(limit).map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        joined: u.created_at,
        currency: u.currency,
        plan: comped.has(u.email.toLowerCase())
          ? 'comped'
          : PREMIUM_STATUSES.includes(u.subscription_status) ? 'premium' : 'free',
        subscription_status: u.subscription_status || null,
        renews_or_ends: u.subscription_period_end,
        cancelling: Boolean(u.subscription_cancel_at_period_end),
        people: u.people,
        gifts: u.gifts,
        // Approximate: when their most recent login session started.
        last_login: u.last_session_expiry ? u.last_session_expiry - SESSION_TTL_MS : null,
      })),
    };
  };
}

module.exports = { createAdminStats };
