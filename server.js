require('dotenv').config();
const express = require('express');
const path = require('path');
const rateLimit = require('express-rate-limit');

const {
  SHOPIFY_STORE_DOMAIN,
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,
  SHOPIFY_API_VERSION = '2026-07',
  PORT = 3000,
} = process.env;

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Basic abuse protection on the public submission endpoint.
const submitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many submissions from this device. Please try again later.' },
});

// --- Validation -------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateCustomerPayload(body) {
  const errors = {};
  const clean = {};

  const firstName = (body.firstName || '').trim();
  const lastName = (body.lastName || '').trim();
  const email = (body.email || '').trim().toLowerCase();
  const phone = (body.phone || '').trim();
  const company = (body.company || '').trim();
  const note = (body.note || '').trim();
  const acceptsMarketing = Boolean(body.acceptsMarketing);

  const address1 = (body.address1 || '').trim();
  const city = (body.city || '').trim();
  const province = (body.province || '').trim();
  const country = (body.country || '').trim();
  const zip = (body.zip || '').trim();

  if (!firstName) errors.firstName = 'First name is required.';
  else if (firstName.length > 100) errors.firstName = 'First name is too long.';

  if (!lastName) errors.lastName = 'Last name is required.';
  else if (lastName.length > 100) errors.lastName = 'Last name is too long.';

  if (!email) errors.email = 'Email is required.';
  else if (!EMAIL_RE.test(email)) errors.email = 'Enter a valid email address.';

  if (phone && !/^[+()\-.\s\d]{7,20}$/.test(phone)) {
    errors.phone = 'Enter a valid phone number.';
  }

  if (note.length > 500) errors.note = 'Note must be 500 characters or fewer.';

  if (Object.keys(errors).length > 0) {
    return { errors };
  }

  clean.firstName = firstName;
  clean.lastName = lastName;
  clean.email = email;
  clean.phone = phone || undefined;
  clean.company = company || undefined;
  clean.note = note || undefined;
  clean.acceptsMarketing = acceptsMarketing;
  clean.address =
    address1 || city || province || country || zip
      ? {
          address1: address1 || undefined,
          city: city || undefined,
          province: province || undefined,
          country: country || undefined,
          zip: zip || undefined,
        }
      : undefined;

  return { clean };
}

// --- Shopify auth ---------------------------------------------------
//
// As of Jan 1, 2026, Shopify no longer issues a static Admin API token
// directly from the app UI for newly created apps. Instead, apps created in
// the Dev Dashboard authenticate via the OAuth client credentials grant:
// exchange the app's Client ID + Client Secret for a short-lived access
// token (~24h). We cache the token in memory and refresh it shortly before
// it expires, so normal request handling never pays the extra round trip.

let cachedToken = null; // { token, expiresAt }

async function getAccessToken() {
  const SAFETY_MARGIN_MS = 60 * 1000;

  if (cachedToken && cachedToken.expiresAt - SAFETY_MARGIN_MS > Date.now()) {
    return cachedToken.token;
  }

  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
    const err = new Error('Shopify credentials are not configured on the server.');
    err.code = 'CONFIG_MISSING';
    throw err;
  }

  const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const err = new Error(`Failed to obtain Shopify access token (${response.status})`);
    err.code = 'SHOPIFY_AUTH_ERROR';
    err.detail = text;
    throw err;
  }

  const data = await response.json();

  cachedToken = {
    token: data.access_token,
    // expires_in is in seconds; fall back to 24h if it's ever missing.
    expiresAt: Date.now() + (data.expires_in ? data.expires_in * 1000 : 24 * 60 * 60 * 1000),
  };

  return cachedToken.token;
}

// --- Shopify client -----------------------------------------------------

const CUSTOMER_CREATE_MUTATION = `
  mutation CustomerCreate($input: CustomerInput!) {
    customerCreate(input: $input) {
      customer {
        id
        firstName
        lastName
        email
        phone
      }
      userErrors {
        field
        message
      }
    }
  }
`;

async function createShopifyCustomer(customer) {
  const accessToken = await getAccessToken();

  const input = {
    firstName: customer.firstName,
    lastName: customer.lastName,
    email: customer.email,
    phone: customer.phone,
    note: customer.note,
    tags: customer.company ? [`company:${customer.company}`] : undefined,
    emailMarketingConsent: {
      marketingState: customer.acceptsMarketing ? 'SUBSCRIBED' : 'NOT_SUBSCRIBED',
      marketingOptInLevel: 'SINGLE_OPT_IN',
    },
    addresses: customer.address ? [customer.address] : undefined,
  };

  const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken,
    },
    body: JSON.stringify({ query: CUSTOMER_CREATE_MUTATION, variables: { input } }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const err = new Error(`Shopify API request failed (${response.status})`);
    err.code = 'SHOPIFY_HTTP_ERROR';
    err.detail = text;
    throw err;
  }

  const payload = await response.json();

  if (payload.errors && payload.errors.length > 0) {
    const err = new Error(payload.errors.map((e) => e.message).join('; '));
    err.code = 'SHOPIFY_GRAPHQL_ERROR';
    throw err;
  }

  const result = payload.data && payload.data.customerCreate;
  const userErrors = (result && result.userErrors) || [];

  if (userErrors.length > 0) {
    const err = new Error('Shopify rejected the customer.');
    err.code = 'SHOPIFY_USER_ERROR';
    err.userErrors = userErrors;
    throw err;
  }

  return result.customer;
}

// --- Routes ---------------------------------------------------------

app.post('/api/customers', submitLimiter, async (req, res) => {
  const { errors, clean } = validateCustomerPayload(req.body || {});

  if (errors) {
    return res.status(422).json({ error: 'Please fix the highlighted fields.', fields: errors });
  }

  try {
    const customer = await createShopifyCustomer(clean);
    return res.status(201).json({
      message: 'Customer created successfully.',
      customer: { id: customer.id, email: customer.email },
    });
  } catch (err) {
    if (err.code === 'CONFIG_MISSING') {
      console.error('Shopify credentials missing:', err.message);
      return res.status(500).json({ error: 'The server is not configured to reach Shopify yet.' });
    }

    if (err.code === 'SHOPIFY_AUTH_ERROR') {
      console.error('Shopify auth failed:', err.message, err.detail || '');
      return res.status(502).json({ error: 'Could not authenticate with Shopify. Please try again shortly.' });
    }

    if (err.code === 'SHOPIFY_USER_ERROR') {
      const fieldErrors = {};
      let generalMessage = 'Shopify could not create this customer.';

      for (const ue of err.userErrors) {
        const field = Array.isArray(ue.field) ? ue.field.join('.') : ue.field;
        if (field && field.includes('email')) {
          fieldErrors.email = ue.message;
        } else if (field && field.includes('phone')) {
          fieldErrors.phone = ue.message;
        } else {
          generalMessage = ue.message;
        }
      }

      return res.status(409).json({ error: generalMessage, fields: fieldErrors });
    }

    console.error('Shopify customer creation failed:', err.message, err.detail || '');
    return res.status(502).json({ error: 'Could not reach Shopify. Please try again in a moment.' });
  }
});

app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
    console.warn(
      'Warning: SHOPIFY_STORE_DOMAIN / SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET not set. Copy .env.example to .env and fill them in.'
    );
  }
});
