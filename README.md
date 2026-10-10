# Giftlist — gift idea tracker

A small web app for keeping track of gifts. Users create an account, add the
people they buy for with a budget for each, and log gift ideas (item name, link
and price) per person. Each gift is tracked through:

**Idea → Buy → Purchased → Received → Wrapped**

## Features

- **Accounts**: email and password sign-up and log-in. Passwords are hashed with
  scrypt, and sessions use an HttpOnly cookie. Each user only sees their own data.
- **People & budgets**: each person gets a budget bar showing what's been spent
  (Purchased, Received or Wrapped), what's planned (Buy), and what's left or over.
- **Gift ideas**: name, optional link, price. Filter by status, move forward with
  one click, or jump to any step with the status stepper.
- **Automatic images**: every gift gets a picture when it's added.
  - If it has a link, the server looks for the product photo on that page
    (`og:image` / `twitter:image`).
  - Otherwise (or if no photo is found) it generates artwork: a colour gradient
    taken from the item name, an icon picked from keywords (🎧 headphones,
    ☕ coffee, 📚 books, …), and the item name.
  - Renaming a gift updates generated artwork. The card menu can also switch
    between the product photo and generated artwork.
- **Plans**: free for up to 2 people; **Premium** (£5/year, via Stripe) for
  unlimited people. If Premium lapses, nothing is deleted: the first 2 people
  the user added stay fully editable, and everyone else becomes read-only
  (viewable and deletable, but their details and gifts can't be changed)
  until they renew.
- **Past gifts** (Premium): archive bought gifts under an occasion such as
  "Christmas 2026" (one at a time, or everything bought for a person in one
  go) to remember what you gave in previous years. Archiving resets that
  person's budget. If Premium lapses, past gifts are kept but hidden.
- **Password reset** by email, and **account deletion** from the account page.
- **Terms of Service** (`/terms`) and **Privacy Policy** (`/privacy`), with the
  company details, price and contact email filled in automatically. Edit them
  in `src/legal/`.
- **Currency** per user (USD, GBP, EUR, CAD, AUD, NZD, JPY, INR).
- Responsive layout with light and dark themes.

## Running it

Requires **Node.js 22.13+**. It uses the built-in `node:sqlite`, so there's no
native database driver to compile.

```
cd giftTracker
npm install
npm start          # http://localhost:3000
npm test           # API + image tests
```

Configuration (environment variables):

| Variable               | Default                   | Purpose                                             |
| ---------------------- | ------------------------- | --------------------------------------------------- |
| `PORT`                 | `3000`                    | HTTP port                                           |
| `DATABASE_FILE`        | `data/gift-tracker.db`    | SQLite file (created automatically)                 |
| `COOKIE_SECURE`        | `false`                   | Set `true` when served over HTTPS                   |
| `TRUST_PROXY`          | unset                     | e.g. `1` behind a reverse proxy, for correct client IPs |
| `FETCH_PRODUCT_IMAGES` | `true`                    | `false` = always use generated artwork              |
| `APP_URL`              | `http://localhost:PORT`   | Public address, e.g. `https://gifts.example.co.uk` (used in emails and Stripe links) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | unset | Outgoing email for password resets. Without them, reset links are printed to the server log |
| `STRIPE_SECRET_KEY`    | unset                     | Stripe secret key. **Without Stripe settings, billing is off and everyone is unlimited** |
| `STRIPE_PRICE_ID`      | unset                     | The yearly Premium price (`price_…`)                |
| `STRIPE_WEBHOOK_SECRET`| unset                     | Signing secret of the webhook endpoint (`whsec_…`)  |
| `PRICE_LABEL`          | `£5/year`                 | Price shown in the app                              |
| `CONTACT_EMAIL`        | `MAIL_FROM`, else `hello@firstwebdev.co.uk` | Contact address shown in the Terms and Privacy Policy |
| `PREMIUM_EMAILS`       | unset                     | Comma-separated emails that get Premium free (e.g. yours) |

Product photo lookup makes outbound HTTP requests from the server. It refuses
private, loopback and link-local addresses, follows at most 4 redirects, and
caps both time and size. If the server has no direct internet access, gifts
fall back to generated artwork.

## Setting up Stripe

Build and test in a **sandbox** first, then repeat the same steps in live mode.

1. **Create a sandbox.** In the Stripe Dashboard, open the account menu →
   **Sandboxes → Create sandbox** (e.g. "Giftlist dev"). Sandboxes keep test
   data and settings separate from live mode.
2. **Product and price.** **Product catalogue → Add product**: name
   "Giftlist Premium", recurring price **£5.00 per year**. Copy the price ID
   (`price_…`) into `STRIPE_PRICE_ID`.
3. **API key (restricted).** **Developers → API keys → Create restricted key**,
   named "Giftlist server", with only these permissions:

   | Resource | Permission |
   | --- | --- |
   | Customers | Write |
   | Checkout Sessions | Write |
   | Customer portal | Write |
   | Subscriptions | Read |

   Put the key (`rk_test_…`, later `rk_live_…`) in `STRIPE_SECRET_KEY`. Store it
   only in the hosting control panel's environment variables, never in the
   code or in git.
4. **Webhook.** **Developers → Webhooks → Add destination**, endpoint
   `https://YOUR-SITE/api/stripe/webhook`, API version **2026-09-30.endive**
   (the version the app is pinned to), listening for:

   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `customer.subscription.created`, `.updated`, `.deleted`, `.paused`, `.resumed`
   - `invoice.paid`
   - `invoice.payment_failed`

   Copy the signing secret (`whsec_…`) into `STRIPE_WEBHOOK_SECRET`.
5. **Customer portal.** **Settings → Billing → Customer portal**: turn it on
   and allow customers to cancel subscriptions, update payment methods and see
   invoices. This powers "Manage subscription".
6. **Failed payments.** **Settings → Billing → Subscriptions and emails**: turn
   on Smart Retries and the emails for failed payments and expiring cards, so
   Stripe chases failed renewals for you. While Stripe retries, the user keeps
   Premium (`past_due`); if every retry fails, the subscription is cancelled
   and the user drops to the free plan.
7. **Test.** Restart the app and upgrade with the test card
   `4242 4242 4242 4242` (any future expiry, any CVC). To try a renewal or a
   failed renewal without waiting a year, use a **test clock** (Billing → Test
   clocks) to move a test customer's subscription forward in time. The
   webhook's event log in the Dashboard shows each delivery and the app's
   response. If a call fails with a permissions error, add that permission
   to the restricted key.
8. **Go live.** Repeat steps 2–6 in live mode with a new restricted key and
   webhook secret, and work through Stripe's
   [go-live checklist](https://docs.stripe.com/get-started/checklist/go-live).

**VAT / tax:** the app doesn't turn on Stripe Tax. That's correct while the
business isn't VAT-registered. If you register for UK VAT, or sell to EU
consumers in a way that requires EU VAT registration, add the registration in
**Stripe Tax** first, then enable automatic tax on the Checkout Session.
Enabling it without a registration silently collects nothing.

**How the app stays in sync:** every webhook re-reads the subscription from
Stripe rather than trusting the event body, so retries, duplicates and events
arriving out of order are all safe. Users are matched to Stripe by customer
ID; the user ID in Checkout's `client_reference_id` is only a fallback.

## Structure

```
src/index.js    Entry point (reads env, opens DB, starts server)
src/app.js      Express app: auth, people, gifts and image API routes
src/auth.js     Password hashing, sessions, rate limiting
src/billing.js  Free/Premium plans, Stripe Checkout, portal and webhooks
src/mailer.js   Outgoing email (password resets)
src/legal/      Terms of Service and Privacy Policy text
src/db.js       SQLite schema
src/images.js   Generated SVG artwork + product photo lookup
public/         Single-page front end (vanilla JS, no build step)
test/           node:test API tests
```

## Hosting

This app needs a Node server and a persistent disk for the SQLite file, for
example Render, Railway, Fly.io, a small VPS, or cPanel hosting with
"Setup Node.js App" (e.g. Krystal). It can't run on static-only hosting.

### cPanel (e.g. Krystal)

1. Upload the project to your home directory (outside `public_html`).
2. **Setup Node.js App → Create Application**: Node.js 22.13+, Production mode,
   application root = the uploaded folder, startup file `src/index.js`.
3. Add environment variables `COOKIE_SECURE=true`, `TRUST_PROXY=1`,
   `APP_URL=https://your-subdomain`, plus the email and Stripe settings above.
   For email, create a mailbox in cPanel (e.g. `noreply@yourdomain`) and use
   its SMTP details (usually port 465).
4. **Run NPM Install**, then **Start/Restart**. Back up `data/` regularly.
