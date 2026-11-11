'use strict';

/**
 * End-to-end sell path against local mocks.
 * No live Stripe key, no call to api.stripe.com, no call to api.resend.com.
 * Webhooks are signed with Stripe's generateTestHeaderString / constructEvent scheme.
 */

const http = require('http');
const { spawn } = require('child_process');
const { Client } = require('pg');
const Stripe = require('stripe');
const { applyMigrations } = require('../lib/migrate');

const root = require('path').join(__dirname, '..');
const ADMIN_URL = process.env.FULFILLMENT_ADMIN_URL || 'postgresql:///postgres?host=/var/run/postgresql';
const DB_NAME = `bidcheckpro_e2e_${process.pid}`;
const MARKER = 'E2E_BID_MARKER_DO_NOT_LEAK';
const MISMATCH = `Labor $1,000\nMaterials $800\nElectrical $360\nTotal $2,660\n${MARKER}`;
const MATCH = 'Labor $1,000\nMaterials $800\nElectrical $360\nTotal $2,160';

function assert(condition, message) {
  if (!condition) {
    const error = new Error(message);
    error.code = 'e2e_failed';
    throw error;
  }
}

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function startStripeMock() {
  const requests = [];
  const server = await listen(async (req, res) => {
    const raw = await readBody(req);
    requests.push({ method: req.method, url: req.url, raw });
    const params = new URLSearchParams(raw);
    const amount = params.get('line_items[0][price_data][unit_amount]');
    const id = `cs_test_e2e_${requests.length}`;
    const body = {
      id,
      object: 'checkout.session',
      url: `https://checkout.stripe.test/c/pay/${id}`,
      payment_status: 'unpaid',
      mode: 'payment',
      amount_total: Number(amount || 0),
      currency: 'usd',
      metadata: {
        bidId: params.get('metadata[bidId]') || '',
        tier: params.get('metadata[tier]') || '',
      },
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  return { server, requests, port: server.address().port };
}

async function startResendMock() {
  const messages = [];
  const server = await listen(async (req, res) => {
    const raw = await readBody(req);
    let body = {};
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      body = { raw };
    }
    messages.push({
      method: req.method,
      url: req.url,
      idempotencyKey: req.headers['idempotency-key'] || '',
      authorization: req.headers.authorization || '',
      body,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: `email_inert_${messages.length}` }));
  });
  return { server, messages, port: server.address().port };
}

async function freePort() {
  const server = await listen((req, res) => {
    res.writeHead(404);
    res.end();
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForOk(url, child) {
  const deadline = Date.now() + 60000;
  let lastError = 'not started';
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`next start exited ${child.exitCode} before it was ready (${lastError})`);
    }
    try {
      const response = await fetch(url);
      if (response.status < 500) return response;
      lastError = `status ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`timed out waiting for ${url}: ${lastError}`);
}

function signedEvent(secret, event) {
  const stripe = new Stripe('sk_test_webhook_construct_only_00', { telemetry: false, maxNetworkRetries: 0 });
  const payload = JSON.stringify(event);
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
  return { payload, header };
}

function completedEvent({ id, sessionId, bidId, amountTotal, tier }) {
  return {
    id,
    object: 'event',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: sessionId,
        object: 'checkout.session',
        payment_status: 'paid',
        amount_total: amountTotal,
        currency: 'usd',
        customer_details: { email: 'synthetic-buyer@example.test' },
        metadata: { bidId, tier },
      },
    },
  };
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await response.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: response.status, json };
}

async function main() {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  await admin.end();
  const databaseUrl = `postgresql:///${DB_NAME}?host=/var/run/postgresql`;
  await applyMigrations(databaseUrl);

  const stripeMock = await startStripeMock();
  const resendMock = await startResendMock();
  const appPort = await freePort();
  const webhookSecret = `whsec_${Buffer.from(require('crypto').randomBytes(24)).toString('base64')}`;
  const logs = [];
  const nextBin = require.resolve('next/dist/bin/next');
  const child = spawn(process.execPath, [nextBin, 'start', '-p', String(appPort), '-H', '127.0.0.1'], {
    cwd: root,
    env: {
      ...process.env,
      STRIPE_SECRET_KEY: 'sk_test_e2e_local_not_a_real_key',
      STRIPE_WEBHOOK_SECRET: webhookSecret,
      STRIPE_MOCK_HOST: '127.0.0.1',
      STRIPE_MOCK_PORT: String(stripeMock.port),
      NEXT_PUBLIC_BASE_URL: 'https://preview.bidcheckpro.test',
      FULFILLMENT_DATABASE_URL: databaseUrl,
      RESEND_API_KEY: 're_e2e_inert',
      RESEND_FROM: 'BidCheckPro <reviews@example.test>',
      RESEND_API_BASE: `http://127.0.0.1:${resendMock.port}`,
      AI_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));

  const base = `http://127.0.0.1:${appPort}`;
  const db = new Client({ connectionString: databaseUrl });
  try {
    delete process.env.AI_API_KEY;
    const home = await waitForOk(`${base}/`, child);
    const html = await home.text();
    assert(html.includes('Check one bid'), 'home page is missing the single-bid checkout button');
    assert(html.includes('Compare my bids'), 'home page is missing the compare checkout button');
    assert(html.includes('Cover my project'), 'home page is missing the full-project checkout button');
    assert(html.includes('$79') && html.includes('$149') && html.includes('$359'), 'home page is missing the catalog prices');
    assert(!html.includes('Unavailable'), 'a checkout button is still marked unavailable');

    const preview = await postJson(`${base}/api/review`, {
      bidText: MISMATCH,
      side: 'receiving',
      consent: false,
    });
    assert(preview.status === 200, `review status ${preview.status} ${JSON.stringify(preview.json)}`);
    assert(JSON.stringify(preview.json).includes('2160 vs 2660'), 'review did not flag 2160 vs 2660');

    const compared = await postJson(`${base}/api/compare`, {
      bidText: MISMATCH,
      secondBidText: MATCH,
      side: 'receiving',
    });
    assert(compared.status === 200, `compare status ${compared.status}`);
    assert(compared.json.comparison.bidACents === 266000, 'compare bid A total');
    assert(compared.json.comparison.bidBCents === 216000, 'compare bid B total');

    const closed = await postJson(`${base}/api/send-email`, {
      to: 'synthetic-attacker@example.test',
      subject: 'open relay',
      text: 'should not send',
    });
    assert(closed.status === 403, `send-email status ${closed.status}`);
    assert(resendMock.messages.length === 0, 'public send-email reached the mail sink');

    const checkout = await postJson(`${base}/api/checkout`, {
      tier: 'single',
      bidText: MISMATCH,
      side: 'receiving',
      consent: true,
      amount: 50,
    });
    assert(checkout.status === 200, `checkout status ${checkout.status} ${JSON.stringify(checkout.json)}`);
    assert(checkout.json.url.startsWith('https://checkout.stripe.test/'), 'checkout did not return the mock session URL');
    assert(!JSON.stringify(checkout.json).includes(MARKER), 'checkout response leaked the bid marker');
    const createCalls = stripeMock.requests.filter((request) => request.url.includes('/v1/checkout/sessions'));
    assert(createCalls.length === 1, `expected 1 Stripe session create, saw ${createCalls.length}`);
    assert(createCalls[0].raw.includes('7900'), `Stripe mock was not charged 7900: ${createCalls[0].raw}`);
    assert(!createCalls[0].raw.includes('unit_amount]=50') && !createCalls[0].raw.includes('unit_amount=50'), 'client amount was forwarded to Stripe');
    assert(!createCalls[0].raw.includes(MARKER), 'full bid text was sent to Stripe');

    await db.connect();
    const stored = await db.query('SELECT bid_text, session_id, amount_cents, payment_status FROM fulfillment_bids WHERE bid_id = $1', [checkout.json.bidId]);
    assert(stored.rowCount === 1, 'bid row missing');
    assert(stored.rows[0].bid_text.includes(MARKER), 'database did not keep the bid');
    assert(stored.rows[0].amount_cents === 7900, 'stored amount was not 7900');
    assert(stored.rows[0].payment_status === 'unpaid', 'bid was marked paid before the webhook');
    const sessionId = stored.rows[0].session_id;

    const event = completedEvent({
      id: 'evt_e2e_1',
      sessionId,
      bidId: checkout.json.bidId,
      amountTotal: 7900,
      tier: 'single',
    });
    const signed = signedEvent(webhookSecret, event);
    const fulfilled = await postJson(`${base}/api/webhook`, signed.payload, { 'stripe-signature': signed.header });
    assert(fulfilled.status === 200, `webhook status ${fulfilled.status} ${JSON.stringify(fulfilled.json)}`);
    assert(fulfilled.json.fulfilled === true, 'webhook did not fulfill');
    assert(!JSON.stringify(fulfilled.json).includes('synthetic-buyer@example.test'), 'webhook response echoed the buyer');
    assert(!JSON.stringify(fulfilled.json).includes(MARKER), 'webhook response echoed the bid');
    assert(resendMock.messages.length === 1, `expected 1 inert email, saw ${resendMock.messages.length}`);
    assert(resendMock.messages[0].idempotencyKey === 'fulfillment:evt_e2e_1', 'idempotency key was not forwarded');
    assert(resendMock.messages[0].body.text.includes('2160 vs 2660'), 'email did not include the arithmetic mismatch');
    assert(!resendMock.messages[0].body.text.includes(MARKER), 'email included the raw bid marker');
    assert(String(resendMock.messages[0].authorization).includes('re_e2e_inert'), 'inert Resend key was not presented to the local sink');

    const paid = await db.query('SELECT payment_status FROM fulfillment_bids WHERE bid_id = $1', [checkout.json.bidId]);
    assert(paid.rows[0].payment_status === 'paid', 'bid was not marked paid');

    const replay = await postJson(`${base}/api/webhook`, signed.payload, { 'stripe-signature': signed.header });
    assert(replay.status === 200 && replay.json.duplicate === true, 'replay was not idempotent');
    const second = signedEvent(webhookSecret, completedEvent({
      id: 'evt_e2e_2',
      sessionId,
      bidId: checkout.json.bidId,
      amountTotal: 7900,
      tier: 'single',
    }));
    const duplicateSession = await postJson(`${base}/api/webhook`, second.payload, { 'stripe-signature': second.header });
    assert(duplicateSession.status === 200 && duplicateSession.json.duplicate === true, 'second event id fulfilled again');
    assert(resendMock.messages.length === 1, `email sink received ${resendMock.messages.length} messages after replay`);

    const forged = await postJson(`${base}/api/webhook`, signed.payload.replace('"amount_total":7900', '"amount_total":100'), {
      'stripe-signature': signed.header,
    });
    assert(forged.status === 400 && forged.json.code === 'invalid_signature', 'forged webhook was accepted');

    const compare = await postJson(`${base}/api/checkout`, {
      tier: 'compare',
      bidText: MISMATCH,
      secondBidText: MATCH,
      side: 'receiving',
      consent: true,
      amount: 100,
    });
    const full = await postJson(`${base}/api/checkout`, {
      tier: 'full',
      bidText: MISMATCH,
      side: 'receiving',
      consent: true,
      amount: 100,
    });
    assert(compare.status === 200 && full.status === 200, 'compare or full checkout failed');
    const amounts = stripeMock.requests.map((request) => new URLSearchParams(request.raw).get('line_items[0][price_data][unit_amount]'));
    assert(amounts.includes('14900'), `compare price missing from ${amounts.join(',')}`);
    assert(amounts.includes('35900'), `full price missing from ${amounts.join(',')}`);

    const sessionRows = await db.query('SELECT COUNT(DISTINCT checkout_session_id)::int AS sessions, COUNT(*) FILTER (WHERE delivery_status = \'sent\')::int AS sent FROM fulfillment_events WHERE checkout_session_id = $1 OR event_id IN (\'evt_e2e_1\', \'evt_e2e_2\')', [sessionId]);
    assert(sessionRows.rows[0].sessions === 1, 'more than one checkout session claim');
    assert(sessionRows.rows[0].sent === 1, 'more than one sent delivery');

    console.log(JSON.stringify({
      ok: true,
      app: base,
      checkoutSession: sessionId,
      stripeCreates: amounts,
      emails: resendMock.messages.length,
      database: DB_NAME,
    }));
  } catch (error) {
    console.error(logs.join('').slice(-4000));
    throw error;
  } finally {
    const signalGroup = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // already exited
        }
      }
    };
    signalGroup('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        signalGroup('SIGKILL');
        resolve();
      }, 4000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    const closeServer = (server) => new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        resolve();
      }, 2000);
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    await closeServer(stripeMock.server);
    await closeServer(resendMock.server);
    await db.end().catch(() => {});
    const cleanup = new Client({ connectionString: ADMIN_URL });
    await cleanup.connect();
    await cleanup.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await cleanup.end();
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
