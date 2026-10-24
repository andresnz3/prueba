'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { readConfig } = require('../../src/config/environment');
const { readAuthConfig } = require('../../src/config/auth');
const { createDatabasePool } = require('../../src/config/database');
const { createAuthRepository, rows } = require('../../src/repositories/auth');
const { createSystemAdminService } = require('../../src/services/system-admin');
const { createCustomerService } = require('../../src/services/customer-accounts');
const { createSalesService } = require('../../src/services/sales');
const { reconcileCreditPackage } = require('../../src/services/system-admin-credit-preview');
const { packageForSalesImport, normalizeSale, formatMoney, formatRate } = require('../../src/services/system-admin-sales-migration-values');

const database = process.env.POS_INTEGRATION_DATABASE;
if (!/^pos_auth_test_[a-f0-9]{24}$/.test(database || '') || database === process.env.DB_NAME) throw new Error('Usar el ejecutor MySQL aislado');

const systemAdmin = { username: 'andres', role: 'ADMIN', business_id: '1', user_id: '7' };
const isCredit = sale => ['saleType', 'tipoVenta', 'sale_type', 'tipo', 'paymentMethod', 'metodoPago', 'metodo', 'payment_method', 'medioPago']
  .some(key => /^(credito|credit|fiado)$/i.test(String(sale?.[key] || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')));

function creditFixture() {
  const baseDate = Date.UTC(2025, 0, 1, 12);
  const clients = [
    { id: 101, name: 'Ana Pendiente', debt: '50.00', deudaSinFactura: '0.00' },
    { id: 102, name: 'Beto Parcial', debt: '60.00', deudaSinFactura: '0.00' },
    { id: 103, name: 'Carla Pagada', debt: '0.00', deudaSinFactura: '0.00' },
    { id: 104, name: 'Eva General', debt: '20.00', deudaSinFactura: '0.00' },
    { id: 105, name: 'Fina Anulada', debt: '60.00', deudaSinFactura: '0.00' },
    { id: 106, name: 'Gala Factura Anulada', debt: '0.00', deudaSinFactura: '0.00' }
  ];
  const sale = (id, invoice, clientId, clientName, amount, at, annulled = false) => ({
    id, factura: invoice, clienteId: clientId, cliente: clientName, tipo: 'credito', medioPago: 'credit',
    fechaTS: baseDate + at, vencimientoTS: baseDate + at + 30 * 86400000, total: amount, subtotal: amount,
    tax: '0.00', descuentoMonto: '0.00', anulada: annulled,
    items: [{ productId: 901, producto: 'Café', codigo: 'CREDIT-COFFEE', cantidad: 1, costo: '2.00', precio: amount, subtotal: amount, total: amount }]
  });
  const sales = [
    sale('1750000000000.0001', 'CR-ANA', 101, 'Ana Pendiente', '50.00', 1),
    sale('1750000000000.0002', 'CR-BETO', 102, 'Beto Parcial', '100.00', 2),
    sale('1750000000000.0003', 'CR-CARLA', 103, 'Carla Pagada', '20.00', 3),
    sale('1750000000000.0004', 'CR-EVA-1', 104, 'Eva General', '30.00', 4),
    sale('1750000000000.0005', 'CR-EVA-2', 104, 'Eva General', '40.00', 5),
    sale('1750000000000.0006', 'CR-FINA', 105, 'Fina Anulada', '60.00', 6),
    sale('1750000000000.0007', 'CR-GALA-VOID', 106, 'Gala Factura Anulada', '80.00', 7, true)
  ];
  const abonos = [
    { id: '1750000001000.0101', tipo: 'cliente', referenciaId: 102, facturaId: sales[1].id, monto: '40.00', metodoPago: 'efectivo', estado: 'pendiente', fechaTS: baseDate + 100, anulado: false },
    { id: '1750000001000.0102', tipo: 'cliente', referenciaId: 103, facturaId: sales[2].id, monto: '20.00', metodoPago: 'efectivo', estado: 'pendiente', fechaTS: baseDate + 200, anulado: false },
    { id: '1750000001000.0103', tipo: 'cliente', referenciaId: 104, monto: '50.00', metodoPago: 'tarjeta', estado: 'confirmado', fechaTS: baseDate + 300, anulado: false },
    { id: '1750000001000.0104', tipo: 'cliente', referenciaId: 105, facturaId: sales[5].id, monto: '10.00', metodoPago: 'efectivo', estado: 'pendiente', fechaTS: baseDate + 400, anulado: true }
  ];
  return {
    type: 'pos_local_migration_package', version: 1, exportedAt: '2026-10-14T12:00:00.000Z',
    business: { id: 'local-credit-fixture-' + randomUUID(), name: 'Crédito de prueba ' + randomUUID() },
    data: { products: [{ id: 901, barcode: 'CREDIT-COFFEE', name: 'Café', cost: '2.00', taxRate: '0.0000' }], clients, suppliers: [], sales, purchases: [], abonos }
  };
}

async function setupTarget(pool, repo, packageValue, label) {
  const targetBusinessId = String((await rows(pool, 'INSERT INTO businesses (name) VALUES (?)', ['Migración créditos ' + label + ' ' + randomUUID()])).insertId);
  const targetUserId = String((await rows(pool,
    'INSERT INTO users (business_id,username,full_name,password_hash,role) VALUES (?,?,?,?,?)',
    [targetBusinessId, 'credit-' + randomUUID().slice(0, 16), 'Usuario migración', 'hash-de-prueba', 'ADMIN'])).insertId);
  const reconciled = reconcileCreditPackage(packageValue);
  for (const client of reconciled.clients) await rows(pool, 'INSERT INTO clients (business_id,name,opening_balance) VALUES (?,?,0.00)', [targetBusinessId, client.clientName]);
  const imported = packageForSalesImport(packageValue);
  const productByIdentity = new Map();
  for (let index = 0; index < packageValue.data.sales.length; index++) {
    const raw = packageValue.data.sales[index];
    if (!isCredit(raw)) continue;
    const normalized = normalizeSale(raw, index, imported);
    assert.equal(normalized.error, undefined);
    for (const item of normalized.items) {
      const key = item.barcode ? 'barcode:' + item.barcode : 'name:' + item.name.toLocaleLowerCase();
      if (productByIdentity.has(key)) continue;
      const barcode = item.barcode || 'CREDIT-' + randomUUID();
      const product = await rows(pool,
        'INSERT INTO products (business_id,barcode,name,category,cost,retail_price,wholesale_price,stock,min_stock,tax_rate) VALUES (?,?,?,\'General\',?,0.00,0.00,12.000,1.000,?)',
        [targetBusinessId, barcode, item.name || barcode, formatMoney(item.costCents || 0n), formatRate(item.taxRate)]);
      productByIdentity.set(key, String(product.insertId));
    }
  }
  const gateDetails = JSON.stringify({ sourceBusinessName: imported.sourceBusinessName, sourceBusinessId: imported.sourceBusinessId, sourceBusinessKey: imported.sourceBusinessKey, packageExportedAt: imported.exportedAt });
  for (const action of ['MIGRATION_BASIC_IMPORT', 'MIGRATION_INVENTORY_IMPORT']) await rows(pool,
    'INSERT INTO audit_logs (business_id,user_id,action,entity,entity_id,details,created_at) VALUES (?,NULL,?,?,?, ?,UTC_TIMESTAMP(3))',
    [targetBusinessId, action, 'businesses', targetBusinessId, gateDetails]);
  return { targetBusinessId, targetUserId, imported, service: createSystemAdminService(repo) };
}

async function snapshot(pool, businessId) {
  const counts = {};
  for (const table of ['inventory_movements', 'cash_sessions', 'cash_movements', 'supplier_payments', 'purchases', 'purchase_items', 'pos_operations']) {
    const [row] = await rows(pool, 'SELECT COUNT(*) AS count FROM ' + table + ' WHERE business_id=?', [businessId]);
    counts[table] = Number(row.count);
  }
  const products = await rows(pool, 'SELECT id,stock,cost,retail_price,wholesale_price FROM products WHERE business_id=? ORDER BY id', [businessId]);
  const clients = await rows(pool, 'SELECT id,opening_balance FROM clients WHERE business_id=? ORDER BY id', [businessId]);
  return { counts, products, clients };
}

async function sessionFor(pool, repo, businessId, userId, authConfig) {
  const tokenHash = randomBytes(32).toString('hex');
  await rows(pool, 'INSERT INTO sessions (business_id,user_id,token_hash,expires_at) VALUES (?,?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 DAY))', [businessId, userId, tokenHash]);
  return repo.session(tokenHash, authConfig.absoluteSeconds);
}

test('MySQL migra las tres facturas reales de Diana, mantiene saldo cero y es idempotente', async t => {
  const fs = require('node:fs');
  const path = require('node:path');
  const config = readConfig();
  const authConfig = readAuthConfig({ CSRF_SECRET: randomBytes(32).toString('hex'), AUTH_RATE_MAX: '100' });
  const pool = createDatabasePool({ ...config.database, database, connectionLimit: 12 });
  t.after(() => pool.end());
  const repo = createAuthRepository(pool, authConfig);
  const packageValue = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../prueba-compras.json'), 'utf8'));
  const target = await setupTarget(pool, repo, packageValue, 'real');
  const before = await snapshot(pool, target.targetBusinessId);
  const preview = await target.service.previewCreditMigration(systemAdmin, target.targetBusinessId, packageValue);
  assert.equal(preview.eligible, true, JSON.stringify(preview.issues));
  assert.equal(preview.financiallyConsistent, true);
  assert.deepEqual(preview.totals, { invoices: 3, payments: 3, total: '106.10', paid: '106.10', balance: '0.00' });
  assert.deepEqual(preview.invoices.map(row => [row.clientName, row.invoiceNumber, row.total, row.paid, row.balance, row.status]), [
    ['Diana', '14', '25.00', '25.00', '0.00', 'PAID'], ['Diana', '15', '43.70', '43.70', '0.00', 'PAID'], ['Diana', '16', '37.40', '37.40', '0.00', 'PAID']
  ]);
  assert.ok(preview.issues.filter(row => row.code === 'LOCAL_PENDING_APPLIED').length === 3);
  const imported = await target.service.migrateCreditMigration(systemAdmin, target.targetBusinessId, packageValue);
  assert.deepEqual(imported.created, { invoices: 3, payments: 3 });
  assert.deepEqual(imported.skipped, { invoices: 0, payments: 0 });
  assert.deepEqual(imported.financial, { invoices: 3, payments: 3, total: '106.10', paid: '106.10', balance: '0.00' });

  const sourceSales = packageValue.data.sales.filter(isCredit);
  const saleRefs = await rows(pool, 'SELECT source_sale_id,source_client_id,source_invoice_number FROM migration_sales_references WHERE business_id=? AND source_business_key=? ORDER BY source_invoice_number', [target.targetBusinessId, target.imported.sourceBusinessKey]);
  assert.equal(saleRefs.length, 3);
  assert.deepEqual(saleRefs.map(row => row.source_sale_id).sort(), sourceSales.map(row => String(row.id)).sort());
  assert.ok(saleRefs.every(row => row.source_client_id === String(sourceSales[0].clienteId)));
  assert.deepEqual(saleRefs.map(row => row.source_invoice_number).sort(), ['14', '15', '16']);
  const historicalSales = await rows(pool, 'SELECT s.id,s.invoice_number,s.status,s.total,s.created_at,s.due_at,s.detail,s.is_historical,r.source_sale_id,r.source_invoice_number FROM sales s JOIN migration_sales_references r ON r.business_id=s.business_id AND r.sale_id=s.id WHERE s.business_id=? AND s.sale_type=\'CREDIT\' ORDER BY r.source_invoice_number', [target.targetBusinessId]);
  assert.equal(historicalSales.length, 3);
  assert.ok(historicalSales.every(row => Boolean(row.is_historical) && row.status === 'COMPLETED'));
  assert.deepEqual(historicalSales.map(row => row.total), ['25.00', '43.70', '37.40']);
  assert.deepEqual(historicalSales.map(row => row.detail.startsWith('Factura local: ' + row.source_invoice_number)), [true, true, true]);
  for (const row of historicalSales) {
    const original = sourceSales.find(sale => String(sale.id) === String(row.source_sale_id));
    assert.equal(row.created_at.toISOString(), new Date(original.fechaTS).toISOString());
    assert.equal(row.due_at.toISOString(), new Date(original.vencimientoTS).toISOString());
  }
  const historicalPayments = await rows(pool, 'SELECT p.id,p.sale_id,p.amount,p.status,p.is_historical,p.source_status,p.cash_session_id,p.created_at,r.source_payment_id,r.source_client_id,r.source_sale_key FROM customer_payments p JOIN migration_credit_payment_references r ON r.business_id=p.business_id AND r.customer_payment_id=p.id WHERE p.business_id=? ORDER BY r.source_payment_id', [target.targetBusinessId]);
  assert.equal(historicalPayments.length, 3);
  assert.ok(historicalPayments.every(row => row.status === 'POSTED' && Boolean(row.is_historical) && row.source_status === 'pendiente' && row.cash_session_id === null));
  assert.deepEqual(historicalPayments.map(row => row.source_payment_id).sort(), packageValue.data.abonos.filter(row => row.tipo === 'cliente').map(row => String(row.id)).sort());
  assert.ok(historicalPayments.every(row => row.source_client_id === String(sourceSales[0].clienteId)));
  for (const row of historicalPayments) {
    const original = packageValue.data.abonos.find(payment => String(payment.id) === String(row.source_payment_id));
    assert.equal(row.created_at.toISOString(), new Date(original.fechaTS).toISOString());
  }
  const after = await snapshot(pool, target.targetBusinessId);
  assert.deepEqual(after, before, 'el crédito histórico no modifica inventario, Kardex, caja ni saldos iniciales');

  const session = await sessionFor(pool, repo, target.targetBusinessId, target.targetUserId, authConfig);
  const auth = { canAccess: async () => true };
  const customers = createCustomerService({ repo, auth, config: authConfig });
  const diana = (await rows(pool, 'SELECT id FROM clients WHERE business_id=? AND name=\'Diana\'', [target.targetBusinessId]))[0];
  const statement = await customers.statement(session, String(diana.id), { limit: 100, offset: 0 });
  assert.equal(statement.client.debt, '0.00');
  assert.equal(statement.invoices.length, 3);
  assert.ok(statement.invoices.every(row => row.balance === '0.00' && row.status === 'PAID'));
  const sales = createSalesService({ repo, auth, config: authConfig, creditSnapshot: async () => ({}) });
  const cashOverview = await sales.cashOverview(session);
  assert.deepEqual(cashOverview.operationSales, [], 'las facturas importadas no aparecen como operaciones de Caja');
  assert.deepEqual(cashOverview.operationCollections, [], 'los abonos importados no aparecen como ingresos de Caja');
  assert.deepEqual(cashOverview.movements, []);
  await assert.rejects(sales.cancel(session, String(historicalSales[0].id), { operationKey: randomUUID(), reason: 'No tocar el historial' }), { publicCode: 'HISTORICAL_SALE_READ_ONLY' });
  await assert.rejects(sales.confirmPayment(session, String(historicalPayments[0].id), { operationKey: randomUUID() }), { publicCode: 'PAYMENT_NOT_FOUND' });

  const repeated = structuredClone(packageValue);
  repeated.data.sales.reverse(); repeated.data.abonos.reverse();
  const retry = await target.service.migrateCreditMigration(systemAdmin, target.targetBusinessId, repeated);
  assert.deepEqual(retry.created, { invoices: 0, payments: 0 });
  assert.deepEqual(retry.skipped, { invoices: 3, payments: 3 });
  const [references] = await rows(pool, 'SELECT COUNT(*) AS count FROM migration_credit_payment_references WHERE business_id=?', [target.targetBusinessId]);
  assert.equal(Number(references.count), 3);

  const changedInvoice = structuredClone(packageValue);
  changedInvoice.data.sales.find(isCredit).detail = 'dato de origen cambiado';
  const invoiceConflict = await target.service.previewCreditMigration(systemAdmin, target.targetBusinessId, changedInvoice);
  assert.ok(invoiceConflict.issues.some(row => row.code === 'SOURCE_CONFLICT' && row.blocking));
  await assert.rejects(target.service.migrateCreditMigration(systemAdmin, target.targetBusinessId, changedInvoice), { publicCode: 'MIGRATION_CREDIT_BLOCKED' });
  const changedPayment = structuredClone(packageValue);
  changedPayment.data.abonos.find(row => row.tipo === 'cliente').monto = '24.99';
  changedPayment.data.clients.find(row => String(row.id) === '1791253307139').debt = '0.01';
  const paymentConflict = await target.service.previewCreditMigration(systemAdmin, target.targetBusinessId, changedPayment);
  assert.ok(paymentConflict.issues.some(row => row.code === 'PAYMENT_SOURCE_CONFLICT' && row.blocking));
  await assert.rejects(target.service.migrateCreditMigration(systemAdmin, target.targetBusinessId, changedPayment), { publicCode: 'MIGRATION_CREDIT_BLOCKED' });

  await rows(pool, 'INSERT INTO audit_logs (business_id,user_id,action,entity,entity_id,details,created_at) VALUES (?,NULL,\'MIGRATION_SALES_IMPORT\',\'businesses\',?,?,UTC_TIMESTAMP(3))',
    [target.targetBusinessId, target.targetBusinessId, JSON.stringify({ sourceBusinessName: 'Otro origen histórico', sourceBusinessKey: 'b'.repeat(64) })]);
  const otherOrigin = await target.service.previewCreditMigration(systemAdmin, target.targetBusinessId, packageValue);
  assert.equal(otherOrigin.sourceOriginConflict.required, true);
  assert.equal(otherOrigin.canImport, true, 'otro origen es una advertencia que requiere confirmación');
  await assert.rejects(target.service.migrateCreditMigration(systemAdmin, target.targetBusinessId, packageValue), { publicCode: 'MIGRATION_CREDIT_ORIGIN_CONFIRMATION_REQUIRED' });
  const confirmedRetry = await target.service.migrateCreditMigration(systemAdmin, target.targetBusinessId, packageValue, { confirmDifferentSource: true });
  assert.deepEqual(confirmedRetry.created, { invoices: 0, payments: 0 });
  const [audit] = await rows(pool, "SELECT details FROM audit_logs WHERE business_id=? AND action='MIGRATION_CREDIT_IMPORT' ORDER BY id DESC LIMIT 1", [target.targetBusinessId]);
  const auditDetails = typeof audit.details === 'string' ? JSON.parse(audit.details) : audit.details;
  assert.equal(auditDetails.actor.username, 'andres');
  assert.equal(auditDetails.confirmedDifferentSource, true);
  assert.equal(auditDetails.sourceBusinessKey, target.imported.sourceBusinessKey);
});

test('MySQL concilia pendientes, parciales, pagadas, abono general y anulaciones; bloquea deuda sin factura e inconsistencias', async t => {
  const config = readConfig();
  const authConfig = readAuthConfig({ CSRF_SECRET: randomBytes(32).toString('hex'), AUTH_RATE_MAX: '100' });
  const pool = createDatabasePool({ ...config.database, database, connectionLimit: 12 });
  t.after(() => pool.end());
  const repo = createAuthRepository(pool, authConfig);
  const packageValue = creditFixture();
  const target = await setupTarget(pool, repo, packageValue, 'synthetic');
  const preview = await target.service.previewCreditMigration(systemAdmin, target.targetBusinessId, packageValue);
  assert.equal(preview.eligible, true, JSON.stringify(preview.issues));
  assert.deepEqual(preview.totals, { invoices: 7, payments: 4, total: '300.00', paid: '110.00', balance: '190.00' });
  assert.equal(preview.invoices.find(row => row.invoiceNumber === 'CR-BETO').balance, '60.00');
  assert.equal(preview.invoices.find(row => row.invoiceNumber === 'CR-CARLA').status, 'PAID');
  assert.equal(preview.invoices.find(row => row.invoiceNumber === 'CR-EVA-1').paid, '30.00');
  assert.equal(preview.invoices.find(row => row.invoiceNumber === 'CR-EVA-2').paid, '20.00');
  assert.equal(preview.invoices.find(row => row.invoiceNumber === 'CR-GALA-VOID').status, 'CANCELLED');
  assert.ok(preview.issues.some(row => row.code === 'LOCAL_PENDING_APPLIED' && !row.blocking));
  assert.ok(preview.issues.some(row => row.code === 'GENERAL_PAYMENT' && !row.blocking));
  assert.ok(preview.issues.some(row => row.code === 'VOID_PAYMENT' && !row.blocking));
  const before = await snapshot(pool, target.targetBusinessId);
  const imported = await target.service.migrateCreditMigration(systemAdmin, target.targetBusinessId, packageValue);
  assert.deepEqual(imported.created, { invoices: 7, payments: 5 }, 'el abono general se divide en dos aplicaciones por factura');
  const after = await snapshot(pool, target.targetBusinessId);
  assert.deepEqual(after, before);
  const posted = await rows(pool, "SELECT status,COUNT(*) AS count FROM customer_payments WHERE business_id=? AND status='POSTED' GROUP BY status", [target.targetBusinessId]);
  const voided = await rows(pool, "SELECT status,COUNT(*) AS count FROM customer_payments WHERE business_id=? AND status='VOID' GROUP BY status", [target.targetBusinessId]);
  assert.equal(Number(posted[0].count), 4);
  assert.equal(Number(voided[0].count), 1);
  const localStatuses = await rows(pool, 'SELECT source_payment_id,source_status,status FROM migration_credit_payment_references r JOIN customer_payments p ON p.business_id=r.business_id AND p.id=r.customer_payment_id WHERE r.business_id=? ORDER BY source_payment_id,source_sale_key', [target.targetBusinessId]);
  assert.ok(localStatuses.some(row => row.source_status === 'pendiente' && row.status === 'POSTED'));
  assert.ok(localStatuses.some(row => row.source_status === 'pendiente' && row.status === 'VOID'));

  const noInvoice = structuredClone(packageValue);
  noInvoice.data.sales = []; noInvoice.data.abonos = [];
  noInvoice.data.clients[0].debt = '12.00'; noInvoice.data.clients[0].deudaSinFactura = '12.00';
  const openingTarget = await setupTarget(pool, repo, noInvoice, 'opening-debt');
  const openingPreview = await openingTarget.service.previewCreditMigration(systemAdmin, openingTarget.targetBusinessId, noInvoice);
  assert.equal(openingPreview.canImport, false);
  assert.ok(openingPreview.issues.some(row => row.code === 'OPENING_DEBT' && row.blocking));
  const openingBefore = await snapshot(pool, openingTarget.targetBusinessId);
  await assert.rejects(openingTarget.service.migrateCreditMigration(systemAdmin, openingTarget.targetBusinessId, noInvoice), { publicCode: 'MIGRATION_CREDIT_BLOCKED' });
  assert.deepEqual(await snapshot(pool, openingTarget.targetBusinessId), openingBefore);

  const mismatch = structuredClone(packageValue);
  mismatch.data.clients.find(row => String(row.id) === '102').debt = '59.99';
  const mismatchPreview = await target.service.previewCreditMigration(systemAdmin, target.targetBusinessId, mismatch);
  assert.equal(mismatchPreview.canImport, false);
  assert.ok(mismatchPreview.issues.some(row => row.code === 'BALANCE_MISMATCH' && row.blocking));
  await assert.rejects(target.service.migrateCreditMigration(systemAdmin, target.targetBusinessId, mismatch), { publicCode: 'MIGRATION_CREDIT_BLOCKED' });
});

test('MySQL revierte una importación a mitad de transacción y no deja facturas ni referencias huérfanas', async t => {
  const config = readConfig();
  const authConfig = readAuthConfig({ CSRF_SECRET: randomBytes(32).toString('hex'), AUTH_RATE_MAX: '100' });
  const pool = createDatabasePool({ ...config.database, database, connectionLimit: 8 });
  t.after(() => pool.end());
  const repo = createAuthRepository(pool, authConfig);
  const packageValue = creditFixture();
  const target = await setupTarget(pool, repo, packageValue, 'rollback');
  const brokenRepo = { ...repo, rows: async (db, sql, values) => {
    if (sql.startsWith('INSERT INTO migration_credit_payment_references')) throw new Error('forced credit migration rollback');
    return repo.rows(db, sql, values);
  } };
  const brokenService = createSystemAdminService(brokenRepo);
  await assert.rejects(brokenService.migrateCreditMigration(systemAdmin, target.targetBusinessId, packageValue), /forced credit migration rollback/);
  for (const table of ['sales', 'sale_items', 'customer_payments', 'migration_sales_references', 'migration_credit_payment_references']) {
    const [row] = await rows(pool, 'SELECT COUNT(*) AS count FROM ' + table + ' WHERE business_id=?', [target.targetBusinessId]);
    assert.equal(Number(row.count), 0, table + ' debe quedar limpio tras rollback');
  }
  const [audits] = await rows(pool, "SELECT COUNT(*) AS count FROM audit_logs WHERE business_id=? AND action='MIGRATION_CREDIT_IMPORT'", [target.targetBusinessId]);
  assert.equal(Number(audits.count), 0);
});
