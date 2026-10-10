'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/app');
const images = require('../src/images');

let server;
let base;

before(async () => {
  const app = createApp(openDatabase(':memory:'), { fetchRemoteImages: false, authAttemptLimit: 1000 });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

// Minimal cookie-keeping client.
function client() {
  let cookie = '';
  return async function call(method, path, body, headers = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        'X-Requested-With': 'GiftTracker',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  };
}

let counter = 0;
async function signedIn() {
  const call = client();
  counter += 1;
  const res = await call('POST', '/api/auth/register', {
    name: 'Test User', email: `user${counter}@example.com`, password: 'correct horse', currency: 'GBP',
  });
  assert.equal(res.status, 201);
  return call;
}

test('register, log out, log back in', async () => {
  const call = client();
  let res = await call('POST', '/api/auth/register', { name: 'Ada', email: 'Ada@Example.com', password: 'password123' });
  assert.equal(res.status, 201);
  assert.equal(res.data.user.email, 'ada@example.com');

  res = await call('GET', '/api/auth/me');
  assert.equal(res.data.user.name, 'Ada');

  res = await call('POST', '/api/auth/register', { name: 'Ada', email: 'ada@example.com', password: 'password123' });
  assert.equal(res.status, 409);

  await call('POST', '/api/auth/logout');
  res = await call('GET', '/api/auth/me');
  assert.equal(res.data.user, null);
  res = await call('GET', '/api/people');
  assert.equal(res.status, 401);

  res = await call('POST', '/api/auth/login', { email: 'ada@example.com', password: 'wrong-password' });
  assert.equal(res.status, 401);
  res = await call('POST', '/api/auth/login', { email: 'ADA@example.com', password: 'password123' });
  assert.equal(res.status, 200);
  res = await call('GET', '/api/people');
  assert.equal(res.status, 200);
});

test('rejects weak passwords and bad emails', async () => {
  const call = client();
  let res = await call('POST', '/api/auth/register', { name: 'A', email: 'a@b.co', password: 'short' });
  assert.equal(res.status, 400);
  res = await call('POST', '/api/auth/register', { name: 'A', email: 'not-an-email', password: 'longenough' });
  assert.equal(res.status, 400);
});

test('mutating requests need the app header', async () => {
  const call = await signedIn();
  const res = await call('POST', '/api/people', { name: 'Sam' }, { 'X-Requested-With': '' });
  assert.equal(res.status, 403);
});

test('people with budgets and gift tracking through every status', async () => {
  const call = await signedIn();
  let res = await call('POST', '/api/people', { name: 'Mum', budget: '75.50', notes: 'Likes gardening' });
  assert.equal(res.status, 201);
  const mum = res.data.person;
  assert.equal(mum.budget_cents, 7550);

  res = await call('POST', `/api/people/${mum.id}/gifts`, { name: 'Gardening gloves', url: 'shop.example/gloves', price: 20 });
  assert.equal(res.status, 201);
  const gloves = res.data.gift;
  assert.equal(gloves.status, 'idea');
  assert.equal(gloves.url, 'https://shop.example/gloves');
  assert.equal(gloves.price_cents, 2000);
  assert.equal(gloves.image_source, 'generated');

  res = await call('POST', `/api/people/${mum.id}/gifts`, { name: 'Scented candle', price: '15.25' });
  const candle = res.data.gift;

  // Walk the gloves through the whole lifecycle.
  for (const status of ['buy', 'purchased', 'received', 'wrapped']) {
    res = await call('PATCH', `/api/gifts/${gloves.id}`, { status });
    assert.equal(res.status, 200);
    assert.equal(res.data.gift.status, status);
  }
  res = await call('PATCH', `/api/gifts/${candle.id}`, { status: 'buy' });
  res = await call('PATCH', `/api/gifts/${candle.id}`, { status: 'shipped' });
  assert.equal(res.status, 400);

  res = await call('GET', `/api/people/${mum.id}`);
  assert.equal(res.data.person.gifts.length, 2);
  assert.equal(res.data.person.spent_cents, 2000);
  assert.equal(res.data.person.planned_cents, 1525);

  res = await call('GET', '/api/people');
  const summary = res.data.people.find((p) => p.id === mum.id);
  assert.equal(summary.gift_count, 2);
  assert.equal(summary.n_wrapped, 1);
  assert.equal(summary.n_buy, 1);
  assert.equal(summary.spent_cents, 2000);

  res = await call('PATCH', `/api/people/${mum.id}`, { budget: 100 });
  assert.equal(res.data.person.budget_cents, 10000);
  assert.equal(res.data.person.name, 'Mum');
});

test('gift images are generated, served and refreshed on rename', async () => {
  const call = await signedIn();
  const { data: { person } } = await call('POST', '/api/people', { name: 'Dad' });
  const { data: { gift } } = await call('POST', `/api/people/${person.id}/gifts`, { name: 'Noise cancelling headphones' });

  let res = await call('GET', gift.image_url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/svg+xml');
  const svg = res.data.toString();
  assert.match(svg, /<svg/);
  assert.match(svg, /🎧/);
  assert.match(svg, /Noise cancelling/);

  res = await call('PATCH', `/api/gifts/${gift.id}`, { name: 'Coffee <grinder> & beans' });
  assert.notEqual(res.data.gift.image_url, gift.image_url);
  res = await call('GET', res.data.gift.image_url);
  assert.match(res.data.toString(), /☕/);
  assert.match(res.data.toString(), /Coffee &lt;grinder&gt; &amp; beans/);

  res = await call('POST', `/api/gifts/${gift.id}/image`, { source: 'generated' });
  assert.equal(res.status, 200);
  assert.equal(res.data.gift.image_version, 3);
});

test("users can't see or change each other's data", async () => {
  const alice = await signedIn();
  const bob = await signedIn();
  const { data: { person } } = await alice('POST', '/api/people', { name: 'Secret friend' });
  const { data: { gift } } = await alice('POST', `/api/people/${person.id}/gifts`, { name: 'Surprise' });

  assert.equal((await bob('GET', `/api/people/${person.id}`)).status, 404);
  assert.equal((await bob('PATCH', `/api/people/${person.id}`, { name: 'x' })).status, 404);
  assert.equal((await bob('DELETE', `/api/people/${person.id}`)).status, 404);
  assert.equal((await bob('POST', `/api/people/${person.id}/gifts`, { name: 'x' })).status, 404);
  assert.equal((await bob('PATCH', `/api/gifts/${gift.id}`, { status: 'buy' })).status, 404);
  assert.equal((await bob('GET', gift.image_url)).status, 404);
  assert.equal((await bob('DELETE', `/api/gifts/${gift.id}`)).status, 404);
  assert.deepEqual((await bob('GET', '/api/people')).data.people, []);
});

test('deleting a person removes their gifts', async () => {
  const call = await signedIn();
  const { data: { person } } = await call('POST', '/api/people', { name: 'Temp' });
  const { data: { gift } } = await call('POST', `/api/people/${person.id}/gifts`, { name: 'Thing' });
  assert.equal((await call('DELETE', `/api/people/${person.id}`)).status, 200);
  assert.equal((await call('PATCH', `/api/gifts/${gift.id}`, { status: 'buy' })).status, 404);
});

test('validates gift input', async () => {
  const call = await signedIn();
  const { data: { person } } = await call('POST', '/api/people', { name: 'Kid' });
  assert.equal((await call('POST', `/api/people/${person.id}/gifts`, { name: '' })).status, 400);
  assert.equal((await call('POST', `/api/people/${person.id}/gifts`, { name: 'x', price: -5 })).status, 400);
  assert.equal((await call('POST', `/api/people/${person.id}/gifts`, { name: 'x', url: 'javascript:alert(1)' })).status, 400);
  assert.equal((await call('POST', '/api/people', { name: 'y', budget: 'lots' })).status, 400);
});

test('finds product images in page metadata', () => {
  const html = `<html><head>
    <meta name="description" content="A thing">
    <meta content="/img/product.jpg?a=1&amp;b=2" property="og:image">
  </head></html>`;
  assert.equal(images.findImageUrl(html, 'https://shop.example/p/1'), 'https://shop.example/img/product.jpg?a=1&b=2');
  assert.equal(images.findImageUrl('<link rel="image_src" href="//cdn.example/x.png">', 'https://a.example/'), 'https://cdn.example/x.png');
  assert.equal(images.findImageUrl('<p>nothing</p>', 'https://a.example/'), null);
});

test('refuses to fetch images from private addresses', async () => {
  assert.equal(images.isPublicAddress('127.0.0.1', 4), false);
  assert.equal(images.isPublicAddress('10.1.2.3', 4), false);
  assert.equal(images.isPublicAddress('169.254.169.254', 4), false);
  assert.equal(images.isPublicAddress('::1', 6), false);
  assert.equal(images.isPublicAddress('8.8.8.8', 4), true);
  await assert.rejects(images.fetchProductImage('http://127.0.0.1:1/'));
  await assert.rejects(images.fetchProductImage('http://localhost:1/'));
  await assert.rejects(images.fetchProductImage('file:///etc/passwd'));
});
