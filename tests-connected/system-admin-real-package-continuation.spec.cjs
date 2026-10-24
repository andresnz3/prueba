'use strict';

const fs = require('node:fs');
const { createHash, randomBytes } = require('node:crypto');
const { test, expect } = require('@playwright/test');
const { readConfig } = require('../backend/src/config/environment');
const { createDatabasePool } = require('../backend/src/config/database');
const { createDestinationAndAdmin, openDestinationPage, signInSystemAdmin } = require('./local-migration-flow.helper.cjs');

const v1Path = process.env.POS_MIGRATION_V1_FILE;
const v2Path = process.env.POS_MIGRATION_V2_FILE;
test.skip(!v1Path || !v2Path, 'Define POS_MIGRATION_V1_FILE y POS_MIGRATION_V2_FILE para la prueba aislada de continuación.');

const isRequest = (response, suffix) => response.url().endsWith(suffix) && response.request().method() === 'POST';
async function enableArchiveResponseCapture(page) {
  await page.evaluate(() => {
    const nativeFetch = window.fetch.bind(window);
    window.__posMigrationArchiveResponse = null;
    window.fetch = async (input, init) => {
      const response = await nativeFetch(input, init);
      const requestUrl = typeof input === 'string' ? input : input?.url || '';
      if (new URL(requestUrl, window.location.href).pathname.endsWith('/system-admin/migration/archive')) {
        const payload = await response.clone().json().catch(() => ({}));
        window.__posMigrationArchiveResponse = {
          status: response.status,
          errorCode: payload.error?.code || null,
          batchId: payload.batchId || null,
          packageSha256: payload.packageSha256 || null,
          fileSha256: payload.fileSha256 || null,
          counts: payload.counts || null,
          continuation: payload.continuation || null,
          continuationConflicts: payload.continuationConflicts || null,
          identityConfirmationApplied: payload.identityConfirmationApplied ?? null,
          archiveOnlyRecords: payload.archiveOnlyRecords ?? null,
          confirmation: payload.identityConfirmation ? {
            confirmed: payload.identityConfirmation.confirmed,
            scope: payload.identityConfirmation.scope,
            packageSha256: payload.identityConfirmation.packageSha256,
            fileSha256: payload.identityConfirmation.fileSha256,
            targetBusinessId: payload.identityConfirmation.targetBusinessId
          } : null
        };
      }
      return response;
    };
  });
}

async function readArchiveResponse(page, status) {
  await page.waitForFunction(expected => window.__posMigrationArchiveResponse?.status === expected, status, { timeout: 120_000 });
  return page.evaluate(() => window.__posMigrationArchiveResponse);
}

async function loadPackage(page, path) {
  const raw = fs.readFileSync(path);
  const value = JSON.parse(raw.toString('utf8'));
  const previewResponsePromise = page.waitForResponse(response => isRequest(response, '/system-admin/migration/archive/preview'), { timeout: 180_000 })
    .then(response => response.status());
  await page.locator('#migrationPackageFile').setInputFiles({ name: path.split(/[\\/]/).pop(), mimeType: 'application/json', buffer: raw });
  await expect(page.locator('#migrationPackageReview')).toBeVisible({ timeout: 180_000 });
  await expect(page.locator('#migrationArchiveReview')).toBeVisible({ timeout: 180_000 });
  const previewStatus = await previewResponsePromise;
  expect(previewStatus).toBe(200);
  return { raw, value, fileSha256: createHash('sha256').update(raw).digest('hex') };
}

