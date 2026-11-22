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
  let hostname;
  try {
    parsed = new URL(connectionString);
    hostname = decodeURIComponent(parsed.hostname);
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
  const queryHosts = parsed.searchParams.getAll('host');
  const effectiveHost = queryHosts.at(-1) || hostname || process.env.PGHOST;
  const local = [hostname, effectiveHost].every(
    (host) => isLocalHostname(host) || host.startsWith('/')
  );
  const sslModes = parsed.searchParams.getAll('sslmode');
  const sslmode = sslModes.at(-1) ?? null;
  // pg lets URL parameters override the SSL option supplied by the caller.
  const ssl = parsed.searchParams.getAll('ssl');
  const disablesTls = sslModes.includes('disable') || ssl.includes('0') || ssl.includes('');
  if (!local && disablesTls) {
    return {
      ok: false,
      local: false,
      requireTls: true,
      error: 'FULFILLMENT_DATABASE_URL must use TLS for a non-local host. Use sslmode=require and remove any disabled or empty SSL setting.',
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
