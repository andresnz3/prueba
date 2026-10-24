'use strict';

const fs = require('node:fs');
const { createHash, randomBytes } = require('node:crypto');
const { test, expect } = require('@playwright/test');
const { readConfig } = require('../backend/src/config/environment');
const { createDatabasePool } = require('../backend/src/config/database');
const { createDestinationAndAdmin, signInSystemAdmin } = require('./local-migration-flow.helper.cjs');

const packagePath = process.env.POS_MIGRATION_REVIEW_FILE;

test.skip(!packagePath, 'Define POS_MIGRATION_REVIEW_FILE para ejecutar la migración aislada con el paquete proporcionado.');

test('el botón Migrar datos ejecuta el paquete real en un destino temporal y conserva el bloqueo si faltan tiendas', async ({ page, context }) => {
  test.setTimeout(180_000);
  const raw = fs.readFileSync(packagePath);
  const rawHash = createHash('sha256').update(raw).digest('hex');
  const value = JSON.parse(raw.toString('utf8'));
  expect(value.type).toBe('pos_local_migration_package');
  expect(value.version).toBe(1);
  await signInSystemAdmin(page, context);
  const suffix = randomBytes(5).toString('hex');
  const destination = await createDestinationAndAdmin(page, suffix, 'PRUEBA MIGRACION JSON');
  await page.locator('#migrationPackageFile').setInputFiles({ name: 'cliente-real.json', mimeType: 'application/json', buffer: raw });
  await expect(page.locator('#migrationPackageReview')).toBeVisible();
  await expect(page.locator('#migrationArchiveReview')).toBeVisible({ timeout: 120_000 });
  await expect(page.locator('#migrationIdentityReview')).toContainText('127 registros con el identificador antiguo compartido');
  await expect(page.locator('#migrationIdentityReview')).toContainText('No hace falta revisarlos uno por uno');
  await expect(page.locator('#migrationIdentityReview details')).toHaveCount(0);
  await expect(page.locator('#migrationIdentityReview')).not.toContainText('registros antiguos por revisar');
  await expect(page.locator('#migrationLegacyIdentityNotice')).toContainText('Encontramos 127 registros con el identificador antiguo compartido');
  await expect(page.locator('#migrationArchiveReview textarea')).toHaveCount(0);
  await expect(page.locator('#migrationArchiveConfirmLabel')).toHaveText('Confirmo que este archivo pertenece al negocio seleccionado y autorizo su migración');
  await expect(page.locator('#migrationArchiveConfirm')).not.toBeChecked();
  await page.locator('#migrationArchiveConfirm').check();
  const migrationButton = page.getByRole('button', { name: 'Migrar datos', exact: true });
  await expect(page.locator('#migrationArchiveStartGate')).toBeHidden();
  await expect(page.locator('#migrationArchiveReconciliationNotes')).toContainText('No se asumirán vacíos');
  await expect(page.locator('#migrationArchiveBlockers')).not.toContainText('127 registros pendientes de revisión');
  await expect(page.locator('#migrationArchiveIdentityDetails')).toBeHidden();
  await expect(page.locator('#migrationArchiveReadiness li')).toHaveCount(8);
  await expect(page.locator('#migrationArchiveReadiness li[data-state="missing"]')).toHaveCount(0);
  await expect(migrationButton).toBeEnabled();
  const archiveResponsePromise = page.waitForResponse(response => response.url().endsWith('/system-admin/migration/archive') && response.request().method() === 'POST', { timeout: 120_000 });
  const operationResponsePromise = page.waitForResponse(response => /\/project\/operations$/.test(response.url()) && response.request().method() === 'POST', { timeout: 120_000 });
  await migrationButton.click();
  const archiveResponse = await archiveResponsePromise;
  const archive = await archiveResponse.json();
  expect(archiveResponse.status()).toBe(201);
  expect(archive.identityConfirmationApplied).toBe(127);
  expect(archive.identityConfirmation).toMatchObject({
    confirmed: true,
    scope: 'SHARED_LEGACY_BUSINESS_ID_ROWS_ONLY',
    targetBusinessId: destination.businessId,
    packageSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
  });
  expect(archive.identityConfirmation.packageSha256).toBe(archive.packageSha256);
  expect(archive.identityConfirmation.adminIdentity.username).toBe('andres');
  expect(archive.identityConfirmation.adminIdentity.userId).toBeTruthy();
  expect(archive.identityConfirmation.confirmedAt).toBeTruthy();
  expect(archive.identityConfirmation.confirmationText).toBe('Confirmo que este archivo pertenece al negocio seleccionado y autorizo su migración');
  const operationsResponse = await operationResponsePromise;
  const operations = await operationsResponse.json();
  expect(operationsResponse.status(), JSON.stringify(operations.reconciliation?.blockers || [])).toBe(200);
  expect(operations.reconciliation.complete).toBe(false);
  expect(operations.businessStatus).toBe('INACTIVE');
  expect(operations.reconciliation.blockers.length).toBeGreaterThan(0);
  const differenceModules = new Set(operations.reconciliation.differences.map(item => item.module));
  for (const module of ['sales', 'purchases', 'supplierPayments', 'cashSessions', 'cashMovements', 'supplierBalances']) {
    expect(differenceModules.has(module), JSON.stringify(operations.reconciliation.differences.filter(item => item.module === module).slice(0, 20))).toBe(false);
  }
  const operational = operations.reconciliation.operational;
  expect(operational.sales.source).toBe(value.data.sales.length);
  expect(operational.sales.imported).toBe(operational.sales.source);
  expect(operational.purchases.source).toBe(value.data.purchases.length);
  expect(operational.purchases.imported).toBe(operational.purchases.source);
  expect(operational.cashSessions.source).toBe(value.data.cashSessions.length);
  expect(operational.cashSessions.imported).toBe(operational.cashSessions.source);
  expect(operational.inventoryMovements.source).toBe(value.data.inventoryMovements.length);
  expect(operational.inventoryMovements.imported).toBe(operational.inventoryMovements.source);
  expect(operational.inventoryMovements.operationalMovements).toBe(operational.inventoryMovements.source - 1);
  expect(operational.inventoryMovements.zeroQuantityEvents).toBe(1);
  expect(operations.reconciliation.differences.filter(item => item.module === 'inventoryMovements')).toEqual([]);
  expect(operations.reconciliation.importResults.purchases.supplierResolution).toHaveLength(value.data.purchases.length);
  const database = process.env.POS_INTEGRATION_DATABASE;
  expect(database).toMatch(/^pos_auth_test_[a-f0-9]{24}$/);
  expect(database).not.toBe(readConfig().database.database);
  const pool = createDatabasePool({ ...readConfig().database, database, connectionLimit: 2 });
  try {
    const [salesReferenceRows] = await pool.execute(
      'SELECT source_sale_id AS sourceSaleId FROM migration_sales_references WHERE business_id=? AND source_business_key=(SELECT source_business_key FROM migration_import_batches WHERE business_id=? AND id=?)',
      [destination.businessId, destination.businessId, operations.batchId]
    );
    expect(salesReferenceRows).toHaveLength(value.data.sales.length);
    const [authorizationRows] = await pool.execute(
      "SELECT action,entity_id AS batchId,JSON_UNQUOTE(JSON_EXTRACT(details,'$.targetBusinessId')) AS targetBusinessId,JSON_UNQUOTE(JSON_EXTRACT(details,'$.packageSha256')) AS packageSha256,JSON_UNQUOTE(JSON_EXTRACT(details,'$.adminIdentity.username')) AS adminUsername,JSON_UNQUOTE(JSON_EXTRACT(details,'$.adminIdentity.userId')) AS adminUserId,JSON_UNQUOTE(JSON_EXTRACT(details,'$.confirmedAt')) AS confirmedAt FROM audit_logs WHERE business_id=? AND action='LOCAL_MIGRATION_PACKAGE_AUTHORIZED' AND entity_id=?",
      [destination.businessId, operations.batchId]
    );
    expect(authorizationRows).toHaveLength(1);
    expect(authorizationRows[0]).toMatchObject({
      action: 'LOCAL_MIGRATION_PACKAGE_AUTHORIZED',
      batchId: operations.batchId,
      targetBusinessId: destination.businessId,
      packageSha256: archive.packageSha256,
      adminUsername: 'andres'
    });
    expect(authorizationRows[0].adminUserId).toBeTruthy();
    expect(authorizationRows[0].confirmedAt).toBeTruthy();
    const [rows] = await pool.execute(
      'SELECT (SELECT status FROM businesses WHERE id=?) AS businessStatus,(SELECT state FROM business_migration_controls WHERE business_id=?) AS migrationState,(SELECT COUNT(*) FROM products WHERE business_id=?) AS products,(SELECT COUNT(*) FROM clients WHERE business_id=?) AS clients,(SELECT COUNT(*) FROM suppliers WHERE business_id=?) AS suppliers,(SELECT COUNT(*) FROM sales WHERE business_id=? AND is_historical=TRUE) AS sales,(SELECT COUNT(*) FROM purchases WHERE business_id=? AND is_historical=TRUE) AS purchases,(SELECT COUNT(*) FROM cash_sessions WHERE business_id=? AND is_historical=TRUE) AS cashSessions,(SELECT COUNT(*) FROM inventory_movements WHERE business_id=? AND is_historical=TRUE) AS inventoryMovements,(SELECT COUNT(*) FROM sales s WHERE s.business_id=? AND s.is_historical=TRUE AND NOT EXISTS (SELECT 1 FROM migration_source_records r WHERE r.business_id=s.business_id AND r.target_record_id=s.id AND r.target_table=\'sales\' AND r.record_status=\'PROJECTED\')) AS unlinkedSales,(SELECT COUNT(*) FROM purchases p WHERE p.business_id=? AND p.is_historical=TRUE AND NOT EXISTS (SELECT 1 FROM migration_source_records r WHERE r.business_id=p.business_id AND r.target_record_id=p.id AND r.target_table=\'purchases\' AND r.record_status=\'PROJECTED\')) AS unlinkedPurchases',
      Array(11).fill(destination.businessId)
    );
    expect(rows[0].businessStatus).toBe('INACTIVE');
    expect(rows[0].migrationState).toBe('PENDING');
    expect(Number(rows[0].products)).toBe(value.data.products.length);
    expect(Number(rows[0].clients)).toBe(value.data.clients.length);
    expect(Number(rows[0].suppliers)).toBe(value.data.suppliers.length);
    expect(Number(rows[0].sales)).toBe(value.data.sales.length);
    expect(Number(rows[0].purchases)).toBe(operational.purchases.imported);
    expect(Number(rows[0].purchases)).toBe(value.data.purchases.length);
    expect(Number(rows[0].unlinkedSales)).toBe(0);
    expect(Number(rows[0].unlinkedPurchases)).toBe(0);
    expect(Number(rows[0].cashSessions)).toBe(operational.cashSessions.imported);
    expect(Number(rows[0].inventoryMovements)).toBe(operational.inventoryMovements.operationalMovements);
    const [historicalCounts] = await pool.execute(
      'SELECT (SELECT COUNT(*) FROM supplier_payments WHERE business_id=? AND is_historical=TRUE) AS supplierPayments,(SELECT COUNT(*) FROM cash_movements WHERE business_id=? AND is_historical=TRUE) AS cashMovements',
      [destination.businessId, destination.businessId]
    );
    expect(Number(historicalCounts[0].supplierPayments)).toBe(value.data.abonos.filter(payment => payment.tipo === 'proveedor').length);
    expect(Number(historicalCounts[0].cashMovements)).toBe(value.data.cashSessions.reduce((count, session) => count + (session.movimientos || []).length, 0));
    const [unpostedCounts] = await pool.execute(
      'SELECT (SELECT COUNT(*) FROM sales WHERE business_id=? AND is_historical=FALSE) AS sales,(SELECT COUNT(*) FROM purchases WHERE business_id=? AND is_historical=FALSE) AS purchases,(SELECT COUNT(*) FROM supplier_payments WHERE business_id=? AND is_historical=FALSE) AS supplierPayments,(SELECT COUNT(*) FROM cash_sessions WHERE business_id=? AND is_historical=FALSE) AS cashSessions,(SELECT COUNT(*) FROM cash_movements WHERE business_id=? AND is_historical=FALSE) AS cashMovements,(SELECT COUNT(*) FROM inventory_movements WHERE business_id=? AND is_historical=FALSE) AS inventoryMovements',
      Array(6).fill(destination.businessId)
    );
    expect(Object.values(unpostedCounts[0]).map(Number)).toEqual([0, 0, 0, 0, 0, 0]);
    const [zeroMovementSource] = await pool.execute(
      "SELECT record_status AS recordStatus,target_table AS targetTable,target_record_id AS targetRecordId,pending_reason AS pendingReason,JSON_UNQUOTE(JSON_EXTRACT(source_payload,'$.cantidad')) AS sourceQuantity FROM migration_source_records WHERE business_id=? AND batch_id=? AND entity_type='inventoryMovements' AND source_record_key='id:1791253127965.8538'",
      [destination.businessId, operations.batchId]
    );
    expect(zeroMovementSource).toHaveLength(1);
    expect(zeroMovementSource[0]).toMatchObject({ recordStatus: 'PROJECTED', targetTable: 'migration_zero_inventory_events', pendingReason: null });
    expect(zeroMovementSource[0].targetRecordId).toBeTruthy();
    expect(Number(zeroMovementSource[0].sourceQuantity)).toBe(0);
    const [zeroEvents] = await pool.execute(
      'SELECT e.quantity,e.stock_after AS stockAfter,e.source_type AS sourceType,e.occurred_at AS occurredAt,e.product_id AS productId,e.source_record_key AS sourceRecordKey FROM migration_zero_inventory_events e WHERE e.business_id=? AND e.batch_id=?',
      [destination.businessId, operations.batchId]
    );
    expect(zeroEvents).toHaveLength(1);
    expect(zeroEvents[0].quantity).toBe('0.000');
    expect(zeroEvents[0].sourceRecordKey).toBe('id:1791253127965.8538');
    expect(zeroEvents[0].sourceType).toBeTruthy();
    const [productStocks] = await pool.execute(
      "SELECT r.source_record_key AS sourceRecordKey,p.stock FROM migration_source_records r JOIN products p ON p.business_id=r.business_id AND p.id=r.target_record_id WHERE r.business_id=? AND r.batch_id=? AND r.entity_type='products' AND r.record_status='PROJECTED'",
      [destination.businessId, operations.batchId]
    );
    expect(productStocks).toHaveLength(value.data.products.length);
    for (const product of productStocks) {
      const source = value.data.products.find(row => 'id:' + String(row.id) === product.sourceRecordKey);
      expect(source).toBeTruthy();
      expect(Number(product.stock)).toBe(Number(source.stock));
    }
  } finally {
    await pool.end();
  }
  await expect(page.locator('#migrationArchiveStatus')).toContainText('Migración pendiente de revisión');
  await expect(page.locator('#migrationFullDifferenceList')).toContainText('gastos');
  await expect(page.locator('#migrationFullDifferenceList')).toContainText('órdenes pendientes');
  await expect(page.locator('#migrationFullDifferenceList')).not.toContainText('Inventario:');
  await expect(page.locator('#migrationFullDifferenceList')).not.toContainText('cantidad cero');
  await expect(page.locator('#migrationFullDifferenceList')).not.toContainText('vuelve a exportarlo');
  const activationResult = await page.evaluate(async businessId => {
    const client = new window.PosApiClient(window.POS_API_BASE_URL);
    await client.me();
    try { await client.setAdminBusinessStatus(businessId, 'ACTIVE'); return 'ACTIVE'; }
    catch (failure) { return failure.code || 'UNKNOWN'; }
  }, destination.businessId);
  expect(activationResult).toBe('MIGRATION_RECONCILIATION_REQUIRED');
  expect(createHash('sha256').update(fs.readFileSync(packagePath)).digest('hex')).toBe(rawHash);
});
