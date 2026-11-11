'use strict';

function isLocalHostname(hostname) {
  if (!hostname) return true;
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function describeDatabaseUrl(connectionString) {
  if (!connectionString || typeof connectionString !== 'string' || !connectionString.trim()) {
    return {
      ok: false,
      local: false,
      requireTls: false,
      error: 'FULFILLMENT_DATABASE_URL is not set. Set a postgres:// or postgresql:// URL for local Postgres or a hosted database such as Neon.',
    };
  }
  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch {
    return {
      ok: false,
      local: false,
      requireTls: false,
      error: 'FULFILLMENT_DATABASE_URL is not a valid URL. Use a postgres:// or postgresql:// connection string.',
    };
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    return {
      ok: false,
      local: false,
      requireTls: false,
      error: 'FULFILLMENT_DATABASE_URL must use the postgres: or postgresql: scheme.',
    };
  }
  const local = isLocalHostname(parsed.hostname);
  const sslmode = parsed.searchParams.get('sslmode');
  if (!local && sslmode === 'disable') {
    return {
      ok: false,
      local: false,
      requireTls: true,
      error: 'FULFILLMENT_DATABASE_URL must use TLS for a non-local host. Use sslmode=require and do not set sslmode=disable.',
    };
  }
  return {
    ok: true,
    local,
    sslmode,
    requireTls: !local,
    error: null,
  };
}

function postgresSsl(described) {
  if (!described || !described.requireTls) return undefined;
  return { rejectUnauthorized: described.sslmode !== 'no-verify' };
}

function isLocalPostgresUrl(connectionString) {
  const described = describeDatabaseUrl(connectionString);
  return described.ok === true && described.local === true;
}

module.exports = {
  describeDatabaseUrl,
  isLocalHostname,
  isLocalPostgresUrl,
  postgresSsl,
};
