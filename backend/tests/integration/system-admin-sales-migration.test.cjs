'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { existsSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { readConfig } = require('../../src/config/environment');
const { readAuthConfig } = require('../../src/config/auth');
const { createDatabasePool } = require('../../src/config/database');
const { createAuthRepository, rows } = require('../../src/repositories/auth');
const { createSystemAdminService } = require('../../src/services/system-admin');

const database = process.env.POS_INTEGRATION_DATABASE;
if (!/^pos_auth_test_[a-f0-9]{24}$/.test(database || '') || database === process.env.DB_NAME) throw new Error('Usar el ejecutor aislado');

function mysqlDate(value) {
  return value instanceof Date ? value.toISOString().slice(0, 23).replace('T', ' ') : String(value);
}

test('MySQL migra ventas historicas sin operaciones financieras y de forma atomica e idempotente', async t => {
  const config = readConfig();
  const authConfig = readAuthConfig({ CSRF_SECRET: randomBytes(32).toString('hex'), AUTH_RATE_MAX: '100' });
  const pool = createDatabasePool({ ...config.database, database, connectionLimit: 20 });
  t.after(() => pool.end());
  const targetBusiness = String((await rows(pool, 'INSERT INTO businesses (name) VALUES (?)', ['Destino ventas historicas'])).insertId);
  await rows(pool,
    'INSERT INTO users (business_id, username, full_name, password_hash, role) VALUES (?, ?, ?, ?, ?)',
    [targetBusiness, 'migracion-test', 'Usuario migracion', 'hash-de-prueba', 'ADMIN']);
  const repo = createAuthRepository(pool, authConfig);
  const service = createSystemAdminService(repo);
  const admin = { username: 'andres', role: 'ADMIN', business_id: '1', user_id: '7' };
  const sourcePackage = {
    type: 'pos_local_migration_package',
    version: 1,
    exportedAt: '2026-10-13T12:00:00.000Z',
    business: { name: 'Local ventas historicas' },
    data: {
      products: [{ id: 'local-product-1', barcode: 'MIG-SALE-1', name: 'Producto historico', category: 'Abarrotes', cost: '4.25', stock: '5.500', tax_rate: '5.0000' }],
      clients: [{ id: 'local-client-1', name: 'Cliente historico' }],
      suppliers: [],
      inventoryMovements: [],
      sales: [
        {
          id: 'local-sale-1',
          invoiceNumber: 'F-100',
          createdAt: '2025-04-10T15:30:00.000Z',
          clientId: 'local-client-1',
          saleType: 'CASH',
          paymentMethod: 'CASH',
          subtotal: '30.00',
          discount: '2.00',
          discountPercent: '6.6667',
          tax: '1.50',
          total: '29.50',
          detail: 'Venta historica de prueba',
          items: [{
            productId: 'local-product-1',
            quantity: '2.000',
            unitPrice: '15.00',
            subtotal: '30.00',
            discount: '2.00',
          tax: '1.50',
            total: '29.50',
            costAtSale: '4.25',
            taxRate: '5.0000'
          }]
        },
        {
          id: 'local-sale-2',
          invoiceNumber: 'F-101',
          createdAt: '2025-04-11T09:15:00.000Z',
          clientId: 'local-client-1',
          saleType: 'CREDIT',
          paymentMethod: 'CREDIT',
          subtotal: '4.00',
          total: '4.00',
          dueAt: '2025-05-11T09:15:00.000Z',
          detail: 'Venta historica a credito',
          items: [{
            productId: 'local-product-1',
            quantity: '1.000',
            unitPrice: '4.00',
            subtotal: '4.00',
            total: '4.00',
            costAtSale: '4.25'
          }]
        },
        ...[0, 1].map(() => ({
          invoiceNumber: 'F-102',
          createdAt: '2025-04-12T10:00:00.000Z',
          clientId: 'local-client-1',
          saleType: 'CASH',
          paymentMethod: 'CASH',
          subtotal: '4.00',
          total: '4.00',
          items: [{
            productId: 'local-product-1',
            quantity: '1.000',
            unitPrice: '4.00',
            subtotal: '4.00',
            total: '4.00',
            costAtSale: '4.25'
          }]
        }))
      ]
    }
  };

  await service.migrateBasic(admin, targetBusiness, sourcePackage, false);
  await service.migrateInventory(admin, targetBusiness, sourcePackage);
  const [productBefore] = await rows(pool,
    'SELECT id, stock FROM products WHERE business_id = ? AND barcode = ?',
    [targetBusiness, 'MIG-SALE-1']);
  const [client] = await rows(pool,
    'SELECT id FROM clients WHERE business_id = ? AND name = ?',
    [targetBusiness, 'Cliente historico']);
  assert.ok(productBefore);
  assert.ok(client);

  const ordinaryUser = { ...admin, username: 'usuario', role: 'VENDEDOR' };
  await assert.rejects(service.previewSalesMigration(ordinaryUser, targetBusiness, sourcePackage), { publicCode: 'SYSTEM_ADMIN_REQUIRED' });
  await assert.rejects(service.migrateSales({ ...admin, username: 'otro-admin', business_id: targetBusiness }, targetBusiness, sourcePackage), { publicCode: 'SYSTEM_ADMIN_REQUIRED' });

  const updatedPackage = structuredClone(sourcePackage);
  updatedPackage.exportedAt = '2026-10-14T18:00:00.000Z';
  updatedPackage.data.products[0].stock = '4.500';
  await service.migrateBasic(admin, targetBusiness, updatedPackage, false);
  const reviewedInventory = await service.previewInventoryMigration(admin, targetBusiness, updatedPackage);
  assert.equal(reviewedInventory.eligible, true);
  assert.equal(reviewedInventory.products.inventoryMovementsToCreate, 0);
  assert.equal(reviewedInventory.products.productsToSkip, 1);
  assert.ok(reviewedInventory.warnings.some(warning => warning.includes('stock destino no coincide')));

  const salesPreview = await service.previewSalesMigration(admin, targetBusiness, updatedPackage);
  assert.equal(salesPreview.eligible, true);
  assert.equal(salesPreview.gates.inventory, true);
  assert.equal(salesPreview.sales.couldMigrate, 3, salesPreview.warnings.map(warning => warning.replace(/\([^)]*\)/g, '(dato de prueba)')).join('; '));
  assert.equal(salesPreview.sales.toSkip, 1);
  assert.ok(salesPreview.warnings.some(warning => warning.includes('venta a crédito omitida') && warning.includes('decisión explícita')));

  let failReferenceInsert = true;
  const failingRepo = {
    ...repo,
    rows: async (db, sql, values) => {
      if (failReferenceInsert && sql.startsWith('INSERT INTO migration_sales_references')) {
        failReferenceInsert = false;
        throw new Error('forced migration rollback test');
      }
      return repo.rows(db, sql, values);
    }
  };
  const failingService = createSystemAdminService(failingRepo);
  await assert.rejects(failingService.migrateSales(admin, targetBusiness, updatedPackage), /forced migration rollback test/);
  for (const table of ['sales', 'sale_items', 'migration_sales_references']) {
    const [count] = await rows(pool, 'SELECT COUNT(*) AS count FROM ' + table + ' WHERE business_id = ?', [targetBusiness]);
    assert.equal(Number(count.count), 0, table + ' debe revertirse al fallar la transaccion');
  }

  const migrated = await service.migrateSales(admin, targetBusiness, updatedPackage);
  assert.deepEqual(migrated.created, { sales: 3 });
  assert.deepEqual(migrated.skipped, { sales: 1 });
  const sales = await rows(pool,
    'SELECT id, client_id, cash_session_id, invoice_number, sale_type, payment_method, subtotal, discount, discount_percent, tax, total, status, cash_status, detail, due_at, created_at FROM sales WHERE business_id = ? ORDER BY created_at, id',
    [targetBusiness]);
  assert.equal(sales.length, 3);
  assert.equal(String(sales[0].client_id), String(client.id));
  assert.equal(sales[0].cash_session_id, null);
  assert.equal(sales[0].subtotal, '30.00');
  assert.equal(sales[0].discount, '2.00');
  assert.equal(sales[0].discount_percent, '6.6667');
  assert.equal(sales[0].tax, '1.50');
  assert.equal(sales[0].total, '29.50');
  assert.equal(sales[0].status, 'COMPLETED');
  assert.equal(sales[0].cash_status, 'NOT_APPLICABLE');
  assert.match(sales[0].detail, /Venta historica de prueba/);
  assert.equal(mysqlDate(sales[0].created_at), '2025-04-10 15:30:00.000');
  assert.ok(sales.every(sale => sale.sale_type === 'CASH' && sale.payment_method !== 'CREDIT'));

  const items = await rows(pool,
    'SELECT sale_id, product_id, product_name, barcode, quantity, unit_price, tax_rate, discount, subtotal, total, cost_at_sale FROM sale_items WHERE business_id = ? ORDER BY sale_id',
    [targetBusiness]);
  assert.equal(items.length, 3);
  assert.ok(items.every(item => String(item.product_id) === String(productBefore.id)));
  assert.ok(items.every(item => item.product_name === 'Producto historico'));
  assert.ok(items.every(item => item.barcode === 'MIG-SALE-1'));
  assert.equal(items[0].quantity, '2.000');
  assert.equal(items[0].unit_price, '15.00');
  assert.equal(items[0].tax_rate, '5.0000');
  assert.equal(items[0].discount, '2.00');
  assert.equal(items[0].subtotal, '30.00');
  assert.equal(items[0].total, '29.50');
  assert.equal(items[0].cost_at_sale, '4.25');

  const reorderedPackage = structuredClone(updatedPackage);
  reorderedPackage.data.sales.reverse();
  const retry = await service.migrateSales(admin, targetBusiness, reorderedPackage);
  assert.deepEqual(retry.created, { sales: 0 });
  assert.deepEqual(retry.skipped, { sales: 4 });
  const [salesCount] = await rows(pool, 'SELECT COUNT(*) AS count FROM sales WHERE business_id = ?', [targetBusiness]);
  const [itemCount] = await rows(pool, 'SELECT COUNT(*) AS count FROM sale_items WHERE business_id = ?', [targetBusiness]);
  const [referenceCount] = await rows(pool, 'SELECT COUNT(*) AS count FROM migration_sales_references WHERE business_id = ?', [targetBusiness]);
  assert.equal(Number(salesCount.count), 3);
  assert.equal(Number(itemCount.count), 3);
  assert.equal(Number(referenceCount.count), 3);

  const [productAfter] = await rows(pool,
    'SELECT stock FROM products WHERE business_id = ? AND id = ?',
    [targetBusiness, productBefore.id]);
  assert.equal(productAfter.stock, productBefore.stock);
  const [movementCount] = await rows(pool,
    'SELECT COUNT(*) AS count FROM inventory_movements WHERE business_id = ? AND product_id = ?',
    [targetBusiness, productBefore.id]);
  assert.equal(Number(movementCount.count), 1, 'la revisión y migración de ventas no deben crear movimientos de inventario');
  for (const table of ['cash_sessions', 'cash_movements', 'customer_payments', 'inventory_movements']) {
    const [count] = await rows(pool, 'SELECT COUNT(*) AS count FROM ' + table + ' WHERE business_id = ?', [targetBusiness]);
    assert.equal(Number(count.count), table === 'inventory_movements' ? 1 : 0, table + ' no debe recibir efectos de migracion de ventas');
  }
});

