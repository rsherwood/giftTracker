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
- **Password reset** by email.
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
| `PREMIUM_EMAILS`       | unset                     | Comma-separated emails that get Premium free (e.g. yours) |

Product photo lookup makes outbound HTTP requests from the server. It refuses
private, loopback and link-local addresses, follows at most 4 redirects, and
caps both time and size. If the server has no direct internet access, gifts
fall back to generated artwork.

## Setting up Stripe

1. Create a Stripe account and, while testing, switch to **Test mode**.
2. **Product catalogue → Add product**: "Giftlist Premium", recurring price
   **£5.00 per year**. Copy the price ID (`price_…`) into `STRIPE_PRICE_ID`.
3. **Developers → API keys**: copy the secret key (`sk_test_…`, later
   `sk_live_…`) into `STRIPE_SECRET_KEY`.
4. **Developers → Webhooks → Add endpoint**:
   `https://YOUR-SITE/api/stripe/webhook`, with the events
   `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated` and `customer.subscription.deleted`.
   Copy its signing secret (`whsec_…`) into `STRIPE_WEBHOOK_SECRET`.
5. **Settings → Billing → Customer portal**: turn it on and allow customers to
   cancel and update their payment method. This powers "Manage subscription".
6. Restart the app and try an upgrade with the test card `4242 4242 4242 4242`.
   When it works, repeat steps 2–4 in live mode and swap in the live values.

Premium is checked on every request from what Stripe last told the webhook, so
renewals, failed payments (Premium is kept while Stripe retries) and
cancellations are picked up automatically.

## Structure

```
src/index.js    Entry point (reads env, opens DB, starts server)
src/app.js      Express app: auth, people, gifts and image API routes
src/auth.js     Password hashing, sessions, rate limiting
src/billing.js  Free/Premium plans, Stripe Checkout, portal and webhooks
src/mailer.js   Outgoing email (password resets)
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
