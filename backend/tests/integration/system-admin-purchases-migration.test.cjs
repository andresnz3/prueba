'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { readConfig } = require('../../src/config/environment');
const { readAuthConfig } = require('../../src/config/auth');
const { createDatabasePool } = require('../../src/config/database');
const { createAuthRepository, rows } = require('../../src/repositories/auth');
const { createSystemAdminService } = require('../../src/services/system-admin');
const { createProcurementService } = require('../../src/services/procurement');
const { createConnectedReportService } = require('../../src/services/connected-reports');

const database = process.env.POS_INTEGRATION_DATABASE;
if (!/^pos_auth_test_[a-f0-9]{24}$/.test(database || '') || database === process.env.DB_NAME) throw new Error('Usar el ejecutor MySQL aislado');

function purchase(id, invoice, timestamp, quantity, total, overrides = {}) {
  const subtotal = quantity * 4.25;
  return {
    id, fechaTS: timestamp, factura: invoice, tipo: 'contado', proveedorId: 9,
    proveedor: 'Distribuidora Norte', subtotal, total, anulada: false,
    items: [{ productId: 104, producto: 'Arroz histórico', cantidad: quantity, costo: 4.25, subtotal, total }],
    ...overrides
  };
}

test('MySQL importa compras historicas una sola vez y no altera inventario, caja, pagos ni CxP', async t => {
  const config = readConfig();
  const authConfig = readAuthConfig({ CSRF_SECRET: randomBytes(32).toString('hex'), AUTH_RATE_MAX: '100' });
  const pool = createDatabasePool({ ...config.database, database, connectionLimit: 20 });
  t.after(() => pool.end());

  const targetBusiness = String((await rows(pool, 'INSERT INTO businesses (name) VALUES (?)', ['Destino compras historicas aislado'])).insertId);
  const targetUser = String((await rows(pool,
    'INSERT INTO users (business_id, username, full_name, password_hash, role) VALUES (?, ?, ?, ?, ?)',
    [targetBusiness, 'compra-historica', 'Usuario migracion', 'hash-de-prueba', 'ADMIN'])).insertId);
  const repo = createAuthRepository(pool, authConfig);
  const service = createSystemAdminService(repo);
  const systemAdmin = { username: 'andres', role: 'ADMIN', business_id: '1', user_id: '7' };
  const sourcePackage = {
    type: 'pos_local_migration_package', version: 1, exportedAt: '2026-10-14T12:00:00.000Z',
    business: { id: 'local-business-7', name: 'Bodega Local' },
    data: {
      products: [{ id: 104, barcode: 'MIG-PURCHASE-1', name: 'Arroz histórico', category: 'Abarrotes', cost: '4.25', stock: '5.000' }],
      clients: [], suppliers: [{ id: 9, name: 'Distribuidora Norte' }],
      purchases: [
        purchase(501, 'FC-501', 1750000000000, 2, 8.20, { subtotal: 8.50, descuentoMonto: 0.50, tax: 0.20, total: 8.20, observaciones: 'Descuento histórico' }),
        purchase(501.25, 'FC-502', 1750086400000, 1, 4.25, { tipo: 'crédito', vencimientoTS: '', vencimiento: '6/11/2026' }),
        purchase(503, 'FC-503', 1750172800000, 1, 4.25, { tipo: 'crédito', vencimientoTS: '', vencimiento: '8/11/2026' }),
        purchase(504, 'FC-504', 1750259200000, 2, 8.50),
        purchase(505, 'FC-505', 1750345600000, 1, 4.25, { anulada: true })
      ]
    }
  };

  await assert.rejects(service.previewPurchasesMigration({ ...systemAdmin, username: 'no-autorizado' }, targetBusiness, sourcePackage), { publicCode: 'SYSTEM_ADMIN_REQUIRED' });
  const gatePreview = await service.previewPurchasesMigration(systemAdmin, targetBusiness, sourcePackage);
  assert.equal(gatePreview.purchases.detected, 5);
  assert.equal(gatePreview.eligible, false);
  assert.equal(gatePreview.gates.basic, false);

  await service.migrateBasic(systemAdmin, targetBusiness, sourcePackage, false);
  const [sourceProduct] = await rows(pool, 'SELECT id FROM products WHERE business_id=? AND barcode=?', [targetBusiness, 'MIG-PURCHASE-1']);
  const [sourceSupplier] = await rows(pool, 'SELECT id FROM suppliers WHERE business_id=? AND name=?', [targetBusiness, 'Distribuidora Norte']);
  assert.ok(sourceProduct);
  assert.ok(sourceSupplier);
  await rows(pool, 'UPDATE products SET stock=?,cost=?,retail_price=?,wholesale_price=? WHERE business_id=? AND id=?', ['17.000', '19.00', '29.00', '24.00', targetBusiness, sourceProduct.id]);

  const ordinaryPurchase = await rows(pool,
    'INSERT INTO purchases (business_id,user_id,supplier_id,supplier_name,invoice_number,purchase_type,subtotal,tax,total,due_at,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))',
    [targetBusiness, targetUser, sourceSupplier.id, 'Distribuidora Norte', 'OPER-01', 'CREDIT', '30.00', '0.00', '30.00', '2026-11-14 12:00:00.000', 'COMPLETED']);
  await rows(pool,
    'INSERT INTO purchase_items (business_id,purchase_id,product_id,product_name,quantity,unit_cost,subtotal,discount,tax,total) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [targetBusiness, ordinaryPurchase.insertId, sourceProduct.id, 'Arroz histórico', '1.000', '30.00', '30.00', '0.00', '0.00', '30.00']);
  await rows(pool,
    'INSERT INTO cash_sessions (business_id,opened_by,opening_amount,status) VALUES (?,?,?,\'OPEN\')',
    [targetBusiness, targetUser, '125.00']);

  const earlierPackage = structuredClone(sourcePackage);
  earlierPackage.data.purchases = sourcePackage.data.purchases.slice(0, 2);
  const earlierImport = await service.migratePurchases(systemAdmin, targetBusiness, earlierPackage);
  assert.deepEqual(earlierImport.created, { purchases: 2 });
  assert.deepEqual(earlierImport.skipped, { purchases: 0 });

  const conflictPackage = structuredClone(sourcePackage);
  conflictPackage.data.purchases[2].factura = 'OPER-01';
  const conflictPreview = await service.previewPurchasesMigration(systemAdmin, targetBusiness, conflictPackage);
  assert.equal(conflictPreview.purchases.detected, 5);
  assert.equal(conflictPreview.purchases.couldMigrate, 2);
  assert.equal(conflictPreview.purchases.toSkip, 3);
  assert.equal(conflictPreview.diagnostics.duplicateInvoices, 1);

  const preview = await service.previewPurchasesMigration(systemAdmin, targetBusiness, sourcePackage);
  assert.equal(preview.eligible, true);
  assert.deepEqual(preview.gates, { basic: true, schema: true, targetUser: true });
  assert.deepEqual(preview.purchases, { detected: 5, couldMigrate: 3, toSkip: 2 });
  assert.equal(preview.diagnostics.duplicateInvoices, 0);
  assert.equal(preview.warnings.filter(warning => warning.includes('ya migrada')).length, 2);

  const failedRepo = {
    ...repo,
    rows: async (db, sql, values) => {
      if (sql.startsWith('INSERT INTO migration_purchase_references')) throw new Error('forced purchase migration rollback');
      return repo.rows(db, sql, values);
    }
  };
  const failedService = createSystemAdminService(failedRepo);
  await assert.rejects(failedService.migratePurchases(systemAdmin, targetBusiness, sourcePackage), /forced purchase migration rollback/);
  const [referencesAfterFailure] = await rows(pool, 'SELECT COUNT(*) AS count FROM migration_purchase_references WHERE business_id=?', [targetBusiness]);
  const [auditsAfterFailure] = await rows(pool, "SELECT COUNT(*) AS count FROM audit_logs WHERE business_id=? AND action='MIGRATION_PURCHASES_IMPORT'", [targetBusiness]);
  assert.equal(Number(referencesAfterFailure.count), 2, 'las referencias iniciales se conservan y las fallidas se revierten');
  assert.equal(Number(auditsAfterFailure.count), 1, 'la auditoria inicial se conserva y la fallida se revierte');
  const [afterFailedPurchases] = await rows(pool, 'SELECT COUNT(*) AS count FROM purchases WHERE business_id=?', [targetBusiness]);
  const [afterFailedItems] = await rows(pool, 'SELECT COUNT(*) AS count FROM purchase_items WHERE business_id=?', [targetBusiness]);
  assert.equal(Number(afterFailedPurchases.count), 3);
  assert.equal(Number(afterFailedItems.count), 3);

  const sessionTokenHash = randomBytes(32).toString('hex');
  const sessionInsert = await rows(pool,
    'INSERT INTO sessions (business_id,user_id,token_hash,expires_at) VALUES (?,?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 DAY))',
    [targetBusiness, targetUser, sessionTokenHash]);
  const session = { business_id: targetBusiness, session_id: String(sessionInsert.insertId), token_hash: sessionTokenHash, user_id: targetUser, username: 'compra-historica', role: 'ADMIN' };
  const connectedAuth = { canAccess: async () => true };
  const connectedConfig = { absoluteSeconds: 28800 };
  const procurement = createProcurementService({ repo, auth: connectedAuth, config: connectedConfig });
  const reports = createConnectedReportService({ repo, auth: connectedAuth, config: connectedConfig });
  const beforePayables = await procurement.payablesSummary(session);
  const beforeSupplier = await procurement.getSupplier(session, String(sourceSupplier.id));
  const beforeCash = await rows(pool, 'SELECT id,opening_amount,status FROM cash_sessions WHERE business_id=?', [targetBusiness]);
  const beforeOperations = {};
  for (const table of ['inventory_movements', 'cash_movements', 'supplier_payments']) {
    const [count] = await rows(pool, 'SELECT COUNT(*) AS count FROM ' + table + ' WHERE business_id=?', [targetBusiness]);
    beforeOperations[table] = Number(count.count);
  }

  const migrated = await service.migratePurchases(systemAdmin, targetBusiness, sourcePackage);
  assert.deepEqual(migrated.created, { purchases: 3 });
  assert.deepEqual(migrated.skipped, { purchases: 2 });
  const purchases = await rows(pool,
    'SELECT id,invoice_number,purchase_type,status,subtotal,discount,tax,total,due_at,created_at,is_historical,notes FROM purchases WHERE business_id=? ORDER BY created_at,id',
    [targetBusiness]);
  const history = purchases.filter(row => Boolean(row.is_historical));
  assert.equal(history.length, 5);
  assert.deepEqual(history.map(row => row.invoice_number), ['FC-501', 'FC-502', 'FC-503', 'FC-504', 'FC-505']);
  assert.deepEqual(history.map(row => row.total), ['8.20', '4.25', '4.25', '8.50', '4.25']);
  assert.equal(history[0].subtotal, '8.50');
  assert.equal(history[0].discount, '0.50');
  assert.equal(history[0].tax, '0.20');
  assert.equal(history[0].notes, 'Descuento histórico');
  assert.equal(history[0].status, 'COMPLETED');
  assert.equal(history[1].purchase_type, 'CREDIT');
  assert.equal(history[1].due_at.toISOString().slice(0, 10), '2026-11-06');
  assert.equal(history[2].due_at.toISOString().slice(0, 10), '2026-11-08');
  assert.equal(history[4].status, 'CANCELLED');
  assert.deepEqual(history.map(row => row.created_at.toISOString().slice(0, 23)), [
    new Date(1750000000000).toISOString().slice(0, 23), new Date(1750086400000).toISOString().slice(0, 23),
    new Date(1750172800000).toISOString().slice(0, 23), new Date(1750259200000).toISOString().slice(0, 23),
    new Date(1750345600000).toISOString().slice(0, 23)
  ]);
  const itemRows = await rows(pool, 'SELECT i.product_id,i.quantity,i.unit_cost,i.subtotal,i.discount,i.tax,i.total FROM purchase_items i JOIN purchases p ON p.business_id=i.business_id AND p.id=i.purchase_id WHERE i.business_id=? AND p.is_historical=TRUE ORDER BY i.purchase_id', [targetBusiness]);
  assert.equal(itemRows.length, 5);
  assert.ok(itemRows.every(item => String(item.product_id) === String(sourceProduct.id)));
  assert.ok(itemRows.every(item => item.unit_cost === '4.25'));
  assert.deepEqual([itemRows[0].quantity, itemRows[0].subtotal, itemRows[0].discount, itemRows[0].tax, itemRows[0].total], ['2.000', '8.50', '0.50', '0.20', '8.20']);

  const retried = await service.migratePurchases(systemAdmin, targetBusiness, { ...structuredClone(sourcePackage), data: { ...sourcePackage.data, purchases: [...sourcePackage.data.purchases].reverse() } });
  assert.deepEqual(retried.created, { purchases: 0 });
  assert.deepEqual(retried.skipped, { purchases: 5 });
  const [referenceCount] = await rows(pool, 'SELECT COUNT(*) AS count FROM migration_purchase_references WHERE business_id=?', [targetBusiness]);
  assert.equal(Number(referenceCount.count), 5);

  const [productAfter] = await rows(pool, 'SELECT stock,cost,retail_price,wholesale_price FROM products WHERE business_id=? AND id=?', [targetBusiness, sourceProduct.id]);
  assert.deepEqual(productAfter, { stock: '17.000', cost: '19.00', retail_price: '29.00', wholesale_price: '24.00' });
  const afterCash = await rows(pool, 'SELECT id,opening_amount,status FROM cash_sessions WHERE business_id=?', [targetBusiness]);
  assert.deepEqual(afterCash, beforeCash);
  for (const [table, count] of Object.entries(beforeOperations)) {
    const [after] = await rows(pool, 'SELECT COUNT(*) AS count FROM ' + table + ' WHERE business_id=?', [targetBusiness]);
    assert.equal(Number(after.count), count, table + ' no debe cambiar en una importacion historica');
  }

  const afterPayables = await procurement.payablesSummary(session);
  const afterSupplier = await procurement.getSupplier(session, String(sourceSupplier.id));
  assert.deepEqual(afterPayables, beforePayables);
  assert.equal(afterPayables.balance, '30.00');
  assert.equal(afterSupplier.debt, beforeSupplier.debt);
  assert.equal(afterSupplier.debt, '30.00');
  const visiblePayables = await procurement.listPayables(session, { q: null, limit: 100, offset: 0 });
  assert.equal(visiblePayables.length, 1);
  const supplierStatement = await procurement.statement(session, String(sourceSupplier.id), { limit: 100, offset: 0 });
  const historicalEntry = supplierStatement.entries.find(row => row.isHistorical && row.purchaseType === 'CREDIT');
  assert.ok(historicalEntry);
  assert.equal(historicalEntry.charge, '0.00');
  assert.equal(historicalEntry.balance, '0.00');
  assert.equal(historicalEntry.runningBalance, '0.00', 'una factura historica no debe aumentar el saldo operativo acumulado');
  assert.equal(historicalEntry.canPay, false);
  await assert.rejects(procurement.payInvoice(session, history[1].id.toString(), { operationKey: randomUUID(), amount: '1.00', paymentMethod: 'OTHER' }), { publicCode: 'PAYABLE_NOT_FOUND' });
  await assert.rejects(procurement.cancelPurchase(session, history[0].id.toString(), { operationKey: randomUUID(), reason: 'No modificar histórico' }), { publicCode: 'HISTORICAL_PURCHASE_READ_ONLY' });

  const report = await reports.report(session, { from: '', until: '' });
  assert.equal(report.payables.balance, '30.00');
  assert.ok(report.purchases.history.some(row => row.isHistorical && row.invoiceNumber === 'FC-501'));
  const [migrationAudit] = await rows(pool, "SELECT COUNT(*) AS count FROM audit_logs WHERE business_id=? AND action='MIGRATION_PURCHASES_IMPORT'", [targetBusiness]);
  assert.equal(Number(migrationAudit.count), 3, 'la importación inicial, la reanudación y el reintento se auditan sin duplicar compras');
});
