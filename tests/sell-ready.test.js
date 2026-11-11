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
} = require('./helpers');
const { setEmailTransportForTests, getEmailTransport } = require('../lib/email');
const { setModelClientForTests } = require('../lib/model-client');
const { resolveBaseUrl } = require('../lib/base-url');
const { OFFERS } = require('../lib/offers');
const { handleCheckout, handleReview, handleCompare, handleWebhook } = require('../lib/handlers');

const root = path.join(__dirname, '..');
const MISMATCH = 'Labor $1,000\nMaterials $800\nElectrical $360\nTotal $2,660';
const MATCH = 'Labor $1,000\nMaterials $800\nElectrical $360\nTotal $2,160';

describe('sell-ready checkout, mail, and bid checks', { concurrency: false }, () => {
  let doubles;

  beforeEach(() => {
    doubles = resetTestDoubles();
  });

  afterEach(() => {
    process.env.NODE_ENV = 'test';
    setEmailTransportForTests(null);
    setModelClientForTests(null);
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM;
    delete process.env.RESEND_API_BASE;
  });

  test('free review flags 2160 vs 2660 without an AI key', async () => {
    delete process.env.AI_API_KEY;
    const result = await handleReview({ bidText: MISMATCH, side: 'receiving', consent: false });
    assert.equal(result.status, 200);
    assert.equal(result.json.preview, true);
    const flag = result.json.flags.find((item) => item.issue === 'Total does not match line items');
    assert.ok(flag);
    assert.match(flag.note, /2160 vs 2660/);
    assert.equal(doubles.store.bidCount(), 0);
  });

  test('the compare API returns both totals and does not store the bids', async () => {
    const result = await handleCompare({
      bidText: MISMATCH,
      secondBidText: MATCH,
      side: 'receiving',
      consent: false,
    });
    assert.equal(result.status, 200);
    assert.equal(result.json.comparison.bidACents, 266000);
    assert.equal(result.json.comparison.bidBCents, 216000);
    assert.equal(result.json.comparison.differenceCents, 50000);
    assert.match(result.json.summary, /2660/);
    assert.match(result.json.summary, /2160/);
    assert.equal(doubles.store.bidCount(), 0);
    const missing = await handleCompare({ bidText: MISMATCH, secondBidText: 'short' });
    assert.equal(missing.status, 400);
    assert.equal(missing.json.code, 'bid_required');
  });

  test('a paid comparison reviews the stored bids, not a replacement body', async () => {
    const created = await handleCheckout({
      tier: 'compare',
      bidText: MISMATCH,
      secondBidText: MATCH,
      side: 'receiving',
      consent: true,
      amount: 1,
    });
    assert.equal(created.status, 200);
    const stored = await doubles.store.getBid(created.json.bidId);
    assert.equal(stored.amountCents, 14900);
    doubles.gateway.markPaid(stored.sessionId);
    const review = await handleReview({
      accessToken: created.json.accessToken,
      sessionId: stored.sessionId,
      bidText: 'ATTACKER_BID $1',
      secondBidText: 'ATTACKER_OTHER $1',
    });
    assert.equal(review.status, 200);
    assert.equal(review.json.tier, 'compare');
    assert.equal(review.json.preview, false);
    assert.equal(review.json.comparison.bidACents, 266000);
    assert.equal(review.json.comparison.bidBCents, 216000);
    assert.equal(JSON.stringify(review.json).includes('ATTACKER_BID'), false);
  });

  test('a second event for the same checkout session does not send another email', async () => {
    const created = await handleCheckout({
      tier: 'single',
      bidText: MISMATCH,
      side: 'receiving',
      consent: true,
    });
    const bid = await doubles.store.getBid(created.json.bidId);
    const transport = createRecordingTransport();
    setEmailTransportForTests(transport);
    const first = completedEvent({ id: 'evt_session_a', sessionId: bid.sessionId, bidId: created.json.bidId });
    const second = completedEvent({ id: 'evt_session_b', sessionId: bid.sessionId, bidId: created.json.bidId });
    const signedFirst = sign(first);
    const signedSecond = sign(second);
    const firstResult = await handleWebhook(signedFirst.payload, signedFirst.header);
    const secondResult = await handleWebhook(signedSecond.payload, signedSecond.header);
    const replay = await handleWebhook(signedFirst.payload, signedFirst.header);
    assert.equal(firstResult.status, 200);
    assert.equal(firstResult.json.fulfilled, true);
    assert.equal(secondResult.status, 200);
    assert.equal(secondResult.json.duplicate, true);
    assert.equal(replay.json.duplicate, true);
    assert.equal(transport.messages.length, 1);
    assert.match(transport.messages[0].text, /2160 vs 2660/);
    assert.equal(transport.messages[0].idempotencyKey, 'fulfillment:evt_session_a');
    assert.equal(JSON.stringify(firstResult).includes('synthetic-buyer@example.test'), false);
    assert.equal(JSON.stringify(secondResult).includes('synthetic-buyer@example.test'), false);
  });

  test('Resend transport posts to the configured host with an idempotency key and never uses the public route', async () => {
    const calls = [];
    const originalFetch = global.fetch;
    global.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return { ok: true, json: async () => ({ id: 'email_inert_1' }) };
    };
    try {
      process.env.RESEND_API_KEY = 're_test_inert';
      process.env.RESEND_FROM = 'BidCheckPro <reviews@example.test>';
      setEmailTransportForTests(null);
      const transport = getEmailTransport();
      const sent = await transport.send({
        to: 'buyer@example.test',
        subject: 'Your BidCheckPro review (single)',
        text: 'Line items add up to 2160 but the stated total is 2660',
        html: '<p>2160 vs 2660</p>',
        idempotencyKey: 'fulfillment:evt_resend',
      });
      assert.equal(sent.id, 'email_inert_1');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://api.resend.com/emails');
      assert.equal(calls[0].init.headers.Authorization, 'Bearer re_test_inert');
      assert.equal(calls[0].init.headers['Idempotency-Key'], 'fulfillment:evt_resend');
      const body = JSON.parse(calls[0].init.body);
      assert.equal(body.from, 'BidCheckPro <reviews@example.test>');
      assert.deepEqual(body.to, ['buyer@example.test']);
      assert.equal(JSON.stringify(calls).includes('/api/send-email'), false);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('a non-local RESEND_API_BASE is refused', async () => {
    process.env.RESEND_API_KEY = 're_test_inert';
    process.env.RESEND_FROM = 'BidCheckPro <reviews@example.test>';
    process.env.RESEND_API_BASE = 'https://example.test';
    setEmailTransportForTests(null);
    const transport = getEmailTransport();
    await assert.rejects(() => transport.send({
      to: 'buyer@example.test',
      subject: 'nope',
      text: 'nope',
      idempotencyKey: 'k',
    }), (error) => error.code === 'email_transport_unconfigured');
  });

  test('production base URL comes from NEXT_PUBLIC_BASE_URL and rejects localhost', () => {
    assert.equal(resolveBaseUrl({ NODE_ENV: 'production', NEXT_PUBLIC_BASE_URL: 'https://www.bidcheckpro.com/' }), 'https://www.bidcheckpro.com');
    assert.equal(resolveBaseUrl({ NODE_ENV: 'production' }), null);
    assert.equal(resolveBaseUrl({ NODE_ENV: 'production', NEXT_PUBLIC_BASE_URL: 'http://localhost:3000' }), null);
    assert.equal(resolveBaseUrl({ NODE_ENV: 'production', NEXT_PUBLIC_BASE_URL: 'http://127.0.0.1:3000' }), null);
    assert.equal(resolveBaseUrl({ NODE_ENV: 'test', NEXT_PUBLIC_BASE_URL: 'http://127.0.0.1:3000' }), 'http://127.0.0.1:3000');
    const handlers = fs.readFileSync(path.join(root, 'lib/handlers.js'), 'utf8');
    const checkout = fs.readFileSync(path.join(root, 'app/api/checkout/route.js'), 'utf8');
    assert.equal(handlers.includes('localhost'), false);
    assert.equal(checkout.includes('localhost'), false);
  });

  test('catalog amounts stay 7900, 14900, and 35900', () => {
    assert.deepEqual(
      [OFFERS.single.amount, OFFERS.compare.amount, OFFERS.full.amount],
      [7900, 14900, 35900]
    );
    const page = fs.readFileSync(path.join(root, 'app/page.js'), 'utf8');
    assert.equal(page.includes("startCheckout('single')"), true);
    assert.equal(page.includes("startCheckout('compare')"), true);
    assert.equal(page.includes("startCheckout('full')"), true);
    assert.equal(page.includes('/api/compare'), true);
    assert.equal(page.includes('paid:'), false);
    assert.equal(page.includes('btnDisabled'), false);
  });
});
