'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, test, beforeEach, afterEach } = require('node:test');
const {
  createRecordingTransport,
  resetTestDoubles,
  sign,
  completedEvent,
  captureLogs,
  getFulfillmentStore,
} = require('./helpers');
const { setEmailTransportForTests } = require('../lib/email');
const { setModelClientForTests } = require('../lib/model-client');
const { setFulfillmentStoreForTests, createMemoryFulfillmentStore } = require('../lib/store');
const { hashAccessToken } = require('../lib/tokens');
const {
  handleCheckout,
  handleReview,
  handleVerifySession,
  handleSendEmail,
  handleWebhook,
  handleWebhookGet,
} = require('../lib/handlers');

const root = path.join(__dirname, '..');
const LONG_BID = `${'Line item padding '.repeat(30)}\nFULL_BID_MARKER\nAFTER_CUT_${'Z'.repeat(80)}`;
const RULE_BID = 'Framing labor ........ 240 hr  $65  $99999\nContingency .......... open';

function savedEnv(names) {
  const previous = {};
  names.forEach((name) => {
    previous[name] = process.env[name];
  });
  return previous;
}

function restoreEnv(previous) {
  Object.entries(previous).forEach(([name, value]) => {
    if (value == null) delete process.env[name];
    else process.env[name] = value;
  });
}

