'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { readConfig } = require('../../src/config/environment');
const { readAuthConfig } = require('../../src/config/auth');
const { createDatabasePool } = require('../../src/config/database');
const { createAuthRepository, rows } = require('../../src/repositories/auth');
const { createSystemAdminService } = require('../../src/services/system-admin');

const database = process.env.POS_INTEGRATION_DATABASE;
if (!/^pos_auth_test_[a-f0-9]{24}$/.test(database || '') || database === process.env.DB_NAME) throw new Error('Use the isolated MySQL runner');

function packageFixture({ sourceId = 'local-archive-01', productCount = 1 } = {}) {
  const value = {
    type: 'pos_local_migration_package', version: 2, exportedAt: '2026-10-21T15:00:00.000Z',
    source: { mode: 'local', scope: { idSource: 'config', localBusinessId: sourceId, idsFound: 1, legacyRecords: 0, excludedRecords: 0, missingStores: [] } },
    business: { name: 'Archivo local de prueba', localBusinessId: sourceId },
    data: {
      products: Array.from({ length: productCount }, (_, index) => ({ id: 'product-' + index, name: 'Producto ' + index, barcode: '000' + index, stock: '1.250', cost: '4.25', retailPrice: '8.50', marginRetail: '100.0000', image: 'data:image/png;base64,iVBORw0KGgo=' })),
      clients: [{ id: 'client-1', name: 'Cliente de prueba', creditLimit: '100.00', openingBalance: '0.00' }],
      suppliers: [{ id: 'supplier-1', name: 'Proveedor de prueba' }],
      sales: [{ id: 'sale-1', invoiceNumber: 'V-014', fechaTS: '2020-01-02T03:04:05.000Z', total: '17.00', discount: '1.00', paymentMethod: 'TRANSFER', items: [{ productId: 'product-0', quantity: '2.000', unitPrice: '8.50' }], status: 'CANCELLED', cancelledAt: '2020-01-03T00:00:00.000Z', cancelReason: 'Corrección histórica', usuario: 'Ana' }],
      purchases: [{ id: 'purchase-1', invoice: 'F-020', date: '2019-12-01', dueDate: '2020-01-01', total: '8.50', discount: '0.50', status: 'CANCELLED', cancelledAt: '2020-01-02T00:00:00.000Z', cancelledBy: 'Luis', items: [{ productId: 'product-0', quantity: '2.000', unitCost: '4.25' }] }],
      cashSessions: [{ id: 'cash-1', status: 'CLOSED', openingAmount: '20.00', openedAt: '2019-12-01T08:00:00.000Z', closedAt: '2019-12-01T18:00:00.000Z', openedBy: 'Ana', closedBy: 'Luis', countedAmounts: { cash: '29.00', card: '5.00', transfer: '2.00' }, movimientos: [{ id: 'cash-movement-1', type: 'EXPENSE', amount: '3.00', paymentMethod: 'CASH', createdAt: '2019-12-01T10:00:00.000Z', usuario: 'Ana' }] }],
      inventoryMovements: [{ id: 'movement-1', producto_id: 'product-0', tipo: 'AJUSTE', cantidad: '-1.250', stock_anterior: '2.500', stock_nuevo: '1.250', costo: '4.25', fechaTS: '2019-11-30T11:00:00.000Z', motivo: 'Conteo', usuario: 'Ana' }],
      abonos: [{ id: 'payment-1', tipo: 'proveedor', facturaId: 'purchase-1', referenciaId: 'supplier-1', monto: '3.17', metodoPago: 'transferencia', estado: 'pendiente', fechaTS: '2020-01-04T13:00:00.000Z', usuario: 'Ana' }],
      expenses: [{ id: 'expense-1', monto: '5.25', category: 'Servicios', concepto: 'Internet', paymentMethod: 'CARD', fechaTS: '2020-01-05T11:00:00.000Z', usuario: 'Ana', anulada: true, motivoAnulacion: 'Duplicado' }],
      auditLogs: [{ id: 'audit-1', usuario: 'Ana', accion: 'ANULAR_VENTA' }],
      saleOrders: [{ id: 'order-1', status: 'PENDING', estimatedTotal: '10.00', createdAt: '2020-02-01T10:00:00.000Z', items: [{ productId: 'product-0', quantity: 1 }] }],
      syncQueue: [{ id: 'queue-1', operation: 'INSERT', store: 'sales', createdAt: '2020-02-02T10:00:00.000Z', data: '{"password":"local-secret","sale":{"id":"not-replayed"}}' }],
      configuration: { name: 'Archivo local de prueba', legalName: 'Comercial Prueba S.A.', ruc: 'J0310000000000', address: 'Managua', phone: '5550101', currency: 'C$', header: 'Gracias', footer: 'Vuelva pronto', logo: 'data:image/png;base64,iVBORw0KGgo=' }, categories: ['General']
    }
  };
  for (const key of ['products', 'clients', 'suppliers', 'sales', 'purchases', 'cashSessions', 'inventoryMovements', 'abonos', 'expenses', 'auditLogs', 'saleOrders', 'syncQueue']) {
    value.data[key] = value.data[key].map(row => ({ ...row, business_id: sourceId }));
  }
  return value;
}

