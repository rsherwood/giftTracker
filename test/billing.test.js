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
