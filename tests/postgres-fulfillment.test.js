'use strict';

require('./network-guard');

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { before, after, beforeEach, describe, test } = require('node:test');
const { isLocalPostgresUrl } = require('../lib/database-url');
const { applyMigrations } = require('../lib/migrate');
const { createPostgresFulfillmentStore } = require('../lib/postgres-store');
const { setFulfillmentStoreForTests } = require('../lib/store');
const { setCheckoutGatewayForTests } = require('../lib/stripe-gateway');
const { setEmailTransportForTests } = require('../lib/email');
const { hashAccessToken } = require('../lib/tokens');
const { handleCheckout, handleWebhook, handleSendEmail } = require('../lib/handlers');
const {
  WEBHOOK_SECRET,
  createFakeGateway,
  completedEvent,
  sign,
  captureLogs,
} = require('./helpers');

const ADMIN_URL = process.env.FULFILLMENT_ADMIN_URL || 'postgresql:///postgres?host=/var/run/postgresql';
const DISPOSABLE_DB = 'bidcheckpro_fulfillment_it';
const LONG_BID = `Line '); DROP TABLE fulfillment_bids; --\nFULL_BID_MARKER\n${'Z'.repeat(500)}`;

let databaseUrl;
let disposable = false;
let store;
let gateway;

async function provision() {
  if (process.env.FULFILLMENT_DATABASE_URL) {
    assert.equal(isLocalPostgresUrl(process.env.FULFILLMENT_DATABASE_URL), true);
    return { url: process.env.FULFILLMENT_DATABASE_URL, disposable: false };
  }
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DISPOSABLE_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DISPOSABLE_DB}`);
  await admin.end();
  return {
    url: `postgresql:///${DISPOSABLE_DB}?host=/var/run/postgresql`,
    disposable: true,
  };
}

