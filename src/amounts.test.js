import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_AMOUNT_UNITS,
  MIN_FEE_UNITS,
  formatAtomic,
  parseAmountUnits,
  parseFeeUnits
} from './amounts.js';

test('frontend amount parsing accepts "10" BNKR and normalizes payload units', () => {
  assert.equal(parseAmountUnits('10'), 1_000_000_000n);
  assert.equal(formatAtomic(parseAmountUnits('10')), '10');
  assert.equal(parseAmountUnits('10') >= MIN_AMOUNT_UNITS, true);
});

test('frontend fee parsing accepts the minimum 0.001 BNKR fee without using amount minimum', () => {
  assert.equal(parseFeeUnits('0.001'), MIN_FEE_UNITS);
  assert.equal(formatAtomic(parseFeeUnits('0.001')), '0.001');
});
