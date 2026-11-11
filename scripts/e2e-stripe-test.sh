#!/bin/sh
# Real Stripe test-mode checkout for a later run. This script is not part of npm test.
#
# Requires:
#   STRIPE_SECRET_KEY=sk_test_...     (sk_live_ is refused)
#   stripe CLI, authenticated as that same account
#   FULFILLMENT_DATABASE_URL          (local unless ALLOW_HOSTED_E2E=1)
#   npm run build already completed
#
# Card 4242 is Stripe's tok_visa test token (4242424242424242). The script
# confirms the Checkout PaymentIntent with that token and does not send a raw PAN.
# Email goes to a local inert sink unless SEND_REAL_EMAIL=1 is set along with
# RESEND_API_KEY and RESEND_FROM.
set -eu
cd "$(dirname "$0")/.."

if [ -z "${STRIPE_SECRET_KEY:-}" ]; then
  echo "STRIPE_SECRET_KEY is required and must be an sk_test_ key." >&2
  exit 2
fi
case "$STRIPE_SECRET_KEY" in
  sk_live_*|rk_live_*)
    echo "Refusing a live Stripe key." >&2
    exit 2
    ;;
  sk_test_*)
    ;;
  *)
    echo "STRIPE_SECRET_KEY must start with sk_test_." >&2
    exit 2
    ;;
esac

if ! command -v stripe >/dev/null 2>&1; then
  echo "The stripe CLI is required (https://docs.stripe.com/stripe-cli)." >&2
  exit 2
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required." >&2
  exit 2
fi
if [ -z "${FULFILLMENT_DATABASE_URL:-}" ]; then
  echo "FULFILLMENT_DATABASE_URL is required." >&2
  exit 2
fi

case "${FULFILLMENT_DATABASE_URL}" in
  *localhost*|*127.0.0.1*|*::1*|postgresql:///*|postgres:///*)
    ;;
  *)
    if [ "${ALLOW_HOSTED_E2E:-}" != "1" ]; then
      echo "Refusing a non-local FULFILLMENT_DATABASE_URL. Set ALLOW_HOSTED_E2E=1 to use a hosted test database." >&2
      exit 2
    fi
    ;;
esac

BASE_PORT="${BASE_PORT:-3456}"
BASE_URL="${BASE_URL:-http://127.0.0.1:${BASE_PORT}}"
case "$BASE_URL" in
  https://bidcheckpro.com*|https://www.bidcheckpro.com*|http://bidcheckpro.com*|http://www.bidcheckpro.com*)
    echo "Refusing to run this test-mode script against production." >&2
    exit 2
    ;;
esac

if [ ! -d .next ]; then
  echo "Build the app first: npm run build" >&2
  exit 2
fi

node -e "require('./lib/migrate').applyMigrations(process.env.FULFILLMENT_DATABASE_URL).catch((error) => { console.error(error.message); process.exit(1); })"

LISTEN_LOG="$(mktemp)"
APP_LOG="$(mktemp)"
SINK_LOG="$(mktemp)"
SINK_PORT="$(node -e "const net=require('net'); const s=net.createServer(); s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port)); s.close();});")"

cleanup() {
  if [ -n "${LISTEN_PID:-}" ]; then kill "$LISTEN_PID" 2>/dev/null || true; fi
  if [ -n "${APP_PID:-}" ]; then kill "$APP_PID" 2>/dev/null || true; fi
  if [ -n "${SINK_PID:-}" ]; then kill "$SINK_PID" 2>/dev/null || true; fi
  rm -f "$LISTEN_LOG" "$APP_LOG" "$SINK_LOG"
}
trap cleanup EXIT INT TERM

node -e '
const http = require("http");
const fs = require("fs");
const port = Number(process.argv[1]);
const file = process.argv[2];
http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    fs.appendFileSync(file, JSON.stringify({
      idempotency: req.headers["idempotency-key"] || "",
      body: Buffer.concat(chunks).toString("utf8"),
    }) + "\n");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "email_inert_cli" }));
  });
}).listen(port, "127.0.0.1");
' "$SINK_PORT" "$SINK_LOG" &
SINK_PID=$!

stripe listen \
  --api-key "$STRIPE_SECRET_KEY" \
  --forward-to "${BASE_URL}/api/webhook" \
  >"$LISTEN_LOG" 2>&1 &
LISTEN_PID=$!

WEBHOOK_SECRET=""
i=0
while [ "$i" -lt 40 ]; do
  WEBHOOK_SECRET="$(grep -E -o 'whsec_[A-Za-z0-9_+=/-]+' "$LISTEN_LOG" | head -n 1 || true)"
  if [ -n "$WEBHOOK_SECRET" ]; then
    break
  fi
  i=$((i + 1))
  sleep 0.5
