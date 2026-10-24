'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { URL, URLSearchParams } = require('node:url');

const fixturePath = path.join(__dirname, '..', '..', 'prueba de ventas.json');

function representativePackage() {
  const items = Array.from({ length: 15 }, () => ({
    productId: 104, productoId: 104, barcode: '00123', codigo: '00123',
    productName: 'Arroz', nombreProducto: 'Arroz', quantity: 2, cantidad: 2,
    unitPrice: 12.1, precioUnitario: 12.1, retailPrice: 12.1, wholesalePrice: 12.1,
    tarifa: 'Menudeo', precio1: 12.1, precio2: 12.1, subtotal: 24.2, subTotal: 24.2,
    discountAmount: 0, descuentoMonto: 0, discountPercent: 0, descuentoPct: 0,
    tax: 0, impuesto: 0, total: 24.2, importe: 24.2, costAtSale: 4.25, costo: 4.25,
    taxRate: 0, impuestoPorcentaje: 0,
    product: { id: 104, barcode: '00123', name: 'Arroz', image: 'photo-not-sent' }
  }));
  return {
    type: 'pos_local_migration_package', version: 1, exportedAt: '2026-10-14T12:00:00.000Z',
    business: { id: 'local-sales-1', name: 'Bodega Local' },
    data: {
      products: [{ id: 104, barcode: '00123', name: 'Arroz', cost: 4.25, taxRate: 0, image: 'photo-not-sent' }],
      clients: [{ id: 3, name: 'Cliente de prueba' }], suppliers: [],
      sales: Array.from({ length: 4 }, (_, index) => ({
        id: index + 1, saleId: index + 1, numero: index + 1, invoiceNumber: index + 1,
        createdAt: 1750000000000 + index, fechaTS: 1750000000000 + index,
        clientId: 3, clienteId: 3, clientName: 'Cliente de prueba', customerName: 'Cliente de prueba',
        subtotal: 363, subTotal: 363, base: 363, discount: 0, descuentoMonto: 0, discountPercent: 0, descuentoPct: 0,
        tax: 0, impuesto: 0, total: 363, grandTotal: 363, paymentMethod: 'cash', metodoPago: 'cash',
        saleType: 'contado', tipo: 'contado', status: 'COMPLETED', estado: 'COMPLETADA',
        priceType: 'Menudeo', tarifa: 'Menudeo', anulada: false, items
      }))
    }
  };
}

test('el cliente API compacta la vista previa y conserva importes, fechas, IDs y referencias', async () => {
  const packageValue = fs.existsSync(fixturePath) ? JSON.parse(fs.readFileSync(fixturePath, 'utf8')) : representativePackage();
  const originalPackage = JSON.stringify(packageValue);
  const requests = [];
  const session = {
    csrfToken: 'A'.repeat(43),
    expiresAt: '2026-10-15T00:00:00.000Z',
    user: { id: '7', businessId: '1', username: 'andres', fullName: 'Administrador', role: 'ADMIN', active: true }
  };
  const sandbox = {
    window: {}, URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      if (url.endsWith('/auth/me')) return { ok: true, status: 200, json: async () => session };
      if (url.endsWith('/system-admin/migration/sales/preview')) {
        requests.push({ url, body: JSON.parse(options.body) });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            eligible: true,
            gates: { basic: true, inventory: true, schema: true, targetUser: true },
            sales: { detected: 4, couldMigrate: 4, toSkip: 0 },
            sourceOriginConflict: { required: false, incomingSourceBusinessName: 'Bodega Local', incomingSourceBusinessKey: 'b'.repeat(64), existingSources: [] },
            warnings: []
          })
        };
      }
      if (url.endsWith('/system-admin/migration/sales')) {
        requests.push({ url, body: JSON.parse(options.body) });
        return { ok: true, status: 201, json: async () => ({ ok: true, created: { sales: 4 }, skipped: { sales: 0 }, warnings: [] }) };
      }
      throw new Error('Solicitud no esperada');
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', '..', 'api-client.js'), 'utf8'), sandbox);
  const client = new sandbox.window.PosApiClient('https://example.test/api');
  await client.me();
  const preview = await client.previewSalesMigration('5', packageValue);
  assert.equal(preview.sales.detected, 4);
  assert.equal(preview.sourceOriginConflict.required, false);
  const previewRequest = requests[0].body;
  assert.equal(previewRequest.targetBusinessId, '5');
  const previewBytes = Buffer.byteLength(JSON.stringify(requests[0]), 'utf8');
  assert.ok(previewBytes < 16384, 'la vista previa debe quedar dentro del límite global de cuerpo: ' + previewBytes + ' bytes');
  assert.equal(previewRequest.package.data.sales.length, 4);
  const sale = previewRequest.package.data.sales[0];
  assert.equal(typeof sale.id, 'number');
  assert.equal(sale.invoiceNumber, 1);
  assert.equal(sale.createdAt, packageValue.data.sales[0].fechaTS);
  assert.equal(sale.discountPercent, 0);
  assert.equal(sale.discount, 0);
  assert.equal(sale.paymentMethod, 'cash');
  assert.equal(sale.priceType, 'Menudeo');
  assert.ok(sale.status === 'COMPLETED' || sale.anulada === false);
  assert.equal(sale.items[0].quantity, 2);
  assert.equal(sale.items[0].unitPrice, 12.1);
  assert.equal(Object.hasOwn(sale.items[0], 'image'), false);
  assert.equal(Object.hasOwn(previewRequest.package.data.products[0], 'image'), false);

  await client.migrateSales('5', packageValue, true);
  assert.equal(requests[1].body.confirmDifferentSource, true);
  assert.ok(Buffer.byteLength(JSON.stringify(requests[1]), 'utf8') < 16384);
  const migratedSale = requests[1].body.package.data.sales[0];
  assert.equal(migratedSale.id, sale.id);
  assert.equal(migratedSale.invoiceNumber, sale.invoiceNumber);
  assert.equal(migratedSale.createdAt, sale.createdAt);
  assert.equal(migratedSale.clientId, sale.clientId);
  assert.equal(migratedSale.subtotal, sale.subtotal);
  assert.equal(migratedSale.discount, sale.discount);
  assert.equal(migratedSale.discountPercent, sale.discountPercent);
  assert.equal(migratedSale.total, sale.total);
  assert.equal(migratedSale.items[0].productId, sale.items[0].productId);
  assert.equal(migratedSale.items[0].quantity, sale.items[0].quantity);
  assert.equal(migratedSale.items[0].unitPrice, sale.items[0].unitPrice);
  assert.equal(Object.hasOwn(requests[1].body.package.data.products[0], 'image'), false);
  assert.equal(JSON.stringify(packageValue), originalPackage, 'la exportación original debe quedar intacta');
});
