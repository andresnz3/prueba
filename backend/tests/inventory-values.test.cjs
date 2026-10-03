'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const v = require('../src/services/inventory-values');
const { errorHandler } = require('../src/middleware/errors');
test('decimales exactos sin truncado, con limites del esquema', () => {
  assert.equal(v.decimal('9999999999.99', 2, 10), '9999999999.99');
  assert.equal(v.decimal('0.001', 3, 9), '0.001');
  assert.equal(v.decimal('-12.3456', 4, 3, true), '-12.3456');
  for (const value of ['1.001', '1e2', '', null, '10000000000', '-1', Infinity]) assert.throws(() => v.decimal(value, 2, 10));
  assert.equal(v.fixed(v.units('1.234') + v.units('0.001'), 3), '1.235');
});
test('movimientos rechazan cero, tipos de documentos futuros y merma negativa', () => {
  for (const data of [{ type: 'WASTE', quantity: '-1', reason: 'x' }, { type: 'SALE', quantity: '1', reason: 'x' }, { type: 'ADJUSTMENT', quantity: '0', reason: 'x' }, { type: 'WASTE', quantity: '1.0001', reason: 'x' }, { type: 'WASTE', quantity: '1', reason: '' }]) assert.throws(() => v.movement(data));
  assert.equal(v.movement({ type: 'ADJUSTMENT', quantity: '-0.001', reason: 'Conteo' }).quantity, '-0.001');
});
test('productos no aceptan autoridad de negocio, usuario ni revision ausente', () => {
  assert.throws(() => v.product({ revision: 'a'.repeat(64), businessId: '2', name: 'x' }, true));
  assert.throws(() => v.product({ name: 'x' }, true));
  assert.throws(() => v.product({ revision: 'a'.repeat(64), userId: '1' }, true));
});
test('paginacion acotada y campos desconocidos rechazados', () => {
  assert.deepEqual(v.page({ limit: '100', offset: '200' }), { limit: 100, offset: 200 });
  for (const data of [{ limit: '101' }, { offset: '-1' }, { business_id: '2' }, { limit: ['2'] }]) assert.throws(() => v.page(data));
});
test('caida de MySQL devuelve 503 sin informacion interna', () => {
  let status, body;
  errorHandler(Object.assign(new Error('private database details'), { code: 'ECONNREFUSED' }), {}, { headersSent: false, status(value) { status = value; return this; }, json(value) { body = value; } }, () => {});
  assert.equal(status, 503); assert.deepEqual(body, { error: { code: 'DATABASE_UNAVAILABLE' } });
});
