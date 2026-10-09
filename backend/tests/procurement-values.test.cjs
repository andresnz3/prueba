'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { purchase } = require('../src/services/procurement-values');

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
