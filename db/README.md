# PostgreSQL fulfillment store

`FULFILLMENT_DATABASE_URL` accepts a local or hosted `postgres://` / `postgresql://` URL, including Neon. A non-local host must use TLS (`sslmode=require`). `sslmode=disable` on a remote host is refused. When the variable is unset or invalid, checkout, paid review, and webhooks return 503 and the error names `FULFILLMENT_DATABASE_URL`. No connection is opened in that case.

Prices are fixed in `lib/offers.js`: single $79 (7900), compare $149 (14900), full project $359 (35900). `POST /api/send-email` stays closed. Customer mail is sent only from the paid webhook when `RESEND_API_KEY` and `RESEND_FROM` are set. Resend is asked to dedupe `provider_idempotency_key` via the `Idempotency-Key` header. One checkout session is claimed once, even if Stripe delivers a second event id.

## Configure

Leave `FULFILLMENT_DATABASE_URL` unset until the database exists. Unset means checkout, paid review, and webhooks return 503.

Hosted example:

```bash
export FULFILLMENT_DATABASE_URL="postgresql://user:password@ep-example.neon.tech/bidcheckpro?sslmode=require"
node -e "require('./lib/migrate').applyMigrations(process.env.FULFILLMENT_DATABASE_URL)"
```

Local disposable database:

```bash
createdb bidcheckpro_fulfillment
export FULFILLMENT_DATABASE_URL="postgresql:///bidcheckpro_fulfillment?host=/var/run/postgresql"
node -e "require('./lib/migrate').applyMigrations(process.env.FULFILLMENT_DATABASE_URL)"
psql "$FULFILLMENT_DATABASE_URL" -f db/grants.sql
```

Create `bidcheckpro_app` first, as shown in `db/grants.sql`. The running app should use that role. Local integration tests use an administrator connection only to create a disposable database, then prove the restricted role cannot create tables.

`FULFILLMENT_RETENTION_DAYS` is optional. When it is a positive integer, new consented bids get `retain_until`. When it is unset, `retain_until` stays null and `purgeExpiredBids()` deletes nothing. The owner still has to choose how long full bid text may be kept.

## What the ledger guarantees

- One row per Stripe `event.id`. `claimEvent` inserts that row in a transaction and locks it with `FOR UPDATE`. A second worker either sees an in-date processing lease and gets `busy`, or waits until the first transaction commits.
- A second event id for the same Checkout session loses the unique `checkout_session_id` claim and does not send another email.
- A failed event, or a processing lease that has expired, can be reclaimed. That is retry recovery after a crash. It is not process-local memory.
- Access tokens are stored only as SHA-256 hashes. Buyer email is not a column.
- Full bid text is stored only when `consent` is true. Comparison text is stored in `second_bid_text` for the compare tier. `purgeExpiredBids()` deletes expired rows and does not write the text to logs.

## What it does not guarantee

The database cannot make an external email exactly once.

If the provider accepts a message and the process dies before the ledger commits `delivery_status = sent`, the row remains `sending` or, when the handler observed the acceptance, `accepted_unacked`. A later retry calls the provider again with the same `provider_idempotency_key`. That is at-least-once delivery of the API call.

Exactly once requires the provider to treat that key as idempotent and a reconciliation job for keys left in `sending` or `accepted_unacked`. Resend is called with that key as `Idempotency-Key`. Email delivery here is not exactly-once.

## Tests

`npm test` does not need PostgreSQL. `npm run test:pg` creates or reuses a local database and will fail if local PostgreSQL is down. `scripts/test-local.sh` is the local command. It refuses a non-local URL so the integration suite cannot be pointed at a hosted database by accident. `scripts/e2e-local-fulfillment.js` runs the HTTP app against a mocked Stripe API, a signed webhook, a disposable local database, and an inert email sink.
