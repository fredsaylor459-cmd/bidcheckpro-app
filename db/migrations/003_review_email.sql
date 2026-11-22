-- Keep the rendered message with the consented bid and its retention policy.
ALTER TABLE fulfillment_bids
  ADD COLUMN review_email jsonb;
