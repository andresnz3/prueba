'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { URL, URLSearchParams } = require('node:url');

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'api-client.js'), 'utf8');

function sale(id, invoiceNumber) {
  return {
    id: String(id), businessId: '9', invoiceNumber, status: 'COMPLETED',
    paymentMethod: 'CASH', cashStatus: 'NOT_APPLICABLE',
    items: [{ productId: '12', name: 'Producto histórico', quantity: '1.000', unitPrice: '12.00', subtotal: '12.00', total: '12.00' }],
    createdAt: '2025-06-11T15:30:00.000Z',
    subtotal: '12.00', discount: '0.00', total: '12.00', tax: '0.00'
  };
}

function apiFor(sales) {
  const calls = [];
  const session = {
    csrfToken: 'A'.repeat(43),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    user: { id: '3', businessId: '9', username: 'admin', fullName: 'Admin', role: 'ADMIN', active: true }
  };
  const sandbox = {
    window: {}, URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    fetch: async url => {
      calls.push(url);
      const invoice = /\/sales\/(\d+)$/.exec(url);
      const data = url.endsWith('/auth/me') ? session : invoice ? { sale: sales.find(value => value.id === invoice[1]) } : { sales };
      return { ok: true, status: 200, json: async () => data };
    }
  };
  vm.runInNewContext(source, sandbox);
  return { client: new sandbox.window.PosApiClient('https://example.test/api'), calls };
}

test('Historial acepta facturas ordinarias y referencias de ventas históricas migradas', async () => {
  const current = Array.from({ length: 26 }, (_, index) => sale(index + 1, String(index + 1).padStart(6, '0')));
  const migratedWithSourceInvoice = sale(27, 'MIG-FC-501-' + 'a'.repeat(28));
  Object.assign(migratedWithSourceInvoice, { isHistorical: true, sourceBusinessKey: 'c'.repeat(64), sourceSaleId: 'local-sale-27', sourceBusinessName: 'Paquete histórico', originalInvoiceNumber: '000027' });
  const migratedWithoutSourceInvoice = sale(28, 'MIG-' + 'b'.repeat(28));
  const { client, calls } = apiFor([...current, migratedWithSourceInvoice, migratedWithoutSourceInvoice]);

  await client.me();
  const history = await client.sales(0);

  assert.equal(history.length, 28);
  assert.equal(history[26].invoiceNumber, migratedWithSourceInvoice.invoiceNumber);
  assert.equal(history[26].isHistorical, true);
  assert.equal(history[26].sourceBusinessName, 'Paquete histórico');
  assert.equal(history[26].originalInvoiceNumber, '000027');
  assert.equal(history[27].invoiceNumber, migratedWithoutSourceInvoice.invoiceNumber);
  assert.equal(calls.filter(url => url.includes('/sales?')).length, 1);
  const detail = await client.sale('27');
  assert.equal(detail.invoiceNumber, migratedWithSourceInvoice.invoiceNumber);
});

test('Historial sigue rechazando referencias con formato no admitido', async () => {
  const { client } = apiFor([sale(1, 'FACTURA-LOCAL-1')]);
  await client.me();

  await assert.rejects(client.sales(0), error => error.code === 'INVALID_RESPONSE');
});
