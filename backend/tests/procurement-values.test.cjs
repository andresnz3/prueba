'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { purchase, purchaseEdit } = require('../src/services/procurement-values');

const base = () => ({
  operationKey: randomUUID(), supplierId: '1', purchaseType: 'CREDIT', dueDays: 30,
  items: [{ productId: '2', quantity: '1.000', unitCost: '10.00' }]
});

test('compra conectada permite factura externa opcional y conserva el formato anterior', () => {
  const withoutInvoice = purchase(base());
  assert.equal(withoutInvoice.invoiceNumber, '');
  assert.equal(withoutInvoice.supplierInvoiceNumber, null);

  const withInvoice = purchase({ ...base(), supplierInvoiceNumber: 'F-1029' });
  assert.equal(withInvoice.invoiceNumber, 'F-1029');
  assert.equal(withInvoice.supplierInvoiceNumber, 'F-1029');

  const legacy = purchase({ ...base(), invoiceNumber: 'LEGACY-1' });
  assert.equal(legacy.supplierInvoiceNumber, 'LEGACY-1');
});

test('compra rechaza referencias internas como factura de proveedor', () => {
  assert.throws(() => purchase({ ...base(), supplierInvoiceNumber: 'COMP-000001' }), { publicCode: 'INVALID_INPUT' });
  assert.throws(() => purchase({ ...base(), supplierInvoiceNumber: 'F-1', invoiceNumber: 'F-2' }), { publicCode: 'INVALID_INPUT' });
});

test('corrección de compra requiere revisión vigente, clave idempotente y productos únicos', () => {
  const data = purchaseEdit({ operationKey: randomUUID(), revision: 'a'.repeat(64), supplierInvoiceNumber: 'F-EDIT-1', items: [{ productId: '2', quantity: '1.250', unitCost: '10.00' }] });
  assert.equal(data.revision, 'a'.repeat(64));
  assert.equal(data.supplierInvoiceNumber, 'F-EDIT-1');
  assert.equal(data.items[0].quantity, '1.250');
  assert.throws(() => purchaseEdit({ ...data, revision: 'invalid' }), { publicCode: 'PURCHASE_REVISION_INVALID' });
  assert.throws(() => purchaseEdit({ ...data, items: [data.items[0], data.items[0]] }), { publicCode: 'INVALID_INPUT' });
  assert.throws(() => purchaseEdit({ ...data, notes: 'No permitidos' }), { publicCode: 'INVALID_INPUT' });
  assert.throws(() => purchaseEdit({ ...data, supplierInvoiceNumber: 'COMP-000001' }), { publicCode: 'INVALID_INPUT' });
});
