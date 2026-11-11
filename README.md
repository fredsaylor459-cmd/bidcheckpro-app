# BidCheckPro — Automated Bid Review

Paste a bid. Get an instant AI-powered review that flags soft numbers, missing items, high labor, and vague allowances.

Built on 36 years of framing, remodels, and punch lists.

## Setup

```bash
npm install
cp .env.example .env.local
# Add your AI_API_KEY and Stripe keys
npm run dev
```

## Paid fulfillment

Paid checkout, compare-bids, full-project coverage, and review email are disabled.
The server refuses an in-memory fulfillment store. A durable store is not configured, so checkout and webhooks fail closed.

## Tests

```bash
npm test
scripts/test-local.sh
```

`npm test` uses the in-memory test double and does not need PostgreSQL. `scripts/test-local.sh` runs that suite plus the local PostgreSQL integration tests. Both use synthetic data and do not call Stripe, email, or model hosts. See `db/README.md` for the store guarantee and its limits.
