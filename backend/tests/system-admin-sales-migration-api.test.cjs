'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { URL, URLSearchParams } = require('node:url');

const fixturePath = path.join(__dirname, '..', '..', 'prueba de ventas.json');

test('el cliente API envía los campos históricos del JSON real al endpoint de vista previa', async t => {
  if (!fs.existsSync(fixturePath)) {
    t.skip('El JSON local de prueba no está disponible en este checkout.');
    return;
  }
  const packageValue = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  let previewRequest = null;
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
        previewRequest = JSON.parse(options.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            eligible: true,
            gates: { basic: true, inventory: true, schema: true, targetUser: true },
            sales: { detected: 4, couldMigrate: 4, toSkip: 0 },
            warnings: []
          })
        };
      }
      throw new Error('Solicitud no esperada');
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', '..', 'api-client.js'), 'utf8'), sandbox);
  const client = new sandbox.window.PosApiClient('https://example.test/api');
  await client.me();
  const preview = await client.previewSalesMigration('5', packageValue);
  assert.equal(preview.sales.detected, 4);
  assert.equal(previewRequest.targetBusinessId, '5');
  assert.equal(previewRequest.package.data.sales.length, 4);
  const sale = previewRequest.package.data.sales[0];
  assert.equal(typeof sale.id, 'number');
  assert.equal(sale.numero, 1);
  assert.equal(sale.fechaTS, packageValue.data.sales[0].fechaTS);
  assert.equal(sale.descuentoPct, 0);
  assert.equal(sale.descuentoMonto, 0);
  assert.equal(sale.medioPago, 'cash');
  assert.equal(sale.tarifa, 'Menudeo');
  assert.equal(sale.anulada, false);
  assert.equal(sale.items[0].cantidad, 2);
  assert.equal(sale.items[0].retailPrice, 12.1);
  assert.equal(sale.items[0].wholesalePrice, 12.1);
  assert.equal(Object.hasOwn(sale.items[0], 'image'), false);
});
