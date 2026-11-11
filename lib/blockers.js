'use strict';

const FULFILLMENT_BLOCKERS = [
  'FULFILLMENT_DATABASE_URL must be a postgres:// or postgresql:// connection string. Hosted Postgres such as Neon is allowed, and non-local hosts require TLS. Unset returns 503.',
  'In-memory storage is refused outside tests and is not a production store.',
  'Customer email is sent only from the paid fulfillment flow when RESEND_API_KEY and RESEND_FROM are set. POST /api/send-email does not send.',
  'Prices are fixed on the server: single $79 (7900), compare $149 (14900), full project $359 (35900).',
];

module.exports = { FULFILLMENT_BLOCKERS };
