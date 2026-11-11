-- Provisional PostgreSQL fulfillment schema.
-- This chooses an engine, not a hosting provider. Remote databases stay disabled
-- until the owner sets that policy in application code.

CREATE TABLE fulfillment_bids (
  bid_id text PRIMARY KEY,
  access_token_hash text NOT NULL UNIQUE,
  bid_text text NOT NULL,
  side text NOT NULL CHECK (side IN ('sending', 'receiving')),
  consent boolean NOT NULL CHECK (consent),
  consent_at timestamptz NOT NULL,
  tier text NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  currency text NOT NULL,
  session_id text UNIQUE,
  payment_status text NOT NULL CHECK (payment_status IN ('unpaid', 'paid')),
  retain_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE fulfillment_events (
  event_id text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('processing', 'succeeded', 'failed')),
  delivery_status text NOT NULL CHECK (delivery_status IN (
    'not_requested',
    'sending',
    'accepted_unacked',
    'sent',
    'failed',
    'skipped'
  )),
  provider_idempotency_key text,
  attempts integer NOT NULL DEFAULT 1 CHECK (attempts > 0),
  lease_until timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX fulfillment_events_status_lease_idx
  ON fulfillment_events (status, lease_until);

CREATE INDEX fulfillment_bids_retain_until_idx
  ON fulfillment_bids (retain_until);
