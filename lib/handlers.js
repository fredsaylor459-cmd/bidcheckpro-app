'use strict';

const { FULFILLMENT_BLOCKERS } = require('./blockers');
const { getFulfillmentStore } = require('./store');
const { describeDatabaseUrl } = require('./database-url');
const { resolveBaseUrl } = require('./base-url');
const { getOffer } = require('./offers');
const { randomId, createAccessToken, hashAccessToken } = require('./tokens');
const { ruleBasedReview } = require('./review-rules');
const { checkBidArithmetic, compareBids } = require('./bid-math');
const { getModelClient } = require('./model-client');
const { getCheckoutGateway, constructWebhookEvent } = require('./stripe-gateway');
const { getEmailTransport, publicEmailDisabled } = require('./email');
const { buildReviewEmail } = require('./review-email');

function retentionDeadline() {
  const raw = process.env.FULFILLMENT_RETENTION_DAYS;
  if (!raw) return null;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1) return null;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function paymentMatches(session, bid) {
  if (!session || !bid || bid.consent !== true) return false;
  if (session.payment_status !== 'paid') return false;
  if (!bid.sessionId || session.id !== bid.sessionId) return false;
  if (session.metadata?.bidId !== bid.bidId) return false;
  if (session.metadata?.tier !== bid.tier) return false;
  if (Number(session.amount_total) !== Number(bid.amountCents)) return false;
  if (String(session.currency || '').toLowerCase() !== String(bid.currency || '').toLowerCase()) return false;
  return true;
}

function fulfillmentUnavailable() {
  const described = describeDatabaseUrl(process.env.FULFILLMENT_DATABASE_URL);
  if (!process.env.FULFILLMENT_DATABASE_URL) {
    return {
      status: 503,
      json: {
        error: 'FULFILLMENT_DATABASE_URL is not set. Set a postgres:// or postgresql:// URL for local Postgres or a hosted database such as Neon.',
        code: 'fulfillment_unconfigured',
        blockers: FULFILLMENT_BLOCKERS,
      },
    };
  }
  if (!described.ok) {
    return {
      status: 503,
      json: {
        error: described.error,
        code: 'fulfillment_database_invalid',
        blockers: FULFILLMENT_BLOCKERS,
      },
    };
  }
  return {
    status: 503,
    json: {
      error: 'Fulfillment storage is not available.',
      code: 'fulfillment_unconfigured',
      blockers: FULFILLMENT_BLOCKERS,
    },
  };
}

function unconfigured(code) {
  if (code === 'fulfillment_unconfigured') return fulfillmentUnavailable();
  return {
    status: 503,
    json: {
      error: 'Fulfillment is not configured.',
      code,
      blockers: FULFILLMENT_BLOCKERS,
    },
  };
}

function publicComparison(comparison) {
  if (!comparison || typeof comparison !== 'object') return undefined;
  const out = {};
  [
    'bidACents',
    'bidBCents',
    'bidASumCents',
    'bidBSumCents',
    'bidAStatedCents',
    'bidBStatedCents',
    'differenceCents',
  ].forEach((key) => {
    if (comparison[key] == null) out[key] = null;
    else if (Number.isInteger(comparison[key])) out[key] = comparison[key];
  });
  if (comparison.higher === 'a' || comparison.higher === 'b' || comparison.higher === 'tie') {
    out.higher = comparison.higher;
  }
  return out;
}

function publicReview(review) {
  if (!review || typeof review !== 'object') {
    return { summary: 'Review complete.', flags: [], questions: [] };
  }
  const result = {
    flags: Array.isArray(review.flags) ? review.flags : [],
    summary: typeof review.summary === 'string' ? review.summary : 'Review complete.',
    questions: Array.isArray(review.questions) ? review.questions : [],
    preview: review.preview === true,
    tier: review.tier,
    side: review.side,
  };
  if (review.arithmetic && typeof review.arithmetic === 'object') {
    result.arithmetic = {
      sumCents: Number.isInteger(review.arithmetic.sumCents) ? review.arithmetic.sumCents : null,
      statedCents: Number.isInteger(review.arithmetic.statedCents) ? review.arithmetic.statedCents : null,
    };
  }
  const comparison = publicComparison(review.comparison);
  if (comparison) result.comparison = comparison;
  return result;
}

