'use strict';

require('./network-guard');

const Stripe = require('stripe');
const { createMemoryFulfillmentStore, setFulfillmentStoreForTests, getFulfillmentStore } = require('../lib/store');
const { setCheckoutGatewayForTests } = require('../lib/stripe-gateway');
const { setEmailTransportForTests } = require('../lib/email');
const { setModelClientForTests } = require('../lib/model-client');

const WEBHOOK_SECRET = 'whsec_local_synthetic_only';
const stripe = new Stripe('sk_test_webhook_construct_only_00', { telemetry: false, maxNetworkRetries: 0 });

function createFakeGateway() {
  const sessions = new Map();
  const calls = [];
  return {
    calls,
    async createSession(input) {
      calls.push({ op: 'create', ...input });
      const id = `cs_test_${calls.length}`;
      sessions.set(id, {
        id,
        url: `https://checkout.stripe.test/c/pay/${id}`,
        payment_status: 'unpaid',
        amount_total: input.amount,
        currency: input.currency || 'usd',
        metadata: { bidId: input.bidId, tier: input.tier },
      });
      return { id, url: sessions.get(id).url };
    },
    setSession(id, patch) {
      const session = sessions.get(id);
      if (!session) throw new Error(`missing session ${id}`);
      Object.assign(session, patch);
      return session;
    },
    async retrieveSession(id) {
      calls.push({ op: 'retrieve', id });
      return sessions.get(id) || null;
    },
    markPaid(id) {
      const session = sessions.get(id);
      if (!session) throw new Error(`missing session ${id}`);
      session.payment_status = 'paid';
      return session;
    },
  };
}

function createRecordingTransport() {
  const messages = [];
  let failTimes = 0;
  const transport = {
    messages,
    async send(message) {
      messages.push(message);
      if (messages.length <= failTimes) {
        const error = new Error('synthetic mail failure');
        error.code = 'mail_failed';
        throw error;
      }
      return { id: `email_mock_${messages.length}` };
    },
  };
  transport.failNext = (count) => {
    failTimes = messages.length + count;
  };
  return transport;
}

function resetTestDoubles() {
  process.env.NODE_ENV = 'test';
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.NEXT_PUBLIC_BASE_URL = 'http://127.0.0.1:3000';
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.AI_API_KEY;
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_DELIVERY_ENABLED;
  delete process.env.FULFILLMENT_DATABASE_URL;
  delete process.env.FULFILLMENT_RETENTION_DAYS;
  const store = createMemoryFulfillmentStore();
  const gateway = createFakeGateway();
  setFulfillmentStoreForTests(store);
  setCheckoutGatewayForTests(gateway);
  setEmailTransportForTests(null);
  setModelClientForTests(null);
  return { store, gateway };
}

function sign(event, secret = WEBHOOK_SECRET) {
  const payload = JSON.stringify(event);
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
  return { payload, header };
}

function completedEvent({
  id,
  sessionId,
  bidId,
  paymentStatus = 'paid',
  email = 'synthetic-buyer@example.test',
  amountTotal = 7900,
  currency = 'usd',
  tier = 'single',
}) {
  return {
    id,
    object: 'event',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: sessionId,
        object: 'checkout.session',
        payment_status: paymentStatus,
        amount_total: amountTotal,
        currency,
        customer_details: { email },
        metadata: bidId ? { bidId, tier } : { tier },
      },
    },
  };
}

function captureLogs(fn) {
  const lines = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalInfo = console.info;
  const push = (...args) => lines.push(args.map((part) => String(part)).join(' '));
  console.log = push;
  console.error = push;
  console.info = push;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      console.log = originalLog;
      console.error = originalError;
      console.info = originalInfo;
    })
    .then((result) => ({ result, lines }));
}

module.exports = {
  WEBHOOK_SECRET,
  createFakeGateway,
  createRecordingTransport,
  resetTestDoubles,
  sign,
  completedEvent,
  captureLogs,
  getFulfillmentStore,
};