async function createMigrationTarget(pool, name) {
  const [business] = await pool.execute("INSERT INTO businesses (name,status) VALUES (?,'INACTIVE')", [name]);
  const id = String(business.insertId);
  await pool.execute("INSERT INTO business_migration_controls (business_id,state,actor_business_id,actor_user_id) VALUES (?,'PENDING','1','1')", [id]);
  return id;
}

test('full source archive is idempotent, tenant-scoped, and does not create operational commerce rows', async t => {
  const config = readConfig();
  const pool = createDatabasePool({ ...config.database, database, connectionLimit: 8 });
  t.after(() => pool.end());
  const target = await createMigrationTarget(pool, 'Archivo local de prueba');
  const other = String((await rows(pool, 'INSERT INTO businesses (name) VALUES (?)', ['Archivo destino B'])) .insertId);
  const repo = createAuthRepository(pool, readAuthConfig({ CSRF_SECRET: 'f'.repeat(64) }));
  const service = createSystemAdminService(repo);
  const admin = { username: 'andres', role: 'ADMIN', business_id: '1', user_id: '1' };
  const fixture = packageFixture();

  await assert.rejects(service.previewFullMigration(admin, other, fixture), error => error.publicCode === 'MIGRATION_TARGET_REQUIRED');

  const preview = await service.previewFullMigration(admin, target, fixture);
  assert.equal(preview.eligibleToArchive, true);
  assert.equal(preview.identityReview.counts.confirmed, 12);
  assert.equal(preview.recordsExpected, 14);
  const saved = await service.archiveFullMigration(admin, target, fixture, true);
  assert.equal(saved.status, 'BLOCKED');
  assert.equal(saved.recordsArchived, 14);
  assert.equal(saved.pendingRecords, 1);

  const retry = await service.archiveFullMigration(admin, target, fixture, true);
  assert.equal(retry.batchId, saved.batchId);
  const [auditEvents] = await pool.execute("SELECT COUNT(*) AS count FROM audit_logs WHERE business_id=? AND entity='migration_import_batches' AND entity_id=?", [target, saved.batchId]);
  assert.equal(Number(auditEvents[0].count), 3);
  const state = await service.migrationBatchStatus(admin, target, saved.batchId);
  assert.equal(state.batch.status, 'BLOCKED');
  assert.equal(state.records.products.ARCHIVED, 1);
  assert.equal(state.records.saleOrders.ARCHIVED, 1);
  assert.equal(state.records.expenses.ARCHIVED, 1);
  assert.equal(state.records.syncQueue.PENDING, 1);

  const [commercial] = await pool.execute('SELECT (SELECT COUNT(*) FROM sales WHERE business_id=?) AS sales,(SELECT COUNT(*) FROM purchases WHERE business_id=?) AS purchases,(SELECT COUNT(*) FROM cash_sessions WHERE business_id=?) AS cashSessions,(SELECT COUNT(*) FROM inventory_movements WHERE business_id=?) AS inventoryMovements,(SELECT COUNT(*) FROM expenses WHERE business_id=?) AS expenses', [target, target, target, target, target]);
  assert.deepEqual(Object.values(commercial[0]).map(Number), [0, 0, 0, 0, 0]);
  await assert.rejects(service.migrationBatchStatus(admin, other, saved.batchId), error => error.publicCode === 'MIGRATION_BATCH_NOT_FOUND');
  await assert.rejects(service.previewFullMigration(admin, target, { ...fixture, data: { ...fixture.data, expenses: [{ id: 'changed', amount: 99 }] } }), error => error.publicCode === 'MIGRATION_PACKAGE_CHANGED');
  const records = await service.migrationBatchRecords(admin, target, saved.batchId, { offset: 0, limit: 250 });
  assert.equal(records.records.length, 14);
  assert.equal(records.records.find(row => row.entityType === 'expenses').payload.usuario, 'Ana');
  const archived = Object.fromEntries(records.records.map(row => [row.entityType, row]));
  assert.equal(archived.products.payload.stock, '1.250');
  assert.equal(archived.products.payload.image, 'data:image/png;base64,iVBORw0KGgo=');
  assert.equal(archived.sales.payload.total, '17.00');
  assert.equal(archived.sales.payload.status, 'CANCELLED');
  assert.equal(archived.sales.payload.items[0].productId, 'product-0');
  assert.equal(archived.purchases.payload.cancelledBy, 'Luis');
  assert.equal(archived.inventoryMovements.payload.stock_nuevo, '1.250');
  assert.equal(archived.abonos.payload.monto, '3.17');
  assert.equal(archived.cashSessions.payload.movimientos[0].createdAt, '2019-12-01T10:00:00.000Z');
  assert.equal(archived.saleOrders.payload.status, 'PENDING');
  assert.equal(archived.syncQueue.recordStatus, 'PENDING');
  assert.equal(archived.syncQueue.payload.data.includes('local-secret'), false);
  assert.equal(archived.configuration.payload.logo, 'data:image/png;base64,iVBORw0KGgo=');

  await assert.rejects(service.setBusinessStatus(admin, target, 'ACTIVE'), error => error.publicCode === 'MIGRATION_RECONCILIATION_REQUIRED');
  const mixed = packageFixture({ sourceId: 'local-archive-mixed' });
  mixed.source.scope.excludedRecords = 1;
  await assert.rejects(service.archiveFullMigration(admin, target, mixed, true), error => error.publicCode === 'MIGRATION_SOURCE_SCOPE_REQUIRED');
  const foreign = packageFixture({ sourceId: 'local-archive-foreign' });
  foreign.data.products[0].business_id = 'another-business';
  await assert.rejects(service.archiveFullMigration(admin, target, foreign, true), error => error.publicCode === 'MIGRATION_SOURCE_SCOPE_REQUIRED');

  const wrongNameTarget = await createMigrationTarget(pool, 'Otro negocio');
  const wrongNamePreview = await service.previewFullMigration(admin, wrongNameTarget, fixture);
  assert.equal(wrongNamePreview.eligibleToArchive, true);
  assert.ok(wrongNamePreview.blockers.some(message => message.includes('difiere del destino')));
  const nameDifferenceArchive = await service.archiveFullMigration(admin, wrongNameTarget, fixture, true);
  assert.equal(nameDifferenceArchive.status, 'BLOCKED');
  const nameDifferenceStatus = await service.migrationBatchStatus(admin, wrongNameTarget, nameDifferenceArchive.batchId);
  assert.equal(nameDifferenceStatus.batch.manifest.identityReview.sourceEvidence.nameMatches, false);
});

