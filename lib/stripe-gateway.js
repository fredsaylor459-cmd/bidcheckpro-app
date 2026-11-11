'use strict';

let testGateway = null;

function setCheckoutGatewayForTests(gateway) {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Checkout test gateway refused outside NODE_ENV=test');
  }
  testGateway = gateway;
}

function stripeClient(secretKey) {
  const Stripe = require('stripe');
  return new Stripe(secretKey, { telemetry: false, maxNetworkRetries: 0 });
}

function createLiveCheckoutGateway() {
  const stripe = stripeClient(process.env.STRIPE_SECRET_KEY);
  return {
    async createSession(input) {
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode: 'payment',
        line_items: [
          {
            price_data: {
              currency: 'usd',
              product_data: { name: input.productName },
              unit_amount: input.amount,
            },
            quantity: 1,
          },
        ],
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        metadata: {
          bidId: input.bidId,
          tier: input.tier,
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
};