describe('prelaunch fulfillment gates', { concurrency: false }, () => {
  let doubles;
  let envSnapshot;

  beforeEach(() => {
    envSnapshot = savedEnv([
      'NODE_ENV',
      'STRIPE_WEBHOOK_SECRET',
      'STRIPE_SECRET_KEY',
      'NEXT_PUBLIC_BASE_URL',
      'AI_API_KEY',
      'RESEND_API_KEY',
      'EMAIL_DELIVERY_ENABLED',
      'FULFILLMENT_DATABASE_URL',
      'FULFILLMENT_RETENTION_DAYS',
    ]);
    doubles = resetTestDoubles();
  });

  afterEach(() => {
    process.env.NODE_ENV = 'test';
    setEmailTransportForTests(null);
    setModelClientForTests(null);
    restoreEnv(envSnapshot);
  });

  test('client paid flag does not unlock a full review', async () => {
    const calls = [];
    setModelClientForTests(async (input) => {
      calls.push(input);
      return {
        flags: [1, 2, 3, 4].map((n) => ({ line: `L${n}`, issue: 'x', note: 'n', severity: 'low' })),
        summary: 'model preview',
        questions: [],
      };
    });
    const result = await handleReview({
      bidText: LONG_BID,
      side: 'receiving',
      consent: true,
      paid: true,
    });
    assert.equal(result.status, 200);
    assert.equal(result.json.preview, true);
    assert.equal(result.json.flags.length, 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].thorough, false);
    assert.equal(calls[0].bidText, LONG_BID);
    assert.equal(JSON.stringify(result.json).includes('FULL_BID_MARKER'), false);
  });

  test('consent is required before model processing and is not required for local rules', async () => {
    const calls = [];
    setModelClientForTests(async () => {
      calls.push('called');
      return { flags: [], summary: 'should not run', questions: [] };
    });
    const refused = await handleReview({ bidText: RULE_BID, side: 'sending', consent: false, paid: true });
    assert.equal(refused.status, 400);
    assert.equal(refused.json.code, 'consent_required');
    assert.equal(calls.length, 0);

    setModelClientForTests(null);
    const local = await handleReview({ bidText: RULE_BID, side: 'sending', consent: false });
    assert.equal(local.status, 200);
    assert.equal(local.json.preview, true);
    assert.equal(doubles.store.bidCount(), 0);
  });

  test('free preview does not store the bid even with consent', async () => {
    const result = await handleReview({ bidText: LONG_BID, side: 'receiving', consent: true });
    assert.equal(result.status, 200);
    assert.equal(doubles.store.bidCount(), 0);
  });

  test('unsupported and unknown tiers are refused and do not store a bid', async () => {
    for (const tier of ['compare', 'full', 'mystery', undefined]) {
      const result = await handleCheckout({ tier, bidText: LONG_BID, side: 'receiving', consent: true });
      assert.equal(result.status, 400, `tier ${tier}`);
      assert.equal(result.json.code, 'offer_unavailable');
    }
    assert.equal(doubles.store.bidCount(), 0);
    assert.equal(doubles.gateway.calls.length, 0);
  });

  test('checkout requires consent, keeps the full bid out of Stripe, and returns an unguessable token', async () => {
    const { lines } = await captureLogs(async () => {
      const refused = await handleCheckout({ tier: 'single', bidText: LONG_BID, side: 'receiving', consent: false });
      assert.equal(refused.status, 400);
      assert.equal(refused.json.code, 'consent_required');
      assert.equal(doubles.store.bidCount(), 0);

      const created = await handleCheckout({ tier: 'single', bidText: LONG_BID, side: 'sending', consent: true });
      assert.equal(created.status, 200);
      assert.match(created.json.accessToken, /^[A-Za-z0-9_-]{40,}$/);
      assert.equal(created.json.url.includes('checkout.stripe.test'), true);
      const call = doubles.gateway.calls[0];
      assert.equal(call.amount, 7900);
      assert.equal(call.tier, 'single');
      assert.equal(call.bidId, created.json.bidId);
      const serialized = JSON.stringify(call);
      assert.equal(serialized.includes('FULL_BID_MARKER'), false);
      assert.equal(serialized.includes(LONG_BID.slice(0, 40)), false);
      assert.equal(Object.hasOwn(call, 'bidText'), false);
      const stored = await doubles.store.getBid(created.json.bidId);
      assert.equal(stored.bidText, LONG_BID);
      assert.equal(stored.bidText.length > 200, true);
      assert.equal(stored.accessToken, undefined);
      assert.equal(stored.accessTokenHash, hashAccessToken(created.json.accessToken));
      assert.equal(stored.consent, true);
      assert.equal(stored.sessionId, 'cs_test_1');
    });
    assert.equal(lines.join('\n').includes('FULL_BID_MARKER'), false);
    assert.equal(lines.join('\n').includes('@'), false);
  });

  test('a failed checkout does not keep the bid', async () => {
    doubles.gateway.createSession = async () => {
      throw new Error('synthetic stripe failure');
    };
    const result = await handleCheckout({ tier: 'single', bidText: LONG_BID, side: 'receiving', consent: true });
    assert.equal(result.status, 502);
    assert.equal(result.json.code, 'checkout_failed');
    assert.equal(JSON.stringify(result.json).includes('synthetic stripe'), false);
    assert.equal(doubles.store.bidCount(), 0);
  });

  test('paid review requires the access token and an authoritative paid session', async () => {
    const created = await handleCheckout({ tier: 'single', bidText: LONG_BID, side: 'receiving', consent: true });
    const sessionId = (await doubles.store.getBid(created.json.bidId)).sessionId;
    const seen = [];
    setModelClientForTests(async (input) => {
      seen.push(input);
      return { flags: [{ line: 'stored', issue: 'ok', note: 'n', severity: 'low' }], summary: 'paid model review', questions: ['q'] };
    });

    const selfAsserted = await handleReview({ bidText: 'short replacement bid text', paid: true, sessionId, consent: true });
    assert.equal(selfAsserted.status, 403);
    assert.equal(seen.length, 0);

    const tokenOnly = await handleReview({ accessToken: created.json.accessToken, bidText: 'other bid text that must be ignored for review' });
    assert.equal(tokenOnly.status, 403);

    const unpaid = await handleReview({ accessToken: created.json.accessToken, sessionId });
    assert.equal(unpaid.status, 402);
    assert.equal(unpaid.json.code, 'payment_required');

    doubles.gateway.markPaid(sessionId);
    const wrongToken = await handleReview({ accessToken: `${created.json.accessToken}nope`, sessionId });
    assert.equal(wrongToken.status, 403);

    const swapped = await handleReview({
      accessToken: created.json.accessToken,
      sessionId,
      bidText: 'ATTACKER_BID_TEXT_SHOULD_NOT_BE_USED',
      paid: true,
    });
    assert.equal(swapped.status, 200);
    assert.equal(swapped.json.preview, false);
    assert.equal(swapped.json.tier, 'single');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].thorough, true);
    assert.equal(seen[0].bidText, LONG_BID);
    assert.equal(JSON.stringify(swapped.json).includes('ATTACKER_BID_TEXT'), false);
    assert.equal(JSON.stringify(swapped.json).includes('FULL_BID_MARKER'), false);
    assert.equal(JSON.stringify(swapped.json).includes('@'), false);
  });

  test('verify session does not leak buyer email and ignores a bare session id', async () => {
    const created = await handleCheckout({ tier: 'single', bidText: LONG_BID, side: 'receiving', consent: true });
    const sessionId = (await doubles.store.getBid(created.json.bidId)).sessionId;
    doubles.gateway.markPaid(sessionId);
    const bare = await handleVerifySession({ sessionId, email: 'synthetic-buyer@example.test' });
    assert.equal(bare.status, 403);
    assert.equal(bare.json.paid, false);
    assert.equal(JSON.stringify(bare).includes('synthetic-buyer@example.test'), false);

    const verified = await handleVerifySession({ accessToken: created.json.accessToken, sessionId });
    assert.deepEqual(verified.json, { paid: true, tier: 'single' });
    assert.equal(JSON.stringify(verified).includes('@'), false);
  });

  test('a paid session for a different bid does not authorize this token', async () => {
    const first = await handleCheckout({ tier: 'single', bidText: LONG_BID, side: 'receiving', consent: true });
    const second = await handleCheckout({ tier: 'single', bidText: `${LONG_BID}\nsecond bid line item`, side: 'receiving', consent: true });
    const firstSession = (await doubles.store.getBid(first.json.bidId)).sessionId;
    const secondSession = (await doubles.store.getBid(second.json.bidId)).sessionId;
    doubles.gateway.markPaid(secondSession);
    const crossed = await handleReview({ accessToken: first.json.accessToken, sessionId: secondSession });
    assert.equal(crossed.status, 403);
    assert.equal(firstSession === secondSession, false);
  });

  test('public email endpoint never sends', async () => {
    const transport = createRecordingTransport();
    setEmailTransportForTests(transport);
    process.env.RESEND_API_KEY = 're_synthetic_not_real';
    process.env.EMAIL_DELIVERY_ENABLED = 'true';
    const { result, lines } = await captureLogs(() => handleSendEmail({
      to: 'synthetic-attacker@example.test',
      subject: 'open relay probe',
      html: '<b>should not send</b>',
    }));
    assert.equal(result.status, 403);
    assert.equal(result.json.code, 'email_disabled');
    assert.equal(transport.messages.length, 0);
    assert.equal(JSON.stringify(result).includes('synthetic-attacker@example.test'), false);
    assert.equal(lines.join('\n').includes('synthetic-attacker@example.test'), false);
  });

  test('webhook GET exposes nothing', async () => {
    const result = handleWebhookGet();
    assert.equal(result.status, 405);
    assert.equal(JSON.stringify(result).includes('@'), false);
    assert.equal(JSON.stringify(result).includes('unlocked'), false);
  });

  test('webhook signature, missing secret, and missing store fail closed', async () => {
    const event = completedEvent({ id: 'evt_bad', sessionId: 'cs_test_x', bidId: 'bid_missing' });
    const signed = sign(event);
    const bad = await handleWebhook(signed.payload, 't=1,v1=deadbeef');
    assert.equal(bad.status, 400);
    assert.equal(bad.json.code, 'invalid_signature');

    delete process.env.STRIPE_WEBHOOK_SECRET;
    const missingSecret = await handleWebhook(signed.payload, signed.header);
    assert.equal(missingSecret.status, 500);
    assert.equal(missingSecret.json.code, 'webhook_unconfigured');

    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_local_synthetic_only';
    const previousEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const noStore = await handleWebhook(signed.payload, sign(event).header);
    process.env.NODE_ENV = previousEnv;
    assert.equal(noStore.status, 500);
    assert.equal(noStore.json.code, 'fulfillment_unconfigured');
    assert.equal(noStore.json.blockers.includes('In-memory storage is refused outside tests and is not a production store.'), true);
  });

  test('webhook fulfillment keeps the full bid, skips email while disabled, and does not echo the buyer', async () => {
    const created = await handleCheckout({ tier: 'single', bidText: LONG_BID, side: 'receiving', consent: true });
    const bid = await doubles.store.getBid(created.json.bidId);
    const transport = createRecordingTransport();
    setEmailTransportForTests(null);
    const event = completedEvent({
      id: 'evt_paid_1',
      sessionId: bid.sessionId,
      bidId: created.json.bidId,
      email: 'synthetic-buyer@example.test',
    });
    const signed = sign(event);
    const { result, lines } = await captureLogs(() => handleWebhook(signed.payload, signed.header));
    assert.equal(result.status, 200);
    assert.equal(result.json.fulfilled, true);
    assert.equal(result.json.email, 'disabled');
    assert.equal(transport.messages.length, 0);
    assert.equal(JSON.stringify(result).includes('synthetic-buyer@example.test'), false);
    assert.equal(JSON.stringify(result).includes('FULL_BID_MARKER'), false);
    const stored = await doubles.store.getBid(created.json.bidId);
    assert.equal(stored.paymentStatus, 'paid');
    assert.equal(stored.bidText, LONG_BID);
    assert.equal(lines.join('\n').includes('synthetic-buyer@example.test'), false);
    assert.equal(lines.join('\n').includes('FULL_BID_MARKER'), false);
  });

  test('replaying the same signed event does not send a second email', async () => {
    const created = await handleCheckout({ tier: 'single', bidText: LONG_BID, side: 'receiving', consent: true });
    const bid = await doubles.store.getBid(created.json.bidId);
    const transport = createRecordingTransport();
    setEmailTransportForTests(transport);
    const event = completedEvent({ id: 'evt_replay', sessionId: bid.sessionId, bidId: created.json.bidId });
    const signed = sign(event);
    const first = await handleWebhook(signed.payload, signed.header);
    const second = await handleWebhook(signed.payload, signed.header);
    assert.equal(first.status, 200);
    assert.equal(first.json.fulfilled, true);
    assert.equal(second.status, 200);
    assert.equal(second.json.duplicate, true);
    assert.equal(transport.messages.length, 1);
    assert.equal(transport.messages[0].to, 'synthetic-buyer@example.test');
    assert.equal(JSON.stringify(first).includes('synthetic-buyer@example.test'), false);
    assert.equal(JSON.stringify(second).includes('synthetic-buyer@example.test'), false);
  });

  test('concurrent webhook deliveries send at most one email', async () => {
    const created = await handleCheckout({ tier: 'single', bidText: LONG_BID, side: 'receiving', consent: true });
    const bid = await doubles.store.getBid(created.json.bidId);
    let release;
    let started;
    const gate = new Promise((resolve) => {
      started = resolve;
    });
    const messages = [];
    setEmailTransportForTests({
      async send(message) {
        messages.push(message);
        started();
        await new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    const event = completedEvent({ id: 'evt_concurrent', sessionId: bid.sessionId, bidId: created.json.bidId });
    const signed = sign(event);
    const first = handleWebhook(signed.payload, signed.header);
    await gate;
    const second = await handleWebhook(signed.payload, signed.header);
    assert.equal(second.status, 500);
    assert.equal(second.json.code, 'event_in_progress');
    assert.equal(messages.length, 1);
    release();
    const finished = await first;
    assert.equal(finished.status, 200);
    assert.equal(finished.json.fulfilled, true);
    const replay = await handleWebhook(signed.payload, signed.header);
    assert.equal(replay.status, 200);
    assert.equal(replay.json.duplicate, true);
    assert.equal(messages.length, 1);
  });

  test('failed email returns retryable failure and the next delivery sends once', async () => {
    const created = await handleCheckout({ tier: 'single', bidText: LONG_BID, side: 'receiving', consent: true });
    const bid = await doubles.store.getBid(created.json.bidId);
    const transport = createRecordingTransport();
    transport.failNext(1);
    setEmailTransportForTests(transport);
    const event = completedEvent({ id: 'evt_retry', sessionId: bid.sessionId, bidId: created.json.bidId });
    const signed = sign(event);
    const failed = await handleWebhook(signed.payload, signed.header);
    assert.equal(failed.status, 500);
    assert.equal(failed.json.code, 'fulfillment_failed');
    assert.equal(doubles.store.getEvent('evt_retry').status, 'failed');
    assert.equal((await doubles.store.getBid(created.json.bidId)).paymentStatus, 'paid');

    const retried = await handleWebhook(signed.payload, signed.header);
    assert.equal(retried.status, 200);
    assert.equal(retried.json.fulfilled, true);
    assert.equal(transport.messages.length, 2);

    const replay = await handleWebhook(signed.payload, signed.header);
    assert.equal(replay.status, 200);
    assert.equal(replay.json.duplicate, true);
    assert.equal(transport.messages.length, 2);
    assert.equal(JSON.stringify(failed).includes('@'), false);
    assert.equal(JSON.stringify(retried).includes('@'), false);
  });

  test('enabling email without a transport fails closed and stays retryable', async () => {
    const created = await handleCheckout({ tier: 'single', bidText: LONG_BID, side: 'receiving', consent: true });
    const bid = await doubles.store.getBid(created.json.bidId);
    setEmailTransportForTests(null);
    process.env.EMAIL_DELIVERY_ENABLED = 'true';
    const event = completedEvent({ id: 'evt_no_transport', sessionId: bid.sessionId, bidId: created.json.bidId });
    const signed = sign(event);
    const first = await handleWebhook(signed.payload, signed.header);
    const second = await handleWebhook(signed.payload, signed.header);
    assert.equal(first.status, 500);
    assert.equal(first.json.code, 'email_transport_unconfigured');
    assert.equal(second.status, 500);
    assert.equal(second.json.code, 'email_transport_unconfigured');
    assert.equal(doubles.store.getEvent('evt_no_transport').status, 'failed');
    assert.notEqual(first.json.fulfilled, true);
  });

  test('production mode ignores the test store and test email transport', async () => {
    const store = createMemoryFulfillmentStore();
    setFulfillmentStoreForTests(store);
    const transport = createRecordingTransport();
    setEmailTransportForTests(transport);
    process.env.NODE_ENV = 'production';
    assert.equal(getFulfillmentStore(), null);
    assert.throws(() => setFulfillmentStoreForTests(createMemoryFulfillmentStore()), /refused/);
    const checkout = await handleCheckout({ tier: 'single', bidText: LONG_BID, side: 'receiving', consent: true });
    assert.equal(checkout.status, 503);
    assert.equal(checkout.json.code, 'fulfillment_unconfigured');
    assert.equal(store.bidCount(), 0);
    const event = completedEvent({ id: 'evt_prod', sessionId: 'cs_test_prod', bidId: 'bid_prod' });
    const signed = sign(event);
    const webhook = await handleWebhook(signed.payload, signed.header);
    assert.equal(webhook.status, 500);
    assert.equal(webhook.json.code, 'fulfillment_unconfigured');
    assert.equal(transport.messages.length, 0);
    const review = await handleReview({ accessToken: 'token', sessionId: 'cs_test_prod', paid: true });
    assert.equal(review.status, 503);
  });

  test('amount, currency, and tier must match the stored bid', async () => {
    const created = await handleCheckout({ tier: 'single', bidText: LONG_BID, side: 'receiving', consent: true });
    const bid = await doubles.store.getBid(created.json.bidId);
    doubles.gateway.markPaid(bid.sessionId);

    doubles.gateway.setSession(bid.sessionId, { amount_total: 100 });
    const wrongAmount = await handleReview({ accessToken: created.json.accessToken, sessionId: bid.sessionId });
    assert.equal(wrongAmount.status, 403);

    doubles.gateway.setSession(bid.sessionId, { amount_total: 7900, currency: 'eur' });
    const wrongCurrency = await handleReview({ accessToken: created.json.accessToken, sessionId: bid.sessionId });
    assert.equal(wrongCurrency.status, 403);

    doubles.gateway.setSession(bid.sessionId, { currency: 'usd', metadata: { bidId: created.json.bidId, tier: 'compare' } });
    const wrongTier = await handleReview({ accessToken: created.json.accessToken, sessionId: bid.sessionId });
    assert.equal(wrongTier.status, 403);

    const mismatchedEvent = completedEvent({
      id: 'evt_amount_mismatch',
      sessionId: bid.sessionId,
      bidId: created.json.bidId,
      amountTotal: 100,
    });
    const signedMismatch = sign(mismatchedEvent);
    const webhook = await handleWebhook(signedMismatch.payload, signedMismatch.header);
    assert.equal(webhook.status, 200);
    assert.equal(webhook.json.code, 'payment_mismatch');
    assert.equal((await doubles.store.getBid(created.json.bidId)).paymentStatus, 'unpaid');
  });

  test('a forged webhook body fails signature verification', async () => {
    const event = completedEvent({ id: 'evt_forged', sessionId: 'cs_test_forged', bidId: 'bid_forged', amountTotal: 7900 });
    const signed = sign(event);
    const forged = signed.payload.replace('"amount_total":7900', '"amount_total":100');
    assert.notEqual(forged, signed.payload);
    const result = await handleWebhook(forged, signed.header);
    assert.equal(result.status, 400);
    assert.equal(result.json.code, 'invalid_signature');
    const unsigned = await handleWebhook(signed.payload, '');
    assert.equal(unsigned.status, 400);
  });

  test('crash after provider acceptance retries with the same idempotency key', async () => {
    const created = await handleCheckout({ tier: 'single', bidText: LONG_BID, side: 'receiving', consent: true });
    const bid = await doubles.store.getBid(created.json.bidId);
    const logical = new Map();
    let invocations = 0;
    setEmailTransportForTests({
      async send(message) {
        invocations += 1;
        if (logical.has(message.idempotencyKey)) {
          return { id: logical.get(message.idempotencyKey), duplicate: true };
        }
        const id = `email_logical_${logical.size + 1}`;
        logical.set(message.idempotencyKey, id);
        const error = new Error('provider accepted then process stopped');
        error.accepted = true;
        error.code = 'crash_after_accept';
        throw error;
      },
    });
    const event = completedEvent({ id: 'evt_crash_window', sessionId: bid.sessionId, bidId: created.json.bidId });
    const signed = sign(event);
    const crashed = await handleWebhook(signed.payload, signed.header);
    assert.equal(crashed.status, 500);
    assert.equal(crashed.json.code, 'delivery_unacked');
    assert.equal(doubles.store.getEvent('evt_crash_window').deliveryStatus, 'accepted_unacked');

    const retried = await handleWebhook(signed.payload, signed.header);
    assert.equal(retried.status, 200);
    assert.equal(retried.json.fulfilled, true);
    assert.equal(logical.size, 1);
    assert.equal(invocations, 2);
    assert.equal(JSON.stringify(crashed).includes('synthetic-buyer@example.test'), false);
  });

  test('a non-local database URL stays fail-closed', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    delete process.env.FULFILLMENT_DATABASE_URL;
    assert.equal(getFulfillmentStore(), null);
    process.env.FULFILLMENT_DATABASE_URL = 'postgresql://reviewer:secret@db.example.com:5432/fulfillment';
    assert.equal(getFulfillmentStore(), null);
    const checkout = await handleCheckout({ tier: 'single', bidText: LONG_BID, side: 'receiving', consent: true });
    assert.equal(checkout.status, 503);
    assert.equal(checkout.json.code, 'fulfillment_unconfigured');
    process.env.NODE_ENV = previous;
    delete process.env.FULFILLMENT_DATABASE_URL;
  });

  test('source routes no longer trust a client paid flag, memory unlock, or public mailer', () => {
    const page = fs.readFileSync(path.join(root, 'app/page.js'), 'utf8');
    const webhook = fs.readFileSync(path.join(root, 'app/api/webhook/route.js'), 'utf8');
    const sendEmail = fs.readFileSync(path.join(root, 'app/api/send-email/route.js'), 'utf8');
    const verify = fs.readFileSync(path.join(root, 'app/api/verify-session/route.js'), 'utf8');
    assert.equal(page.includes('paid:'), false);
    assert.equal(page.includes('demo unlock'), false);
    assert.equal(page.toLowerCase().includes('refund'), false);
    assert.equal(webhook.includes('unlockedSessions'), false);
    assert.equal(webhook.includes('send-email'), false);
    assert.equal(webhook.includes('resend'), false);
    assert.equal(sendEmail.includes('api.resend.com'), false);
    assert.equal(verify.includes('customer_details'), false);
  });
});
