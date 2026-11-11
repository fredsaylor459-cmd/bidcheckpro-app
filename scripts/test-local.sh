#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

if [ -n "${FULFILLMENT_DATABASE_URL:-}" ]; then
  node -e "const { isLocalPostgresUrl } = require('./lib/database-url'); if (!isLocalPostgresUrl(process.env.FULFILLMENT_DATABASE_URL)) { console.error('Refusing non-local FULFILLMENT_DATABASE_URL'); process.exit(1); }"
fi

npm test
npm run test:pg
