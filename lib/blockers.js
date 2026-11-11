'use strict';

const FULFILLMENT_BLOCKERS = [
  'No approved durable fulfillment store is configured. The PostgreSQL adapter stays inactive until FULFILLMENT_DATABASE_URL is a local database URL.',
  'In-memory storage is refused outside tests and is not a production store.',
  'Email delivery stays disabled until an owner-approved transport exists.',
  'Compare-bids and full-project checkout are not implemented.',
];

module.exports = { FULFILLMENT_BLOCKERS };
