'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Stripe = require('stripe');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/app');

const WEBHOOK_SECRET = 'whsec_test_secret';
const realStripe = new Stripe('sk_test_dummy');

// Stand-in for the Stripe client: records calls and serves subscriptions from memory.
const subscriptions = new Map();
const calls = [];
const fakeStripe = {
  webhooks: realStripe.webhooks,
  customers: {
    create: async (params) => {
      calls.push(['customers.create', params]);
      return { id: `cus_${params.metadata.user_id}` };
    },
  },
  checkout: {
    sessions: {
      create: async (params) => {
        calls.push(['checkout.create', params]);
        return { url: 'https://checkout.stripe.test/session' };
      },
    },
  },
  billingPortal: {
    sessions: { create: async (params) => ({ url: `https://billing.stripe.test/${params.customer}` }) },
  },
  subscriptions: { retrieve: async (id) => subscriptions.get(id) },
};

const mail = [];
let server;
let base;

before(async () => {
  const app = createApp(openDatabase(':memory:'), {
    fetchRemoteImages: false,
    authAttemptLimit: 1000,
    appUrl: 'https://gifts.example.test',
    contactEmail: 'help@example.test',
    adminEmails: ['Boss@Example.com'],
    sendMail: async (message) => { mail.push(message); },
    billing: {
      stripe: fakeStripe,
      priceId: 'price_123',
      webhookSecret: WEBHOOK_SECRET,
      premiumEmails: ['owner@example.com'],
    },
  });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

function client() {
  let cookie = '';
  return async function call(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: {
        'X-Requested-With': 'GiftTracker',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: res.status, data: await res.json() };
  };
}

let counter = 0;
async function newUser(email) {
  const call = client();
  counter += 1;
  const res = await call('POST', '/api/auth/register', {
    name: 'Pat', email: email || `pat${counter}@example.com`, password: 'password123',
  });
  assert.equal(res.status, 201);
  return { call, user: res.data.user };
}

async function sendWebhook(event, secret = WEBHOOK_SECRET) {
  const payload = JSON.stringify(event);
  const signature = realStripe.webhooks.generateTestHeaderString({ payload, secret });
  const res = await fetch(`${base}/api/stripe/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature },
    body: payload,
  });
  return res.status;
}

const subscription = (id, customer, status, extra = {}) => ({
  id,
  object: 'subscription',
  customer,
  status,
  cancel_at_period_end: false,
  items: { data: [{ current_period_end: 1893456000 }] }, // 2030-01-01
  metadata: {},
  ...extra,
});

test('free plan allows two people, then asks for an upgrade', async () => {
  const { call } = await newUser();
  let res = await call('GET', '/api/billing');
  assert.equal(res.data.billing.plan, 'free');
  assert.equal(res.data.billing.free_people_limit, 2);

  assert.equal((await call('POST', '/api/people', { name: 'One' })).status, 201);
  assert.equal((await call('POST', '/api/people', { name: 'Two' })).status, 201);
  res = await call('POST', '/api/people', { name: 'Three' });
  assert.equal(res.status, 402);
  assert.equal(res.data.code, 'upgrade_required');

  // Gifts for existing people are still unlimited.
  const { data: { people } } = await call('GET', '/api/people');
  for (let i = 0; i < 5; i++) {
    assert.equal((await call('POST', `/api/people/${people[0].id}/gifts`, { name: `Gift ${i}` })).status, 201);
  }
});

test('checkout, webhook activation, cancellation and lapse', async () => {
  const { call, user } = await newUser();
  let res = await call('POST', '/api/billing/checkout');
  assert.equal(res.status, 200);
  assert.equal(res.data.url, 'https://checkout.stripe.test/session');
  const [, params] = calls.findLast(([name]) => name === 'checkout.create');
  assert.equal(params.mode, 'subscription');
  assert.equal(params.customer, `cus_${user.id}`);
  assert.deepEqual(params.line_items, [{ price: 'price_123', quantity: 1 }]);
  assert.equal(params.success_url, 'https://gifts.example.test/#/account?checkout=success');

  // A second checkout reuses the same Stripe customer.
  await call('POST', '/api/billing/checkout');
  assert.equal(calls.filter(([n, p]) => n === 'customers.create' && p.metadata.user_id === String(user.id)).length, 1);

  // Payment completes.
  const subId = `sub_${user.id}`;
  subscriptions.set(subId, subscription(subId, `cus_${user.id}`, 'active'));
  assert.equal(await sendWebhook({
    id: 'evt_1', type: 'checkout.session.completed',
    data: { object: { mode: 'subscription', subscription: subId, customer: `cus_${user.id}`, client_reference_id: String(user.id) } },
  }), 200);

  res = await call('GET', '/api/billing');
  assert.equal(res.data.billing.premium, true);
  assert.equal(res.data.billing.subscription.period_end, 1893456000 * 1000);
  for (let i = 0; i < 4; i++) assert.equal((await call('POST', '/api/people', { name: `P${i}` })).status, 201);
  assert.equal((await call('POST', '/api/billing/checkout')).status, 400);
  assert.match((await call('POST', '/api/billing/portal')).data.url, /cus_/);

  // Cancels renewal: still Premium until the end of the period.
  subscriptions.set(subId, subscription(subId, `cus_${user.id}`, 'active', { cancel_at_period_end: true }));
  await sendWebhook({ id: 'evt_2', type: 'customer.subscription.updated', data: { object: subscriptions.get(subId) } });
  res = await call('GET', '/api/billing');
  assert.equal(res.data.billing.premium, true);
  assert.equal(res.data.billing.subscription.cancel_at_period_end, true);

  // Period ends: back to free, data kept, can't add more people.
  subscriptions.set(subId, subscription(subId, `cus_${user.id}`, 'canceled'));
  await sendWebhook({ id: 'evt_3', type: 'customer.subscription.deleted', data: { object: subscriptions.get(subId) } });
  res = await call('GET', '/api/billing');
  assert.equal(res.data.billing.premium, false);
  assert.equal(res.data.billing.people_count, 4);
  assert.equal((await call('GET', '/api/people')).data.people.length, 4);
  assert.equal((await call('POST', '/api/people', { name: 'Another' })).status, 402);
});

test('webhooks with a bad signature are rejected', async () => {
  assert.equal(await sendWebhook({ id: 'evt_x', type: 'customer.subscription.updated', data: { object: {} } }, 'whsec_wrong'), 400);
});

test('emails listed in PREMIUM_EMAILS get Premium free', async () => {
  const { call } = await newUser('Owner@Example.com');
  const res = await call('GET', '/api/billing');
  assert.equal(res.data.billing.premium, true);
  assert.equal(res.data.billing.comped, true);
  for (let i = 0; i < 3; i++) assert.equal((await call('POST', '/api/people', { name: `P${i}` })).status, 201);
});

test('password reset by email', async () => {
  const { call } = await newUser('forgetful@example.com');
  const other = client();

  // Unknown emails get the same answer and no email.
  const before = mail.length;
  let res = await other('POST', '/api/auth/forgot', { email: 'nobody@example.com' });
  assert.equal(res.status, 200);
  assert.equal(mail.length, before);

  res = await other('POST', '/api/auth/forgot', { email: 'FORGETFUL@example.com' });
  assert.equal(res.status, 200);
  const message = mail.at(-1);
  assert.equal(message.to, 'forgetful@example.com');
  const token = message.text.match(/#\/reset\?token=([\w-]+)/)[1];
  assert.match(message.text, /https:\/\/gifts\.example\.test\/#\/reset\?token=/);

  assert.equal((await other('POST', '/api/auth/reset', { token, password: 'short' })).status, 400);
  res = await other('POST', '/api/auth/reset', { token, password: 'brand-new-password' });
  assert.equal(res.status, 200);
  assert.equal(res.data.user.email, 'forgetful@example.com');
  assert.equal((await other('GET', '/api/people')).status, 200);

  // Link is single-use, old sessions are signed out, new password works.
  assert.equal((await other('POST', '/api/auth/reset', { token, password: 'another-password' })).status, 400);
  assert.equal((await call('GET', '/api/people')).status, 401);
  assert.equal((await client()('POST', '/api/auth/login', { email: 'forgetful@example.com', password: 'brand-new-password' })).status, 200);
  assert.equal((await client()('POST', '/api/auth/login', { email: 'forgetful@example.com', password: 'password123' })).status, 401);
});

test('after Premium lapses only the first two people can be changed', async () => {
  const { call, user } = await newUser();
  const subId = `sub_${user.id}`;
  await call('POST', '/api/billing/checkout');
  subscriptions.set(subId, subscription(subId, `cus_${user.id}`, 'active'));
  await sendWebhook({ id: 'evt_a', type: 'customer.subscription.updated', data: { object: subscriptions.get(subId) } });

  const people = [];
  const gifts = [];
  // Added in this order, but listed alphabetically, so "first two" must mean first added.
  for (const name of ['Zed', 'Yan', 'Bea', 'Abe']) {
    const { data: { person } } = await call('POST', '/api/people', { name });
    const { data: { gift } } = await call('POST', `/api/people/${person.id}/gifts`, { name: `Gift for ${name}` });
    people.push(person);
    gifts.push(gift);
  }

  subscriptions.set(subId, subscription(subId, `cus_${user.id}`, 'canceled'));
  await sendWebhook({ id: 'evt_b', type: 'customer.subscription.deleted', data: { object: subscriptions.get(subId) } });

  const listed = (await call('GET', '/api/people')).data.people;
  assert.deepEqual(
    Object.fromEntries(listed.map((p) => [p.name, p.locked])),
    { Abe: true, Bea: true, Yan: false, Zed: false },
  );
  assert.equal((await call('GET', `/api/people/${people[2].id}`)).data.person.locked, true);

  // The first two are fully editable.
  for (const i of [0, 1]) {
    assert.equal((await call('PATCH', `/api/people/${people[i].id}`, { budget: 10 })).status, 200);
    assert.equal((await call('POST', `/api/people/${people[i].id}/gifts`, { name: 'More' })).status, 201);
    assert.equal((await call('PATCH', `/api/gifts/${gifts[i].id}`, { status: 'buy' })).status, 200);
    assert.equal((await call('POST', `/api/gifts/${gifts[i].id}/image`, { source: 'generated' })).status, 200);
    assert.equal((await call('DELETE', `/api/gifts/${gifts[i].id}`)).status, 200);
  }

  // The rest are read-only: viewable, but every change is refused.
  for (const i of [2, 3]) {
    assert.equal((await call('GET', `/api/people/${people[i].id}`)).status, 200);
    for (const [method, path, body] of [
      ['PATCH', `/api/people/${people[i].id}`, { name: 'x' }],
      ['POST', `/api/people/${people[i].id}/gifts`, { name: 'x' }],
      ['PATCH', `/api/gifts/${gifts[i].id}`, { status: 'buy' }],
      ['POST', `/api/gifts/${gifts[i].id}/image`, { source: 'generated' }],
      ['DELETE', `/api/gifts/${gifts[i].id}`],
    ]) {
      const res = await call(method, path, body);
      assert.equal(res.status, 402, `${method} ${path}`);
      assert.equal(res.data.code, 'upgrade_required');
    }
  }

  // Deleting one of the first two moves the next person into the free allowance.
  assert.equal((await call('DELETE', `/api/people/${people[0].id}`)).status, 200);
  assert.equal((await call('PATCH', `/api/people/${people[2].id}`, { budget: 5 })).status, 200);
  assert.equal((await call('PATCH', `/api/people/${people[3].id}`, { budget: 5 })).status, 402);

  // Renewing unlocks everyone again.
  subscriptions.set(subId, subscription(subId, `cus_${user.id}`, 'active'));
  await sendWebhook({ id: 'evt_c', type: 'customer.subscription.updated', data: { object: subscriptions.get(subId) } });
  assert.equal((await call('PATCH', `/api/people/${people[3].id}`, { budget: 5 })).status, 200);
});

test('renewals and failed renewal payments are picked up from invoice events', async () => {
  const { call, user } = await newUser();
  await call('POST', '/api/billing/checkout');
  const [, params] = calls.findLast(([name]) => name === 'checkout.create');
  assert.match(params.integration_identifier, /^giftlist-premium-[a-z]{8}$/);
  assert.equal(params.payment_method_types, undefined);

  const subId = `sub_${user.id}`;
  const customer = `cus_${user.id}`;
  // Newer API versions reference the subscription under invoice.parent.
  const invoice = { object: 'invoice', customer, parent: { subscription_details: { subscription: subId } } };

  subscriptions.set(subId, subscription(subId, customer, 'active'));
  await sendWebhook({ id: 'evt_i1', type: 'invoice.paid', data: { object: invoice } });
  assert.equal((await call('GET', '/api/billing')).data.billing.premium, true);

  // A year later the renewal is paid and the period moves on.
  subscriptions.set(subId, subscription(subId, customer, 'active', { items: { data: [{ current_period_end: 1924992000 }] } }));
  await sendWebhook({ id: 'evt_i2', type: 'invoice.paid', data: { object: invoice } });
  assert.equal((await call('GET', '/api/billing')).data.billing.subscription.period_end, 1924992000 * 1000);

  // Renewal payment fails: Premium is kept while Stripe retries...
  subscriptions.set(subId, subscription(subId, customer, 'past_due'));
  await sendWebhook({ id: 'evt_i3', type: 'invoice.payment_failed', data: { object: invoice } });
  let billing = (await call('GET', '/api/billing')).data.billing;
  assert.equal(billing.premium, true);
  assert.equal(billing.subscription.status, 'past_due');

  // ...and ends once Stripe gives up.
  subscriptions.set(subId, subscription(subId, customer, 'unpaid'));
  await sendWebhook({ id: 'evt_i4', type: 'invoice.payment_failed', data: { object: invoice } });
  billing = (await call('GET', '/api/billing')).data.billing;
  assert.equal(billing.premium, false);

  // Older payload shape (invoice.subscription) still works.
  subscriptions.set(subId, subscription(subId, customer, 'active'));
  await sendWebhook({ id: 'evt_i5', type: 'invoice.paid', data: { object: { object: 'invoice', customer, subscription: subId } } });
  assert.equal((await call('GET', '/api/billing')).data.billing.premium, true);
});

test('terms and privacy pages are served with the site details filled in', async () => {
  for (const [path, heading] of [['/terms', 'Terms of Service'], ['/privacy', 'Privacy Policy']]) {
    const res = await fetch(base + path);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.match(html, new RegExp(`<h1>${heading}</h1>`));
    assert.match(html, /mailto:help@example\.test/);
    assert.match(html, /13708714/);
    assert.doesNotMatch(html, /\{\{/);
  }
  const terms = await (await fetch(`${base}/terms`)).text();
  assert.match(terms, /£5\/year/);
  assert.match(terms, /up to 2 people/);
});

test('deleting an account', async () => {
  const { call, user } = await newUser('leaving@example.com');
  const { data: { person } } = await call('POST', '/api/people', { name: 'Mum' });
  await call('POST', `/api/people/${person.id}/gifts`, { name: 'Scarf' });

  assert.equal((await call('DELETE', '/api/auth/me', { password: 'wrong-password' })).status, 401);

  // An active subscription has to be cancelled first so it can't keep charging.
  const subId = `sub_${user.id}`;
  await call('POST', '/api/billing/checkout');
  subscriptions.set(subId, subscription(subId, `cus_${user.id}`, 'active'));
  await sendWebhook({ id: 'evt_d1', type: 'customer.subscription.updated', data: { object: subscriptions.get(subId) } });
  let res = await call('DELETE', '/api/auth/me', { password: 'password123' });
  assert.equal(res.status, 409);
  assert.equal(res.data.code, 'cancel_subscription_first');

  // Once it's set to end, the account can go.
  subscriptions.set(subId, subscription(subId, `cus_${user.id}`, 'active', { cancel_at_period_end: true }));
  await sendWebhook({ id: 'evt_d2', type: 'customer.subscription.updated', data: { object: subscriptions.get(subId) } });
  res = await call('DELETE', '/api/auth/me', { password: 'password123' });
  assert.equal(res.status, 200);

  assert.equal((await call('GET', '/api/people')).status, 401);
  assert.equal((await client()('POST', '/api/auth/login', { email: 'leaving@example.com', password: 'password123' })).status, 401);
  // The email can be used for a new account.
  assert.equal((await client()('POST', '/api/auth/register', { name: 'Back', email: 'leaving@example.com', password: 'password123' })).status, 201);
});

test('past gifts: Premium can archive, view and restore; others are asked to upgrade', async () => {
  const { call, user } = await newUser();
  const { data: { person } } = await call('POST', '/api/people', { name: 'Dad', budget: 100 });
  const add = async (name, status, price) => (await call('POST', `/api/people/${person.id}/gifts`, { name, status, price })).data.gift;
  const socks = await add('Socks', 'wrapped', 10);
  const book = await add('Book', 'purchased', 15);
  const idea = await add('Drone', 'idea', 200);

  // Free plan: archiving needs Premium.
  let res = await call('POST', `/api/gifts/${socks.id}/archive`, {});
  assert.equal(res.status, 402);
  assert.equal(res.data.code, 'upgrade_required');
  assert.equal((await call('POST', `/api/people/${person.id}/archive-bought`, {})).status, 402);

  // Upgrade.
  const subId = `sub_${user.id}`;
  await call('POST', '/api/billing/checkout');
  subscriptions.set(subId, subscription(subId, `cus_${user.id}`, 'active'));
  await sendWebhook({ id: 'evt_p1', type: 'customer.subscription.updated', data: { object: subscriptions.get(subId) } });

  // Archive one gift with a label, then everything else that's been bought.
  res = await call('POST', `/api/gifts/${socks.id}/archive`, { label: 'Dad’s birthday 2026' });
  assert.equal(res.status, 200);
  assert.equal(res.data.gift.archive_label, 'Dad’s birthday 2026');
  res = await call('POST', `/api/people/${person.id}/archive-bought`, {});
  assert.equal(res.data.archived, 1); // just the book; the idea stays
  assert.match(res.data.person.archived.find((g) => g.id === book.id).archive_label, /^Christmas \d{4}$/);

  // Current list, budget and dashboard ignore past gifts.
  let detail = (await call('GET', `/api/people/${person.id}`)).data.person;
  assert.deepEqual(detail.gifts.map((g) => g.id), [idea.id]);
  assert.equal(detail.spent_cents, 0);
  assert.equal(detail.archived.length, 2);
  assert.equal(detail.archived_count, 2);
  const summary = (await call('GET', '/api/people')).data.people.find((p) => p.id === person.id);
  assert.equal(summary.gift_count, 1);
  assert.equal(summary.archived_count, 2);
  assert.equal(summary.n_wrapped, 0);

  // Past gifts are read-only until restored.
  res = await call('PATCH', `/api/gifts/${book.id}`, { status: 'wrapped' });
  assert.equal(res.status, 409);
  assert.equal(res.data.code, 'archived');
  assert.equal((await call('POST', `/api/gifts/${book.id}/restore`)).status, 200);
  assert.equal((await call('PATCH', `/api/gifts/${book.id}`, { status: 'wrapped' })).status, 200);

  // When Premium ends, past gifts are kept but hidden behind an upgrade.
  subscriptions.set(subId, subscription(subId, `cus_${user.id}`, 'canceled'));
  await sendWebhook({ id: 'evt_p2', type: 'customer.subscription.deleted', data: { object: subscriptions.get(subId) } });
  detail = (await call('GET', `/api/people/${person.id}`)).data.person;
  assert.equal(detail.archived, null);
  assert.equal(detail.archived_count, 1);
  assert.equal((await call('POST', `/api/gifts/${socks.id}/restore`)).status, 402);
  assert.equal((await call('DELETE', `/api/gifts/${socks.id}`)).status, 402);
});

test('feature requests are emailed to the site owner', async () => {
  // Logged out, with a reply address.
  const anon = client();
  let res = await anon('POST', '/api/feedback', { message: 'Please add birthday reminders!', name: 'Sam', email: 'Sam@Example.com' });
  assert.equal(res.status, 200);
  let mail1 = mail.at(-1);
  assert.equal(mail1.to, 'help@example.test');
  assert.equal(mail1.replyTo, 'sam@example.com');
  assert.match(mail1.subject, /^Giftlist feature request: Please add birthday reminders!$/);
  assert.match(mail1.text, /Please add birthday reminders!/);
  assert.match(mail1.text, /Not logged in/);

  // Logged in: name, email and plan come from the account.
  const { call } = await newUser('ideas@example.com');
  res = await call('POST', '/api/feedback', { message: 'Let me share a list with my partner. '.repeat(3) });
  assert.equal(res.status, 200);
  mail1 = mail.at(-1);
  assert.equal(mail1.replyTo, 'ideas@example.com');
  assert.match(mail1.text, /Account: Free \(user #\d+\)/);
  assert.match(mail1.subject, /…$/);

  // Validation and the spam trap.
  assert.equal((await anon('POST', '/api/feedback', { message: 'short' })).status, 400);
  assert.equal((await anon('POST', '/api/feedback', { message: 'A perfectly good idea here', email: 'nope' })).status, 400);
  const before = mail.length;
  assert.equal((await anon('POST', '/api/feedback', { message: 'Buy cheap watches now!!!', website: 'spam.example' })).status, 200);
  assert.equal(mail.length, before);
});

test('admin stats are only available to admin emails, and never include list contents', async () => {
  const visitor = client();
  assert.equal((await visitor('GET', '/api/admin/stats')).status, 404);

  const { call: someone } = await newUser();
  const { data: { person } } = await someone('POST', '/api/people', { name: 'Secret Santa Target' });
  await someone('POST', `/api/people/${person.id}/gifts`, { name: 'Very private present', status: 'buy' });
  assert.equal((await someone('GET', '/api/admin/stats')).status, 404);
  assert.equal((await someone('GET', '/api/auth/me')).data.user.is_admin, false);

  const { call: boss } = await newUser('boss@example.com');
  assert.equal((await boss('GET', '/api/auth/me')).data.user.is_admin, true);
  const res = await boss('GET', '/api/admin/stats');
  assert.equal(res.status, 200);
  const stats = res.data;
  const userCount = stats.users.length;
  assert.ok(stats.totals.users >= 2);
  assert.equal(stats.totals.users, userCount);
  assert.ok(stats.totals.users_7d >= 2);
  assert.ok(stats.totals.active_7d >= 2);
  assert.ok(stats.gifts_by_status.buy >= 1);
  assert.ok(stats.signups_by_week.length >= 1);
  assert.match(stats.signups_by_week[0].week_start, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(new Date(`${stats.signups_by_week[0].week_start}T00:00:00Z`).getUTCDay(), 1); // weeks start on Monday

  const row = stats.users.find((u) => u.people === 1 && u.gifts === 1);
  assert.ok(row);
  assert.equal(row.plan, 'free');
  assert.ok(row.last_login > Date.now() - 60_000);
  assert.equal(stats.users.find((u) => u.email === 'owner@example.com').plan, 'comped');
  assert.equal(stats.totals.comped, 1);

  const body = JSON.stringify(stats);
  assert.doesNotMatch(body, /Secret Santa Target|Very private present|password/);
});

test('a portal cancellation recorded as cancel_at counts as cancelled', async () => {
  const { call, user } = await newUser();
  const subId = `sub_${user.id}`;
  const customer = `cus_${user.id}`;
  await call('POST', '/api/billing/checkout');
  subscriptions.set(subId, subscription(subId, customer, 'active'));
  await sendWebhook({ id: 'evt_c1', type: 'customer.subscription.updated', data: { object: subscriptions.get(subId) } });
  assert.equal((await call('DELETE', '/api/auth/me', { password: 'password123' })).status, 409);

  // Cancelled in the portal: newer API versions set cancel_at and leave the old flag false.
  const endsAt = 1893456000; // 2030-01-01
  subscriptions.set(subId, subscription(subId, customer, 'active', { cancel_at: endsAt, cancel_at_period_end: false }));
  await sendWebhook({ id: 'evt_c2', type: 'customer.subscription.updated', data: { object: subscriptions.get(subId) } });
  const billing = (await call('GET', '/api/billing')).data.billing;
  assert.equal(billing.premium, true); // still Premium until it ends
  assert.equal(billing.subscription.cancel_at_period_end, true);
  assert.equal(billing.subscription.period_end, endsAt * 1000);
  assert.equal((await call('DELETE', '/api/auth/me', { password: 'password123' })).status, 200);
});

test('deleting re-checks Stripe, so a missed cancellation webhook does not block it', async () => {
  const { call, user } = await newUser();
  const subId = `sub_${user.id}`;
  await call('POST', '/api/billing/checkout');
  subscriptions.set(subId, subscription(subId, `cus_${user.id}`, 'active'));
  await sendWebhook({ id: 'evt_m1', type: 'customer.subscription.updated', data: { object: subscriptions.get(subId) } });

  // Cancelled in Stripe, but the webhook never arrived.
  subscriptions.set(subId, subscription(subId, `cus_${user.id}`, 'active', { cancel_at: 1893456000 }));
  assert.equal((await call('DELETE', '/api/auth/me', { password: 'password123' })).status, 200);
});

test('health check reports the version and whether the admin page is set up', async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.admin_page, 'enabled');
  assert.doesNotMatch(JSON.stringify(body), /@/);
});
