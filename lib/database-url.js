'use strict';

function isLocalPostgresUrl(connectionString) {
  if (!connectionString || typeof connectionString !== 'string') return false;
  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') return false;
  const host = parsed.hostname;
  if (!host) return true;
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

module.exports = { isLocalPostgresUrl };