done
if [ -z "$WEBHOOK_SECRET" ]; then
  echo "stripe listen did not print a webhook secret." >&2
  cat "$LISTEN_LOG" >&2 || true
  exit 1
fi

RESEND_API_KEY_VALUE="${RESEND_API_KEY:-re_test_inert}"
RESEND_FROM_VALUE="${RESEND_FROM:-BidCheckPro <reviews@example.test>}"
RESEND_BASE="http://127.0.0.1:${SINK_PORT}"
if [ "${SEND_REAL_EMAIL:-}" = "1" ]; then
  if [ -z "${RESEND_API_KEY:-}" ] || [ -z "${RESEND_FROM:-}" ]; then
    echo "SEND_REAL_EMAIL=1 requires RESEND_API_KEY and RESEND_FROM." >&2
    exit 2
  fi
  RESEND_BASE=""
fi

# next start forces NODE_ENV=production, so the public origin must be https and not localhost.
env \
  STRIPE_SECRET_KEY="$STRIPE_SECRET_KEY" \
  STRIPE_WEBHOOK_SECRET="$WEBHOOK_SECRET" \
  NEXT_PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://preview.bidcheckpro.test}" \
  FULFILLMENT_DATABASE_URL="$FULFILLMENT_DATABASE_URL" \
  RESEND_API_KEY="$RESEND_API_KEY_VALUE" \
  RESEND_FROM="$RESEND_FROM_VALUE" \
  RESEND_API_BASE="$RESEND_BASE" \
  npx next start -H 127.0.0.1 -p "$BASE_PORT" >"$APP_LOG" 2>&1 &
APP_PID=$!

ready=0
i=0
while [ "$i" -lt 60 ]; do
  if curl -sf -o /dev/null "$BASE_URL/"; then
    ready=1
    break
  fi
  i=$((i + 1))
  sleep 0.5
done
if [ "$ready" -ne 1 ]; then
  echo "The app did not become ready." >&2
  cat "$APP_LOG" >&2 || true
  exit 1
fi

CHECKOUT="$(curl -sf -X POST "$BASE_URL/api/checkout" \
  -H 'Content-Type: application/json' \
  -d '{"tier":"single","bidText":"Labor $1,000\nMaterials $800\nElectrical $360\nTotal $2,660","side":"receiving","consent":true,"amount":50}')"
SESSION_ID="$(printf '%s' "$CHECKOUT" | node -e 'let s=""; process.stdin.on("data",(c)=>s+=c); process.stdin.on("end",()=>{ const d=JSON.parse(s); if(!d.sessionId) process.exit(1); process.stdout.write(d.sessionId); });')"
echo "Created test Checkout session ${SESSION_ID}"

PI="$(stripe checkout sessions retrieve "$SESSION_ID" --api-key "$STRIPE_SECRET_KEY" | node -e 'let s=""; process.stdin.on("data",(c)=>s+=c); process.stdin.on("end",()=>{ const j=JSON.parse(s); const pi=j.payment_intent; if(!pi){ console.error("Checkout session has no payment_intent yet"); process.exit(1); } process.stdout.write(typeof pi==="string"?pi:pi.id); });')"

# tok_visa is the test token for 4242424242424242.
stripe payment_intents confirm "$PI" \
  --api-key "$STRIPE_SECRET_KEY" \
  -d payment_method_data[type]=card \
  -d payment_method_data[card][token]=tok_visa \
  >/dev/null

i=0
PAID="unpaid"
while [ "$i" -lt 40 ]; do
  PAID="$(SESSION_ID="$SESSION_ID" FULFILLMENT_DATABASE_URL="$FULFILLMENT_DATABASE_URL" node <<'NODE'
const { Client } = require('pg');
(async () => {
  const client = new Client({ connectionString: process.env.FULFILLMENT_DATABASE_URL });
  await client.connect();
  const result = await client.query(
    'SELECT payment_status FROM fulfillment_bids WHERE session_id = $1',
    [process.env.SESSION_ID]
  );
  process.stdout.write(result.rows[0] ? result.rows[0].payment_status : 'missing');
  await client.end();
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
NODE
)"
  if [ "$PAID" = "paid" ]; then
    break
  fi
  i=$((i + 1))
  sleep 0.5
done

if [ "$PAID" != "paid" ]; then
  echo "Fulfillment did not mark the session paid (last status: ${PAID})." >&2
  echo "stripe listen log:" >&2
  cat "$LISTEN_LOG" >&2 || true
  echo "app log:" >&2
  cat "$APP_LOG" >&2 || true
  exit 1
fi

echo "Test-mode Checkout ${SESSION_ID} was paid with tok_visa (card 4242) and fulfilled once."
if [ "${SEND_REAL_EMAIL:-}" != "1" ]; then
  echo "Email was delivered to the local inert sink, not Resend."
fi
