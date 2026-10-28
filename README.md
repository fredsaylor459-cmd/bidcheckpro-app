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

## Deploy to Vercel

Push to GitHub and import in Vercel. Add env vars.

## Stripe webhook

Endpoint: `https://your-domain.vercel.app/api/webhook`
Event: `checkout.session.completed`
