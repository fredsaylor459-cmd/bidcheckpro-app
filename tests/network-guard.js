'use strict';

const http = require('http');
const https = require('https');

function guard(mod) {
  const original = mod.request;
  mod.request = function patched(options, callback) {
    const host = typeof options === 'string'
      ? new URL(options).hostname
      : options?.hostname || options?.host;
    if (host === '127.0.0.1' || host === 'localhost' || host === '::1') {
      return original.apply(this, arguments);
    }
    const error = new Error(`Blocked outbound request to ${host || 'unknown host'}`);
    error.code = 'BLOCKED_NETWORK';
    throw error;
  };
}

guard(http);
guard(https);

if (typeof global.fetch === 'function') {
  const originalFetch = global.fetch.bind(global);
  global.fetch = async function guardedFetch(input, init) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const host = new URL(url, 'http://127.0.0.1').hostname;
    if (host === '127.0.0.1' || host === 'localhost' || host === '::1') {
      return originalFetch(input, init);
    }
    throw new Error(`Blocked outbound fetch to ${host}`);
  };
}
