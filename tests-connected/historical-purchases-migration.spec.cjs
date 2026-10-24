'use strict';

const { test, expect } = require('@playwright/test');
const { createDatabasePool } = require('../backend/src/config/database');
const { readConfig } = require('../backend/src/config/environment');
const { api, createDestinationAndAdmin, identityPackage, importCompletePackage, openDestinationPage, signInSystemAdmin, uniqueSuffix } = require('./local-migration-flow.helper.cjs');

const database = process.env.POS_INTEGRATION_DATABASE;
if (!/^pos_auth_test_[a-f0-9]{24}$/.test(database || '') || database === process.env.DB_NAME) throw new Error('Usar únicamente el ejecutor MySQL temporal');

test('migra compras históricas a sus tablas operativas sin alterar stock, caja ni CxP', async ({ page, context }) => {
  await signInSystemAdmin(page, context);
  const suffix = uniqueSuffix();
  const sourceId = 'browser-purchases-' + suffix;
  const sourceName = 'Negocio local compras ' + suffix;
  const target = await createDestinationAndAdmin(page, suffix, 'Destino compras ' + suffix);
  const productName = 'Arroz histórico ' + suffix;
  const supplierName = 'Proveedor histórico ' + suffix;
  const creditPurchaseId = 'local-credit-purchase-' + suffix;
  const cashPurchaseId = 'local-cash-purchase-' + suffix;
  const sourcePackage = identityPackage(sourceId, sourceName, {
    products: [{ id: 104, barcode: 'MIG-BUY-' + suffix, name: productName, category: 'Abarrotes', cost: '4.25', retailPrice: '5.00', wholesalePrice: '4.75', stock: '0.000', minStock: '1.000', taxRate: '0.0000', active: true }],
    suppliers: [{ id: 9, name: supplierName, contact: 'Contacto local', phone: '5551200', ruc: null, address: 'Managua', active: true }],
    purchases: [
      { id: creditPurchaseId, fechaTS: 1750000000000, factura: 'HIST-CREDIT-' + suffix, tipo: 'credito', proveedorId: 9, proveedor: supplierName, subtotal: '8.50', descuentoMonto: '0.50', tax: '0.20', total: '8.20', vencimiento: '2026-11-06', anulada: false, items: [{ productId: 104, producto: productName, codigo: 'MIG-BUY-' + suffix, cantidad: '2.000', costo: '4.25', subtotal: '8.50', descuento: '0.50', tax: '0.20', total: '8.20' }] },
      { id: cashPurchaseId, fechaTS: 1750086400000, factura: 'HIST-CASH-' + suffix, tipo: 'contado', proveedorId: 9, proveedor: supplierName, subtotal: '4.25', total: '4.25', anulada: false, items: [{ productId: 104, producto: productName, codigo: 'MIG-BUY-' + suffix, cantidad: '1.000', costo: '4.25', subtotal: '4.25', total: '4.25' }] }
    ],
    abonos: [{ id: 'local-supplier-payment-' + suffix, tipo: 'proveedor', referenciaId: 9, facturaId: creditPurchaseId, monto: '2.00', metodoPago: 'transferencia', estado: 'pendiente', fechaTS: 1750000001000, anulado: false }],
    users: [{ id: 'local-owner', username: 'unsafe-local-owner', password: 'Legacy-weak-password', role: 'ADMIN' }]
  });

  const migration = await importCompletePackage(page, target.businessId, sourcePackage, 'compras-' + suffix + '.json');
  const config = readConfig();
  const pool = createDatabasePool({ ...config.database, database, connectionLimit: 3 });
  try {
    const [snapshot] = await pool.execute(
      'SELECT (SELECT COUNT(*) FROM purchases WHERE business_id=? AND is_historical=TRUE) AS purchases,' +
      '(SELECT COUNT(*) FROM purchase_items i JOIN purchases p ON p.business_id=i.business_id AND p.id=i.purchase_id WHERE p.business_id=? AND p.is_historical=TRUE) AS items,' +
      '(SELECT COUNT(*) FROM supplier_payments WHERE business_id=? AND is_historical=TRUE) AS supplierPayments,' +
      '(SELECT COUNT(*) FROM inventory_movements WHERE business_id=?) AS inventoryMovements,' +
      '(SELECT COUNT(*) FROM cash_sessions WHERE business_id=?) AS cashSessions,' +
      '(SELECT COUNT(*) FROM cash_movements WHERE business_id=?) AS cashMovements,' +
      '(SELECT stock FROM products WHERE business_id=? AND barcode=?) AS stock,' +
      '(SELECT COUNT(*) FROM users WHERE business_id=? AND username=\'unsafe-local-owner\') AS copiedLocalUser,' +
      '(SELECT state FROM business_migration_controls WHERE business_id=?) AS migrationState,' +
      '(SELECT status FROM businesses WHERE id=?) AS businessStatus,' +
      '(SELECT status FROM migration_import_batches WHERE business_id=? AND id=?) AS batchStatus',
      [target.businessId, target.businessId, target.businessId, target.businessId, target.businessId, target.businessId, target.businessId, 'MIG-BUY-' + suffix, target.businessId, target.businessId, target.businessId, target.businessId, migration.batchId]
    );
    expect(Object.fromEntries(Object.entries(snapshot[0]).filter(([key]) => !['stock', 'migrationState', 'businessStatus', 'batchStatus'].includes(key)).map(([key, value]) => [key, Number(value)])))
      .toEqual({ purchases: 2, items: 2, supplierPayments: 1, inventoryMovements: 0, cashSessions: 0, cashMovements: 0, copiedLocalUser: 0 });
    expect(snapshot[0].stock).toBe('0.000');
    expect([snapshot[0].migrationState, snapshot[0].businessStatus, snapshot[0].batchStatus]).toEqual(['COMPLETE', 'INACTIVE', 'COMPLETED']);
    const [supplierPaymentState] = await pool.execute('SELECT status,is_historical FROM supplier_payments WHERE business_id=?', [target.businessId]);
    expect(supplierPaymentState.map(row => [row.status, Number(row.is_historical)])).toEqual([['PENDING', 1]]);
    const [rows] = await pool.execute('SELECT invoice_number,purchase_type,status,subtotal,discount,tax,total,due_at FROM purchases WHERE business_id=? AND is_historical=TRUE ORDER BY created_at,id', [target.businessId]);
    expect(rows.map(row => [row.purchase_type, row.status, row.subtotal, row.discount, row.tax, row.total])).toEqual([
      ['CREDIT', 'COMPLETED', '8.50', '0.50', '0.20', '8.20'], ['CASH', 'COMPLETED', '4.25', '0.00', '0.00', '4.25']
    ]);
  } finally {
    await pool.end();
  }

  expect((await api(page, 'setAdminBusinessStatus', target.businessId, 'ACTIVE')).status).toBe('ACTIVE');
  const destination = await openDestinationPage(context.browser(), target, require.resolve('../tests/dexie-search-shim.js'));
  try {
    await destination.page.locator('#navPurchasesBtn').click();
    await expect(destination.page.locator('#purchasesView')).toBeVisible();
    await destination.page.locator('[data-period-filter="purchases"] [data-period-preset="all"]').click();
    const historicalRow = destination.page.locator('#connectedPurchasesTableBody tr').filter({ hasText: 'HIST-CREDIT-' + suffix });
    await expect(historicalRow).toContainText('Hist\u00f3rica');
    await expect(historicalRow).toContainText('sin saldo operativo');
    await expect(historicalRow.getByRole('button', { name: 'Anular' })).toHaveCount(0);
    await historicalRow.getByRole('button', { name: 'Ver factura' }).click();
    await expect(destination.page.locator('#ticketContent')).toContainText('Compra hist\u00f3rica');
    await expect(destination.page.locator('#ticketContent')).toContainText('sin saldo operativo');
    await expect(destination.page.locator('#ticketContent')).toContainText('costo C$4.25');
    await destination.page.locator('#closeTicketBtn').click();
    await destination.page.locator('#navPayablesBtn').click();
    await expect(destination.page.locator('#payablesView')).toBeVisible();
    expect(await api(destination.page, 'payables')).toHaveLength(0);
    expect(await api(destination.page, 'payablesSummary')).toMatchObject({ businessId: target.businessId, balance: '0.00', pendingPayments: '0.00' });
    const suppliers = await api(destination.page, 'suppliers');
    expect(suppliers.find(row => row.name === supplierName)).toMatchObject({ debt: '0.00', historicalDebt: '6.20' });
  } finally {
    await destination.context.close();
  }
});
