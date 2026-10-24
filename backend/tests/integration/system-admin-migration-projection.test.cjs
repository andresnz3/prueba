'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { readConfig } = require('../../src/config/environment');
const { readAuthConfig } = require('../../src/config/auth');
const { createDatabasePool } = require('../../src/config/database');
const { createAuthRepository } = require('../../src/repositories/auth');
const { createImageStore } = require('../../src/services/product-images');
const { createInventoryService } = require('../../src/services/inventory');
const { createSystemAdminService } = require('../../src/services/system-admin');

const database = process.env.POS_INTEGRATION_DATABASE;
if (!/^pos_auth_test_[a-f0-9]{24}$/.test(database || '') || database === process.env.DB_NAME) throw new Error('Use the isolated MySQL runner');

async function fixture() {
  const sourceId = 'projection-fixture-local-id';
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#345678' } }).png().toBuffer();
  const image = 'data:image/png;base64,' + png.toString('base64');
  const value = {
    type: 'pos_local_migration_package', version: 2, exportedAt: '2024-04-05T11:22:33.000Z',
    source: { mode: 'local', scope: { idSource: 'config', localBusinessId: sourceId, idsFound: 1, legacyRecords: 0, excludedRecords: 0, missingStores: [] } },
    business: { name: 'Proyección operativa prueba', localBusinessId: sourceId },
    data: {
      products: [{ id: 'product-local-1', business_id: sourceId, name: 'Café', barcode: 'CAF-01', category: 'Abarrotes', cost: '12.25', marginRetail: '25.0000', marginWholesale: '10.0000', retailPrice: '15.31', wholesalePrice: '13.48', stock: '4.500', minStock: '1.000', taxRate: '0.0000', active: true, image }],
      clients: [{ id: 'client-local-1', business_id: sourceId, name: 'Cliente Uno', phone: '5551111', creditLimit: '250.00', openingBalance: '0.00', active: true }],
      suppliers: [{ id: 'supplier-local-1', business_id: sourceId, name: 'Proveedor Uno', contact: 'Ventas', phone: '5552222', active: true }],
      sales: [{ id: 'sale-local-1', business_id: sourceId, clienteId: 'client-local-1', items: [{ productId: 'product-local-1', quantity: '1.000', price: '15.31' }], total: '15.31', status: 'COMPLETED', date: '2024-04-05T12:00:00.000Z' }],
      purchases: [{ id: 'purchase-local-1', business_id: sourceId, proveedorId: 'supplier-local-1', items: [{ productId: 'product-local-1', quantity: '2.000', cost: '12.25' }], total: '24.50', status: 'COMPLETED', date: '2024-04-04T12:00:00.000Z' }],
      cashSessions: [{ id: 'cash-local-1', business_id: sourceId, openedAt: '2024-04-05T08:00:00.000Z', closedAt: '2024-04-05T18:00:00.000Z', openingAmount: '100.00', closingAmount: '91.00', movimientos: [{ saleId: 'sale-local-1', purchaseId: 'purchase-local-1' }] }],
      inventoryMovements: [{ id: 'inventory-local-1', business_id: sourceId, producto_id: 'product-local-1', quantity: '-1.500', reason: 'Ajuste histórico', createdAt: '2024-04-05T09:00:00.000Z' }],
      abonos: [{ id: 'payment-local-1', business_id: sourceId, tipo: 'Cliente', referenciaId: 'client-local-1', facturaId: 'sale-local-1', cashSessionId: 'cash-local-1', amount: '5.00', date: '2024-04-05T13:00:00.000Z' }],
      expenses: [{ id: 'expense-local-1', business_id: sourceId, sessionId: 'cash-local-1', amount: '9.00', category: 'Servicios', date: '2024-04-05T17:00:00.000Z' }],
      auditLogs: [{ id: 'audit-local-1', business_id: sourceId, action: 'LOCAL_FIXTURE', entity: 'sale', entity_id: 'sale-local-1', createdAt: '2024-04-05T12:00:00.000Z' }],
      saleOrders: [{ id: 'order-local-1', business_id: sourceId, items: [{ productId: 'product-local-1', quantity: '1.000' }], status: 'PENDING', createdAt: '2024-04-05T10:00:00.000Z' }],
      syncQueue: [],
      configuration: { name: 'Proyección operativa prueba', localBusinessId: sourceId, legalName: 'Comercial Prueba S.A.', ruc: 'J0310000000000', phone: '5553333', address: 'Managua', currency: 'C$', invoicePrefix: 'V-', minStock: '2.000', header: 'Gracias por su compra', footer: 'Vuelva pronto', logo: image },
      categories: ['Abarrotes']
    }
  };
  return { value, image };
}

async function createTarget(pool, name) {
  const [business] = await pool.execute("INSERT INTO businesses (name,status) VALUES (?,'INACTIVE')", [name]);
  const id = String(business.insertId);
  await pool.execute("INSERT INTO business_migration_controls (business_id,state,actor_business_id,actor_user_id) VALUES (?,'PENDING','1','1')", [id]);
  return id;
}

