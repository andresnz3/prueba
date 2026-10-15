'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  packageForSalesImport, normalizeSale, fingerprintSale, sourceSaleKey
} = require('../src/services/system-admin-sales-migration-values');

const sourcePackage = {
  type: 'pos_local_migration_package',
  version: 1,
  business: { name: 'Local de pruebas' },
  data: {
    products: [{ id: 'producto-local', barcode: 'MIG-1', name: 'Producto', cost: '2.50' }],
    clients: [],
    suppliers: [],
    sales: [{
      createdAt: '2025-04-10T15:30:00.000Z',
      invoiceNumber: 'F-100',
      subtotal: '30.00',
      discount: '2.00',
      tax: '1.50',
      total: '29.50',
      detail: 'Venta de prueba',
      items: [{
        productId: 'producto-local',
        quantity: '2.000',
        unitPrice: '15.00',
        subtotal: '30.00',
        discount: '2.00',
        tax: '1.50',
        total: '29.50'
      }]
    }]
  }
};

function makeKeys(value) {
  const imported = packageForSalesImport(value);
  const occurrences = new Map();
  return value.data.sales.map((raw, index) => {
    const sale = normalizeSale(raw, index, imported);
    assert.equal(sale.error, undefined);
    sale.items = sale.items.map((item, line) => ({ ...item, productId: 'target-' + line }));
    const fingerprint = fingerprintSale(sale, null);
    const occurrence = occurrences.get(fingerprint) || 0;
    occurrences.set(fingerprint, occurrence + 1);
    return sourceSaleKey(sale, fingerprint, occurrence);
  });
}

test('la huella detecta cambios de fecha, detalle e importes de las líneas', () => {
  const baseline = makeKeys(sourcePackage)[0];
  const changed = structuredClone(sourcePackage);
  changed.data.sales[0].detail = 'Detalle editado';
  assert.notEqual(makeKeys(changed)[0], baseline);

  const changedLine = structuredClone(sourcePackage);
  changedLine.data.sales[0].items[0].quantity = '1.000';
  changedLine.data.sales[0].items[0].subtotal = '15.00';
  changedLine.data.sales[0].items[0].total = '14.50';
  changedLine.data.sales[0].subtotal = '15.00';
  changedLine.data.sales[0].total = '14.50';
  assert.notEqual(makeKeys(changedLine)[0], baseline);
});

test('ventas idénticas sin ID local conservan claves al reordenar el paquete', () => {
  const repeated = structuredClone(sourcePackage);
  repeated.data.sales.push(structuredClone(repeated.data.sales[0]));
  const originalKeys = makeKeys(repeated);
  assert.notEqual(originalKeys[0], originalKeys[1]);

  const unrelated = structuredClone(sourcePackage.data.sales[0]);
  unrelated.detail = 'Otra venta';
  const reordered = structuredClone(repeated);
  reordered.data.sales = [unrelated, ...reordered.data.sales.reverse()];
  assert.deepEqual(makeKeys(reordered).slice(1).sort(), originalKeys.sort());
});

test('el JSON real normaliza importes, fechas, medio de pago y los IDs decimales', t => {
  const fixturePath = path.join(__dirname, '..', '..', 'prueba de ventas.json');
  if (!fs.existsSync(fixturePath)) {
    t.skip('El JSON local de prueba no está disponible en este checkout.');
    return;
  }
  const realPackage = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const imported = packageForSalesImport(realPackage);
  const normalized = imported.sales.map((sale, index) => normalizeSale(sale, index, imported));
  assert.equal(normalized.length, 4);
  assert.ok(normalized.every(sale => sale.error === undefined));
  assert.deepEqual(normalized.map(sale => sale.total), [2420n, 1210n, 2420n, 1210n]);
  assert.deepEqual(normalized.map(sale => sale.discount), [0n, 0n, 0n, 0n]);
  assert.deepEqual(normalized.map(sale => sale.items[0].unitPrice), [1210n, 1210n, 1210n, 1210n]);
  assert.deepEqual(normalized.map(sale => sale.items[0].quantity), [2000n, 1000n, 2000n, 1000n]);
  assert.ok(normalized.every(sale => sale.paymentMethod === 'CASH'));
  assert.ok(normalized.every(sale => sale.saleType === 'CASH' && sale.priceType === 'RETAIL' && sale.status === 'COMPLETED'));
  assert.ok(normalized.every(sale => sale.clientReference === null));
  assert.ok(normalized.every(sale => /^\d+\.\d+$/.test(sale.localSaleId)));
  assert.ok(normalized.every(sale => /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}$/.test(sale.createdAt)));
});

test('omite un registro si los totales históricos no reconcilian', () => {
  const incoherent = structuredClone(sourcePackage);
  incoherent.data.sales[0].total = '29.00';
  const imported = packageForSalesImport(incoherent);
  const sale = normalizeSale(incoherent.data.sales[0], 0, imported);
  assert.match(sale.error, /total histórico C\$29\.00 no coincide/);
});