async function reviewText({ bidText, side, thorough }) {
  const mathFlags = checkBidArithmetic(bidText).flags;
  const model = getModelClient();
  let review;
  if (!model) {
    review = ruleBasedReview(bidText, side, true);
  } else {
    try {
      const parsed = await model({ bidText, side, thorough });
      review = publicReview(parsed);
      review.flags = [...mathFlags, ...(Array.isArray(review.flags) ? review.flags : [])];
      review.side = side === 'sending' ? 'sending' : 'receiving';
    } catch {
      review = ruleBasedReview(bidText, side, true);
    }
  }
  if (!thorough) {
    review.flags = review.flags.slice(0, 2);
    review.preview = true;
  } else {
    review.preview = false;
  }
  return review;
}

async function reviewForBid(bid) {
  if (bid.tier === 'compare') {
    const review = compareBids(bid.bidText, bid.secondBidText || '');
    return publicReview({ ...review, preview: false, tier: 'compare', side: bid.side });
  }
  const review = await reviewText({ bidText: bid.bidText, side: bid.side, thorough: true });
  const questions = Array.isArray(review.questions) ? review.questions.slice() : [];
  if (bid.tier === 'full') {
    questions.push(
      'How are change orders priced, and who signs them before the work starts?',
      'What is the draw schedule, and which work must be finished before each draw?'
    );
  }
  return publicReview({ ...review, questions, preview: false, tier: bid.tier, side: bid.side });
}

async function authorizePaidAccess({ accessToken, sessionId }) {
  if (!accessToken || !sessionId) {
    return { ok: false, status: 403, json: { paid: false, error: 'Access was not recognized.', code: 'forbidden' } };
  }
  const store = getFulfillmentStore();
  if (!store) return { ok: false, ...unconfigured('fulfillment_unconfigured') };
  const gateway = getCheckoutGateway();
  if (!gateway) return { ok: false, ...unconfigured('stripe_unconfigured') };

  const bid = await store.getBidByTokenHash(hashAccessToken(accessToken));
  if (!bid || bid.consent !== true) {
    return { ok: false, status: 403, json: { paid: false, error: 'Access was not recognized.', code: 'forbidden' } };
  }

  let session;
  try {
    session = await gateway.retrieveSession(sessionId);
  } catch {
    return {
      ok: false,
      status: 502,
      json: { paid: false, error: 'Payment could not be verified.', code: 'payment_verification_failed' },
    };
  }

  if (!session || session.id !== sessionId) {
    return { ok: false, status: 403, json: { paid: false, error: 'This payment does not match this bid.', code: 'forbidden' } };
  }
  if (session.payment_status !== 'paid') {
    return { ok: false, status: 402, json: { paid: false, error: 'Payment is not complete.', code: 'payment_required' } };
  }
  if (!paymentMatches(session, bid)) {
    return { ok: false, status: 403, json: { paid: false, error: 'This payment does not match this bid.', code: 'forbidden' } };
  }
  return { ok: true, bid, session };
}

