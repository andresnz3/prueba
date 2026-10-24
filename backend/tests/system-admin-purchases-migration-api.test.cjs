'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { URL, URLSearchParams } = require('node:url');

test('el cliente API conserva los campos locales de compras y elimina campos ajenos', async () => {
  const packageValue = {
    type: 'pos_local_migration_package', version: 1, exportedAt: '2026-10-14T12:00:00.000Z',
    business: { id: 'local-1', name: 'Bodega local', password: 'no enviar' },
    data: {
      products: [{ id: 104, barcode: '00123', name: 'Arroz', image: 'no enviar' }],
      clients: [],
      suppliers: [{ id: 9, name: 'Distribuidora Norte', token: 'no enviar' }],
      purchases: [{
        id: '1750000000000.25', numero: 'FC-501', fechaTS: 1750000000000, tipo: 'credito', proveedorId: 9,
        proveedor: 'Distribuidora Norte', subtotal: 20, descuentoPct: 5, descuentoMonto: 1, tax: 0,
        total: 19, vencimientoTS: '', vencimiento: '2025-07-15', anulada: false, usuario: 'no enviar', sessionToken: 'no enviar',
        items: [{ productId: 104, producto: 'Arroz', cantidad: 2, costo: 10, subtotal: 20, total: 19, password: 'no enviar' }]
      }]
    }
  };
  const originalPackage = JSON.stringify(packageValue);
  const requests = [];
  const session = {
    csrfToken: 'A'.repeat(43), expiresAt: '2026-10-15T00:00:00.000Z',
    user: { id: '7', businessId: '1', username: 'andres', fullName: 'Administrador', role: 'ADMIN', active: true }
  };
  const sandbox = {
    window: {}, URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      if (url.endsWith('/auth/me')) return { ok: true, status: 200, json: async () => session };
      requests.push({ url, body: JSON.parse(options.body) });
      if (url.endsWith('/system-admin/migration/purchases/preview')) return {
        ok: true, status: 200,
        json: async () => ({
          ok: true, eligible: true,
          gates: { basic: true, schema: true, targetUser: true },
          purchases: { detected: 1, couldMigrate: 1, toSkip: 0 },
          diagnostics: { suppliersUnmatched: 0, suppliersAmbiguous: 0, productsUnmatched: 0, productsAmbiguous: 0, duplicateInvoices: 0, missingCosts: 0, inconsistentTotals: 0, unsupportedStatuses: 0 },
          warnings: []
        })
      };
      if (url.endsWith('/system-admin/migration/purchases')) return {
        ok: true, status: 201,
        json: async () => ({ ok: true, created: { purchases: 1 }, skipped: { purchases: 0 }, warnings: [] })
      };
      throw new Error('Solicitud no esperada: ' + url);
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', '..', 'api-client.js'), 'utf8'), sandbox);
  const client = new sandbox.window.PosApiClient('https://example.test/api');
  await client.me();

  const preview = await client.previewPurchasesMigration('5', packageValue);
  assert.equal(preview.purchases.couldMigrate, 1);
  const imported = requests[0].body.package;
  assert.ok(Buffer.byteLength(JSON.stringify(requests[0].body), 'utf8') < 16384);
  assert.equal(requests[0].url, 'https://example.test/api/system-admin/migration/purchases/preview');
  assert.equal(imported.business.id, 'local-1');
  assert.equal(imported.data.products[0].barcode, '00123');
  assert.equal(imported.data.suppliers[0].name, 'Distribuidora Norte');
  assert.equal(imported.data.purchases[0].id, '1750000000000.25');
  assert.equal(imported.data.purchases[0].invoiceNumber, 'FC-501');
  assert.equal(imported.data.purchases[0].createdAt, 1750000000000);
  assert.equal(imported.data.purchases[0].supplierId, 9);
  assert.equal(imported.data.purchases[0].supplierName, 'Distribuidora Norte');
  assert.equal(imported.data.purchases[0].discountPercent, 5);
  assert.equal(imported.data.purchases[0].discount, 1);
  assert.equal(imported.data.purchases[0].dueAt, '2025-07-15');
  assert.equal(imported.data.purchases[0].total, 19);
  assert.equal(imported.data.purchases[0].items[0].productId, 104);
  assert.equal(imported.data.purchases[0].items[0].quantity, 2);
  assert.equal(imported.data.purchases[0].items[0].unitCost, 10);
  assert.equal(imported.data.purchases[0].items[0].subtotal, 20);
  assert.equal(imported.data.purchases[0].items[0].total, 19);
  assert.equal(Object.hasOwn(imported.data.purchases[0], 'usuario'), false);
  assert.equal(Object.hasOwn(imported.data.purchases[0], 'sessionToken'), false);
  assert.equal(Object.hasOwn(imported.data.purchases[0].items[0], 'password'), false);
  assert.equal(Object.hasOwn(imported.business, 'password'), false);
  assert.equal(Object.hasOwn(imported.data.products[0], 'image'), false);

  const result = await client.migratePurchases('5', packageValue);
  assert.equal(result.created.purchases, 1);
  assert.equal(requests[1].url, 'https://example.test/api/system-admin/migration/purchases');
  assert.ok(Buffer.byteLength(JSON.stringify(requests[1].body), 'utf8') < 16384);
  assert.equal(requests[1].body.package.data.purchases[0].id, '1750000000000.25');
  assert.equal(requests[1].body.package.data.purchases[0].invoiceNumber, 'FC-501');
  assert.equal(requests[1].body.package.data.purchases[0].createdAt, 1750000000000);
  assert.equal(requests[1].body.package.data.purchases[0].discountPercent, 5);
  assert.equal(requests[1].body.package.data.purchases[0].dueAt, '2025-07-15');
  assert.equal(requests[1].body.package.data.purchases[0].items[0].productId, 104);
  assert.equal(requests[1].body.package.data.purchases[0].items[0].quantity, 2);
  assert.equal(requests[1].body.package.data.purchases[0].items[0].unitCost, 10);
  assert.equal(JSON.stringify(packageValue), originalPackage, 'ni la vista previa ni la migración deben mutar la exportación original');
});
