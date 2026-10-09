'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { expense, cancellation } = require('../src/services/expense-values');

test('gastos conectados validan categoría, importe y medio local', () => {
  const result = expense({ operationKey: randomUUID(), category: 'Servicios Básicos', description: 'Pago de internet', receiptReference: '', amount: '12.5', paymentMethod: 'CASH' });
  assert.equal(result.amount, '12.50'); assert.equal(result.receiptReference, null); assert.equal(result.paymentMethod, 'CASH');
  assert.throws(() => expense({ operationKey: randomUUID(), category: 'inventada', description: 'Pago', receiptReference: '', amount: '1.00', paymentMethod: 'BANK' }), { publicCode: 'INVALID_INPUT' });
  assert.throws(() => expense({ operationKey: randomUUID(), category: 'Otro', description: 'Pago', receiptReference: '', amount: '0', paymentMethod: 'CASH' }), { publicCode: 'INVALID_INPUT' });
  assert.throws(() => expense({ operationKey: randomUUID(), category: 'Otro', description: 'Pago', receiptReference: '', amount: '1.00', paymentMethod: 'CARD' }), { publicCode: 'PAYMENT_METHOD_REQUIRED' });
});

test('anular gasto requiere UUID de operación y motivo', () => {
  assert.deepEqual(cancellation({ operationKey: randomUUID(), reason: 'Registro duplicado' }).reason, 'Registro duplicado');
  assert.throws(() => cancellation({ operationKey: randomUUID(), reason: '' }), { publicCode: 'REASON_REQUIRED' });
});