async function databaseSnapshot(pool, businessId) {
  const [rows] = await pool.execute(
    'SELECT (SELECT COUNT(*) FROM products WHERE business_id=?) AS products,(SELECT COUNT(*) FROM clients WHERE business_id=?) AS clients,(SELECT COUNT(*) FROM suppliers WHERE business_id=?) AS suppliers,(SELECT COUNT(*) FROM sales WHERE business_id=? AND is_historical=TRUE) AS sales,(SELECT COUNT(*) FROM purchases WHERE business_id=? AND is_historical=TRUE) AS purchases,(SELECT COUNT(*) FROM cash_sessions WHERE business_id=? AND is_historical=TRUE) AS cashSessions,(SELECT COUNT(*) FROM cash_movements WHERE business_id=? AND is_historical=TRUE) AS cashMovements,(SELECT COUNT(*) FROM inventory_movements WHERE business_id=? AND is_historical=TRUE) AS inventoryMovements,(SELECT COUNT(*) FROM migration_zero_inventory_events WHERE business_id=?) AS zeroInventoryEvents,(SELECT COUNT(*) FROM expenses WHERE business_id=? AND is_historical=TRUE) AS expenses,(SELECT COUNT(*) FROM sale_orders WHERE business_id=? AND is_historical=TRUE) AS orders,(SELECT COUNT(*) FROM audit_logs WHERE business_id=? AND action=\'LOCAL_HISTORY\') AS auditLogs,(SELECT COUNT(*) FROM customer_payments WHERE business_id=? AND is_historical=TRUE) AS customerPayments,(SELECT COUNT(*) FROM supplier_payments WHERE business_id=? AND is_historical=TRUE) AS supplierPayments,(SELECT COUNT(*) FROM sales WHERE business_id=? AND is_historical=FALSE) AS liveSales,(SELECT COUNT(*) FROM purchases WHERE business_id=? AND is_historical=FALSE) AS livePurchases,(SELECT COUNT(*) FROM cash_movements WHERE business_id=? AND is_historical=FALSE) AS liveCashMovements,(SELECT COUNT(*) FROM inventory_movements WHERE business_id=? AND is_historical=FALSE) AS liveInventoryMovements',
    Array(18).fill(businessId)
  );
  return Object.fromEntries(Object.entries(rows[0]).map(([key, value]) => [key, Number(value)]));
}