test('el JSON real permite vista previa e importación aislada sin efectos operativos', async t => {
  const fixturePath = resolve(__dirname, '../../../prueba de ventas.json');
  if (!existsSync(fixturePath)) {
    t.skip('El JSON local de prueba no está disponible en este checkout.');
    return;
  }
  const packageValue = JSON.parse(readFileSync(fixturePath, 'utf8'));
  assert.equal(packageValue.data.sales.length, 4);
  const config = readConfig();
  const authConfig = readAuthConfig({ CSRF_SECRET: randomBytes(32).toString('hex'), AUTH_RATE_MAX: '100' });
  const pool = createDatabasePool({ ...config.database, database, connectionLimit: 20 });
  t.after(() => pool.end());
  const targetBusiness = String((await rows(pool, 'INSERT INTO businesses (name) VALUES (?)', ['Destino JSON real aislado'])).insertId);
  await rows(pool,
    'INSERT INTO users (business_id, username, full_name, password_hash, role) VALUES (?, ?, ?, ?, ?)',
    [targetBusiness, 'migracion-json-real', 'Usuario prueba real', 'hash-de-prueba', 'ADMIN']);
  const service = createSystemAdminService(createAuthRepository(pool, authConfig));
  const admin = { username: 'andres', role: 'ADMIN', business_id: '1', user_id: '7' };

  await service.migrateBasic(admin, targetBusiness, packageValue, false);
  await service.migrateInventory(admin, targetBusiness, packageValue);
  const stocksBefore = await rows(pool,
    'SELECT id, stock FROM products WHERE business_id = ? ORDER BY id',
    [targetBusiness]);
  const [movementsBefore] = await rows(pool,
    'SELECT COUNT(*) AS count FROM inventory_movements WHERE business_id = ?',
    [targetBusiness]);

  await rows(pool,
    'INSERT INTO audit_logs (business_id, user_id, action, entity, entity_id, details, created_at) VALUES (?, NULL, ?, ?, ?, ?, UTC_TIMESTAMP(3))',
    [targetBusiness, 'MIGRATION_SALES_IMPORT', 'businesses', targetBusiness, JSON.stringify({
      sourceBusinessName: packageValue.business.name,
      packageExportedAt: packageValue.exportedAt ?? null,
      summary: { created: { sales: 0 }, skipped: { sales: 4 } }
    })]);

  const preview = await service.previewSalesMigration(admin, targetBusiness, packageValue);
  assert.equal(preview.eligible, true);
  assert.equal(preview.sales.detected, 4);
  assert.equal(preview.sales.couldMigrate, 4, preview.warnings.map(warning => warning.replace(/\([^)]*\)/g, '(dato de prueba)')).join('; '));
  assert.equal(preview.sales.toSkip, 0);
  assert.equal(preview.warnings.length, 0);

  const imported = await service.migrateSales(admin, targetBusiness, packageValue);
  assert.deepEqual(imported.created, { sales: 4 });
  assert.deepEqual(imported.skipped, { sales: 0 });
  const sales = await rows(pool,
    'SELECT id, total, subtotal, discount, payment_method, sale_type, created_at FROM sales WHERE business_id = ? ORDER BY created_at, id',
    [targetBusiness]);
  assert.equal(sales.length, 4);
  assert.deepEqual(sales.map(sale => sale.total), ['24.20', '12.10', '24.20', '12.10']);
  assert.deepEqual(sales.map(sale => mysqlDate(sale.created_at)), packageValue.data.sales.map(sale => new Date(sale.fechaTS).toISOString().slice(0, 23).replace('T', ' ')));
  assert.ok(sales.every(sale => sale.sale_type === 'CASH' && sale.payment_method === 'CASH'));

  const items = await rows(pool,
    'SELECT sale_id, product_id, barcode, quantity, unit_price, subtotal, total FROM sale_items WHERE business_id = ? ORDER BY sale_id',
    [targetBusiness]);
  assert.equal(items.length, 4);
  assert.deepEqual(items.map(item => item.quantity), ['2.000', '1.000', '2.000', '1.000']);
  assert.ok(items.every(item => item.unit_price === '12.10' && item.total === item.subtotal));
  for (const item of items) {
    const [product] = await rows(pool,
      'SELECT id FROM products WHERE business_id = ? AND barcode = ?',
      [targetBusiness, item.barcode]);
    assert.ok(product);
    assert.equal(String(item.product_id), String(product.id));
  }

  const repeatedPreview = await service.previewSalesMigration(admin, targetBusiness, packageValue);
  assert.equal(repeatedPreview.sales.detected, 4);
  assert.equal(repeatedPreview.sales.couldMigrate, 0);
  assert.equal(repeatedPreview.sales.toSkip, 4);
  const repeatedImport = await service.migrateSales(admin, targetBusiness, packageValue);
  assert.deepEqual(repeatedImport.created, { sales: 0 });
  assert.deepEqual(repeatedImport.skipped, { sales: 4 });

  const stocksAfter = await rows(pool,
    'SELECT id, stock FROM products WHERE business_id = ? ORDER BY id',
    [targetBusiness]);
  const [movementsAfter] = await rows(pool,
    'SELECT COUNT(*) AS count FROM inventory_movements WHERE business_id = ?',
    [targetBusiness]);
  assert.deepEqual(stocksAfter, stocksBefore);
  assert.equal(Number(movementsAfter.count), Number(movementsBefore.count));
  for (const table of ['cash_sessions', 'cash_movements', 'customer_payments']) {
    const [count] = await rows(pool, 'SELECT COUNT(*) AS count FROM ' + table + ' WHERE business_id = ?', [targetBusiness]);
    assert.equal(Number(count.count), 0, table + ' debe permanecer sin cambios');
  }
});