test('admin package confirmation authorizes only shared identity rows for the exact file and target', async t => {
  const config = readConfig();
  const pool = createDatabasePool({ ...config.database, database, connectionLimit: 8 });
  t.after(() => pool.end());
  const target = await createMigrationTarget(pool, 'Archivo antiguo de prueba');
  const repo = createAuthRepository(pool, readAuthConfig({ CSRF_SECRET: 'd'.repeat(64) }));
  const service = createSystemAdminService(repo);
  const admin = { username: 'andres', role: 'ADMIN', business_id: '1', user_id: '1' };
  const fixture = packageFixture({ sourceId: 'legacy-source-02' });
  fixture.business.name = 'Archivo antiguo de prueba';
  fixture.data.products[0].business_id = '00000000-0000-0000-0000-000000000000';
  fixture.data.clients[0].business_id = '00000000-0000-0000-0000-000000000000';
  fixture.source.scope.legacyRecords = 0;

  const preview = await service.previewFullMigration(admin, target, fixture);
  assert.equal(preview.eligibleToArchive, true);
  assert.equal(preview.legacyIdentityConfirmationRequired, true);
  assert.equal(preview.bulkIdentityEligibleRecords, 2);
  assert.equal(preview.identityReview.counts.sharedId, 2);
  await assert.rejects(service.archiveFullMigration(admin, target, fixture, false), error => error.publicCode === 'MIGRATION_ARCHIVE_CONFIRMATION_REQUIRED');

  const saved = await service.archiveFullMigration(admin, target, fixture, true);
  assert.equal(saved.status, 'BLOCKED');
  assert.equal(saved.identityConfirmation.confirmed, true);
  assert.equal(saved.identityConfirmation.targetBusinessId, target);
  assert.equal(saved.identityConfirmation.packageSha256, preview.packageSha256);
  assert.equal(saved.identityConfirmation.adminIdentity.userId, '1');
  assert.match(saved.identityConfirmation.confirmedAt, /^20\d\d-/);
  assert.equal(saved.identityConfirmation.identityResolvedRecords, 2);
  assert.equal(saved.identityConfirmationApplied, 2);
  const state = await service.migrationBatchStatus(admin, target, saved.batchId);
  assert.equal(state.batch.manifest.identityReview.batchConfirmation.packageSha256, preview.packageSha256);
  assert.equal(state.records.products.ARCHIVED, 1);
  assert.equal(state.records.clients.ARCHIVED, 1);
  assert.ok(state.records.syncQueue.PENDING > 0);
  const [sourceRows] = await pool.execute('SELECT entity_type AS entity,record_status AS status,source_payload AS payload FROM migration_source_records WHERE business_id=? AND batch_id=? AND entity_type IN (\'products\',\'clients\') ORDER BY entity_type', [target, saved.batchId]);
  assert.deepEqual(sourceRows.map(row => row.status), ['ARCHIVED', 'ARCHIVED']);
  assert.ok(sourceRows.every(row => (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload).business_id === '00000000-0000-0000-0000-000000000000'));
  const [audit] = await pool.execute("SELECT details FROM audit_logs WHERE business_id=? AND action='LOCAL_MIGRATION_PACKAGE_AUTHORIZED'", [target]);
  assert.equal(audit.length, 1);
  const auditDetails = typeof audit[0].details === 'string' ? JSON.parse(audit[0].details) : audit[0].details;
  assert.equal(auditDetails.packageSha256, preview.packageSha256);
  await assert.rejects(service.setBusinessStatus(admin, target, 'ACTIVE'), error => error.publicCode === 'MIGRATION_RECONCILIATION_REQUIRED');

  const changed = structuredClone(fixture);
  changed.data.products[0].name += ' cambiado';
  await assert.rejects(service.archiveFullMigration(admin, target, changed, true), error => error.publicCode === 'MIGRATION_PACKAGE_CHANGED');
  const otherTarget = await createMigrationTarget(pool, 'Otro destino de prueba');
  await assert.rejects(service.archiveFullMigration(admin, otherTarget, fixture, false), error => error.publicCode === 'MIGRATION_ARCHIVE_CONFIRMATION_REQUIRED');
});