test('el paquete v2 continúa v1, se reanuda sin duplicados, concilia y activa solo después', async ({ page, context, browser }) => {
  test.setTimeout(600_000);
  const v1BytesBefore = createHash('sha256').update(fs.readFileSync(v1Path)).digest('hex');
  const v2BytesBefore = createHash('sha256').update(fs.readFileSync(v2Path)).digest('hex');
  const v1 = JSON.parse(fs.readFileSync(v1Path, 'utf8'));
  const v2 = JSON.parse(fs.readFileSync(v2Path, 'utf8'));
  expect(v1.version).toBe(1);
  expect(v2.version).toBe(2);
  expect(v2.source.scope.localBusinessId).toBe(v2.business.localBusinessId);

  await signInSystemAdmin(page, context);
  await enableArchiveResponseCapture(page);
  const suffix = randomBytes(5).toString('hex');
  const destination = await createDestinationAndAdmin(page, suffix, 'Continuidad de migración temporal');
  const database = process.env.POS_INTEGRATION_DATABASE;
  expect(database).toMatch(/^pos_auth_test_[a-f0-9]{24}$/);
  expect(database).not.toBe(readConfig().database.database);
  const pool = createDatabasePool({ ...readConfig().database, database, connectionLimit: 4 });
  try {
    const v1Package = await loadPackage(page, v1Path);
    expect(v1Package.value.version).toBe(1);
    await expect(page.locator('#migrationIdentityReview')).toContainText('127 registros con el identificador antiguo compartido');
    await page.locator('#migrationArchiveConfirm').check();
    const v1ArchivePromise = page.waitForResponse(response => isRequest(response, '/system-admin/migration/archive'), { timeout: 180_000 });
    const v1OperationsPromise = page.waitForResponse(response => isRequest(response, '/project/operations'), { timeout: 240_000 });
    await expect(page.getByRole('button', { name: 'Migrar datos', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Migrar datos', exact: true }).click();
    const v1ArchiveResponse = await v1ArchivePromise;
    const v1Archive = await readArchiveResponse(page, v1ArchiveResponse.status());
    expect(v1Archive.status).toBe(201);
    expect(v1Archive.identityConfirmationApplied).toBe(127);
    expect(v1Archive.confirmation.packageSha256).toBe(v1Archive.packageSha256);
    expect(v1Archive.confirmation.fileSha256).toBe(v1Package.fileSha256);
    const v1OperationsResponse = await v1OperationsPromise;
    expect(v1OperationsResponse.status()).toBe(200);
    const v1Operations = await v1OperationsResponse.json();
    expect(v1Operations.reconciliation.complete).toBe(false);
    expect(v1Operations.businessStatus).toBe('INACTIVE');
    expect(v1Operations.reconciliation.blockers.length).toBeGreaterThan(0);
    const afterV1 = await databaseSnapshot(pool, destination.businessId);
    expect(afterV1.sales).toBe(v1.data.sales.length);
    expect(afterV1.purchases).toBe(v1.data.purchases.length);
    expect(afterV1.liveSales).toBe(0);
    expect(afterV1.livePurchases).toBe(0);

    const blockedActivation = await page.evaluate(async businessId => {
      const client = new window.PosApiClient(window.POS_API_BASE_URL);
      await client.me();
      try { await client.setAdminBusinessStatus(businessId, 'ACTIVE'); return 'ACTIVE'; }
      catch (failure) { return failure.code || 'UNKNOWN'; }
    }, destination.businessId);
    expect(blockedActivation).toBe('MIGRATION_RECONCILIATION_REQUIRED');

    const v2Package = await loadPackage(page, v2Path);
    expect(v2Package.value.version).toBe(2);
    await expect(page.locator('#migrationIdentityReview')).toContainText('332');
    await expect(page.locator('#migrationArchiveReconciliationNotes')).toContainText('356');
    await expect(page.locator('#migrationArchiveReview textarea')).toHaveCount(0);
    await expect(page.locator('#migrationArchiveConfirm')).not.toBeChecked();
    await page.locator('#migrationArchiveConfirm').check();
    const migrationButton = page.getByRole('button', { name: 'Migrar datos', exact: true });
    await expect(migrationButton).toBeEnabled();

    let interrupted = false;
    let signalInterrupted;
    const interruption = new Promise(resolve => { signalInterrupted = resolve; });
    const projectMatcher = url => url.pathname.endsWith('/project/operations');
    const failOnce = async route => {
      if (!interrupted) {
        interrupted = true;
        signalInterrupted();
        await route.abort('failed');
        return;
      }
      await route.continue();
    };
    await page.route(projectMatcher, failOnce);
    const firstV2ArchivePromise = page.waitForResponse(response => isRequest(response, '/system-admin/migration/archive'), { timeout: 180_000 });
    await migrationButton.click();
    const firstV2ArchiveResponse = await firstV2ArchivePromise;
    const firstV2Archive = await readArchiveResponse(page, firstV2ArchiveResponse.status());
    expect(firstV2Archive.status, firstV2Archive.errorCode || 'ARCHIVE_FAILED').toBe(201);
    expect(firstV2Archive.batchId).not.toBe(v1Archive.batchId);
    expect(firstV2Archive.continuation.priorBatchId).toBe(v1Archive.batchId);
    expect(firstV2Archive.continuation.mode).toBe('V1_TO_V2_CONTINUATION');
    expect(firstV2Archive.continuationConflicts).toEqual([]);
    expect(firstV2Archive.counts).toMatchObject({ products: 4, clients: 4, suppliers: 4, sales: 28, purchases: 6, cashSessions: 5, inventoryMovements: 69, abonos: 7, expenses: 1, auditLogs: 177, saleOrders: 29, syncQueue: 356 });
    expect(firstV2Archive.identityConfirmationApplied).toBe(332);
    expect(firstV2Archive.archiveOnlyRecords).toBe(356);
    expect(firstV2Archive.confirmation.scope).toBe('PACKAGE_PROVENANCE_WITH_AUDIT_ONLY_QUEUE');
    expect(firstV2Archive.confirmation.fileSha256).toBe(v2Package.fileSha256);
    await interruption;
    await expect(page.locator('#migrationArchiveStatus')).toContainText('pendiente', { timeout: 120_000 });
    await expect(page.locator('#migrationArchiveConfirm')).not.toBeChecked();
    await page.unroute(projectMatcher, failOnce);
    const afterInterruptedArchive = await databaseSnapshot(pool, destination.businessId);
    expect(afterInterruptedArchive).toEqual(afterV1);

    await page.locator('#migrationArchiveConfirm').check();
    await expect(migrationButton).toBeEnabled();
    const retryArchivePromise = page.waitForResponse(response => isRequest(response, '/system-admin/migration/archive'), { timeout: 180_000 });
    const retryOperationsPromise = page.waitForResponse(response => isRequest(response, '/project/operations'), { timeout: 240_000 });
    await migrationButton.click();
    const retryArchiveResponse = await retryArchivePromise;
    const retryArchive = await readArchiveResponse(page, retryArchiveResponse.status());
    expect(retryArchive.status).toBe(201);
    expect(retryArchive.batchId).toBe(firstV2Archive.batchId);
    expect(retryArchive.packageSha256).toBe(firstV2Archive.packageSha256);
    const operationsResponse = await retryOperationsPromise;
    expect(operationsResponse.status()).toBe(200);
    const operations = await operationsResponse.json();
    expect(operations.reconciliation.complete).toBe(true, JSON.stringify(operations.reconciliation.differences));
    expect(operations.reconciliation.fullMigrationComplete).toBe(true);
    expect(operations.reconciliation.differences).toEqual([]);
    expect(operations.businessStatus).toBe('INACTIVE');
    expect(operations.reconciliation.migrationState).toBe('COMPLETE');
    expect(operations.reconciliation.operational.sales).toMatchObject({ source: 28, imported: 28 });
    expect(operations.reconciliation.operational.purchases).toMatchObject({ source: 6, imported: 6 });
    expect(operations.reconciliation.operational.inventoryMovements).toMatchObject({ source: 69, imported: 69, operationalMovements: 68, zeroQuantityEvents: 1 });
    expect(operations.reconciliation.operational.expenses).toMatchObject({ source: 1, imported: 1 });
    expect(operations.reconciliation.operational.cashSessions).toMatchObject({ source: 5, imported: 5 });
    expect(operations.reconciliation.operational.auditLogs).toMatchObject({ source: 177, imported: 177 });
    expect(operations.reconciliation.operational.saleOrders).toMatchObject({ source: 29, imported: 29, sourceItems: 58, importedItems: 58 });
    expect(operations.reconciliation.operational.syncQueue).toMatchObject({ source: 356, archived: 356, executed: 0 });

    const afterV2 = await databaseSnapshot(pool, destination.businessId);
    expect(afterV2).toMatchObject({ products: 4, clients: 4, suppliers: 4, sales: 28, purchases: 6, cashSessions: 5, inventoryMovements: 68, zeroInventoryEvents: 1, expenses: 1, orders: 29, auditLogs: 177, liveSales: 0, livePurchases: 0, liveCashMovements: 0, liveInventoryMovements: 0 });
    const supplierPaymentExpected = v2.data.abonos.filter(row => /PROVEEDOR/i.test(String(row.tipo || row.type || ''))).length;
    expect(afterV2.supplierPayments).toBe(supplierPaymentExpected);
    expect(afterV2.customerPayments).toBe(v2.data.abonos.length - supplierPaymentExpected);
    const [inventoryStocks] = await pool.execute(
      'SELECT r.source_record_key AS sourceRecordKey,p.stock FROM migration_source_records r JOIN products p ON p.business_id=r.business_id AND p.id=r.target_record_id WHERE r.business_id=? AND r.batch_id=? AND r.entity_type=\'products\' AND r.record_status=\'PROJECTED\'',
      [destination.businessId, retryArchive.batchId]
    );
    expect(inventoryStocks).toHaveLength(v2.data.products.length);
    for (const row of inventoryStocks) {
      const source = v2.data.products.find(product => 'id:' + String(product.id) === row.sourceRecordKey);
      expect(source).toBeTruthy();
      expect(Number(row.stock)).toBe(Number(source.stock));
    }
    const sourceZero = v2.data.inventoryMovements.find(row => Number(row.quantity ?? row.cantidad) === 0);
    const [zeroRows] = await pool.execute(
      'SELECT COUNT(*) AS count,MIN(quantity) AS quantity FROM migration_zero_inventory_events WHERE business_id=? AND source_record_key=?',
      [destination.businessId, 'id:' + String(sourceZero.id)]
    );
    expect(Number(zeroRows[0].count)).toBe(1);
    expect(String(zeroRows[0].quantity)).toBe('0.000');
    const [cashCounts] = await pool.execute('SELECT COUNT(*) AS count FROM cash_movements WHERE business_id=? AND is_historical=TRUE', [destination.businessId]);
    const expectedCashMovements = v2.data.cashSessions.reduce((sum, session) => sum + (session.movimientos || []).length, 0);
    expect(Number(cashCounts[0].count)).toBe(expectedCashMovements);
    const [batchRows] = await pool.execute(
      'SELECT package_version AS packageVersion,package_sha256 AS packageSha256,JSON_UNQUOTE(JSON_EXTRACT(manifest,\'$.packageHashes.originalFileSha256\')) AS fileSha256,status FROM migration_import_batches WHERE business_id=? ORDER BY package_version',
      [destination.businessId]
    );
    expect(batchRows.map(row => Number(row.packageVersion))).toEqual([1, 2]);
    expect(batchRows[0].fileSha256).toBe(v1BytesBefore);
    expect(batchRows[1].fileSha256).toBe(v2BytesBefore);
    expect(batchRows[1].status).toBe('COMPLETED');
    const [syncRows] = await pool.execute(
      'SELECT COUNT(*) AS total,SUM(record_status=\'PROJECTED\') AS projected,SUM(target_table=\'migration_source_records\') AS archiveOnly FROM migration_source_records WHERE business_id=? AND batch_id=? AND entity_type=\'syncQueue\'',
      [destination.businessId, retryArchive.batchId]
    );
    expect([Number(syncRows[0].total), Number(syncRows[0].projected), Number(syncRows[0].archiveOnly)]).toEqual([356, 356, 356]);
    const [gateRows] = await pool.execute('SELECT b.status,c.state FROM businesses b JOIN business_migration_controls c ON c.business_id=b.id WHERE b.id=?', [destination.businessId]);
    expect([gateRows[0].status, gateRows[0].state]).toEqual(['INACTIVE', 'COMPLETE']);
  } finally {
    await pool.end();
  }

  const activated = await page.evaluate(async businessId => {
    const client = new window.PosApiClient(window.POS_API_BASE_URL);
    await client.me();
    try { return await client.setAdminBusinessStatus(businessId, 'ACTIVE'); }
    catch (failure) { return failure.code || 'UNKNOWN'; }
  }, destination.businessId);
  expect(activated).toMatchObject({ status: 'ACTIVE' });

  const targetSession = await openDestinationPage(browser, destination, require.resolve('../tests/dexie-search-shim.js'));
  try {
    const importedSales = await targetSession.page.evaluate(async () => {
      const api = new window.PosApiClient(window.POS_API_BASE_URL);
      await api.me();
      return api.sales();
    });
    expect(importedSales).toHaveLength(28);
    expect(importedSales.every(sale => sale.businessId === destination.businessId && sale.isHistorical && sale.status === 'COMPLETED')).toBe(true);
    const paymentTotals = importedSales.reduce((totals, sale) => {
      const entry = totals[sale.paymentMethod] || { count: 0, total: 0 };
      entry.count += 1;
      entry.total += Number(sale.total);
      totals[sale.paymentMethod] = entry;
      return totals;
    }, {});
    expect(Object.fromEntries(Object.entries(paymentTotals).map(([method, row]) => [method, { count: row.count, total: Number(row.total.toFixed(2)) }]))).toEqual({ CASH: { count: 23, total: 4304.4 }, CARD: { count: 1, total: 1788.3 }, CREDIT: { count: 4, total: 180.9 } });

    await targetSession.page.locator('#navReportesBtn').click();
    await expect(targetSession.page.locator('#reportesView')).toBeVisible();
    await targetSession.page.locator('#filtroTodoBtn').click();
    await expect(targetSession.page.locator('#repVentas')).toHaveText('C$6273.60');
    await expect(targetSession.page.locator('#repCostoVendido')).toHaveText('C$5703.39');
    await expect(targetSession.page.locator('#repGananciaBruta')).toHaveText('C$570.21');
    await expect(targetSession.page.locator('#repUtilidad')).toHaveText('C$-1929.79');
    await expect(targetSession.page.locator('#repCompras')).toHaveText('C$1986.00');
    await expect(targetSession.page.locator('#repGastos')).toHaveText('C$2500.00');
    await expect(targetSession.page.locator('#repCxC')).toHaveText('C$74.80');
    await expect(targetSession.page.locator('#repCxP')).toHaveText('C$0.00');
    await expect(targetSession.page.locator('#repVentasHistorialBody tr')).toHaveCount(28);
    await expect(targetSession.page.locator('#repVentasHistoryNote')).toContainText('incluidas las importadas');
    await expect(targetSession.page.locator('#repVentasHistoryNote')).not.toContainText('excluyen ventas históricas');
    await expect(targetSession.page.locator('#repVentasMetodoBody')).toContainText('Tarjeta');
    await expect(targetSession.page.locator('#repVentasMetodoBody')).toContainText('C$1788.30');

    const cardSale = importedSales.find(sale => sale.paymentMethod === 'CARD');
    expect(cardSale).toBeTruthy();
    const cardSaleDay = await targetSession.page.evaluate(createdAt => {
      const date = new Date(createdAt);
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    }, cardSale.createdAt);
    await targetSession.page.locator('#reporteDesdeInput').fill(cardSaleDay);
    await targetSession.page.locator('#reporteHastaInput').fill(cardSaleDay);
    await targetSession.page.locator('#aplicarFiltroReporteBtn').click();
    await expect.poll(async () => Number((await targetSession.page.locator('#repVentas').innerText()).replace('C$', ''))).toBeGreaterThan(0);
    await expect.poll(async () => Number((await targetSession.page.locator('#repVentas').innerText()).replace('C$', ''))).toBeLessThan(6273.6);
    await targetSession.page.locator('#filtroTodoBtn').click();
    await expect(targetSession.page.locator('#repVentas')).toHaveText('C$6273.60');

    await targetSession.page.evaluate(() => {
      const column = index => { let value = index + 1, result = ''; while (value) { value -= 1; result = String.fromCharCode(65 + value % 26) + result; value = Math.floor(value / 26); } return result; };
      window.XLSX = { utils: {
        aoa_to_sheet(rows) { const sheet = { '!data': rows }; rows.forEach((row, y) => row.forEach((value, x) => { sheet[`${column(x)}${y + 1}`] = { v: value, t: typeof value === 'number' ? 'n' : 's' }; })); return sheet; },
        book_new() { return { SheetNames: [], Sheets: {} }; },
        book_append_sheet(book, sheet, name) { book.SheetNames.push(name); book.Sheets[name] = sheet; }
      }, writeFile(book, filename) { const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([JSON.stringify({ book, filename })])); link.download = filename; document.body.append(link); link.click(); link.remove(); } };
    });
    const [reportDownload] = await Promise.all([targetSession.page.waitForEvent('download'), targetSession.page.evaluate(() => window.PosReports.exportExcel('sales'))]);
    const reportWorkbook = JSON.parse(fs.readFileSync(await reportDownload.path(), 'utf8')).book;
    expect(JSON.stringify(reportWorkbook.Sheets)).toContain('1788.3');
    expect(reportWorkbook.SheetNames).toContain('Historial de ventas');
    expect(reportWorkbook.Sheets['Historial de ventas']['!data']).toHaveLength(29);

    await targetSession.page.locator('#navDashboardBtn').click();
    await expect(targetSession.page.locator('#dashboardView')).toBeVisible();
    await targetSession.page.locator('[data-dashboard-preset="all"]').click();
    await expect(targetSession.page.locator('#connectedDashSalesTotal')).toHaveText('C$6273.60');
    await expect(targetSession.page.locator('#connectedDashSalesCost')).toHaveText('C$5703.39');
    await expect(targetSession.page.locator('#connectedDashGrossProfit')).toHaveText('C$570.21');
    await expect(targetSession.page.locator('#connectedDashExpenseTotal')).toHaveText('C$2500.00');
    await expect(targetSession.page.locator('#connectedDashNetProfit')).toHaveText('C$-1929.79');
    await expect(targetSession.page.locator('#connectedDashPurchasesTotal')).toHaveText('C$1986.00');
    await expect(targetSession.page.locator('#connectedDashReceivableBalance')).toHaveText('C$74.80');
    await expect(targetSession.page.locator('#connectedDashPayablesBalance')).toHaveText('C$0.00');
    await expect(targetSession.page.locator('#connectedDashCashIn')).toHaveText('C$4304.40');
    await expect(targetSession.page.locator('#connectedDashCashOut')).toHaveText('C$2545.00');
    await expect(targetSession.page.locator('#connectedDashCashExpected')).toHaveText('Sin caja abierta');
    await expect(targetSession.page.locator('#connectedDashHistoryBody tr')).toHaveCount(28);
    const allDashboardSales = await targetSession.page.locator('#connectedDashSalesTotal').innerText();
    await targetSession.page.locator('#dashboardFromInput').fill(cardSaleDay);
    await targetSession.page.locator('#dashboardUntilInput').fill(cardSaleDay);
    await targetSession.page.locator('#dashboardApplyBtn').click();
    await expect.poll(async () => Number((await targetSession.page.locator('#connectedDashSalesTotal').innerText()).replace('C$', ''))).toBeGreaterThan(0);
    await expect.poll(async () => Number((await targetSession.page.locator('#connectedDashSalesTotal').innerText()).replace('C$', ''))).toBeLessThan(6273.6);
    await targetSession.page.locator('[data-dashboard-preset="all"]').click();
    await expect(targetSession.page.locator('#connectedDashSalesTotal')).toHaveText(allDashboardSales);
    const [dashboardDownload] = await Promise.all([targetSession.page.waitForEvent('download'), targetSession.page.evaluate(() => window.PosDashboard.exportExcel())]);
    const dashboardWorkbook = JSON.parse(fs.readFileSync(await dashboardDownload.path(), 'utf8')).book;
    expect(dashboardWorkbook.SheetNames).toContain('Ventas del período');
    expect(dashboardWorkbook.Sheets['Ventas del período']['!data']).toHaveLength(29);

    await targetSession.page.locator('#navHistoryBtn').click();
    await expect(targetSession.page.locator('#historyView')).toBeVisible();
    const historicalOrderRows = targetSession.page.locator('#historicalOrdersTableBody tr');
    await expect(historicalOrderRows).toHaveCount(29);
    const cancelledOrder = historicalOrderRows.filter({ hasText: 'Anulada' });
    await expect(cancelledOrder).toHaveCount(1);
    await expect(cancelledOrder).toContainText('Precio histórico no disponible');
    await expect(cancelledOrder).toContainText('C$67.10');
  } finally {
    await targetSession.context.close();
  }

  expect(createHash('sha256').update(fs.readFileSync(v1Path)).digest('hex')).toBe(v1BytesBefore);
  expect(createHash('sha256').update(fs.readFileSync(v2Path)).digest('hex')).toBe(v2BytesBefore);
});
