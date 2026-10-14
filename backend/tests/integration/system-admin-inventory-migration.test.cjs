'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { readConfig } = require('../../src/config/environment');
const { readAuthConfig } = require('../../src/config/auth');
const { createDatabasePool } = require('../../src/config/database');
const { createAuthRepository, rows } = require('../../src/repositories/auth');
const { createSystemAdminService } = require('../../src/services/system-admin');

const database = process.env.POS_INTEGRATION_DATABASE;
if (!/^pos_auth_test_[a-f0-9]{24}$/.test(database || '') || database === process.env.DB_NAME) throw new Error('Usar el ejecutor aislado');

test('MySQL registra inventario inicial desde un paquete despues de la migracion basica', async t => {
  const config = readConfig();
  const authConfig = readAuthConfig({ CSRF_SECRET: randomBytes(32).toString('hex'), AUTH_RATE_MAX: '100' });
  const pool = createDatabasePool({ ...config.database, database, connectionLimit: 20 });
  t.after(() => pool.end());
  const targetBusiness = String((await rows(pool, 'INSERT INTO businesses (name) VALUES (?)', ['Destino de pruebas'])).insertId);
  const repo = createAuthRepository(pool, authConfig);
  const service = createSystemAdminService(repo);
  const admin = { username: 'andres', role: 'ADMIN', business_id: '1', user_id: '7' };
  const sourcePackage = {
    type: 'pos_local_migration_package',
    version: 1,
    exportedAt: '2026-10-13T12:00:00.000Z',
    business: { name: 'Local de pruebas' },
    data: {
      products: [{ barcode: 'MIG-INV-1', name: 'Producto importado', category: 'Abarrotes', cost: '4.25', stock: '5.500' }],
      clients: [], suppliers: [],
      inventoryMovements: [{ id: 'local-1', type: 'SALE', quantity: '-1.000' }],
      sales: [{ id: 'ignored-sale' }], purchases: [{ id: 'ignored-purchase' }], cashSessions: [{ id: 'ignored-cash' }], abonos: [{ id: 'ignored-payment' }]
    }
  };

  await t.test('fase basica crea el producto y habilita el preview', async () => {
    const imported = await service.migrateBasic(admin, targetBusiness, sourcePackage, false);
    assert.deepEqual(imported.created, { products: 1, clients: 0, suppliers: 0 });
    const preview = await service.previewInventoryMigration(admin, targetBusiness, sourcePackage);
    assert.equal(preview.eligible, true);
    assert.equal(preview.products.productsWithStock, 1);
    assert.equal(preview.products.productsWithoutStock, 0);
    assert.equal(preview.products.productsToSkip, 0);
    assert.equal(preview.products.inventoryMovementsToCreate, 1);
  });

  await t.test('inserta un solo movimiento inicial y deja intactas otras tablas', async () => {
    const [product] = await rows(pool, 'SELECT id, stock FROM products WHERE business_id = ? AND barcode = ?', [targetBusiness, 'MIG-INV-1']);
    const first = await service.migrateInventory(admin, targetBusiness, sourcePackage);
    assert.deepEqual(first.created, { inventoryMovements: 1 });
    assert.deepEqual(first.skipped, { inventoryMovements: 0 });
    const entries = await rows(pool, 'SELECT business_id, product_id, user_id, type, quantity, stock_after, reason, unit_cost FROM inventory_movements WHERE business_id = ? AND product_id = ?', [targetBusiness, product.id]);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].business_id, targetBusiness);
    assert.equal(String(entries[0].product_id), String(product.id));
    assert.equal(entries[0].user_id, null);
    assert.equal(entries[0].type, 'MIGRACION_INICIAL');
    assert.equal(entries[0].quantity, '5.500');
    assert.equal(entries[0].stock_after, '5.500');
    assert.equal(entries[0].reason, 'Migración inicial desde paquete local');
    assert.equal(entries[0].unit_cost, '4.25');
    const [unchanged] = await rows(pool, 'SELECT stock FROM products WHERE business_id = ? AND id = ?', [targetBusiness, product.id]);
    assert.equal(unchanged.stock, product.stock);

    const retry = await service.migrateInventory(admin, targetBusiness, sourcePackage);
    assert.deepEqual(retry.created, { inventoryMovements: 0 });
    assert.deepEqual(retry.skipped, { inventoryMovements: 1 });
    const [audit] = await rows(pool, "SELECT details FROM audit_logs WHERE business_id = ? AND action = 'MIGRATION_INVENTORY_IMPORT' ORDER BY id DESC LIMIT 1", [targetBusiness]);
    const details = typeof audit.details === 'string' ? JSON.parse(audit.details) : audit.details;
    assert.equal(details.actor.username, 'andres');
    assert.equal(details.targetBusinessId, targetBusiness);
    assert.equal(details.sourceBusinessName, 'Local de pruebas');
    assert.equal(details.packageExportedAt, sourcePackage.exportedAt);
    assert.deepEqual(details.summary, { created: retry.created, skipped: retry.skipped });

    const [sales] = await rows(pool, 'SELECT COUNT(*) AS count FROM sales WHERE business_id = ?', [targetBusiness]);
    const [purchases] = await rows(pool, 'SELECT COUNT(*) AS count FROM purchases WHERE business_id = ?', [targetBusiness]);
    const [cash] = await rows(pool, 'SELECT COUNT(*) AS count FROM cash_sessions WHERE business_id = ?', [targetBusiness]);
    assert.equal(Number(sales.count), 0);
    assert.equal(Number(purchases.count), 0);
    assert.equal(Number(cash.count), 0);
  });
});