test('package confirmation keeps duplicate identifiers and broken references pending', async t => {
  const config = readConfig();
  const pool = createDatabasePool({ ...config.database, database, connectionLimit: 8 });
  t.after(() => pool.end());
  const target = await createMigrationTarget(pool, 'Archivo con alertas');
  const repo = createAuthRepository(pool, readAuthConfig({ CSRF_SECRET: 'e'.repeat(64) }));
  const service = createSystemAdminService(repo);
  const admin = { username: 'andres', role: 'ADMIN', business_id: '1', user_id: '1' };
  const fixture = packageFixture({ sourceId: 'legacy-source-03' });
  fixture.data.products[0].business_id = '00000000-0000-0000-0000-000000000000';
  fixture.data.products.push({ ...fixture.data.products[0], name: 'Producto duplicado' });
  fixture.data.sales[0].items = [{ productId: 'product-does-not-exist', quantity: '1.000' }];
  const saved = await service.archiveFullMigration(admin, target, fixture, true);
  assert.equal(saved.identityConfirmationApplied, 2);
  assert.equal(saved.identityConfirmedImportableRecords, 0);
  assert.ok(saved.pendingRecords >= 3);
  const [rows] = await pool.execute('SELECT entity_type AS entity,record_status AS status,pending_reason AS reason FROM migration_source_records WHERE business_id=? AND batch_id=? AND entity_type IN (\'products\',\'sales\') ORDER BY entity_type,source_record_key', [target, saved.batchId]);
  assert.equal(rows.filter(row => row.entity === 'products').length, 2);
  const duplicateRows = rows.filter(row => row.entity === 'products');
  assert.ok(duplicateRows.every(row => row.status === 'PENDING' && /DUPLICATE_LOCAL_ID/.test(row.reason)), 'las dos filas deben seguir pendientes por tener referencias repetidas');
  assert.ok(rows.filter(row => row.entity === 'sales').every(row => row.status === 'PENDING' && /INCONSISTENT_REFERENCES/.test(row.reason)));
  const [business] = await pool.execute("SELECT state FROM business_migration_controls WHERE business_id=?", [target]);
  assert.equal(business[0].state, 'PENDING');
});

