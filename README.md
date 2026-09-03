# Shopify Customer Entry Form

A customer entry form that creates the submitted customer directly in a Shopify
store. Built with a small Node.js/Express backend and a static HTML/CSS/JS
frontend — no build step, no framework overhead.

## Why this architecture

**The Shopify Admin API token never touches the browser.** A form that calls
Shopify directly from client-side JavaScript would have to embed the Admin API
access token in the page source, where anyone can read it and use it to read
or write every customer, order, and product in the store. Instead, the browser
talks only to this app's own `/api/customers` endpoint; the Express server
holds the token in an environment variable and is the only thing that ever
calls Shopify.

**GraphQL, not REST.** Shopify's Admin REST API is legacy and has not received
new features since October 2024 — the GraphQL Admin API is the current
standard, so customer creation here uses the `customerCreate` mutation rather
than the old `/customers.json` REST endpoint.

**Plain HTML/CSS/JS on the frontend.** For a single form with a handful of
fields, a bundler and a UI framework add build complexity without adding
capability. It ships instantly, has zero client-side dependencies, and is easy
to audit.

## What the form collects

- First name, last name, email — required
- Phone, company, address, a free-text note, and an "accepts marketing"
  checkbox — optional

Company is stored as a customer tag (`company:<value>`) since Shopify
customers don't have a native company field outside B2B/Shopify Plus
accounts. Address fields map to a standard mailing address.

## Project structure

```
.
├── server.js              # Express app: validation + Shopify GraphQL call
├── public/
│   ├── index.html          # Form markup
│   ├── styles.css          # Styling
│   └── app.js               # Client-side validation + fetch to /api/customers
├── .env.example            # Template for required environment variables
└── package.json
```

## Setup

### 1. Create a Shopify custom app and get an Admin API token

1. In your Shopify admin, go to **Settings → Apps and sales channels → Develop
   apps** (enable custom app development first if you haven't already).
2. Click **Create an app**, give it a name (e.g. "Customer Entry Form").
3. Under **Configuration → Admin API integration**, grant the
   `write_customers` and `read_customers` scopes.
4. Click **Install app**, then reveal and copy the **Admin API access token**
   (starts with `shpat_`). Shopify only shows this once.

### 2. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env`:

```
SHOPIFY_STORE_DOMAIN=your-store.myshopify.com
SHOPIFY_ADMIN_API_TOKEN=shpat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### 3. Install and run

```bash
npm install
npm start
```

Visit `http://localhost:3000`.

For local development with auto-restart on file changes:

```bash
npm run dev
```

## API

### `POST /api/customers`

**Request body**

```json
{
  "firstName": "Ada",
  "lastName": "Lovelace",
  "email": "ada@example.com",
  "phone": "+1 555 000 0000",
  "company": "Analytical Engines Ltd",
  "note": "Met at the product demo",
  "address1": "12 Curzon Street",
  "city": "London",
  "province": "",
  "zip": "W1J 5HX",
  "country": "United Kingdom",
  "acceptsMarketing": true
}
```

`firstName`, `lastName`, and `email` are required; everything else is
optional.

**Responses**

| Status | Meaning |
| --- | --- |
| `201` | Customer created. Returns `{ message, customer: { id, email } }`. |
| `422` | Failed validation before ever calling Shopify. Returns `{ error, fields }` with a message per invalid field. |
| `409` | Shopify rejected the customer (e.g. email already exists). Returns `{ error, fields }`. |
| `429` | Rate limited (20 submissions / 15 min / IP). |
| `500` | Server isn't configured with Shopify credentials. |
| `502` | Shopify was unreachable or returned an unexpected error. |

### `GET /healthz`

Returns `{ status: "ok" }`. Useful for uptime checks / load balancer probes.

## Validation and error handling

- Both the browser and the server validate required fields, email format, and
  phone format — the server never trusts client-side validation alone.
- Duplicate-email and other Shopify-side rejections are surfaced back to the
  specific form field rather than as a generic failure.
- The submit button shows a loading state and disables itself while the
  request is in flight, and a status line reports success or failure.
- A rate limiter caps submissions per IP to reduce abuse of the public
  endpoint.

## Security notes

- `.env` is git-ignored; only `.env.example` (with placeholder values) is
  committed.
- The Admin API token is read server-side only and is never sent to the
  client.
- Request bodies are capped at 10kb to limit trivial payload abuse.
- Consider adding CSRF protection and a hosted WAF/CAPTCHA if this form will
  be exposed on a public marketing page rather than behind auth.

## Deployment

This is a standard Node/Express app and runs on any Node host (Render,
Railway, Fly.io, a VPS, etc.):

1. Set `SHOPIFY_STORE_DOMAIN` and `SHOPIFY_ADMIN_API_TOKEN` (and optionally
   `SHOPIFY_API_VERSION`, `PORT`) as environment variables on the host.
2. `npm install && npm start`.

## What I'd do next with more time

- Add automated tests (unit tests for `validateCustomerPayload`, an
  integration test against a mocked Shopify GraphQL endpoint).
- Add idempotency handling so a double-click or retried request can't create
  duplicate customers.
- Support Shopify's `customerMarketingConsent` nuances per region (e.g.
  double opt-in requirements in some markets).
- Add structured logging and request tracing for production observability.
