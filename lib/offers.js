'use strict';

// Server-side prices. The browser cannot choose the amount.
const OFFERS = {
  single: {
    tier: 'single',
    amount: 7900,
    currency: 'usd',
    productName: 'Single Bid Review',
    requiresSecondBid: false,
  },
  compare: {
    tier: 'compare',
    amount: 14900,
    currency: 'usd',
    productName: 'Compare Bids',
    requiresSecondBid: true,
  },
  full: {
    tier: 'full',
    amount: 35900,
    currency: 'usd',
    productName: 'Full Project Coverage',
    requiresSecondBid: false,
  },
};

function getOffer(tier) {
  if (typeof tier !== 'string' || !Object.hasOwn(OFFERS, tier)) return null;
  return OFFERS[tier];
}

module.exports = { OFFERS, getOffer };
