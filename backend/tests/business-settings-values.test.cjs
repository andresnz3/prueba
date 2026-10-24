'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { settings, legacySettings, stockValue } = require('../src/services/business-settings-values');

const valid = {
  businessName: 'Tienda Central', legalName: 'Comercial Central S.A.', ruc: 'J0310000000000', phone: '2255-1234',
  address: 'Managua', ticketHeader: 'Sucursal Centro', ticketFooter: 'Gracias', minStockDefault: 4.125
};

test('valida y normaliza la configuración comercial admitida', () => {
  assert.deepEqual(settings(valid), { ...valid, minStockDefault: '4.125' });
  assert.equal(settings({ ...valid, ruc: '' }).ruc, null);
  assert.equal(stockValue('0'), '0.000');
});

test('rechaza nombre comercial vacío, campos inesperados y valores de stock fuera de rango', () => {
  assert.throws(() => settings({ ...valid, businessName: '   ' }), error => error.publicCode === 'INVALID_INPUT');
  assert.throws(() => settings({ ...valid, businessId: '2' }), error => error.publicCode === 'INVALID_INPUT');
  for (const value of [-1, 1000000000, 1.0001, 'no-numero', null]) {
    assert.throws(() => stockValue(value), error => error.publicCode === 'INVALID_INPUT');
  }
});

test('la importación heredada requiere un origen identificable', () => {
  const legacy = { sourceBusinessName: 'Tienda Central', legalName: valid.legalName, ruc: valid.ruc, phone: valid.phone, address: valid.address, ticketHeader: valid.ticketHeader, ticketFooter: valid.ticketFooter, minStockDefault: valid.minStockDefault };
  assert.equal(legacySettings(legacy).sourceBusinessName, 'Tienda Central');
  assert.throws(() => legacySettings({ ...legacy, sourceBusinessName: undefined }), error => error.publicCode === 'INVALID_INPUT');
});