test('an administrator can resolve a specific identity row with an explicit checkbox only', async t => {
  const config = readConfig();
  const pool = createDatabasePool({ ...config.database, database, connectionLimit: 8 });
  t.after(() => pool.end());
  const target = await createMigrationTarget(pool, 'Revisión explícita de identidad');
  const repo = createAuthRepository(pool, readAuthConfig({ CSRF_SECRET: '7'.repeat(64) }));
  const service = createSystemAdminService(repo);
  const admin = { username: 'andres', role: 'ADMIN', business_id: '1', user_id: '1' };
  const fixture = packageFixture({ sourceId: 'local-review-confirmation' });
  delete fixture.data.products[0].business_id;
  const saved = await service.archiveFullMigration(admin, target, fixture, true);
  assert.equal(saved.status, 'BLOCKED');
  await assert.rejects(service.reviewMigrationIdentityRecord(admin, target, saved.batchId, 'products', 'id:product-0', 'INCLUDE', false), error => error.publicCode === 'MIGRATION_IDENTITY_CONFIRMATION_REQUIRED');
  const reviewed = await service.reviewMigrationIdentityRecord(admin, target, saved.batchId, 'products', 'id:product-0', 'INCLUDE', true);
  assert.equal(reviewed.recordStatus, 'ARCHIVED');
  const [audit] = await pool.execute("SELECT details FROM audit_logs WHERE business_id=? AND action='LOCAL_MIGRATION_IDENTITY_REVIEW'", [target]);
  assert.equal(audit.length, 1);
  const details = typeof audit[0].details === 'string' ? JSON.parse(audit[0].details) : audit[0].details;
  assert.equal(details.attestBelongsToSource, true);
  assert.equal(details.operatorUserId, '1');
  assert.ok(details.reviewedAt);
});

test('archive resumes an interrupted multi-chunk batch without duplicate records', async t => {
  const config = readConfig();
  const pool = createDatabasePool({ ...config.database, database, connectionLimit: 8 });
  t.after(() => pool.end());
  const target = await createMigrationTarget(pool, 'Archivo local de prueba');
  const baseRepo = createAuthRepository(pool, readAuthConfig({ CSRF_SECRET: 'e'.repeat(64) }));
  let insertionCount = 0, failOnce = true;
  const flakyRepo = {
    ...baseRepo,
    rows: async (db, sql, values) => {
      if (failOnce && /^INSERT INTO migration_source_records/i.test(sql)) {
        insertionCount++;
        if (insertionCount === 101) { failOnce = false; throw new Error('simulated interruption'); }
      }
      return baseRepo.rows(db, sql, values);
    }
  };
  const service = createSystemAdminService(flakyRepo);
  const admin = { username: 'andres', role: 'ADMIN', business_id: '1', user_id: '1' };
  const fixture = packageFixture({ sourceId: 'local-archive-resume', productCount: 101 });
  await assert.rejects(service.archiveFullMigration(admin, target, fixture, true), /simulated interruption/);
  const [partial] = await pool.execute('SELECT id,status FROM migration_import_batches WHERE business_id=?', [target]);
  assert.equal(partial.length, 1);
  assert.equal(partial[0].status, 'ARCHIVING');
  const [firstChunk] = await pool.execute('SELECT COUNT(*) AS count FROM migration_source_records WHERE business_id=?', [target]);
  assert.equal(Number(firstChunk[0].count), 100);

  const resumed = await service.archiveFullMigration(admin, target, fixture, true);
  assert.equal(resumed.status, 'BLOCKED');
  assert.equal(resumed.recordsArchived, 114);
  const [after] = await pool.execute('SELECT COUNT(*) AS count FROM migration_source_records WHERE business_id=?', [target]);
  assert.equal(Number(after[0].count), 114);
});

