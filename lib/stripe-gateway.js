'use strict';

const { getOffer } = require('./offers');

let testGateway = null;

function setCheckoutGatewayForTests(gateway) {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Checkout test gateway refused outside NODE_ENV=test');
  }
  testGateway = gateway;
}

function isLocalHostname(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

function stripeClient(secretKey) {
  const Stripe = require('stripe');
  const options = { telemetry: false, maxNetworkRetries: 0 };
  if (process.env.STRIPE_MOCK_HOST) {
    const host = process.env.STRIPE_MOCK_HOST;
    if (!isLocalHostname(host)) {
      const error = new Error('STRIPE_MOCK_HOST is only allowed for a local mock.');
      error.code = 'stripe_mock_refused';
      throw error;
    }
    options.host = host;
    options.port = Number(process.env.STRIPE_MOCK_PORT || '12111');
    options.protocol = 'http';
  }
  return new Stripe(secretKey, options);
}

function createLiveCheckoutGateway() {
  const stripe = stripeClient(process.env.STRIPE_SECRET_KEY);
  return {
    async createSession(input) {
      const offer = getOffer(input.tier);
      if (!offer) {
        const error = new Error('offer_unavailable');
        error.code = 'offer_unavailable';
        throw error;
      }
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode: 'payment',
        line_items: [
          {
            price_data: {
              currency: offer.currency,
              product_data: { name: offer.productName },
              unit_amount: offer.amount,
            },
            quantity: 1,
          },
        ],
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        metadata: {
          bidId: input.bidId,
          tier: offer.tier,
        },
      });
      return { id: session.id, url: session.url };
    },
    async retrieveSession(sessionId) {
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      return {
        id: session.id,
        payment_status: session.payment_status,
        amount_total: session.amount_total,
        currency: session.currency,
        metadata: {
          bidId: session.metadata?.bidId || '',
          tier: session.metadata?.tier || '',
        },
      };
    },
  };
}

function getCheckoutGateway() {
  if (process.env.NODE_ENV === 'test' && testGateway) return testGateway;
  if (!process.env.STRIPE_SECRET_KEY) return null;
  return createLiveCheckoutGateway();
}

function constructWebhookEvent(rawBody, signature) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    const error = new Error('webhook_unconfigured');
    error.code = 'webhook_unconfigured';
    throw error;
  }
  const stripe = stripeClient('sk_test_webhook_construct_only_00');
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}

module.exports = {
  setCheckoutGatewayForTests,
  getCheckoutGateway,
  constructWebhookEvent,
  createLiveCheckoutGateway,
};
