'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeHistoricalPaymentMethod, historicalPaymentMethodSql } = require('../src/services/historical-sales-values');

test('normaliza medios de pago históricos preservando tarjeta y transferencia', () => {
  assert.equal(normalizeHistoricalPaymentMethod('card'), 'CARD');
  assert.equal(normalizeHistoricalPaymentMethod('Tarjeta de crédito'), 'CARD');
  assert.equal(normalizeHistoricalPaymentMethod('transferencia'), 'TRANSFER');
  assert.equal(normalizeHistoricalPaymentMethod('Contado'), 'CASH');
  assert.equal(normalizeHistoricalPaymentMethod('medio desconocido'), null);
});

test('la consulta del medio histórico queda limitada al negocio, lote y venta', () => {
  const sql = historicalPaymentMethodSql('s');
  assert.match(sql, /source_record\.business_id = s\.business_id/);
  assert.match(sql, /source_record\.target_record_id = CAST\(s\.id AS CHAR\)/);
  assert.match(sql, /source_record\.entity_type = 'sales'/);
  assert.match(sql, /source_record\.target_table = 'sales'/);
  assert.match(sql, /source_batch\.status = 'COMPLETED'/);
  assert.match(sql, /REPLACE\(REPLACE\(REPLACE\(REPLACE\(REPLACE\(REPLACE\(REPLACE\(UPPER/);
  assert.match(sql, /WHEN 'TARJETA_DE_CREDITO' THEN 'CARD'/);
  assert.match(sql, /s\.payment_method\)$/);
});
