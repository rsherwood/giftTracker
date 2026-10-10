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

Product photo lookup makes outbound HTTP requests from the server. It refuses
private, loopback and link-local addresses, follows at most 4 redirects, and
caps both time and size. If the server has no direct internet access, gifts
fall back to generated artwork.

## Structure

```
src/index.js    Entry point (reads env, opens DB, starts server)
src/app.js      Express app: auth, people, gifts and image API routes
src/auth.js     Password hashing, sessions, rate limiting
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
3. Add environment variables `COOKIE_SECURE=true`, `TRUST_PROXY=1` and
   `DATABASE_FILE=/home/<user>/<folder>/data/gift-tracker.db`.
4. **Run NPM Install**, then **Start/Restart**. Back up `data/` regularly.
