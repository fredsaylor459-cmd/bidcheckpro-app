-- Sell-ready fulfillment columns.
-- second_bid_text stores the comparison bid only when the buyer consented.
-- checkout_session_id makes one fulfillment win per Checkout session.

ALTER TABLE fulfillment_bids
  ADD COLUMN second_bid_text text;

ALTER TABLE fulfillment_events
  ADD COLUMN checkout_session_id text;

CREATE UNIQUE INDEX fulfillment_events_checkout_session_uq
  ON fulfillment_events (checkout_session_id)
  WHERE checkout_session_id IS NOT NULL;
