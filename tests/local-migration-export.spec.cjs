'use strict';
/* global Dexie, localDB, DEFAULT_BUSINESS_ID */

const { test, expect } = require('@playwright/test');
const { readFile } = require('node:fs/promises');

async function installLocalDatabaseReader(page) {
  await page.addInitScript({ path: require.resolve('./dexie-search-shim.js') });
  await page.addInitScript(() => {
    Dexie.exists = async name => Dexie.__databases.has(name);
    Object.defineProperty(window, 'indexedDB', {
      configurable: true,
      value: {
        open(name) {
          const request = {};
          setTimeout(() => {
            const tables = Dexie.__databases.get(name);
            if (!tables) { request.onerror?.(); return; }
            request.result = {
              objectStoreNames: [...tables.keys()],
              close() {},
              transaction() {
                const transaction = { pending: 0, oncomplete: null, onerror: null, onabort: null };
                transaction.objectStore = storeName => ({
                  getAll() {
                    const result = {};
                    transaction.pending++;
                    Promise.resolve(tables.get(storeName).toArray()).then(rows => {
                      result.result = rows;
                      result.onsuccess?.();
                      transaction.pending--;
                      if (!transaction.pending) setTimeout(() => transaction.oncomplete?.(), 0);
                    }, error => { result.error = error; result.onerror?.(); transaction.onerror?.(); });
                    return result;
                  }
                });
                return transaction;
              }
            };
            request.onsuccess?.();
          }, 0);
          return request;
        }
      }
    });
  });
}

test('export local conserva todas las tiendas, configuracion, imagenes e historial sin modificar Dexie', async ({ page }) => {
  await installLocalDatabaseReader(page);
  await page.route('https://**/*', route => route.abort());
  await page.goto('/?mode=local', { waitUntil: 'domcontentloaded' });
  const original = await page.evaluate(async () => {
    localStorage.setItem('posSystemConfig', JSON.stringify({ localBusinessId: 'local-export-01', name: 'Tienda de prueba', legalName: 'Tienda S.A.', ruc: 'RUC-001', address: 'Managua', phone: '5550101', currency: 'C$', header: 'Encabezado', footer: 'Pie', tax: 15, minStock: 4, salesFlow: 'DIRECT', logo: 'data:image/png;base64,iVBORw0KGgo=' }));
    const business_id = 'local-export-01';
    await localDB.products.put({ id: 'p1', business_id, name: 'Café', barcode: '001', cost: '4.25', retailPrice: '8.50', stock: '1.250', marginRetail: '100.0000', image: 'data:image/png;base64,iVBORw0KGgo=', usuario: 'Ana', password: 'local-secret' });
    await localDB.clients.put({ id: 'c1', business_id, name: 'Cliente Uno', creditLimit: '100.00' });
    await localDB.suppliers.put({ id: 's1', business_id, name: 'Proveedor Uno' });
    await localDB.sales.put({ id: 'v1', business_id, total: '17.00', fechaTS: '2020-01-02T03:04:05.000Z', status: 'CANCELLED', items: [{ productId: 'p1', quantity: '2.000' }] });
    await localDB.purchases.put({ id: 'b1', business_id, total: '8.50', anulada: true, items: [{ productId: 'p1', quantity: '2.000' }] });
    await localDB.cajaSessions.put({ id: 'cash1', business_id, estado: 'cerrada', openedBy: 'Ana', movimientos: [{ id: 'm1', amount: '3.00' }] });
    await localDB.inventory_movements.put({ id: 'i1', business_id, producto_id: 'p1', cantidad: '-1.250', stock_nuevo: '1.250' });
    await localDB.abonos.put({ id: 'a1', business_id, tipo: 'proveedor', facturaId: 'b1', monto: '3.17', usuario: 'Ana' });
    await localDB.gastos.put({ id: 'g1', business_id, monto: '5.25', usuario: 'Ana' });
    await localDB.audit_logs.put({ id: 'l1', business_id, accion: 'ANULACION', usuario: 'Ana' });
    await localDB.saleOrders.put({ id: 'o1', business_id, status: 'PENDING', items: [{ productId: 'p1' }] });
    await localDB.sync_queue.put({ id: 'q1', business_id, data: '{"password":"local-secret","sale":{"id":"v2"}}' });
    return Promise.all(localDB.tables.map(async table => [table.name, await table.toArray()]));
  });

  await page.evaluate(() => {
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    document.getElementById('upgradeView').classList.remove('hidden');
  });
  await page.locator('#migrationExportGenerateBtn').click();
  await expect(page.locator('#migrationExportReview')).toBeVisible();
  await expect(page.locator('#migrationExportScope')).toContainText('La lectura no modificó ningún registro');
  await expect(page.locator('#migrationExportCounts')).toContainText('Gastos');
  await expect(page.locator('#migrationExportCounts')).toContainText('Auditoría');
  await expect(page.locator('#migrationExportCounts')).toContainText('Cola pendiente');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#migrationExportDownloadBtn').click();
  const download = await downloadPromise;
  const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
  expect(exported.version).toBe(2);
  for (const collection of ['products', 'clients', 'suppliers', 'sales', 'purchases', 'cashSessions', 'inventoryMovements', 'abonos', 'expenses', 'auditLogs', 'saleOrders', 'syncQueue', 'categories']) {
    expect(Array.isArray(exported.data[collection]), collection + ' debe estar presente como colección JSON');
  }
  expect(exported.data.products[0].cost).toBe('4.25');
  expect(exported.data.products[0].image).toBe('data:image/png;base64,iVBORw0KGgo=');
  expect(exported.data.products[0].usuario).toBe('Ana');
  expect(Object.hasOwn(exported.data.products[0], 'password')).toBe(false);
  expect(exported.data.cashSessions[0].movimientos[0].amount).toBe('3.00');
  expect(exported.data.inventoryMovements[0].stock_nuevo).toBe('1.250');
  expect(exported.data.abonos[0].facturaId).toBe('b1');
  expect(exported.data.expenses[0].monto).toBe('5.25');
  expect(exported.data.auditLogs[0].accion).toBe('ANULACION');
  expect(exported.data.saleOrders[0].status).toBe('PENDING');
  expect(exported.data.syncQueue[0].data).not.toContain('local-secret');
  expect(exported.data.syncQueue[0].data).toContain('"sale"');
  expect(exported.data.configuration).toMatchObject({ name: 'Tienda de prueba', legalName: 'Tienda S.A.', ruc: 'RUC-001', logo: 'data:image/png;base64,iVBORw0KGgo=' });
  const after = await page.evaluate(() => Promise.all(localDB.tables.map(async table => [table.name, await table.toArray()])));
  expect(after).toEqual(original);
});

