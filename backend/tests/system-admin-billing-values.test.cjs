'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { amount, addMonth, date } = require('../src/services/system-admin-billing-values');

test('subscription payment dates advance one calendar month and clamp at month end', () => {
  assert.equal(addMonth('2026-01-31'), '2026-02-28');
  assert.equal(addMonth('2028-01-31'), '2028-02-29');
  assert.equal(addMonth('2026-12-31'), '2027-01-31');
  assert.equal(addMonth('2026-10-11'), '2026-11-11');
});

test('subscription payment amounts normalize USD cents without floating point', () => {
  assert.equal(amount('1'), '1.00');
  assert.equal(amount('125.5'), '125.50');
  assert.equal(amount('9999999999.99'), '9999999999.99');
  for (const value of ['0', '0.00', '-1', '01.00', '1.001', '10000000000.00', 1]) assert.throws(() => amount(value));
});

test('subscription dates require a real ISO calendar day', () => {
  assert.equal(date('2026-10-11', 'nextDueDate'), '2026-10-11');
  for (const value of ['2026-02-29', '2026-13-01', '2026-1-01', '0999-01-01', null]) assert.throws(() => date(value, 'nextDueDate'));
});
