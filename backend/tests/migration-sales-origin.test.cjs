'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hash } = require('../src/services/system-admin-sales-migration-values');
const { originalInvoiceNumber, sourceKeyFromAudit } = require('../src/services/migration-sales-origin');

test('resuelve el origen de auditorías nuevas y heredadas con la clave que usa la importación', () => {
  const expected = hash('id:local-5\nname:prueba de migracion');
  assert.equal(sourceKeyFromAudit({ sourceBusinessKey: expected, sourceBusinessName: 'Prueba De Migracion' }), expected);
  assert.equal(sourceKeyFromAudit(JSON.stringify({ sourceBusinessId: 'local-5', sourceBusinessName: 'Prueba De Migracion' })), expected);
  assert.equal(sourceKeyFromAudit({ sourceBusinessName: '   ' }), null);
});

test('extrae la factura local conservando ceros y omite detalles sin prefijo de migración', () => {
  assert.equal(originalInvoiceNumber('Factura local: 000027 · detalle original'), '000027');
  assert.equal(originalInvoiceNumber('Factura local: F-100'), 'F-100');
  assert.equal(originalInvoiceNumber('Solo detalle original'), null);
  assert.equal(originalInvoiceNumber('Factura local: '), null);
});