async function handleCheckout(body = {}) {
  const offer = getOffer(body.tier);
  if (!offer) {
    return {
      status: 400,
      json: { error: 'This paid offer is not available.', code: 'offer_unavailable' },
    };
  }
  const bidText = typeof body.bidText === 'string' ? body.bidText : '';
  const secondBidText = typeof body.secondBidText === 'string' ? body.secondBidText : '';
  const side = body.side === 'sending' ? 'sending' : 'receiving';
  const consent = body.consent === true;

  if (!consent) {
    return {
      status: 400,
      json: { error: 'Consent is required before the bid is stored.', code: 'consent_required' },
    };
  }
  if (bidText.trim().length < 10) {
    return { status: 400, json: { error: 'Paste a bid with line items.', code: 'bid_required' } };
  }
  if (offer.requiresSecondBid && secondBidText.trim().length < 10) {
    return { status: 400, json: { error: 'Paste a second bid to compare.', code: 'second_bid_required' } };
  }

  const store = getFulfillmentStore();
  if (!store) return unconfigured('fulfillment_unconfigured');
  const gateway = getCheckoutGateway();
  if (!gateway) return unconfigured('stripe_unconfigured');
  const origin = resolveBaseUrl();
  if (!origin) {
    return {
      status: 503,
      json: {
        error: 'NEXT_PUBLIC_BASE_URL is not set to the public https origin. Localhost is not used in production.',
        code: 'base_url_unconfigured',
      },
    };
  }

  const bidId = randomId('bid');
  const accessToken = createAccessToken();
  await store.putBid({
    bidId,
    accessTokenHash: hashAccessToken(accessToken),
    bidText,
    secondBidText: offer.requiresSecondBid ? secondBidText : null,
    side,
    consent: true,
    consentAt: new Date().toISOString(),
    tier: offer.tier,
    amountCents: offer.amount,
    currency: offer.currency,
    retainUntil: retentionDeadline(),
  });

  let session;
  try {
    session = await gateway.createSession({
      bidId,
      tier: offer.tier,
      amount: offer.amount,
      currency: offer.currency,
      productName: offer.productName,
      successUrl: `${origin}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${origin}/`,
    });
  } catch {
    await store.deleteBid(bidId);
    return { status: 502, json: { error: 'Checkout could not be started.', code: 'checkout_failed' } };
  }

  if (!session?.id || !session?.url) {
    await store.deleteBid(bidId);
    return { status: 502, json: { error: 'Checkout could not be started.', code: 'checkout_failed' } };
  }

  const attached = await store.attachSession(bidId, session.id);
  if (!attached) {
    await store.deleteBid(bidId);
    return { status: 502, json: { error: 'Checkout could not be started.', code: 'checkout_failed' } };
  }
  return { status: 200, json: { url: session.url, accessToken, bidId, sessionId: session.id } };
}

async function handleReview(body = {}) {
  const accessToken = typeof body.accessToken === 'string' ? body.accessToken : '';
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  if (accessToken || sessionId) {
    const access = await authorizePaidAccess({ accessToken, sessionId });
    if (!access.ok) return { status: access.status, json: access.json };
    const review = await reviewForBid(access.bid);
    return { status: 200, json: review };
  }

  const bidText = typeof body.bidText === 'string' ? body.bidText : '';
  const side = body.side === 'sending' ? 'sending' : 'receiving';
  const consent = body.consent === true;
  if (bidText.trim().length < 10) {
    return { status: 400, json: { error: 'Paste a bid with line items.', code: 'bid_required' } };
  }

  if (getModelClient() && !consent) {
    return {
      status: 400,
      json: { error: 'Consent is required before the bid is sent for model review.', code: 'consent_required' },
    };
  }

  const review = await reviewText({ bidText, side, thorough: false });
  return { status: 200, json: publicReview({ ...review, preview: true }) };
}

async function handleCompare(body = {}) {
  const bidText = typeof body.bidText === 'string' ? body.bidText : '';
  const secondBidText = typeof body.secondBidText === 'string' ? body.secondBidText : '';
  const side = body.side === 'sending' ? 'sending' : 'receiving';
  if (bidText.trim().length < 10 || secondBidText.trim().length < 10) {
    return { status: 400, json: { error: 'Paste two bids with line items.', code: 'bid_required' } };
  }
  const review = compareBids(bidText, secondBidText);
  review.side = side;
  return { status: 200, json: publicReview({ ...review, preview: false }) };
}

async function handleVerifySession(body = {}) {
  const access = await authorizePaidAccess({
    accessToken: typeof body.accessToken === 'string' ? body.accessToken : '',
    sessionId: typeof body.sessionId === 'string' ? body.sessionId : '',
  });
  if (!access.ok) {
    const json = { ...access.json };
    delete json.email;
    return { status: access.status, json };
  }
  return { status: 200, json: { paid: true, tier: access.bid.tier } };
}

async function handleSendEmail() {
  return publicEmailDisabled();
}

function handleWebhookGet() {
  return { status: 405, json: { error: 'Method not allowed.', code: 'method_not_allowed' } };
}

