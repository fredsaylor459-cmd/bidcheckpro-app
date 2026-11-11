'use strict';

const { isLocalPostgresUrl } = require('./database-url');
const { createPostgresFulfillmentStore } = require('./postgres-store');

function createMemoryFulfillmentStore({ leaseMs = 120000 } = {}) {
  const bids = new Map();
  const byToken = new Map();
  const events = new Map();

  function reclaim(existing) {
    existing.status = 'processing';
    existing.attempts += 1;
    existing.leaseUntil = Date.now() + leaseMs;
    const needsSameKey = existing.deliveryStatus === 'sending' || existing.deliveryStatus === 'accepted_unacked';
    return {
      action: needsSameKey ? 'retry_same_key' : 'process',
      emailSent: existing.deliveryStatus === 'sent',
      deliveryStatus: existing.deliveryStatus,
      providerIdempotencyKey: existing.providerIdempotencyKey || null,
    };
  }

  return {
    adapter: 'memory-test-double',
    async putBid(record) {
      const stored = {
        bidId: record.bidId,
        accessTokenHash: record.accessTokenHash,
        bidText: record.bidText,
        side: record.side,
        consent: record.consent === true,
        consentAt: record.consentAt,
        tier: record.tier,
        amountCents: record.amountCents,
        currency: record.currency,
        sessionId: null,
        paymentStatus: 'unpaid',
        retainUntil: record.retainUntil || null,
      };
      bids.set(stored.bidId, stored);
      byToken.set(stored.accessTokenHash, stored.bidId);
      return stored;
    },
    async getBid(bidId) {
      return bids.get(bidId) || null;
    },
    async getBidByTokenHash(hash) {
      const bidId = byToken.get(hash);
      if (!bidId) return null;
      return bids.get(bidId) || null;
    },
    async attachSession(bidId, sessionId) {
      const bid = bids.get(bidId);
      if (!bid || bid.sessionId) return null;
      for (const other of bids.values()) {
        if (other.sessionId === sessionId && other.bidId !== bidId) return null;
      }
      bid.sessionId = sessionId;
      return bid;
    },
    async markPaid(bidId, sessionId) {
      const bid = bids.get(bidId);
      if (!bid || !bid.consent) return null;
      if (bid.sessionId && sessionId && bid.sessionId !== sessionId) return null;
      bid.sessionId = sessionId;
      bid.paymentStatus = 'paid';
      return bid;
    },
    async deleteBid(bidId) {
      const bid = bids.get(bidId);
      if (!bid) return;
      bids.delete(bidId);
      byToken.delete(bid.accessTokenHash);
    },
    claimEvent(eventId) {
      const existing = events.get(eventId);
      if (!existing) {
        const created = {
          status: 'processing',
          deliveryStatus: 'not_requested',
          emailSent: false,
          providerIdempotencyKey: null,
          attempts: 1,
          leaseUntil: Date.now() + leaseMs,
          lastErrorCode: null,
        };
        events.set(eventId, created);
        return {
          action: 'process',
          emailSent: false,
          deliveryStatus: created.deliveryStatus,
          providerIdempotencyKey: null,
        };
      }
      if (existing.status === 'succeeded') {
        return {
          action: 'ack',
          emailSent: existing.deliveryStatus === 'sent',
          deliveryStatus: existing.deliveryStatus,
          providerIdempotencyKey: existing.providerIdempotencyKey,
        };
      }
      const leaseOpen = existing.status === 'processing' && existing.leaseUntil > Date.now();
      if (leaseOpen) return { action: 'busy', deliveryStatus: existing.deliveryStatus };
      return reclaim(existing);
    },
    async beginDelivery(eventId, idempotencyKey) {
      const existing = events.get(eventId);
      if (!existing || existing.status !== 'processing') return null;
      if (!existing.providerIdempotencyKey) existing.providerIdempotencyKey = idempotencyKey;
      if (existing.deliveryStatus !== 'sent' && existing.deliveryStatus !== 'accepted_unacked') {
        existing.deliveryStatus = 'sending';
      }
      return {
        providerIdempotencyKey: existing.providerIdempotencyKey,
        deliveryStatus: existing.deliveryStatus,
      };
    },
    async markDeliveryUnacked(eventId) {
      const existing = events.get(eventId);
      if (!existing) return;
      if (existing.deliveryStatus === 'sending' || existing.deliveryStatus === 'accepted_unacked') {
        existing.deliveryStatus = 'accepted_unacked';
      }
    },
    async markEmailSent(eventId) {
      const existing = events.get(eventId);
      if (!existing) return;
      existing.deliveryStatus = 'sent';
      existing.emailSent = true;
    },
    completeEvent(eventId, details = {}) {
      const existing = events.get(eventId);
      if (!existing || existing.status === 'succeeded') return;
      existing.status = 'succeeded';
      existing.lastErrorCode = details.lastErrorCode || null;
      existing.leaseUntil = 0;
      if (details.emailSent) {
        existing.deliveryStatus = 'sent';
        existing.emailSent = true;
      } else if (details.skipped) {
        existing.deliveryStatus = 'skipped';
      }
    },
    failEvent(eventId, lastErrorCode = null) {
      const existing = events.get(eventId);
      if (!existing || existing.status === 'succeeded') return;
      existing.status = 'failed';
      existing.leaseUntil = Date.now() - 1000;
      if (lastErrorCode) existing.lastErrorCode = lastErrorCode;
    },
    getEvent(eventId) {
      return events.get(eventId) || null;
    },
    async expireLease(eventId) {
      const existing = events.get(eventId);
      if (existing) existing.leaseUntil = Date.now() - 1000;
    },
    async setRetainUntil(bidId, retainUntil) {
      const bid = bids.get(bidId);
      if (bid) bid.retainUntil = retainUntil;
    },
    async purgeExpiredBids(now = new Date()) {
      let removed = 0;
      for (const [bidId, bid] of bids) {
        if (bid.retainUntil && new Date(bid.retainUntil).getTime() <= now.getTime()) {
          bids.delete(bidId);
          byToken.delete(bid.accessTokenHash);
          removed += 1;
        }
      }
      return removed;
    },
    bidCount() {
      return bids.size;
    },
  };
}

let testStore = null;
let pgSingleton = null;
let pgSingletonUrl = null;

function setFulfillmentStoreForTests(store) {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Fulfillment test store refused outside NODE_ENV=test');
  }
  testStore = store;
}

function getFulfillmentStore() {
  if (process.env.NODE_ENV === 'test' && testStore) return testStore;
  const url = process.env.FULFILLMENT_DATABASE_URL;
  if (!isLocalPostgresUrl(url)) return null;
  if (!pgSingleton || pgSingletonUrl !== url) {
    pgSingleton = createPostgresFulfillmentStore({ connectionString: url });
    pgSingletonUrl = url;
  }
  return pgSingleton;
}

module.exports = {
  createMemoryFulfillmentStore,
  setFulfillmentStoreForTests,
  getFulfillmentStore,
};