test('optional real client package confirms all shared-ID rows once and remains blocked when the export is incomplete', { skip: !process.env.POS_MIGRATION_REVIEW_FILE }, async t => {
  const config = readConfig();
  const pool = createDatabasePool({ ...config.database, database, connectionLimit: 8 });
  t.after(() => pool.end());
  const filePath = process.env.POS_MIGRATION_REVIEW_FILE;
  const raw = fs.readFileSync(filePath);
  const originalFileHash = createHash('sha256').update(raw).digest('hex');
  const packageValue = JSON.parse(raw.toString('utf8'));
  const target = await createMigrationTarget(pool, 'Real package temporary target');
  const repo = createAuthRepository(pool, readAuthConfig({ CSRF_SECRET: 'a'.repeat(64) }));
  const service = createSystemAdminService(repo);
  const admin = { username: 'andres', role: 'ADMIN', business_id: '1', user_id: '1' };
  const preview = await service.previewFullMigration(admin, target, packageValue);
  assert.equal(preview.packageVersion, 1);
  assert.equal(preview.identityReview.counts.sharedId, 127);
  assert.equal(preview.bulkIdentityEligibleRecords, 127);
  assert.equal(preview.legacyIdentityConfirmationRequired, true);
  for (const store of ['expenses', 'auditLogs', 'saleOrders', 'syncQueue']) assert.ok(preview.missingStores.includes(store));
  const saved = await service.archiveFullMigration(admin, target, packageValue, true);
  assert.equal(saved.identityConfirmationApplied, 127);
  assert.equal(saved.identityConfirmedImportableRecords, 127);
  assert.equal(saved.status, 'BLOCKED');
  assert.ok(saved.blockers.length > 0);
  assert.equal(saved.packageSha256, preview.packageSha256);
  const firstConfirmationTime = saved.identityConfirmation.confirmedAt;
  const retry = await service.archiveFullMigration(admin, target, packageValue, true);
  assert.equal(retry.batchId, saved.batchId);
  assert.equal(retry.recordsArchived, saved.recordsArchived);
  assert.equal(retry.identityConfirmation.confirmedAt, firstConfirmationTime);
  const [records] = await pool.execute('SELECT COUNT(*) AS total,SUM(record_status=\'PENDING\') AS pending,SUM(record_status=\'ARCHIVED\') AS archived FROM migration_source_records WHERE business_id=? AND batch_id=?', [target, saved.batchId]);
  assert.equal(Number(records[0].total), preview.recordsExpected);
  assert.equal(Number(records[0].pending || 0), 0);
  assert.equal(Number(records[0].archived), preview.recordsExpected);
  const [audit] = await pool.execute("SELECT COUNT(*) AS count FROM audit_logs WHERE business_id=? AND action='LOCAL_MIGRATION_PACKAGE_AUTHORIZED'", [target]);
  assert.equal(Number(audit[0].count), 1);
  await assert.rejects(service.setBusinessStatus(admin, target, 'ACTIVE'), error => error.publicCode === 'MIGRATION_RECONCILIATION_REQUIRED');
  const [state] = await pool.execute('SELECT b.status,c.state FROM businesses b JOIN business_migration_controls c ON c.business_id=b.id WHERE b.id=?', [target]);
  assert.deepEqual([state[0].status, state[0].state], ['INACTIVE', 'PENDING']);
  assert.equal(createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'), originalFileHash);
});