async function handleWebhook(rawBody, signature) {
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    return {
      status: 500,
      json: {
        error: 'Webhook secret is not configured.',
        code: 'webhook_unconfigured',
        blockers: FULFILLMENT_BLOCKERS,
      },
    };
  }

  let event;
  try {
    event = constructWebhookEvent(rawBody, signature);
  } catch (error) {
    if (error.code === 'webhook_unconfigured') {
      return { status: 500, json: { error: 'Webhook secret is not configured.', code: 'webhook_unconfigured' } };
    }
    return { status: 400, json: { error: 'Invalid webhook signature.', code: 'invalid_signature' } };
  }

  if (!event?.id) {
    return { status: 400, json: { error: 'Webhook event is missing an id.', code: 'invalid_event' } };
  }
  if (event.type !== 'checkout.session.completed') {
    return { status: 200, json: { received: true, ignored: true } };
  }

  const store = getFulfillmentStore();
  if (!store) return { status: 500, json: fulfillmentUnavailable().json };

  const claim = await store.claimEvent(event.id);
  if (claim.action === 'ack') return { status: 200, json: { received: true, duplicate: true } };
  if (claim.action === 'busy') {
    return { status: 500, json: { error: 'Event is already being processed.', code: 'event_in_progress' } };
  }

  try {
    if (claim.emailSent || claim.deliveryStatus === 'sent') {
      await store.completeEvent(event.id, { emailSent: true });
      return { status: 200, json: { received: true, fulfilled: true, duplicate: true } };
    }

    const session = event.data?.object || {};
    const bid = session.metadata?.bidId ? await store.getBid(session.metadata.bidId) : null;
    if (!paymentMatches(session, bid)) {
      await store.completeEvent(event.id, { skipped: true, lastErrorCode: 'payment_mismatch' });
      return { status: 200, json: { received: true, fulfilled: false, code: 'payment_mismatch' } };
    }

    const marked = await store.markPaid(bid.bidId, session.id);
    if (!marked) {
      await store.completeEvent(event.id, { skipped: true, lastErrorCode: 'payment_mismatch' });
      return { status: 200, json: { received: true, fulfilled: false, code: 'payment_mismatch' } };
    }

    const sessionClaim = await store.claimCheckoutSession(session.id, event.id);
    if (!sessionClaim || sessionClaim.action === 'duplicate') {
      await store.completeEvent(event.id, { skipped: true, lastErrorCode: 'session_already_fulfilled' });
      return { status: 200, json: { received: true, fulfilled: true, duplicate: true } };
    }

    const transport = getEmailTransport();
    if (!transport) {
      if (process.env.NODE_ENV === 'production') {
        const error = new Error('email_transport_unconfigured');
        error.code = 'email_transport_unconfigured';
        throw error;
      }
      await store.completeEvent(event.id, { skipped: true });
      return { status: 200, json: { received: true, fulfilled: true, email: 'disabled' } };
    }

    const recipient = session.customer_details?.email || session.customer_email || '';
    const review = await reviewForBid(bid);
    const message = buildReviewEmail({ review, tier: bid.tier });
    // The ledger records the provider key before the send. A crash after the
    // provider accepts and before delivery_status becomes sent is at-least-once,
    // not exactly-once. The provider must dedupe this key.
    const idempotencyKey = claim.providerIdempotencyKey || `fulfillment:${event.id}`;
    const delivery = await store.beginDelivery(event.id, idempotencyKey);
    const providerKey = delivery?.providerIdempotencyKey || idempotencyKey;
    try {
      await transport.send({
        to: recipient,
        subject: message.subject,
        text: message.text,
        html: message.html,
        idempotencyKey: providerKey,
      });
    } catch (error) {
      if (error && error.accepted) await store.markDeliveryUnacked(event.id);
      throw error;
    }
    await store.markEmailSent(event.id);
    await store.completeEvent(event.id, { emailSent: true });
    return { status: 200, json: { received: true, fulfilled: true } };
  } catch (error) {
    await store.failEvent(event.id, error.code || 'fulfillment_failed');
    let code = 'fulfillment_failed';
    if (error.code === 'email_transport_unconfigured') code = 'email_transport_unconfigured';
    if (error.accepted) code = 'delivery_unacked';
    return { status: 500, json: { error: 'Fulfillment failed and can be retried.', code } };
  }
}

module.exports = {
  handleCheckout,
  handleReview,
  handleCompare,
  handleVerifySession,
  handleSendEmail,
  handleWebhook,
  handleWebhookGet,
  resolveBaseUrl,
};
