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

function getEmailTransport() {
  if (process.env.NODE_ENV === 'test' && testTransport) return testTransport;
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
};
