# BidCheckPro — Automated Bid Review

Paste a bid. The free preview flags soft numbers, missing items, high labor, vague allowances, and totals that do not match the line items. A second bid can be compared on the page and at `POST /api/compare`.

Server prices, charged only by Stripe Checkout:

- Single bid review: $79
- Compare two bids: $149
- Full project coverage: $359

The browser sends a tier name. It does not send the amount.

## Setup

```bash
npm install
cp .env.example .env.local
# Set NEXT_PUBLIC_BASE_URL, Stripe test keys, FULFILLMENT_DATABASE_URL, and Resend.
npm run dev
```

`/api/review` works with no `AI_API_KEY`. The deterministic checker still flags arithmetic such as line items of 2160 against a stated total of 2660. A model is used only when `AI_API_KEY` is set, and arithmetic flags are still added.

`POST /api/send-email` returns 403. Customer mail goes out from the signed webhook through Resend (`RESEND_API_KEY`, `RESEND_FROM`) after a paid Checkout session is claimed. One fulfillment is recorded per Checkout session.

Production `NEXT_PUBLIC_BASE_URL` must be the public https origin. Localhost is not a fallback.

See `db/README.md` for the ledger. Email delivery is at-least-once to the provider, not exactly-once.

## Tests

```bash
npm test
npm run test:pg
scripts/test-local.sh
npm run build
node scripts/e2e-local-fulfillment.js
```

`npm test` uses the in-memory test double and an inert email sink. It does not call Stripe, Resend, or a model host. The local end-to-end script uses a disposable Postgres database, Stripe's signature scheme, and local mocks.

`scripts/e2e-stripe-test.sh` is for a later test-mode run. It refuses any key that is not `sk_test_`, and it is not run in this repo's default test command.

## Production environment

Required before real charges:

- `NEXT_PUBLIC_BASE_URL`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `FULFILLMENT_DATABASE_URL`
- `RESEND_API_KEY`
- `RESEND_FROM`

Recommended: `FULFILLMENT_RETENTION_DAYS`. Optional: `AI_API_KEY`, `AI_API_URL`.
