'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHash, randomBytes } = require('node:crypto');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { readConfig } = require('../../src/config/environment');
const { readAuthConfig } = require('../../src/config/auth');
const { createDatabasePool } = require('../../src/config/database');
const { createAuthRepository } = require('../../src/repositories/auth');
const { createSystemAdminService } = require('../../src/services/system-admin');
const { createImageStore } = require('../../src/services/product-images');

const database = process.env.POS_INTEGRATION_DATABASE;
if (!/^pos_auth_test_[a-f0-9]{24}$/.test(database || '') || database === process.env.DB_NAME) throw new Error('Use the isolated MySQL runner');
const v1Path = process.env.POS_MIGRATION_V1_FILE;
const v2Path = process.env.POS_MIGRATION_V2_FILE;

const elapsed = start => Math.round(Number(process.hrtime.bigint() - start) / 1e6);

test('continuación real v1 a v2: vista previa, archivo, proyección y conciliación en MySQL temporal', {
  skip: !v1Path || !v2Path ? 'Define POS_MIGRATION_V1_FILE y POS_MIGRATION_V2_FILE para la continuación aislada.' : false
}, async t => {
  const config = readConfig();
  const pool = createDatabasePool({ ...config.database, database, connectionLimit: 6 });
  t.after(() => pool.end());
  const imageRoot = mkdtempSync(join(tmpdir(), 'pos-migration-real-continuation-'));
  t.after(() => rmSync(imageRoot, { recursive: true, force: true }));
  const imageStore = createImageStore({ root: imageRoot, quota: 100 * 1024 * 1024 });
  const service = createSystemAdminService(createAuthRepository(pool, readAuthConfig({ CSRF_SECRET: 'f'.repeat(64) })), { imageStore });
  const admin = { username: 'andres', role: 'ADMIN', business_id: '1', user_id: '1' };
  const read = path => {
    const raw = fs.readFileSync(path);
    return { raw, value: JSON.parse(raw.toString('utf8')), fileHash: createHash('sha256').update(raw).digest('hex') };
  };
  const v1 = read(v1Path), v2 = read(v2Path);
  assert.equal(v1.value.version, 1);
  assert.equal(v2.value.version, 2);
  assert.equal(v2.value.business.localBusinessId, v2.value.source.scope.localBusinessId);

  const started = process.hrtime.bigint();
  const target = await service.createMigrationTarget(admin, 'Continuacion real en prueba temporal', 'CONECTADO_BASICO');
  const targetId = String(target.id);
  const credentialSuffix = randomBytes(6).toString('hex');
  await service.createBusinessUser(admin, targetId, {
    username: 'migration_' + credentialSuffix,
    fullName: 'Temporary migration administrator',
    password: randomBytes(24).toString('base64url'),
    role: 'ADMIN'
  });
  const archivedV1 = await service.archiveFullMigration(admin, targetId, v1.value, true, v1.fileHash);
  await service.projectMigrationCatalog(admin, targetId, archivedV1.batchId);
  const operationsV1 = await service.projectMigrationOperations(admin, targetId, archivedV1.batchId);
  assert.equal(operationsV1.businessStatus, 'INACTIVE');
  assert.equal(operationsV1.reconciliation.complete, false);

  const previewStarted = process.hrtime.bigint();
  const preview = await service.previewFullMigration(admin, targetId, v2.value, v2.fileHash);
  const previewMs = elapsed(previewStarted);
  assert.equal(preview.eligibleToArchive, true, JSON.stringify(preview.startBlockers));
  assert.equal(preview.continuation?.priorBatchId, archivedV1.batchId);
  assert.equal(preview.continuationConflicts.length, 0);
  assert.equal(preview.identityReview.counts.sharedId, 332);

  const archiveStarted = process.hrtime.bigint();
  const archivedV2 = await service.archiveFullMigration(admin, targetId, v2.value, true, v2.fileHash);
  const archiveMs = elapsed(archiveStarted);
  assert.equal(archivedV2.status, 'ARCHIVED', JSON.stringify(archivedV2.blockers));
  assert.equal(archivedV2.continuation?.priorBatchId, archivedV1.batchId);
  const retryArchive = await service.archiveFullMigration(admin, targetId, v2.value, true, v2.fileHash);
  assert.equal(retryArchive.batchId, archivedV2.batchId);
  assert.equal(retryArchive.packageSha256, archivedV2.packageSha256);
  const catalogV2 = await service.projectMigrationCatalog(admin, targetId, archivedV2.batchId);
  assert.equal(catalogV2.reconciliation?.stageMatched, true, JSON.stringify(catalogV2.reconciliation?.differences?.map(({ origin, module, field, reason }) => ({ origin, module, field, reason }))));
  const operationsStarted = process.hrtime.bigint();
  const operationsV2 = await service.projectMigrationOperations(admin, targetId, archivedV2.batchId);
  const operationsMs = elapsed(operationsStarted);
  assert.equal(operationsV2.reconciliation.complete, true, JSON.stringify(operationsV2.reconciliation.differences));
  assert.equal(operationsV2.reconciliation.migrationState, 'COMPLETE');
  assert.equal(operationsV2.businessStatus, 'INACTIVE');
  assert.deepEqual(operationsV2.reconciliation.differences, []);
  assert.equal(operationsV2.reconciliation.operational.expenses.imported, 1);
  assert.equal(operationsV2.reconciliation.operational.sales.imported, 28);
  assert.equal(operationsV2.reconciliation.operational.purchases.imported, 6);
  assert.equal(operationsV2.reconciliation.operational.inventoryMovements.operationalMovements, 68);
  assert.equal(operationsV2.reconciliation.operational.inventoryMovements.zeroQuantityEvents, 1);
  assert.equal(operationsV2.reconciliation.operational.saleOrders.imported, 29);
  assert.equal(operationsV2.reconciliation.operational.syncQueue.archived, 356);
  assert.equal(operationsV2.reconciliation.operational.syncQueue.executed, 0);
  const [tableCounts] = await pool.execute(
    'SELECT (SELECT COUNT(*) FROM products WHERE business_id=?) AS products,(SELECT COUNT(*) FROM sales WHERE business_id=? AND is_historical=TRUE) AS sales,(SELECT COUNT(*) FROM purchases WHERE business_id=? AND is_historical=TRUE) AS purchases,(SELECT COUNT(*) FROM cash_sessions WHERE business_id=? AND is_historical=TRUE) AS cashSessions,(SELECT COUNT(*) FROM inventory_movements WHERE business_id=? AND is_historical=TRUE) AS inventoryMovements,(SELECT COUNT(*) FROM migration_zero_inventory_events WHERE business_id=?) AS zeroEvents,(SELECT COUNT(*) FROM expenses WHERE business_id=? AND is_historical=TRUE) AS expenses,(SELECT COUNT(*) FROM sale_orders WHERE business_id=? AND is_historical=TRUE) AS saleOrders,(SELECT COUNT(*) FROM customer_payments WHERE business_id=? AND is_historical=TRUE) AS customerPayments,(SELECT COUNT(*) FROM supplier_payments WHERE business_id=? AND is_historical=TRUE) AS supplierPayments,(SELECT COUNT(*) FROM audit_logs WHERE business_id=? AND action=\'LOCAL_HISTORY\') AS auditLogs',
    Array(11).fill(targetId)
  );
  assert.deepEqual(Object.fromEntries(Object.entries(tableCounts[0]).map(([key, value]) => [key, Number(value)])), {
    products: 4, sales: 28, purchases: 6, cashSessions: 5, inventoryMovements: 68, zeroEvents: 1, expenses: 1, saleOrders: 29, customerPayments: 3, supplierPayments: 4, auditLogs: 177
  });
  const [legacyCancelledOrder] = await pool.execute("SELECT o.status,o.estimated_total,DATE_FORMAT(o.created_at,'%Y-%m-%d %H:%i:%s.%f') AS createdAt,DATE_FORMAT(o.cancelled_at,'%Y-%m-%d %H:%i:%s.%f') AS cancelledAt,COUNT(i.line_number) AS itemCount,SUM(i.quantity) AS quantity,SUM(i.price_snapshot_available=0 AND i.estimated_unit_price IS NULL AND i.estimated_subtotal IS NULL) AS unavailableSnapshots FROM migration_source_records r JOIN sale_orders o ON o.business_id=r.business_id AND o.id=r.target_record_id LEFT JOIN sale_order_items i ON i.business_id=o.business_id AND i.order_id=o.id WHERE r.business_id=? AND r.batch_id=? AND r.entity_type='saleOrders' AND r.source_record_key='id:34cc1140-3432-42d9-b462-720c1d44434b' AND r.record_status='PROJECTED' GROUP BY o.id", [targetId, archivedV2.batchId]);
  assert.equal(legacyCancelledOrder.length, 1);
  assert.deepEqual([legacyCancelledOrder[0].status, String(legacyCancelledOrder[0].estimated_total), Number(legacyCancelledOrder[0].itemCount), String(legacyCancelledOrder[0].quantity), Number(legacyCancelledOrder[0].unavailableSnapshots)], ['CANCELLED', '67.10', 2, '3.000', 2]);
  assert.equal(String(legacyCancelledOrder[0].createdAt).slice(0, 23), new Date(v2.value.data.saleOrders.find(row => row.id === '34cc1140-3432-42d9-b462-720c1d44434b').createdAt).toISOString().slice(0, 23).replace('T', ' '));
  const [settings] = await pool.execute('SELECT currency,min_stock_default,tax_rate_default FROM business_settings WHERE business_id=?', [targetId]);
  assert.equal(settings.length, 1);
  assert.equal(settings[0].currency, 'C$');
  assert.equal(String(settings[0].min_stock_default), '5.000');
  assert.equal(String(settings[0].tax_rate_default), '0.0000');
  const [imageRows] = await pool.execute('SELECT image FROM products WHERE business_id=? AND image IS NOT NULL', [targetId]);
  assert.equal(imageRows.length, 4);
  const reopenedImageStore = createImageStore({ root: imageRoot, quota: 100 * 1024 * 1024 });
  for (const row of imageRows) assert.ok((await reopenedImageStore.read(targetId, row.image)).length > 0);

  const [retryCounts] = await pool.execute(
    'SELECT (SELECT COUNT(*) FROM sales WHERE business_id=? AND is_historical=TRUE) AS sales,(SELECT COUNT(*) FROM purchases WHERE business_id=? AND is_historical=TRUE) AS purchases,(SELECT COUNT(*) FROM expenses WHERE business_id=? AND is_historical=TRUE) AS expenses,(SELECT COUNT(*) FROM sale_orders WHERE business_id=? AND is_historical=TRUE) AS saleOrders,(SELECT COUNT(*) FROM supplier_payments WHERE business_id=? AND is_historical=TRUE) AS supplierPayments,(SELECT COUNT(*) FROM inventory_movements WHERE business_id=? AND is_historical=TRUE) AS inventoryMovements,(SELECT COUNT(*) FROM migration_zero_inventory_events WHERE business_id=?) AS zeroEvents',
    Array(7).fill(targetId)
  );
  assert.deepEqual(Object.fromEntries(Object.entries(retryCounts[0]).map(([key, value]) => [key, Number(value)])), {
    sales: 28, purchases: 6, expenses: 1, saleOrders: 29, supplierPayments: 4, inventoryMovements: 68, zeroEvents: 1
  });

  const [batches] = await pool.execute('SELECT package_version AS version,package_sha256 AS packageSha256,JSON_UNQUOTE(JSON_EXTRACT(manifest,\'$.packageHashes.originalFileSha256\')) AS fileHash FROM migration_import_batches WHERE business_id=? ORDER BY package_version', [targetId]);
  assert.deepEqual(batches.map(row => Number(row.version)), [1, 2]);
  assert.equal(batches[0].fileHash, v1.fileHash);
  assert.equal(batches[1].fileHash, v2.fileHash);

  const activation = await service.setBusinessStatus(admin, targetId, 'ACTIVE');
  assert.equal(activation.status, 'ACTIVE');
  const [gate] = await pool.execute('SELECT state FROM business_migration_controls WHERE business_id=?', [targetId]);
  assert.equal(gate[0].state, 'COMPLETE');
  console.log('Continuacion real aislada (ms): ' + JSON.stringify({ total: elapsed(started), v2Preview: previewMs, v2Archive: archiveMs, v2Operations: operationsMs, versions: batches.map(row => Number(row.version)), status: operationsV2.reconciliation.migrationState, importedOrders: Number(tableCounts[0].saleOrders), unavailablePriceLines: 2, differences: operationsV2.reconciliation.differences.length, activation: activation.status }));
});
