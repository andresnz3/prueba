'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { manualCash } = require('../src/services/financial-values');
test('manual cash validates exact cents, positive values, direction, reason and operation key', () => {
  const operationKey = randomUUID(), input = { operationKey, direction: 'IN', amount: '10.01', reason: ' Fondo de cambio ' };
  assert.deepEqual(manualCash(input), { ...input, reason: 'Fondo de cambio' });
  for (const amount of ['0', '-1', '1.001', 'NaN', '1e3', '10000000000.00', Infinity, null]) assert.throws(() => manualCash({ ...input, amount }));
  for (const reason of ['', '   ', 'a'.repeat(501), 'line\nbreak', null]) assert.throws(() => manualCash({ ...input, reason }));
  for (const direction of ['INCOMING', 'TRANSFER', null]) assert.throws(() => manualCash({ ...input, direction }));
  assert.throws(() => manualCash({ ...input, operationKey: 'invalid' }));
  assert.throws(() => manualCash({ ...input, businessId: 'injected' }));
});
