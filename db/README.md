# Provisional PostgreSQL fulfillment store

This adapter speaks PostgreSQL. It is not a choice of Neon, RDS, Supabase, Vercel Postgres, or any other host. `FULFILLMENT_DATABASE_URL` is ignored unless it is a local `postgres://` or `postgresql://` URL (`localhost`, `127.0.0.1`, `::1`, or a Unix socket). Anything else fails closed with HTTP 503. No remote connection is opened.

Paid buttons stay disabled. `POST /api/send-email` stays closed. The Resend HTTP client is not called.

## Configure

Leave `FULFILLMENT_DATABASE_URL` unset until an owner approves a database. Unset means checkout, paid review, and webhooks return 503.

For a local disposable database:

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
- A failed event, or a processing lease that has expired, can be reclaimed. That is retry recovery after a crash. It is not process-local memory.
- Access tokens are stored only as SHA-256 hashes. Buyer email is not a column.
- Full bid text is stored only when `consent` is true. `purgeExpiredBids()` deletes expired rows and does not write the text to logs.

## What it does not guarantee

The database cannot make an external email exactly once.

If the provider accepts a message and the process dies before the ledger commits `delivery_status = sent`, the row remains `sending` or, when the handler observed the acceptance, `accepted_unacked`. A later retry calls the provider again with the same `provider_idempotency_key`. That is at-least-once delivery of the API call.

Exactly once requires the provider to treat that key as idempotent and a reconciliation job for keys left in `sending` or `accepted_unacked`. This repository does not enable a real email transport, so that provider contract is not satisfied here. Email delivery here is not exactly-once.

## Tests

`npm test` does not need PostgreSQL. `npm run test:pg` creates or reuses a local database and will fail if local PostgreSQL is down. `scripts/test-local.sh` is the CI-shaped command. It refuses a non-local URL.