test('admin projection makes approved catalog and commercial settings operational and repeatable', async t => {
  const config = readConfig();
  const pool = createDatabasePool({ ...config.database, database, connectionLimit: 8 });
  const imageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pos-migration-projection-'));
  t.after(async () => { await pool.end(); await fs.rm(imageRoot, { recursive: true, force: true }); });
  const target = await createTarget(pool, 'Proyección operativa prueba');
  const repository = createAuthRepository(pool, readAuthConfig({ CSRF_SECRET: 'b'.repeat(64) }));
  const imageStore = createImageStore({ root: imageRoot, quota: 10 * 1024 * 1024 });
  const service = createSystemAdminService(repository, { imageStore });
  const admin = { username: 'andres', role: 'ADMIN', business_id: '1', user_id: '1' };
  const { value } = await fixture();
  const archived = await service.archiveFullMigration(admin, target, value, true);
  assert.ok(['ARCHIVED', 'BLOCKED'].includes(archived.status));

  const first = await service.projectMigrationCatalog(admin, target, archived.batchId);
  assert.equal(first.reconciliation.stageMatched, true);
  assert.equal(first.reconciliation.fullMigrationComplete, false);
  assert.equal(first.businessStatus, 'INACTIVE');
  assert.equal(first.migrationState, 'PENDING');
  assert.equal(first.reconciliation.totals.existingProducts, 1);
  const [products] = await pool.execute('SELECT id,name,barcode,category,cost,retail_price,wholesale_price,stock,image,active,deleted FROM products WHERE business_id=?', [target]);
  const [clients] = await pool.execute('SELECT id,name,credit_limit,opening_balance FROM clients WHERE business_id=?', [target]);
  const [suppliers] = await pool.execute('SELECT id,name FROM suppliers WHERE business_id=?', [target]);
  const [settings] = await pool.execute('SELECT business_name,legal_name,ruc,phone,address,currency,logo,ticket_header,ticket_footer FROM business_settings WHERE business_id=?', [target]);
  assert.equal(products.length, 1);
  assert.deepEqual([products[0].name,products[0].barcode,products[0].category,String(products[0].cost),String(products[0].retail_price),String(products[0].wholesale_price),String(products[0].stock),Boolean(products[0].active),Boolean(products[0].deleted)], ['Café','CAF-01','Abarrotes','12.25','15.31','13.48','4.500',true,false]);
  assert.equal(clients.length, 1);
  assert.deepEqual([clients[0].name,String(clients[0].credit_limit),String(clients[0].opening_balance)], ['Cliente Uno','250.00','0.00']);
  assert.deepEqual(suppliers.map(row => row.name), ['Proveedor Uno']);
  assert.deepEqual([settings[0].business_name,settings[0].legal_name,settings[0].ruc,settings[0].phone,settings[0].address,settings[0].currency,settings[0].ticket_header,settings[0].ticket_footer], ['Proyección operativa prueba','Comercial Prueba S.A.','J0310000000000','5553333','Managua','C$','Gracias por su compra','Vuelva pronto']);
  assert.match(products[0].image, new RegExp('^/api/product-images/' + target + '/[a-f0-9]{32}\\.jpg$'));
  assert.match(settings[0].logo, new RegExp('^/api/product-images/' + target + '/[a-f0-9]{32}\\.jpg$'));
  const reopenedStore = createImageStore({ root: imageRoot, quota: 10 * 1024 * 1024 });
  const productBytes = await reopenedStore.read(target, products[0].image);
  const logoBytes = await reopenedStore.read(target, settings[0].logo);
  assert.ok(productBytes.length > 100);
  assert.ok(logoBytes.length > 100);

  const second = await service.projectMigrationCatalog(admin, target, archived.batchId);
  assert.equal(second.reconciliation.complete, false);
  assert.equal(second.reconciliation.totals.existingProducts, 1);
  assert.equal(second.reconciliation.recordsByModule.sales.archived, 1);
  assert.equal(second.reconciliation.recordsByModule.purchases.archived, 1);
  assert.equal(second.reconciliation.recordsByModule.inventoryMovements.archived, 1);
  assert.equal(second.reconciliation.recordsByModule.cashSessions.archived, 1);
  const [counts] = await pool.execute('SELECT (SELECT COUNT(*) FROM products WHERE business_id=?) AS products,(SELECT COUNT(*) FROM clients WHERE business_id=?) AS clients,(SELECT COUNT(*) FROM suppliers WHERE business_id=?) AS suppliers,(SELECT COUNT(*) FROM sales WHERE business_id=?) AS sales,(SELECT COUNT(*) FROM purchases WHERE business_id=?) AS purchases,(SELECT COUNT(*) FROM cash_movements WHERE business_id=?) AS cash',( [target,target,target,target,target,target]));
  assert.deepEqual(Object.values(counts[0]).map(Number), [1,1,1,0,0,0]);
  const [historicalOperations] = await pool.execute('SELECT (SELECT COUNT(*) FROM cash_sessions WHERE business_id=?) AS sessions,(SELECT COUNT(*) FROM inventory_movements WHERE business_id=?) AS inventory,(SELECT COUNT(*) FROM expenses WHERE business_id=?) AS expenses,(SELECT COUNT(*) FROM sale_orders WHERE business_id=?) AS orders', [target,target,target,target]);
  assert.deepEqual(Object.values(historicalOperations[0]).map(Number), [0,0,0,0]);
  await pool.execute('UPDATE products SET stock=5.000 WHERE business_id=? AND barcode=?', [target,'CAF-01']);
  const reconciledAfterChange = await service.projectMigrationCatalog(admin,target,archived.batchId);
  assert.equal(reconciledAfterChange.reconciliation.stageMatched, false);
  assert.ok(reconciledAfterChange.reconciliation.differences.some(item => item.module === 'products' && item.field === 'stock' && item.expected === '4.500' && item.found === '5.000'));
  const [gate] = await pool.execute('SELECT b.status,c.state,c.batch_id FROM businesses b JOIN business_migration_controls c ON c.business_id=b.id WHERE b.id=?', [target]);
  assert.deepEqual([gate[0].status,gate[0].state,gate[0].batch_id], ['INACTIVE','PENDING',archived.batchId]);
});

