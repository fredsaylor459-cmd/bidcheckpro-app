'use strict';

const crypto = require('crypto');

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(16).toString('base64url')}`;
}

function createAccessToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashAccessToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

module.exports = { randomId, createAccessToken, hashAccessToken };
