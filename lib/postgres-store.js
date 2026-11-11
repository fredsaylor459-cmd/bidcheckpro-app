'use strict';

const { Pool } = require('pg');
const { isLocalPostgresUrl } = require('./database-url');

function mapBid(row) {
  if (!row) return null;
  return {
    bidId: row.bid_id,
    accessTokenHash: row.access_token_hash,
    bidText: row.bid_text,
    side: row.side,
    consent: row.consent === true,
    consentAt: row.consent_at,
    tier: row.tier,
    amountCents: row.amount_cents,
    currency: row.currency,
    sessionId: row.session_id,
    paymentStatus: row.payment_status,
    retainUntil: row.retain_until,
  };
}

function claimResult(row) {
  const deliveryStatus = row.delivery_status;
  const needsSameKey = deliveryStatus === 'sending' || deliveryStatus === 'accepted_unacked';
  return {
    action: needsSameKey ? 'retry_same_key' : 'process',
    emailSent: deliveryStatus === 'sent',
    deliveryStatus,
    providerIdempotencyKey: row.provider_idempotency_key || null,
  };
}

function createPostgresFulfillmentStore({ connectionString, leaseMs = 120000 } = {}) {
  if (!isLocalPostgresUrl(connectionString)) {
    throw new Error('PostgreSQL fulfillment store refuses a non-local URL');
  }
  const pool = new Pool({ connectionString, max: 4 });

  async function withClient(fn) {
    const client = await pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  return {
    adapter: 'postgres',
    async putBid(record) {
      if (record.consent !== true) {
        throw new Error('Refusing to store bid text without consent');
      }
      const result = await pool.query(
        `INSERT INTO fulfillment_bids (
           bid_id, access_token_hash, bid_text, side, consent, consent_at,
           tier, amount_cents, currency, payment_status, retain_until
         ) VALUES ($1,$2,$3,$4,true,$5,$6,$7,$8,'unpaid',$9)
         RETURNING *`,
        [
          record.bidId,
          record.accessTokenHash,
          record.bidText,
          record.side,
          record.consentAt,
          record.tier,
          record.amountCents,
          record.currency,
          record.retainUntil || null,
        ]
      );
      return mapBid(result.rows[0]);
    },
    async getBid(bidId) {
      const result = await pool.query('SELECT * FROM fulfillment_bids WHERE bid_id = $1', [bidId]);
      return mapBid(result.rows[0]);
    },
    async getBidByTokenHash(hash) {
      const result = await pool.query('SELECT * FROM fulfillment_bids WHERE access_token_hash = $1', [hash]);
      return mapBid(result.rows[0]);
    },
    async attachSession(bidId, sessionId) {
      const result = await pool.query(
        `UPDATE fulfillment_bids
         SET session_id = $2
         WHERE bid_id = $1
           AND session_id IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM fulfillment_bids existing
             WHERE existing.session_id = $2 AND existing.bid_id <> $1
           )
         RETURNING *`,
        [bidId, sessionId]
      );
      return mapBid(result.rows[0]);
    },
    async markPaid(bidId, sessionId) {
      const result = await pool.query(
        `UPDATE fulfillment_bids
         SET payment_status = 'paid', session_id = $2
         WHERE bid_id = $1
           AND consent
           AND (session_id IS NULL OR session_id = $2)
         RETURNING *`,
        [bidId, sessionId]
      );
      return mapBid(result.rows[0]);
    },
    async deleteBid(bidId) {
      await pool.query('DELETE FROM fulfillment_bids WHERE bid_id = $1', [bidId]);
    },
    async claimEvent(eventId) {
      return withClient(async (client) => {
        await client.query('BEGIN');
        try {
          const inserted = await client.query(
            `INSERT INTO fulfillment_events (
               event_id, status, delivery_status, attempts, lease_until
             ) VALUES ($1, 'processing', 'not_requested', 1, now() + ($2::int * interval '1 millisecond'))
             ON CONFLICT (event_id) DO NOTHING
             RETURNING delivery_status, provider_idempotency_key`,
            [eventId, leaseMs]
          );
          if (inserted.rowCount === 1) {
            await client.query('COMMIT');
            return {
              action: 'process',
              emailSent: false,
              deliveryStatus: 'not_requested',
              providerIdempotencyKey: null,
            };
          }
          const locked = await client.query(
            'SELECT * FROM fulfillment_events WHERE event_id = $1 FOR UPDATE',
            [eventId]
          );
          const row = locked.rows[0];
          if (row.status === 'succeeded') {
            await client.query('COMMIT');
            return {
              action: 'ack',
              emailSent: row.delivery_status === 'sent',
              deliveryStatus: row.delivery_status,
              providerIdempotencyKey: row.provider_idempotency_key,
            };
          }
          const leaseOpen = row.status === 'processing'
            && row.lease_until
            && new Date(row.lease_until).getTime() > Date.now();
          if (leaseOpen) {
            await client.query('COMMIT');
            return { action: 'busy', deliveryStatus: row.delivery_status };
          }
          const updated = await client.query(
            `UPDATE fulfillment_events
             SET status = 'processing',
                 attempts = attempts + 1,
                 lease_until = now() + ($2::int * interval '1 millisecond'),
                 updated_at = now()
             WHERE event_id = $1
             RETURNING delivery_status, provider_idempotency_key`,
            [eventId, leaseMs]
          );
          await client.query('COMMIT');
          return claimResult(updated.rows[0]);
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      });
    },
    async beginDelivery(eventId, idempotencyKey) {
      const result = await pool.query(
        `UPDATE fulfillment_events
         SET delivery_status = CASE
               WHEN delivery_status IN ('sent', 'accepted_unacked') THEN delivery_status
               ELSE 'sending'
             END,
             provider_idempotency_key = COALESCE(provider_idempotency_key, $2),
             updated_at = now()
         WHERE event_id = $1 AND status = 'processing'
         RETURNING provider_idempotency_key, delivery_status`,
        [eventId, idempotencyKey]
      );
      return result.rows[0]
        ? {
          providerIdempotencyKey: result.rows[0].provider_idempotency_key,
          deliveryStatus: result.rows[0].delivery_status,
        }
        : null;
    },
    async markDeliveryUnacked(eventId) {
      await pool.query(
        `UPDATE fulfillment_events
         SET delivery_status = 'accepted_unacked', updated_at = now()
         WHERE event_id = $1 AND delivery_status IN ('sending', 'accepted_unacked')`,
        [eventId]
      );
    },
    async markEmailSent(eventId) {
      await pool.query(
        `UPDATE fulfillment_events
         SET delivery_status = 'sent', updated_at = now()
         WHERE event_id = $1`,
        [eventId]
      );
    },
    async completeEvent(eventId, details = {}) {
      await pool.query(
        `UPDATE fulfillment_events
         SET status = 'succeeded',
             delivery_status = CASE
               WHEN $2::boolean THEN 'sent'
               WHEN $3::boolean THEN 'skipped'
               ELSE delivery_status
             END,
             last_error_code = $4,
             lease_until = NULL,
             updated_at = now()
         WHERE event_id = $1 AND status <> 'succeeded'`,
        [eventId, details.emailSent === true, details.skipped === true, details.lastErrorCode || null]
      );
    },
    async failEvent(eventId, lastErrorCode = null) {
      await pool.query(
        `UPDATE fulfillment_events
         SET status = 'failed',
             last_error_code = COALESCE($2, last_error_code),
             lease_until = now(),
             updated_at = now()
         WHERE event_id = $1 AND status <> 'succeeded'`,
        [eventId, lastErrorCode]
      );
    },
    async getEvent(eventId) {
      const result = await pool.query('SELECT * FROM fulfillment_events WHERE event_id = $1', [eventId]);
      const row = result.rows[0];
      if (!row) return null;
      return {
        status: row.status,
        deliveryStatus: row.delivery_status,
        emailSent: row.delivery_status === 'sent',
        providerIdempotencyKey: row.provider_idempotency_key,
        attempts: row.attempts,
        lastErrorCode: row.last_error_code,
      };
    },
    async expireLease(eventId) {
      await pool.query(
        `UPDATE fulfillment_events
         SET lease_until = now() - interval '1 second'
         WHERE event_id = $1`,
        [eventId]
      );
    },
    async setRetainUntil(bidId, retainUntil) {
      await pool.query(
        'UPDATE fulfillment_bids SET retain_until = $2 WHERE bid_id = $1',
        [bidId, retainUntil]
      );
    },
    async purgeExpiredBids() {
      const result = await pool.query(
        `DELETE FROM fulfillment_bids
         WHERE retain_until IS NOT NULL AND retain_until <= now()
         RETURNING bid_id`
      );
      return result.rowCount;
    },
    async bidCount() {
      const result = await pool.query('SELECT count(*)::int AS count FROM fulfillment_bids');
      return result.rows[0].count;
    },
    async resetForTests() {
      if (process.env.NODE_ENV !== 'test') {
        throw new Error('Refusing to reset the fulfillment store outside tests');
      }
      await pool.query('DELETE FROM fulfillment_events');
      await pool.query('DELETE FROM fulfillment_bids');
    },
    async close() {
      await pool.end();
    },
  };
}

module.exports = { createPostgresFulfillmentStore };