test('identidad local nueva se conserva entre reinicios del navegador y se usa en nuevas operaciones', async ({ page }) => {
  await installLocalDatabaseReader(page);
  await page.addInitScript(() => { if (!localStorage.getItem('posSystemConfig')) localStorage.setItem('posSystemConfig', JSON.stringify({ name: 'Identidad estable' })); });
  await page.route('https://**/*', route => route.abort());
  await page.goto('/?mode=local', { waitUntil: 'domcontentloaded' });

  const first = await page.evaluate(() => ({ id: window.PosLocalIdentity.currentId(), writeId: DEFAULT_BUSINESS_ID, saved: JSON.parse(localStorage.getItem('posSystemConfig')).localBusinessId }));
  expect(first.id).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
  expect(first.writeId).toBe(first.id);
  expect(first.saved).toBe(first.id);

  await page.reload({ waitUntil: 'domcontentloaded' });
  const afterReload = await page.evaluate(() => ({ id: window.PosLocalIdentity.currentId(), writeId: DEFAULT_BUSINESS_ID, saved: JSON.parse(localStorage.getItem('posSystemConfig')).localBusinessId }));
  expect(afterReload).toEqual(first);
});

test('export antiguo conserva los 127 registros compartidos, muestra el desglose y no modifica Dexie', async ({ page }) => {
  await installLocalDatabaseReader(page);
  await page.route('https://**/*', route => route.abort());
  await page.goto('/?mode=local', { waitUntil: 'domcontentloaded' });
  const before = await page.evaluate(async () => {
    localStorage.setItem('posSystemConfig', JSON.stringify({ localBusinessId: 'stable-legacy-business', name: 'Negocio antiguo', ruc: 'RUC-ANTIGUO' }));
    const legacyId = '00000000-0000-0000-0000-000000000000';
    const insert = async (table, rows) => { for (const row of rows) await localDB[table].put({ business_id: legacyId, ...row }); };
    await insert('products', Array.from({ length: 4 }, (_, i) => ({ id: `p${i + 1}`, name: `Producto ${i + 1}` })));
    await insert('clients', Array.from({ length: 4 }, (_, i) => ({ id: `c${i + 1}`, name: `Cliente ${i + 1}` })));
    await insert('suppliers', Array.from({ length: 4 }, (_, i) => ({ id: `s${i + 1}`, name: `Proveedor ${i + 1}` })));
    await insert('sales', Array.from({ length: 28 }, (_, i) => ({ id: `v${i + 1}`, clienteId: 'c1', items: [{ id: 'p1', quantity: '1.000' }] })));
    await insert('purchases', Array.from({ length: 6 }, (_, i) => ({ id: `b${i + 1}`, proveedorId: 's1', items: [{ id: 'p1', quantity: '1.000' }] })));
    await insert('cajaSessions', Array.from({ length: 5 }, (_, i) => ({ id: `cash${i + 1}`, movimientos: [] })));
    await insert('inventory_movements', Array.from({ length: 69 }, (_, i) => ({ id: `i${i + 1}`, producto_id: 'p1', cantidad: '1.000' })));
    await insert('abonos', Array.from({ length: 7 }, (_, i) => ({ id: `a${i + 1}`, tipo: 'cliente', referenciaId: 'c1', facturaId: 'v1', monto: '1.00', cajaSessionId: 'cash1' })));
    return Promise.all(localDB.tables.map(async table => [table.name, await table.toArray()]));
  });

  await page.evaluate(() => {
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    document.getElementById('upgradeView').classList.remove('hidden');
  });
  await page.locator('#migrationExportGenerateBtn').click();
  await expect(page.locator('#migrationExportReview')).toBeVisible();
  await expect(page.locator('#migrationExportIdentityReview')).toContainText('127 antiguos por revisar');

  const downloadPackage = async () => {
    const pending = page.waitForEvent('download');
    await page.locator('#migrationExportDownloadBtn').click();
    return JSON.parse(await readFile(await (await pending).path(), 'utf8'));
  };
  const first = await downloadPackage();
  expect(first.version).toBe(2);
  expect(first.source.scope.missingStores).toEqual([]);
  for (const collection of ['products', 'clients', 'suppliers', 'sales', 'purchases', 'cashSessions', 'inventoryMovements', 'abonos', 'expenses', 'auditLogs', 'saleOrders', 'syncQueue', 'categories']) {
    expect(Array.isArray(first.data[collection]), collection + ' debe exportarse aunque no tenga filas');
  }
  expect(first.data.expenses).toEqual([]);
  expect(first.data.auditLogs).toEqual([]);
  expect(first.data.saleOrders).toEqual([]);
  expect(first.data.syncQueue).toEqual([]);
  expect(first.business.localBusinessId).toBe('stable-legacy-business');
  expect(first.source.scope.identityReview.counts).toMatchObject({ legacy: 127, sharedId: 127, missingId: 0, otherBusiness: 0 });
  expect(first.source.scope.identityReview.byModule).toMatchObject({
    products: { legacy: 4 }, clients: { legacy: 4 }, suppliers: { legacy: 4 }, sales: { legacy: 28 },
    purchases: { legacy: 6 }, cajaSessions: { legacy: 5 }, inventory_movements: { legacy: 69 }, abonos: { legacy: 7 }
  });
  expect(first.data.products).toHaveLength(4);
  expect(first.data.sales).toHaveLength(28);
  expect(first.data.inventoryMovements).toHaveLength(69);

  await page.locator('#migrationExportGenerateBtn').click();
  await expect(page.locator('#migrationExportReview')).toBeVisible();
  const repeated = await downloadPackage();
  expect(repeated.business.localBusinessId).toBe(first.business.localBusinessId);
  expect(repeated.source.scope.identityReview.counts.legacy).toBe(127);
  expect(await page.evaluate(async () => Promise.all(localDB.tables.map(async table => [table.name, await table.toArray()])))).toEqual(before);
});
