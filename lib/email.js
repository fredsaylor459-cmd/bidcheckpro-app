'use strict';

let testTransport = null;

function setEmailTransportForTests(transport) {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Email test transport refused outside NODE_ENV=test');
  }
  testTransport = transport || null;
}

function unconfiguredTransport() {
  return {
    async send() {
      const error = new Error('email_transport_unconfigured');
      error.code = 'email_transport_unconfigured';
      throw error;
    },
  };
}

function isLocalHostname(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

function resendEndpoint() {
  const override = process.env.RESEND_API_BASE;
  if (!override) return 'https://api.resend.com/emails';
  let parsed;
  try {
    parsed = new URL(override);
  } catch {
    const error = new Error('RESEND_API_BASE is not a valid URL.');
    error.code = 'email_transport_unconfigured';
    throw error;
  }
  if (!isLocalHostname(parsed.hostname)) {
    const error = new Error('RESEND_API_BASE is only allowed for a local inert sink.');
    error.code = 'email_transport_unconfigured';
    throw error;
  }
  const path = parsed.pathname.replace(/\/$/, '');
  return `${parsed.origin}${path}/emails`;
}

function createResendTransport() {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  return {
    async send({ to, subject, html, text, idempotencyKey }) {
      if (!to) {
        const error = new Error('missing_recipient');
        error.code = 'missing_recipient';
        throw error;
      }
      const response = await fetch(resendEndpoint(), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey || '',
        },
        body: JSON.stringify({
          from,
          to: Array.isArray(to) ? to : [to],
          subject,
          html: html || undefined,
          text: text || undefined,
        }),
      });
      let data = {};
      try {
        data = await response.json();
      } catch {
        data = {};
      }
      if (!response.ok) {
        const error = new Error('resend_failed');
        error.code = 'resend_failed';
        error.accepted = false;
        throw error;
      }
      return { id: data.id || null };
    },
  };
}

function getEmailTransport() {
  if (process.env.NODE_ENV === 'test' && testTransport) return testTransport;
  const hasKey = Boolean(process.env.RESEND_API_KEY);
  const hasFrom = Boolean(process.env.RESEND_FROM);
  if (hasKey || hasFrom) {
    if (!hasKey || !hasFrom) return unconfiguredTransport();
    return createResendTransport();
  }
  if (process.env.EMAIL_DELIVERY_ENABLED === 'true') return unconfiguredTransport();
  return null;
}

function publicEmailDisabled() {
  return {
    status: 403,
    json: {
      error: 'Email sending is disabled.',
      code: 'email_disabled',
    },
  };
}

module.exports = {
  setEmailTransportForTests,
  getEmailTransport,
  publicEmailDisabled,
  resendEndpoint,
};