describe('local PostgreSQL fulfillment', { concurrency: false }, () => {
  before(async () => {
    process.env.NODE_ENV = 'test';
    const created = await provision();
    databaseUrl = created.url;
    disposable = created.disposable;
    await applyMigrations(databaseUrl);
    store = createPostgresFulfillmentStore({ connectionString: databaseUrl });
    gateway = createFakeGateway();
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
    process.env.NEXT_PUBLIC_BASE_URL = 'http://127.0.0.1:3000';
    delete process.env.EMAIL_DELIVERY_ENABLED;
    delete process.env.RESEND_API_KEY;
    setFulfillmentStoreForTests(store);
    setCheckoutGatewayForTests(gateway);
  });

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    await store.resetForTests();
    gateway = createFakeGateway();
    setCheckoutGatewayForTests(gateway);
    setFulfillmentStoreForTests(store);
    setEmailTransportForTests(null);
    delete process.env.EMAIL_DELIVERY_ENABLED;
  });

  after(async () => {
    if (store) await store.close();
    if (!disposable) return;
    const admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DISPOSABLE_DB} WITH (FORCE)`);
    await admin.end();
  });

  test('stores the full bid and only the access-token hash', async () => {
    const { result, lines } = await captureLogs(async () => handleCheckout({
      tier: 'single',
      bidText: LONG_BID,
      side: 'receiving',
      consent: true,
    }));
    assert.equal(result.status, 200);
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const row = await client.query('SELECT * FROM fulfillment_bids WHERE bid_id = $1', [result.json.bidId]);
      assert.equal(row.rows[0].bid_text, LONG_BID);
      assert.equal(row.rows[0].access_token_hash, hashAccessToken(result.json.accessToken));
      assert.equal(JSON.stringify(row.rows).includes(result.json.accessToken), false);
      assert.equal(row.rows[0].amount_cents, 7900);
      assert.equal(row.rows[0].currency, 'usd');
      assert.equal(row.rows[0].tier, 'single');
      const columns = await client.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'fulfillment_bids'`
      );
      const names = columns.rows.map((column) => column.column_name);
      assert.equal(names.includes('email'), false);
      assert.equal(names.includes('access_token'), false);
      const stillThere = await client.query(
        `SELECT to_regclass('public.fulfillment_bids') AS bids,
                to_regclass('public.fulfillment_events') AS events`
      );
      assert.equal(stillThere.rows[0].bids, 'fulfillment_bids');
      assert.equal(stillThere.rows[0].events, 'fulfillment_events');
    } finally {
      await client.end();
    }
    assert.equal(lines.join('\n').includes('FULL_BID_MARKER'), false);
    assert.equal(lines.join('\n').includes(result.json.accessToken), false);
  });

  test('a second database connection sees the event after a crash window', async () => {
    const other = createPostgresFulfillmentStore({ connectionString: databaseUrl });
    try {
      const first = await store.claimEvent('evt_pg_lease');
      assert.equal(first.action, 'process');
      await store.beginDelivery('evt_pg_lease', 'idem-lease');
      const busy = await other.claimEvent('evt_pg_lease');
      assert.equal(busy.action, 'busy');
      await store.expireLease('evt_pg_lease');
      const recovered = await other.claimEvent('evt_pg_lease');
      assert.equal(recovered.action, 'retry_same_key');
      assert.equal(recovered.providerIdempotencyKey, 'idem-lease');
      const seen = await other.getEvent('evt_pg_lease');
      assert.equal(seen.deliveryStatus, 'sending');
      assert.equal(seen.attempts >= 2, true);
    } finally {
      await other.close();
    }
  });

  test('concurrent claims allow one worker', async () => {
    const [first, second] = await Promise.all([
      store.claimEvent('evt_pg_parallel'),
      store.claimEvent('evt_pg_parallel'),
    ]);
    const actions = [first.action, second.action].sort();
    assert.deepEqual(actions, ['busy', 'process']);
  });

  test('provider acceptance before acknowledgement is retried with one logical send', async () => {
    const created = await handleCheckout({
      tier: 'single',
      bidText: LONG_BID,
      side: 'sending',
      consent: true,
    });
    const bid = await store.getBid(created.json.bidId);
    const logical = new Map();
    let invocations = 0;
    setEmailTransportForTests({
      async send(message) {
        invocations += 1;
        assert.equal(message.idempotencyKey, 'fulfillment:evt_pg_crash');
        if (logical.has(message.idempotencyKey)) {
          return { id: logical.get(message.idempotencyKey), duplicate: true };
        }
        logical.set(message.idempotencyKey, 'email_logical_1');
        const error = new Error('accepted then killed before database acknowledgement');
        error.accepted = true;
        error.code = 'crash_after_accept';
        throw error;
      },
    });
    const event = completedEvent({
      id: 'evt_pg_crash',
      sessionId: bid.sessionId,
      bidId: created.json.bidId,
    });
    const signed = sign(event);
    const crashed = await handleWebhook(signed.payload, signed.header);
    assert.equal(crashed.status, 500);
    assert.equal(crashed.json.code, 'delivery_unacked');
    assert.equal((await store.getEvent('evt_pg_crash')).deliveryStatus, 'accepted_unacked');

    const retried = await handleWebhook(signed.payload, signed.header);
    assert.equal(retried.status, 200);
    assert.equal((await store.getEvent('evt_pg_crash')).deliveryStatus, 'sent');
    assert.equal(logical.size, 1);
    assert.equal(invocations, 2);
    const replay = await handleWebhook(signed.payload, signed.header);
    assert.equal(replay.json.duplicate, true);
    assert.equal(invocations, 2);
    assert.equal((await store.getBid(created.json.bidId)).paymentStatus, 'paid');
  });

  test('mismatched amount does not mark the bid paid', async () => {
    const created = await handleCheckout({
      tier: 'single',
      bidText: 'Framing labor 10 hr $40 $400',
      side: 'receiving',
      consent: true,
    });
    const bid = await store.getBid(created.json.bidId);
    const event = completedEvent({
      id: 'evt_pg_amount',
      sessionId: bid.sessionId,
      bidId: created.json.bidId,
      amountTotal: 100,
      tier: 'compare',
    });
    const signed = sign(event);
    const result = await handleWebhook(signed.payload, signed.header);
    assert.equal(result.json.code, 'payment_mismatch');
    assert.equal((await store.getBid(created.json.bidId)).paymentStatus, 'unpaid');
    const replay = await handleWebhook(signed.payload, signed.header);
    assert.equal(replay.json.duplicate, true);
  });

  test('expired bid text is deleted and unexpired text is kept', async () => {
    process.env.FULFILLMENT_RETENTION_DAYS = '30';
    const created = await handleCheckout({
      tier: 'single',
      bidText: LONG_BID,
      side: 'receiving',
      consent: true,
    });
    delete process.env.FULFILLMENT_RETENTION_DAYS;
    const kept = await handleCheckout({
      tier: 'single',
      bidText: 'Kept line item $20 $20',
      side: 'receiving',
      consent: true,
    });
    assert.ok(created.json.bidId);
    assert.equal((await store.getBid(kept.json.bidId)).retainUntil, null);
    await store.setRetainUntil(created.json.bidId, new Date(Date.now() - 1000).toISOString());
    const removed = await store.purgeExpiredBids();
    assert.equal(removed, 1);
    assert.equal(await store.getBid(created.json.bidId), null);
    assert.equal((await store.getBid(kept.json.bidId)).bidText, 'Kept line item $20 $20');
  });

  test('application role cannot create tables', async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bcp_app_it') THEN
          CREATE ROLE bcp_app_it NOLOGIN;
        END IF;
      END $$`);
      await client.query('GRANT bcp_app_it TO CURRENT_USER');
      await client.query('GRANT USAGE ON SCHEMA public TO bcp_app_it');
      await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE
        ON fulfillment_bids, fulfillment_events, schema_migrations TO bcp_app_it`);
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE bcp_app_it');
      await assert.rejects(
        () => client.query('CREATE TABLE forbidden_by_least_privilege (id integer)'),
        (error) => error && error.code === '42501'
      );
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  });

  test('public email route stays closed while the ledger is durable', async () => {
    let sent = 0;
    setEmailTransportForTests({
      async send() {
        sent += 1;
      },
    });
    process.env.RESEND_API_KEY = 're_synthetic_not_real';
    const result = await handleSendEmail({ to: 'synthetic-attacker@example.test', subject: 'nope' });
    assert.equal(result.status, 403);
    assert.equal(sent, 0);
  });

  test('one checkout session is fulfilled once across two event ids', async () => {
    const created = await handleCheckout({
      tier: 'compare',
      bidText: 'Labor $1,000\nMaterials $1,160\nTotal $2,660',
      secondBidText: 'Labor $1,000\nMaterials $1,160\nTotal $2,160',
      side: 'receiving',
      consent: true,
    });
    assert.equal(created.status, 200);
    const bid = await store.getBid(created.json.bidId);
    assert.equal(bid.amountCents, 14900);
    assert.match(bid.secondBidText, /2,160/);
    const messages = [];
    setEmailTransportForTests({
      async send(message) {
        messages.push(message);
        return { id: 'email_pg_once' };
      },
    });
    const first = completedEvent({
      id: 'evt_pg_session_a',
      sessionId: bid.sessionId,
      bidId: created.json.bidId,
      amountTotal: 14900,
      tier: 'compare',
    });
    const second = completedEvent({
      id: 'evt_pg_session_b',
      sessionId: bid.sessionId,
      bidId: created.json.bidId,
      amountTotal: 14900,
      tier: 'compare',
    });
    const signedFirst = sign(first);
    const signedSecond = sign(second);
    const firstResult = await handleWebhook(signedFirst.payload, signedFirst.header);
    const secondResult = await handleWebhook(signedSecond.payload, signedSecond.header);
    const replay = await handleWebhook(signedFirst.payload, signedFirst.header);
    assert.equal(firstResult.json.fulfilled, true);
    assert.equal(secondResult.json.duplicate, true);
    assert.equal(replay.json.duplicate, true);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].idempotencyKey, 'fulfillment:evt_pg_session_a');
    assert.equal((await store.getBid(created.json.bidId)).paymentStatus, 'paid');
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const rows = await client.query(
        'SELECT event_id, delivery_status, checkout_session_id FROM fulfillment_events ORDER BY event_id'
      );
      const owners = rows.rows.filter((row) => row.checkout_session_id === bid.sessionId);
      assert.equal(owners.length, 1);
      assert.equal(owners[0].event_id, 'evt_pg_session_a');
      assert.equal(owners[0].delivery_status, 'sent');
    } finally {
      await client.end();
    }
  });

  test('docs state the ledger is not exactly-once email', () => {
    const readme = fs.readFileSync(path.join(__dirname, '..', 'db', 'README.md'), 'utf8');
    assert.match(readme, /not exactly-once/);
    assert.match(readme, /at-least-once/);
    assert.match(readme, /provider_idempotency_key/);
  });
});
