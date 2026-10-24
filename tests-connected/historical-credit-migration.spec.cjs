'use strict';

const { test, expect } = require('@playwright/test');
const { createDatabasePool } = require('../backend/src/config/database');
const { readConfig } = require('../backend/src/config/environment');
const { api, createDestinationAndAdmin, identityPackage, importCompletePackage, openDestinationPage, signInSystemAdmin, uniqueSuffix } = require('./local-migration-flow.helper.cjs');

const database = process.env.POS_INTEGRATION_DATABASE;
if (!/^pos_auth_test_[a-f0-9]{24}$/.test(database || '') || database === process.env.DB_NAME) throw new Error('Usar únicamente el ejecutor MySQL temporal');

test('migra crédito y abonos por lote seguro a un destino separado y quedan visibles en CxC', async ({ page, context }) => {
  await signInSystemAdmin(page, context);
  const suffix = uniqueSuffix();
  const sourceId = 'browser-credit-' + suffix;
  const sourceName = 'Negocio local crédito ' + suffix;
  const target = await createDestinationAndAdmin(page, suffix, 'Destino crédito ' + suffix);
  const saleId = 'local-credit-invoice-' + suffix;
  const paymentId = 'local-credit-payment-' + suffix;
  const clientName = 'Cliente crédito ' + suffix;
  const productName = 'Café histórico ' + suffix;
  const sourcePackage = identityPackage(sourceId, sourceName, {
    products: [{ id: 901, barcode: 'MIG-CREDIT-' + suffix, name: productName, category: 'General', cost: '2.00', retailPrice: '25.00', wholesalePrice: '25.00', stock: '0.000', minStock: '0.000', taxRate: '0.0000', active: true, image: null }],
    clients: [{ id: 902, name: clientName, phone: null, ruc: null, address: null, creditLimit: '0.00', openingBalance: '0.00', debt: '0.00', deudaSinFactura: '0.00', active: true }],
    sales: [{ id: saleId, factura: 'FC-' + suffix, clienteId: 902, cliente: clientName, tipo: 'credito', medioPago: 'credit', fechaTS: 1750000000000, vencimientoTS: 1752592000000, subtotal: '25.00', tax: '0.00', total: '25.00', anulada: false, items: [{ productId: 901, producto: productName, codigo: 'MIG-CREDIT-' + suffix, cantidad: '1.000', costo: '2.00', precio: '25.00', subtotal: '25.00', tax: '0.00', total: '25.00' }] }],
    abonos: [{ id: paymentId, tipo: 'cliente', referenciaId: 902, facturaId: saleId, monto: '25.00', metodoPago: 'efectivo', estado: 'pendiente', fechaTS: 1750000001000, anulado: false }],
    users: [{ id: 'local-admin', username: 'unsafe-local-admin', password: 'Legacy-weak-password', role: 'ADMIN' }]
  });

  const migration = await importCompletePackage(page, target.businessId, sourcePackage, 'credito-' + suffix + '.json');
  const config = readConfig();
  const pool = createDatabasePool({ ...config.database, database, connectionLimit: 3 });
  try {
    const [snapshot] = await pool.execute(
      'SELECT (SELECT COUNT(*) FROM sales WHERE business_id=? AND is_historical=TRUE) AS sales,' +
      '(SELECT COUNT(*) FROM customer_payments WHERE business_id=? AND is_historical=TRUE) AS payments,' +
      '(SELECT COUNT(*) FROM migration_sales_references WHERE business_id=? AND source_sale_id=?) AS saleRefs,' +
      '(SELECT COUNT(*) FROM migration_credit_payment_references WHERE business_id=? AND source_payment_id=?) AS paymentRefs,' +
      '(SELECT COUNT(*) FROM inventory_movements WHERE business_id=?) AS inventoryMovements,' +
      '(SELECT COUNT(*) FROM cash_sessions WHERE business_id=?) AS cashSessions,' +
      '(SELECT COUNT(*) FROM cash_movements WHERE business_id=?) AS cashMovements,' +
      '(SELECT stock FROM products WHERE business_id=? AND barcode=?) AS stock,' +
      '(SELECT username FROM users WHERE business_id=? LIMIT 1) AS createdUser,' +
      '(SELECT COUNT(*) FROM users WHERE business_id=? AND username=\'unsafe-local-admin\') AS copiedLocalUser,' +
      '(SELECT state FROM business_migration_controls WHERE business_id=?) AS migrationState,' +
      '(SELECT status FROM businesses WHERE id=?) AS businessStatus,' +
      '(SELECT status FROM migration_import_batches WHERE business_id=? AND id=?) AS batchStatus',
      [target.businessId, target.businessId, target.businessId, saleId, target.businessId, paymentId, target.businessId, target.businessId, target.businessId, target.businessId, 'MIG-CREDIT-' + suffix, target.businessId, target.businessId, target.businessId, target.businessId, target.businessId, migration.batchId]
    );
    expect(Object.fromEntries(Object.entries(snapshot[0]).filter(([key]) => !['stock', 'createdUser', 'migrationState', 'businessStatus', 'batchStatus'].includes(key)).map(([key, value]) => [key, Number(value)])))
      .toEqual({ sales: 1, payments: 1, saleRefs: 1, paymentRefs: 1, inventoryMovements: 0, cashSessions: 0, cashMovements: 0, copiedLocalUser: 0 });
    expect(snapshot[0].stock).toBe('0.000');
    expect(snapshot[0].createdUser).toBe(target.username);
    expect([snapshot[0].migrationState, snapshot[0].businessStatus, snapshot[0].batchStatus]).toEqual(['COMPLETE', 'INACTIVE', 'COMPLETED']);
    const [paymentStates] = await pool.execute('SELECT status,source_status,is_historical FROM customer_payments WHERE business_id=?', [target.businessId]);
    expect(paymentStates.map(row => [row.status, row.source_status, Number(row.is_historical)])).toEqual([['POSTED', 'pendiente', 1]]);
    const [balances] = await pool.execute(
      'SELECT c.opening_balance + COALESCE((SELECT SUM(s.total) FROM sales s WHERE s.business_id=c.business_id AND s.client_id=c.id AND s.sale_type=\'CREDIT\' AND s.status=\'COMPLETED\'),0.00) - COALESCE((SELECT SUM(p.amount) FROM customer_payments p WHERE p.business_id=c.business_id AND p.client_id=c.id AND p.status=\'POSTED\'),0.00) AS balance FROM clients c WHERE c.business_id=?',
      [target.businessId]
    );
    expect(balances[0].balance).toBe('0.00');
  } finally {
    await pool.end();
  }

  expect((await api(page, 'setAdminBusinessStatus', target.businessId, 'ACTIVE')).status).toBe('ACTIVE');
  const destination = await openDestinationPage(context.browser(), target, require.resolve('../tests/dexie-search-shim.js'));
  try {
    await destination.page.locator('#navClientsBtn').click();
    await expect(destination.page.locator('#clientsView')).toBeVisible();
    const clientRow = destination.page.locator('#clientsTableBody tr').filter({ hasText: clientName });
    await expect(clientRow).toContainText('C$0.00');
    await clientRow.getByRole('button', { name: 'Historial' }).click();
    await expect(destination.page.locator('#statementModal')).toBeVisible();
    await expect(destination.page.locator('#statementTableBody')).toContainText('C$25.00');
    const clientId = await clientRow.getAttribute('data-client-id');
    const statement = await api(destination.page, 'clientStatement', clientId);
    expect(statement.payments).toHaveLength(1);
    expect(statement.payments[0]).toMatchObject({ amount: '25.00', isHistorical: true });
  } finally {
    await destination.context.close();
  }
});
