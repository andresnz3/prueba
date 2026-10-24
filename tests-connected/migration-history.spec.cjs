'use strict';

const { test, expect } = require('@playwright/test');
const business = process.env.POS_TEST_BUSINESS;
const password = 'Browser-fixture-password-123!';

test('consulta el archivo histórico sin mezclarlo con operaciones y mantiene aislado el modo local', async ({ page, context }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript({ path: require.resolve('../tests/dexie-search-shim.js') });
  await page.route('https://**/*', route => route.abort());
  await page.route('**/migration-history/inventory**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      businessId: String(business), available: true, total: 2, offset: 0, limit: 50,
      records: [
        { batchId: '8c920ec2-8aec-4f5b-9aab-e2ebac0a4d72', sourceBusinessName: 'Negocio local ficticio', batchStatus: 'BLOCKED', entityType: 'products', sourceRecordKey: 'id:local-product-1', recordStatus: 'ARCHIVED', targetTable: null, targetRecordId: null, sourceActor: 'Ana', pendingReason: null, archivedAt: '2026-10-20T10:00:00.000Z', hasImage: true, payload: { name: 'Producto histórico local', barcode: 'LOCAL-100', stock: '2.500', cost: '3.25' } },
        { batchId: '8c920ec2-8aec-4f5b-9aab-e2ebac0a4d72', sourceBusinessName: 'Negocio local ficticio', batchStatus: 'BLOCKED', entityType: 'inventoryMovements', sourceRecordKey: 'id:local-movement-1', recordStatus: 'ARCHIVED', targetTable: null, targetRecordId: null, sourceActor: 'Ana', pendingReason: 'Aún no está enlazado al Kardex conectado.', archivedAt: '2026-10-20T10:00:00.000Z', hasImage: false, payload: { producto: 'Producto histórico local', tipo: 'AJUSTE', cantidad: '-0.500', stock_anterior: '3.000', stock_nuevo: '2.500' } }
      ],
      reconciliation: { complete: false, archiveIntegrity: 'MATCH', operationalComparison: 'NOT_RUN', unresolvedRecords: 2, batches: [{ batchId: '8c920ec2-8aec-4f5b-9aab-e2ebac0a4d72', sourceBusinessName: 'Negocio local ficticio', status: 'BLOCKED', archiveIntegrity: 'MATCH', expectedRecords: 2, archivedRecords: 2, unresolvedRecords: 2 }], differences: [{ origin: 'Negocio local ficticio', module: 'inventory', entity: 'products', expected: 'Todos los registros enlazados', found: '2 sin enlace', reason: 'El archivo histórico todavía no está conciliado con las tablas del POS.' }] }
    })
  }));
  await page.goto('/?mode=connected');
  await page.locator('#loginUsername').fill('browseradmin');
  await page.locator('#loginPassword').fill(password);
  await page.locator('#loginForm button[type=submit]').click();
  await expect(page.locator('#app')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#navInventoryBtn').click();
  const panel = page.locator('#inventoryView .connected-migration-history');
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Consultar historial conservado' }).click();
  await expect(panel).toContainText('Producto histórico local');
  await expect(panel).toContainText('Incluida en el archivo; todavía no está publicada');
  await expect(panel).toContainText(/La comparación con los registros operativos está pendiente/);
  await expect(panel).toContainText('no tienen enlace operativo');
  await expect(page.locator('#inventoryTableBody')).not.toContainText('Producto histórico local');
  expect(await page.evaluate(() => localDB)).toBeNull();
  const bounds = await panel.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(391);

  const localPage = await context.newPage();
  await localPage.addInitScript({ path: require.resolve('../tests/dexie-search-shim.js') });
  let localHistoryRequests = 0;
  await localPage.route('**/migration-history/**', route => { localHistoryRequests++; return route.abort(); });
  const localErrors = [];
  localPage.on('pageerror', error => localErrors.push(error.message));
  await localPage.goto('/?mode=local');
  expect(await localPage.locator('.connected-migration-history').evaluateAll(nodes => nodes.length === 9 && nodes.every(node => node.classList.contains('hidden')))).toBe(true);
  expect(localHistoryRequests).toBe(0);
  expect(localErrors).toEqual([]);
  await localPage.close();
  expect(errors).toEqual([]);
});
