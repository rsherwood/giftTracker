'use strict';

// Subscription statuses that still give Premium. `past_due` keeps access
// while Stripe retries a failed renewal payment.
const PREMIUM_STATUSES = new Set(['active', 'trialing', 'past_due']);

const FREE_PEOPLE_LIMIT = 2;

// Tags our Checkout Sessions so this flow can be tracked in the Stripe Dashboard.
const INTEGRATION_IDENTIFIER = 'giftlist-premium-oifvwldj';

/**
 * Stripe-backed Premium plan.
 *
 * When no Stripe client is configured, billing is switched off and every
 * account is unlimited (handy for local development and self-hosting).
 */
function createBilling(db, { stripe = null, priceId = '', appUrl = '', priceLabel = '£5/year', premiumEmails = [] } = {}) {
  const enabled = Boolean(stripe && priceId);
  const comped = new Set(premiumEmails.map((e) => e.trim().toLowerCase()).filter(Boolean));

  const q = {
    user: db.prepare('SELECT * FROM users WHERE id = ?'),
    userByCustomer: db.prepare('SELECT * FROM users WHERE stripe_customer_id = ?'),
    setCustomer: db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?'),
    setSubscription: db.prepare(`
      UPDATE users SET subscription_id = ?, subscription_status = ?, subscription_period_end = ?,
        subscription_cancel_at_period_end = ?
      WHERE id = ?`),
    peopleCount: db.prepare('SELECT COUNT(*) AS n FROM people WHERE user_id = ?'),
    // Everyone after the first FREE_PEOPLE_LIMIT people the user added.
    peopleBeyondFree: db.prepare('SELECT id FROM people WHERE user_id = ? ORDER BY id LIMIT -1 OFFSET ?'),
  };

  function isPremium(user) {
    if (!enabled) return true;
    if (comped.has(String(user.email).toLowerCase())) return true;
    return PREMIUM_STATUSES.has(user.subscription_status);
  }

  function summary(userId) {
    const user = q.user.get(userId);
    const premium = isPremium(user);
    return {
      enabled,
      premium,
      plan: premium ? 'premium' : 'free',
      price_label: priceLabel,
      free_people_limit: FREE_PEOPLE_LIMIT,
      people_count: q.peopleCount.get(userId).n,
      // Only meaningful for a real Stripe subscription.
      subscription: user.subscription_id
        ? {
          status: user.subscription_status,
          period_end: user.subscription_period_end,
          cancel_at_period_end: Boolean(user.subscription_cancel_at_period_end),
        }
        : null,
      comped: enabled && comped.has(String(user.email).toLowerCase()),
    };
  }

  /** Whether this user may add another person. */
  function canAddPerson(userId) {
    const user = q.user.get(userId);
    return isPremium(user) || q.peopleCount.get(userId).n < FREE_PEOPLE_LIMIT;
  }

  /**
   * People the user can see but not change. Only non-empty after Premium
   * lapses: the first FREE_PEOPLE_LIMIT people (in the order they were added)
   * stay editable and the rest become read-only until the user upgrades again.
   */
  function lockedPeople(userId) {
    if (isPremium(q.user.get(userId))) return new Set();
    return new Set(q.peopleBeyondFree.all(userId, FREE_PEOPLE_LIMIT).map((row) => row.id));
  }

  async function customerFor(user) {
    if (user.stripe_customer_id) return user.stripe_customer_id;
    const customer = await stripe.customers.create({
      email: user.email,
      name: user.name,
      metadata: { user_id: String(user.id) },
    });
    q.setCustomer.run(customer.id, user.id);
    return customer.id;
  }

  async function createCheckout(userId) {
    const user = q.user.get(userId);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      integration_identifier: INTEGRATION_IDENTIFIER,
      customer: await customerFor(user),
      client_reference_id: String(user.id),
      line_items: [{ price: priceId, quantity: 1 }],
      allow_promotion_codes: true,
      subscription_data: { metadata: { user_id: String(user.id) } },
      // UK consumer law: digital services can start straight away only if the
      // customer agrees that this ends their 14-day cancellation right.
      custom_text: {
        submit: {
          message: 'Premium starts immediately. By subscribing you agree that it begins now and that your 14-day '
            + 'cancellation right ends once it does. You can cancel future renewals at any time.',
        },
      },
      success_url: `${appUrl}/#/account?checkout=success`,
      cancel_url: `${appUrl}/#/account`,
    });
    return session.url;
  }

  async function createPortal(userId) {
    const user = q.user.get(userId);
    if (!user.stripe_customer_id) return null;
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: `${appUrl}/#/account`,
    });
    return session.url;
  }

  // Newer Stripe API versions keep the billing period on the subscription items.
  function periodEnd(subscription) {
    const end = subscription.current_period_end ?? subscription.items?.data?.[0]?.current_period_end;
    return end ? end * 1000 : null;
  }

  function saveSubscription(user, subscription) {
    // Newer Stripe API versions record "cancel at the end of the period" (e.g. from
    // the customer portal) as a scheduled `cancel_at` date rather than the older
    // `cancel_at_period_end` flag, so either one means it won't renew.
    const cancelAt = subscription.cancel_at ? subscription.cancel_at * 1000 : null;
    const cancelling = Boolean(subscription.cancel_at_period_end || cancelAt);
    q.setSubscription.run(
      subscription.id,
      subscription.status,
      cancelAt || periodEnd(subscription),
      cancelling ? 1 : 0,
      user.id,
    );
  }

  // Re-reads the user's subscription from Stripe, in case a webhook was missed or
  // stored before this app understood `cancel_at`. Throttled per user.
  const lastRefresh = new Map();
  async function refreshFromStripe(userId, { force = false } = {}) {
    if (!enabled) return;
    const user = q.user.get(userId);
    if (!user || !user.subscription_id || !PREMIUM_STATUSES.has(user.subscription_status)) return;
    const now = Date.now();
    if (!force && now - (lastRefresh.get(userId) || 0) < 5 * 60 * 1000) return;
    lastRefresh.set(userId, now);
    try {
      saveSubscription(user, await stripe.subscriptions.retrieve(user.subscription_id));
    } catch (err) {
      console.error('Could not refresh subscription from Stripe:', err.message);
    }
  }

  async function syncSubscription(subscriptionId, customerId, fallbackUserId) {
    let user = customerId ? q.userByCustomer.get(customerId) : null;
    if (!user && fallbackUserId) {
      user = q.user.get(Number(fallbackUserId));
      if (user && customerId && !user.stripe_customer_id) q.setCustomer.run(customerId, user.id);
    }
    if (!user) return;
    // Events can arrive out of order, so always read the latest state from Stripe.
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    // Ignore an old subscription once the user has a newer one.
    if (user.subscription_id && user.subscription_id !== subscription.id
        && PREMIUM_STATUSES.has(user.subscription_status) && !PREMIUM_STATUSES.has(subscription.status)) {
      return;
    }
    saveSubscription(user, subscription);
  }

  // Newer API versions moved an invoice's subscription under `parent`.
  function invoiceSubscription(invoice) {
    const ref = invoice.parent?.subscription_details?.subscription ?? invoice.subscription;
    return typeof ref === 'string' ? ref : ref?.id;
  }

  async function handleEvent(event) {
    const object = event.data.object;
    switch (event.type) {
      case 'checkout.session.completed':
      // Bank-debit payments (e.g. Bacs) complete after the session does.
      case 'checkout.session.async_payment_succeeded':
        if (object.mode === 'subscription' && object.subscription) {
          await syncSubscription(object.subscription, object.customer, object.client_reference_id);
        }
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
      case 'customer.subscription.paused':
      case 'customer.subscription.resumed':
        await syncSubscription(object.id, object.customer, object.metadata?.user_id);
        break;
      // Renewals and failed renewal payments. Re-reading the subscription picks
      // up the new period end, or `past_due` / `unpaid` when payment fails.
      case 'invoice.paid':
      case 'invoice.payment_failed': {
        const subscriptionId = invoiceSubscription(object);
        if (subscriptionId) await syncSubscription(subscriptionId, object.customer);
        break;
      }
      default:
        break;
    }
  }

  return {
    enabled, priceLabel, isPremium, summary, canAddPerson, lockedPeople, createCheckout, createPortal, handleEvent, refreshFromStripe,
    FREE_PEOPLE_LIMIT,
  };
}

module.exports = { createBilling, FREE_PEOPLE_LIMIT };
