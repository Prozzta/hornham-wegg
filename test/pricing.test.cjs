'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { normalizeModel, priceFor } = loadTs('src/main/pricing.ts');

test('pricing resolves the published Opus 5.5 and Fable 5.1 standard rates', () => {
  assert.deepEqual(priceFor('claude-opus-5-5'), {
    inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.2, cacheWritePerM: 5
  });
  assert.deepEqual(priceFor('claude-fable-5-1'), {
    inputPerM: 10, outputPerM: 50, cacheReadPerM: 0.25, cacheWritePerM: 12.5
  });
});

test('pricing strips the accepted Opus 5.5 1M suffix before lookup', () => {
  assert.equal(normalizeModel('claude-opus-5-5[1m]'), 'claude-opus-5-5');
  assert.deepEqual(priceFor('claude-opus-5-5[1m]'), priceFor('claude-opus-5-5'));
});
