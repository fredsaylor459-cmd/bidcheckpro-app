'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');
const { checkBidArithmetic, compareBids, exactAmount } = require('../lib/bid-math');

const MISMATCH = [
  'Labor $1,000',
  'Materials $800',
  'Electrical $360',
  'Total $2,660',
].join('\n');

describe('bid arithmetic', () => {
  test('flags a stated total that does not match the line items, 2160 vs 2660', () => {
    const result = checkBidArithmetic(MISMATCH);
    assert.equal(result.sumCents, 216000);
    assert.equal(result.statedCents, 266000);
    assert.equal(exactAmount(result.sumCents), '2160');
    assert.equal(exactAmount(result.statedCents), '2660');
    const flag = result.flags.find((item) => item.issue === 'Total does not match line items');
    assert.ok(flag);
    assert.match(flag.note, /2160/);
    assert.match(flag.note, /2660/);
    assert.match(flag.note, /2160 vs 2660/);
  });

  test('a total that matches the line items is not flagged', () => {
    const result = checkBidArithmetic('Labor $1,000\nMaterials $800\nElectrical $360\nTotal $2,160');
    assert.equal(result.sumCents, 216000);
    assert.equal(result.statedCents, 216000);
    assert.equal(result.flags.some((item) => item.issue === 'Total does not match line items'), false);
  });

  test('flags a line extension that is not quantity times rate', () => {
    const result = checkBidArithmetic('Framing labor 10 hr $40 $500\nTotal $500');
    const flag = result.flags.find((item) => item.issue === 'Line total does not match quantity times rate');
    assert.ok(flag);
    assert.match(flag.note, /400 vs 500/);
  });

  test('compares two bids by their stated totals', () => {
    const other = 'Labor $1,000\nMaterials $800\nElectrical $360\nTotal $2,160';
    const result = compareBids(MISMATCH, other);
    assert.equal(result.comparison.bidACents, 266000);
    assert.equal(result.comparison.bidBCents, 216000);
    assert.equal(result.comparison.differenceCents, 50000);
    assert.equal(result.comparison.higher, 'a');
    const flag = result.flags.find((item) => item.issue === 'Bid totals differ');
    assert.match(flag.note, /2660/);
    assert.match(flag.note, /2160/);
    assert.equal(JSON.stringify(result).includes(MISMATCH), false);
  });
});
