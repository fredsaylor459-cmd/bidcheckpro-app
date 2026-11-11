'use strict';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function resolveBaseUrl(env = process.env) {
  const value = env.NEXT_PUBLIC_BASE_URL;
  if (!value || typeof value !== 'string') return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (env.NODE_ENV === 'production') {
    if (parsed.protocol !== 'https:') return null;
    if (LOCAL_HOSTS.has(parsed.hostname)) return null;
  }
  return parsed.origin;
}

module.exports = { resolveBaseUrl };