test('explicit package confirmation allows shared-ID catalog data while keeping the business blocked', async t => {
  const config = readConfig();
  const pool = createDatabasePool({ ...config.database, database, connectionLimit: 8 });
  t.after(() => pool.end());
  const target = await createTarget(pool, 'Proyeccion antigua prueba');
  const repository = createAuthRepository(pool, readAuthConfig({ CSRF_SECRET: 'c'.repeat(64) }));
  const service = createSystemAdminService(repository, { imageStore: { saveMigration: async businessId => '/api/product-images/' + businessId + '/' + 'a'.repeat(32) + '.jpg' } });
  const admin = { username: 'andres', role: 'ADMIN', business_id: '1', user_id: '1' };
  const { value } = await fixture();
  value.business.name = 'Proyeccion antigua prueba';
  value.data.products[0].business_id = '00000000-0000-0000-0000-000000000000';
  value.source.scope.legacyRecords = 0;
  await assert.rejects(service.archiveFullMigration(admin, target, value, false), error => error.publicCode === 'MIGRATION_ARCHIVE_CONFIRMATION_REQUIRED');
  const archived = await service.archiveFullMigration(admin, target, value, true);
  assert.equal(archived.identityConfirmationApplied, 1);
  const projected = await service.projectMigrationCatalog(admin, target, archived.batchId);
  assert.equal(projected.reconciliation.fullMigrationComplete, false);
  assert.equal(projected.reconciliation.pending.identityOrValidation, 0);
  const [catalog] = await pool.execute('SELECT COUNT(*) AS total FROM products WHERE business_id=?', [target]);
  assert.equal(Number(catalog[0].total), 1);
  const [commerce] = await pool.execute('SELECT (SELECT COUNT(*) FROM sales WHERE business_id=?) AS sales,(SELECT COUNT(*) FROM purchases WHERE business_id=?) AS purchases', [target, target]);
  assert.deepEqual(Object.values(commerce[0]).map(Number), [0, 0]);
  const [status] = await pool.execute('SELECT state FROM business_migration_controls WHERE business_id=?', [target]);
  assert.equal(status[0].state, 'PENDING');
});

test('catalog and operations stages reject a legacy batch without matching target and package attestation', async t => {
  const config = readConfig();
  const pool = createDatabasePool({ ...config.database, database, connectionLimit: 8 });
  t.after(() => pool.end());
  const target = await createTarget(pool, 'Legacy attestation gate');
  const repository = createAuthRepository(pool, readAuthConfig({ CSRF_SECRET: 'b'.repeat(64) }));
  const service = createSystemAdminService(repository);
  const admin = { username: 'andres', role: 'ADMIN', business_id: '1', user_id: '1' };
  const { value } = await fixture();
  value.data.products[0].business_id = '00000000-0000-0000-0000-000000000000';
  const archived = await service.archiveFullMigration(admin, target, value, true);
  const [batch] = await pool.execute('SELECT manifest FROM migration_import_batches WHERE business_id=? AND id=?', [target, archived.batchId]);
  const manifest = typeof batch[0].manifest === 'string' ? JSON.parse(batch[0].manifest) : batch[0].manifest;
  delete manifest.identityReview.batchConfirmation;
  await pool.execute('UPDATE migration_import_batches SET manifest=? WHERE business_id=? AND id=?', [JSON.stringify(manifest), target, archived.batchId]);
  await assert.rejects(service.projectMigrationCatalog(admin, target, archived.batchId), error => error.publicCode === 'MIGRATION_LEGACY_IDENTITY_CONFIRMATION_REQUIRED');
  await assert.rejects(service.projectMigrationOperations(admin, target, archived.batchId), error => error.publicCode === 'MIGRATION_LEGACY_IDENTITY_CONFIRMATION_REQUIRED');
  const [counts] = await pool.execute('SELECT COUNT(*) AS products FROM products WHERE business_id=?', [target]);
  assert.equal(Number(counts[0].products), 0);
});

test('admin projects one complete fictitious local package through existing importers without changing live stock or cash', async t => {
  const config = readConfig();
  const pool = createDatabasePool({ ...config.database, database, connectionLimit: 12 });
  const imageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pos-migration-operations-'));
  t.after(async () => { await pool.end(); await fs.rm(imageRoot, { recursive: true, force: true }); });
  const sourceId = 'complete-fixture-local-business';
  const target = await createTarget(pool, 'Destino integral ficticio');
  await pool.execute('INSERT INTO users (business_id,username,full_name,password_hash,role) VALUES (?,?,?,?,?)',
    [target, 'migration-fixture-admin', 'Administrador conectado de prueba', 'hash-de-prueba', 'ADMIN']);
  const repository = createAuthRepository(pool, readAuthConfig({ CSRF_SECRET: 'd'.repeat(64) }));
  const imageStore = createImageStore({ root: imageRoot, quota: 10 * 1024 * 1024 });
  const service = createSystemAdminService(repository, { imageStore });
  const admin = { username: 'andres', role: 'ADMIN', business_id: '1', user_id: '1' };
  const image = 'data:image/png;base64,' + (await sharp({ create: { width: 3, height: 3, channels: 3, background: '#345678' } }).png().toBuffer()).toString('base64');
  const value = {
    type: 'pos_local_migration_package', version: 2, exportedAt: '2024-06-10T12:00:00.000Z',
    source: { mode: 'local', scope: { idSource: 'config', localBusinessId: sourceId, idsFound: 1, legacyRecords: 0, excludedRecords: 0, missingStores: [] } },
    business: { name: 'Negocio Ficticio Local', localBusinessId: sourceId },
    data: {
      products: [{ id: 'product-1', business_id: sourceId, name: 'Café de prueba', barcode: 'FIX-001', category: 'Abarrotes', cost: '2.00', marginRetail: '0.0000', marginWholesale: '0.0000', retailPrice: '10.00', wholesalePrice: '9.00', stock: '8.000', minStock: '1.000', taxRate: '0.0000', active: true, image }],
      clients: [{ id: 'client-1', business_id: sourceId, name: 'Cliente Ficticio', creditLimit: '100.00', debt: '15.00', deudaSinFactura: '0.00', openingBalance: '0.00', active: true }],
      suppliers: [{ id: 'supplier-1', business_id: sourceId, name: 'Proveedor Ficticio', contact: 'Ventas', phone: '5550001', debt: '10.00', active: true }],
      sales: [
        { id: 'sale-cash-1', business_id: sourceId, invoiceNumber: 'V-FIX-001', createdAt: '2024-06-10T09:00:00.000Z', saleType: 'CASH', paymentMethod: 'CASH', subtotal: '20.00', discount: '0.00', discountPercent: '0.0000', tax: '0.00', total: '20.00', status: 'COMPLETED', items: [{ productId: 'product-1', quantity: '2.000', unitPrice: '10.00', subtotal: '20.00', discount: '0.00', tax: '0.00', total: '20.00', costAtSale: '2.00', taxRate: '0.0000' }] },
        { id: 'sale-credit-1', business_id: sourceId, invoiceNumber: 'V-FIX-002', factura: 'V-FIX-002', createdAt: '2024-06-10T10:00:00.000Z', fechaTS: Date.parse('2024-06-10T10:00:00.000Z'), dueAt: '2024-07-10T10:00:00.000Z', vencimientoTS: Date.parse('2024-07-10T10:00:00.000Z'), clientId: 'client-1', clienteId: 'client-1', cliente: 'Cliente Ficticio', saleType: 'CREDIT', tipo: 'credito', paymentMethod: 'CREDIT', medioPago: 'credit', subtotal: '20.00', discount: '0.00', descuentoMonto: '0.00', discountPercent: '0.0000', tax: '0.00', total: '20.00', status: 'COMPLETED', items: [{ productId: 'product-1', producto: 'Café de prueba', codigo: 'FIX-001', cantidad: '2.000', costo: '2.00', precio: '10.00', quantity: '2.000', unitPrice: '10.00', subtotal: '20.00', discount: '0.00', tax: '0.00', total: '20.00', costAtSale: '2.00', taxRate: '0.0000' }] },
        { id: 'sale-cancelled-1', business_id: sourceId, invoiceNumber: 'V-FIX-003', createdAt: '2024-06-10T15:00:00.000Z', saleType: 'CASH', paymentMethod: 'CASH', subtotal: '5.00', discount: '0.00', discountPercent: '0.0000', tax: '0.00', total: '5.00', status: 'CANCELLED', cancelledAt: '2024-06-10T16:00:00.000Z', cancelReason: 'Anulación de prueba', items: [{ productId: 'product-1', quantity: '1.000', unitPrice: '5.00', subtotal: '5.00', discount: '0.00', tax: '0.00', total: '5.00', costAtSale: '2.00', taxRate: '0.0000' }] }
      ],
      purchases: [
        { id: 'purchase-1', business_id: sourceId, invoiceNumber: 'C-FIX-001', createdAt: '2024-06-09T08:00:00.000Z', dueAt: '2024-07-09T08:00:00.000Z', purchaseType: 'CREDIT', supplierId: 'supplier-1', supplierName: 'Proveedor Ficticio', subtotal: '15.00', discount: '0.00', tax: '0.00', total: '15.00', status: 'COMPLETED', items: [{ productId: 'product-1', quantity: '3.000', cost: '5.00', subtotal: '15.00', discount: '0.00', tax: '0.00', total: '15.00' }] },
        { id: 'purchase-cancelled-1', business_id: sourceId, factura: 'C-FIX-002', facturaNumero: 'C-FIX-002', fechaTS: Date.parse('2024-06-08T08:00:00.000Z'), tipo: 'contado', proveedorId: 'supplier-1', proveedor: 'Proveedor Ficticio', subtotal: '5.00', total: '5.00', anulada: true, fechaAnulacion: '2024-06-08T09:00:00.000Z', motivoAnulacion: 'Anulación de prueba', items: [{ productId: 'product-1', producto: 'Café de prueba', codigo: 'FIX-001', cantidad: '1.000', costo: '5.00', subtotal: '5.00', total: '5.00' }] }
      ],
      cashSessions: [
        { id: 'cash-1', business_id: sourceId, status: 'CLOSED', openedAt: '2024-06-10T08:00:00.000Z', closedAt: '2024-06-10T18:00:00.000Z', openingAmount: '100.00', expectedAmount: '110.00', countedAmount: '110.00', difference: '0.00', openedBy: 'Cajera histórica', closedBy: 'Supervisora histórica', movimientos: [
        { type: 'SALE', direction: 'IN', amount: '20.00', saleId: 'sale-cash-1', paymentMethod: 'CASH', status: 'POSTED', createdAt: '2024-06-10T09:00:00.000Z' },
        { type: 'CUSTOMER_PAYMENT', direction: 'IN', amount: '5.00', customerPaymentId: 'payment-client-1', paymentMethod: 'CASH', status: 'POSTED', createdAt: '2024-06-10T11:00:00.000Z' },
        { type: 'SUPPLIER_PAYMENT', direction: 'OUT', amount: '5.00', supplierPaymentId: 'payment-supplier-1', paymentMethod: 'TRANSFER', status: 'POSTED', createdAt: '2024-06-10T12:00:00.000Z' },
        { type: 'EXPENSE', direction: 'OUT', amount: '10.00', expenseId: 'expense-1', paymentMethod: 'CASH', status: 'POSTED', createdAt: '2024-06-10T13:00:00.000Z' }
        ] },
        { id: 'cash-open-1', business_id: sourceId, status: 'OPEN', openedAt: '2024-06-10T19:00:00.000Z', openingAmount: '50.00', openedBy: 'Cajera de cierre pendiente', movimientos: [] }
      ],
      inventoryMovements: [
        { id: 'inventory-1', business_id: sourceId, productId: 'product-1', type: 'ADJUSTMENT', quantity: '1.000', stockAfter: '8.000', unitCost: '2.00', reason: 'Ajuste histórico de prueba', createdAt: '2024-06-08T10:00:00.000Z' },
        { id: 'inventory-zero-1', business_id: sourceId, productId: 'product-1', type: 'INITIAL', quantity: '0.000', stockAfter: '8.000', unitCost: '2.00', reason: 'Evento inicial sin cambio', usuario: 'Responsable histórico', createdAt: '2024-06-08T09:00:00.000Z' }
      ],
      abonos: [
        { id: 'payment-client-1', business_id: sourceId, tipo: 'cliente', referenciaId: 'client-1', facturaId: 'sale-credit-1', amount: '5.00', monto: '5.00', paymentMethod: 'CASH', metodoPago: 'efectivo', status: 'POSTED', estado: 'confirmado', createdAt: '2024-06-10T11:00:00.000Z', fechaTS: '2024-06-10T11:00:00.000Z' },
        { id: 'payment-supplier-1', business_id: sourceId, tipo: 'proveedor', supplierId: 'supplier-1', purchaseId: 'purchase-1', amount: '5.00', monto: '5.00', paymentMethod: 'TRANSFER', metodoPago: 'transferencia', status: 'POSTED', estado: 'confirmado', createdAt: '2024-06-10T12:00:00.000Z', fechaTS: '2024-06-10T12:00:00.000Z', cashSessionId: 'cash-1' }
      ],
      expenses: [{ id: 'expense-1', business_id: sourceId, sessionId: 'cash-1', amount: '10.00', category: 'Servicios', description: 'Gasto histórico de prueba', paymentMethod: 'CASH', status: 'POSTED', createdAt: '2024-06-10T13:00:00.000Z' }],
      auditLogs: [{ id: 'audit-1', business_id: sourceId, action: 'LOCAL_SALE_CREATED', entity: 'sales', entity_id: 'sale-cash-1', details: { note: 'evento de prueba' }, createdAt: '2024-06-10T09:00:00.000Z', actorName: 'Cajera histórica' }],
      saleOrders: [{ id: 'order-1', business_id: sourceId, status: 'PENDING', createdAt: '2024-06-10T14:00:00.000Z', subtotal: '10.00', discount: '0.00', total: '10.00', priceType: 'RETAIL', items: [{ productId: 'product-1', quantity: '1.000', unitPrice: '10.00', subtotal: '10.00' }] }],
      syncQueue: [], configuration: { name: 'Negocio Ficticio Local', localBusinessId: sourceId, currency: 'C$', ruc: 'J0000000000000', address: 'Dirección ficticia' }, categories: ['Abarrotes']
    }
  };
  const originalPackage = JSON.stringify(value);
  const archived = await service.archiveFullMigration(admin, target, value, true);
  assert.ok(['ARCHIVED', 'BLOCKED'].includes(archived.status));
  const [storedBatch] = await pool.execute('SELECT manifest FROM migration_import_batches WHERE business_id=? AND id=?', [target, archived.batchId]);
  const storedManifest = typeof storedBatch[0].manifest === 'string' ? JSON.parse(storedBatch[0].manifest) : storedBatch[0].manifest;
  assert.deepEqual(storedManifest.blockers, []);
  const catalog = await service.projectMigrationCatalog(admin, target, archived.batchId);
  assert.equal(catalog.reconciliation.stageMatched, true, JSON.stringify(catalog.reconciliation));
  let interruptAfterZeroInventoryInsert = true;
  const interruptedRepo = { ...repository, rows: async (db, sql, values) => {
    if (interruptAfterZeroInventoryInsert && String(sql).startsWith('INSERT INTO audit_logs (business_id,user_id,action,entity,entity_id,details,created_at)')) {
      interruptAfterZeroInventoryInsert = false;
      throw new Error('simulated interruption after zero inventory event projection');
    }
    return repository.rows(db, sql, values);
  } };
  const interruptedService = createSystemAdminService(interruptedRepo, { imageStore });
  await assert.rejects(interruptedService.projectMigrationOperations(admin, target, archived.batchId), /simulated interruption/);
  const [rolledBackAuxiliary] = await pool.execute('SELECT (SELECT COUNT(*) FROM supplier_payments WHERE business_id=? AND is_historical=TRUE) AS supplierPayments,(SELECT COUNT(*) FROM cash_sessions WHERE business_id=? AND is_historical=TRUE) AS sessions,(SELECT COUNT(*) FROM cash_movements WHERE business_id=? AND is_historical=TRUE) AS movements,(SELECT COUNT(*) FROM expenses WHERE business_id=? AND is_historical=TRUE) AS expenses,(SELECT COUNT(*) FROM inventory_movements WHERE business_id=? AND is_historical=TRUE) AS inventory,(SELECT COUNT(*) FROM migration_zero_inventory_events WHERE business_id=?) AS zeroInventoryEvents FROM businesses WHERE id=?', [target,target,target,target,target,target,target]);
  assert.deepEqual(Object.values(rolledBackAuxiliary[0]).map(Number), [0,0,0,0,0,0], 'la etapa auxiliar debe revertirse entera si se interrumpe');
  const projected = await service.projectMigrationOperations(admin, target, archived.batchId);
  assert.equal(JSON.stringify(value), originalPackage, 'el paquete de origen debe permanecer intacto');
  assert.equal(projected.businessStatus, 'INACTIVE');
  assert.equal(projected.reconciliation.businessActivated, false);
  assert.equal(projected.reconciliation.complete, true, JSON.stringify(projected.reconciliation));
  const [operational] = await pool.execute('SELECT (SELECT COUNT(*) FROM sales WHERE business_id=? AND is_historical=TRUE) AS sales,(SELECT COUNT(*) FROM purchases WHERE business_id=? AND is_historical=TRUE) AS purchases,(SELECT COUNT(*) FROM customer_payments WHERE business_id=? AND is_historical=TRUE) AS customerPayments,(SELECT COUNT(*) FROM supplier_payments WHERE business_id=? AND is_historical=TRUE) AS supplierPayments,(SELECT COUNT(*) FROM cash_sessions WHERE business_id=? AND is_historical=TRUE) AS cashSessions,(SELECT COUNT(*) FROM cash_movements WHERE business_id=? AND is_historical=TRUE) AS cashMovements,(SELECT COUNT(*) FROM expenses WHERE business_id=? AND is_historical=TRUE) AS expenses,(SELECT COUNT(*) FROM inventory_movements WHERE business_id=? AND is_historical=TRUE) AS inventoryMovements,(SELECT COUNT(*) FROM sale_orders WHERE business_id=? AND is_historical=TRUE) AS orders,(SELECT COUNT(*) FROM migration_zero_inventory_events WHERE business_id=?) AS zeroInventoryEvents FROM businesses WHERE id=?', [target,target,target,target,target,target,target,target,target,target,target,target]);
  assert.deepEqual(Object.values(operational[0]).map(Number), [3,2,1,1,2,4,1,1,1,1]);
  const [history] = await pool.execute('SELECT (SELECT GROUP_CONCAT(CONCAT(invoice_number,\':\',status,\':\',DATE_FORMAT(created_at,\'%Y-%m-%d %H:%i:%s\')) ORDER BY invoice_number SEPARATOR \',\') FROM sales WHERE business_id=? AND is_historical=TRUE) AS sales,(SELECT GROUP_CONCAT(CONCAT(invoice_number,\':\',status) ORDER BY invoice_number SEPARATOR \',\') FROM purchases WHERE business_id=? AND is_historical=TRUE) AS purchases,(SELECT CONCAT(amount,\':\',payment_method,\':\',status,\':\',purchase_id) FROM supplier_payments WHERE business_id=? AND is_historical=TRUE LIMIT 1) AS supplierPayment,(SELECT CONCAT(amount,\':\',payment_method,\':\',status,\':\',sale_id) FROM customer_payments WHERE business_id=? AND is_historical=TRUE LIMIT 1) AS customerPayment,(SELECT CONCAT(status,\':\',opening_amount,\':\',expected_amount,\':\',counted_amount,\':\',difference,\':\',source_opened_by,\':\',source_closed_by) FROM cash_sessions WHERE business_id=? AND is_historical=TRUE LIMIT 1) AS cashSession,(SELECT CONCAT(amount,\':\',payment_method,\':\',status) FROM expenses WHERE business_id=? AND is_historical=TRUE LIMIT 1) AS expense,(SELECT CONCAT(quantity,\':\',stock_after,\':\',unit_cost,\':\',DATE_FORMAT(created_at,\'%Y-%m-%d %H:%i:%s\')) FROM inventory_movements WHERE business_id=? AND is_historical=TRUE LIMIT 1) AS inventory,(SELECT CONCAT(status,\':\',estimated_total,\':\',COALESCE(sale_id,\'NULL\')) FROM sale_orders WHERE business_id=? AND is_historical=TRUE LIMIT 1) AS saleOrder,(SELECT JSON_UNQUOTE(JSON_EXTRACT(details,\'$.sourcePayload.details.note\')) FROM audit_logs WHERE business_id=? AND action=\'LOCAL_HISTORY\' LIMIT 1) AS auditNote,(SELECT opening_balance+COALESCE((SELECT SUM(total) FROM sales WHERE business_id=c.business_id AND client_id=c.id AND sale_type=\'CREDIT\' AND status=\'COMPLETED\'),0)-COALESCE((SELECT SUM(amount) FROM customer_payments WHERE business_id=c.business_id AND client_id=c.id AND status=\'POSTED\'),0) FROM clients c WHERE c.business_id=? LIMIT 1) AS clientDebt,(SELECT COALESCE((SELECT SUM(total) FROM purchases WHERE business_id=s.business_id AND supplier_id=s.id AND purchase_type=\'CREDIT\' AND status=\'COMPLETED\' AND is_historical=TRUE),0)-COALESCE((SELECT SUM(p.amount) FROM supplier_payments p JOIN purchases pc ON pc.business_id=p.business_id AND pc.id=p.purchase_id WHERE p.business_id=s.business_id AND p.supplier_id=s.id AND pc.purchase_type=\'CREDIT\' AND pc.is_historical=TRUE AND p.is_historical=TRUE AND p.status=\'POSTED\'),0) FROM suppliers s WHERE s.business_id=? LIMIT 1) AS supplierDebt FROM businesses WHERE id=?', [target,target,target,target,target,target,target,target,target,target,target,target]);
  assert.equal(history[0].sales.split(',').map(value => value.slice(value.indexOf(':') + 1)).join(','), 'COMPLETED:2024-06-10 09:00:00,COMPLETED:2024-06-10 10:00:00,CANCELLED:2024-06-10 15:00:00');
  assert.equal(history[0].purchases, 'C-FIX-001:COMPLETED,C-FIX-002:CANCELLED');
  assert.equal(history[0].supplierPayment.split(':').slice(0, 3).join(':'), '5.00:TRANSFER:POSTED');
  assert.equal(history[0].customerPayment.split(':').slice(0, 3).join(':'), '5.00:CASH:POSTED');
  assert.equal(history[0].cashSession, 'CLOSED:100.00:110.00:110.00:0.00:Cajera histórica:Supervisora histórica');
  assert.equal(history[0].expense, '10.00:CASH:POSTED');
  assert.equal(history[0].inventory, '1.000:8.000:2.00:2024-06-08 10:00:00');
  const [zeroEvent] = await pool.execute('SELECT quantity,stock_after AS stockAfter,source_type AS sourceType,reason,source_actor AS sourceActor,DATE_FORMAT(occurred_at,\'%Y-%m-%d %H:%i:%s.%f\') AS occurredAt,product_id AS productId,source_payload AS sourcePayload FROM migration_zero_inventory_events WHERE business_id=? AND batch_id=?', [target, archived.batchId]);
  assert.equal(zeroEvent.length, 1);
  assert.deepEqual([zeroEvent[0].quantity, zeroEvent[0].stockAfter, zeroEvent[0].sourceType, zeroEvent[0].reason, zeroEvent[0].sourceActor, zeroEvent[0].occurredAt.slice(0, 23)], ['0.000', '8.000', 'INITIAL', 'Evento inicial sin cambio', 'Responsable histórico', '2024-06-08 09:00:00.000']);
  const [productMapping] = await pool.execute("SELECT target_record_id AS targetProductId FROM migration_source_records WHERE business_id=? AND batch_id=? AND entity_type='products' AND source_record_key='id:product-1'", [target, archived.batchId]);
  assert.equal(String(zeroEvent[0].productId), String(productMapping[0].targetProductId));
  assert.equal(history[0].saleOrder, 'PENDING:10.00:NULL');
  assert.equal(history[0].auditNote, 'evento de prueba');
  assert.deepEqual([history[0].clientDebt, history[0].supplierDebt], ['15.00', '10.00']);
  const [sourceLinks] = await pool.execute('SELECT (SELECT COUNT(*) FROM migration_sales_references WHERE business_id=? AND source_sale_id IN (\'sale-cash-1\',\'sale-credit-1\',\'sale-cancelled-1\')) AS sales,(SELECT COUNT(*) FROM sales WHERE business_id=? AND is_historical=TRUE AND detail LIKE \'%Factura local: V-FIX-%\') AS originalSaleInvoices,(SELECT COUNT(*) FROM migration_purchase_references WHERE business_id=? AND source_purchase_id IN (\'purchase-1\',\'purchase-cancelled-1\')) AS purchases,(SELECT COUNT(*) FROM migration_source_records r JOIN customer_payments p ON p.business_id=r.business_id AND p.id=r.target_record_id WHERE r.business_id=? AND r.batch_id=? AND r.entity_type=\'abonos\' AND r.source_record_key=\'id:payment-client-1\' AND p.sale_id=(SELECT sale_id FROM migration_sales_references WHERE business_id=? AND source_sale_id=\'sale-credit-1\')) AS customerPayment,(SELECT COUNT(*) FROM migration_supplier_payment_references r JOIN supplier_payments p ON p.business_id=r.business_id AND p.id=r.supplier_payment_id WHERE r.business_id=? AND r.source_payment_id=\'payment-supplier-1\' AND p.purchase_id=(SELECT purchase_id FROM migration_purchase_references WHERE business_id=? AND source_purchase_id=\'purchase-1\')) AS supplierPayment FROM businesses WHERE id=?', [target,target,target,target,archived.batchId,target,target,target,target]);
  assert.deepEqual(Object.values(sourceLinks[0]).map(Number), [3,3,2,1,1], 'los identificadores y referencias locales deben apuntar a las operaciones correctas');
  const [openSessionHistory] = await pool.execute('SELECT COUNT(*) AS count FROM cash_sessions WHERE business_id=? AND is_historical=TRUE AND status=\'CLOSED\' AND source_status=\'OPEN\' AND closed_at IS NULL AND counted_amount IS NULL AND expected_amount IS NULL AND source_opened_by=\'Cajera de cierre pendiente\'', [target]);
  assert.equal(Number(openSessionHistory[0].count), 1, 'una caja local abierta conserva su estado original, pero no se convierte en caja conectada activa');
  const [balances] = await pool.execute('SELECT (SELECT stock FROM products WHERE business_id=? AND barcode=?) AS stock,(SELECT COUNT(*) FROM inventory_movements WHERE business_id=? AND is_historical=FALSE) AS liveInventory,(SELECT COUNT(*) FROM cash_sessions WHERE business_id=? AND status=\'OPEN\') AS openCash,(SELECT COUNT(*) FROM sale_orders WHERE business_id=? AND is_historical=FALSE) AS liveOrders', [target,'FIX-001',target,target,target]);
  assert.deepEqual([balances[0].stock, Number(balances[0].liveInventory), Number(balances[0].openCash), Number(balances[0].liveOrders)], ['8.000',0,0,0]);
  const zeroPayload = typeof zeroEvent[0].sourcePayload === 'string' ? JSON.parse(zeroEvent[0].sourcePayload) : zeroEvent[0].sourcePayload;
  assert.equal(zeroPayload.quantity, '0.000');
  const inventoryRepo = {
    rows: async (db, sql, values) => String(sql).startsWith('SELECT id FROM sessions') ? [{ id: 'migration-fixture-session' }] : repository.rows(db, sql, values),
    tenant: async (_session, action) => {
      const connection = await pool.getConnection();
      try { return await action(connection, { business_id: target, user_id: '1', session_id: 'migration-fixture-session' }); }
      finally { connection.release(); }
    }
  };
  const inventoryService = createInventoryService({ repo: inventoryRepo, auth: { canAccess: async () => true }, config: { absoluteSeconds: 86400 } }, imageStore);
  const kardex = await inventoryService.movements({}, { productId: String(zeroEvent[0].productId), limit: 20, offset: 0 });
  assert.equal(kardex.length, 2);
  assert.ok(kardex.some(row => row.historicalEvent && row.quantity === '0.000' && row.stockAfter === '8.000' && row.reason === 'Evento inicial sin cambio'));
  assert.equal(kardex.reduce((sum, row) => sum + Number(row.quantity), 0), 1, 'el evento cero debe ser visible sin cambiar la suma del Kardex');
  await assert.rejects(service.projectMigrationOperations(admin, target, archived.batchId));
  const [afterRetry] = await pool.execute('SELECT (SELECT COUNT(*) FROM sales WHERE business_id=?) AS sales,(SELECT COUNT(*) FROM purchases WHERE business_id=?) AS purchases,(SELECT COUNT(*) FROM supplier_payments WHERE business_id=?) AS payments,(SELECT COUNT(*) FROM cash_sessions WHERE business_id=? AND is_historical=TRUE) AS sessions,(SELECT COUNT(*) FROM cash_movements WHERE business_id=? AND is_historical=TRUE) AS movements,(SELECT COUNT(*) FROM migration_zero_inventory_events WHERE business_id=?) AS zeroInventoryEvents FROM businesses WHERE id=?', [target,target,target,target,target,target,target]);
  assert.deepEqual(Object.values(afterRetry[0]).map(Number), [3,2,1,2,4,1]);
  const [gate] = await pool.execute('SELECT b.status,c.state FROM businesses b JOIN business_migration_controls c ON c.business_id=b.id WHERE b.id=?', [target]);
  assert.deepEqual([gate[0].status, gate[0].state], ['INACTIVE', 'COMPLETE']);
});
