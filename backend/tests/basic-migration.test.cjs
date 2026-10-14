'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createSystemAdminService } = require('../src/services/system-admin');
const { packageForImport, normalizeName } = require('../src/services/basic-migration-values');

const admin = { username: 'andres', role: 'ADMIN', business_id: '1', user_id: '7' };
const basicPackage = (overrides = {}) => ({
  type: 'pos_local_migration_package',
  version: 1,
  exportedAt: '2026-10-13T12:00:00.000Z',
  business: { name: 'Negocio de origen' },
  data: {
    products: [{ barcode: 'A-1', name: 'Producto nuevo', category: 'Abarrotes', cost: 2, retailPrice: 3, wholesalePrice: 2.5, stock: 4 }],
    clients: [{ name: 'Cliente nuevo', phone: '123' }],
    suppliers: [{ name: 'Proveedor nuevo', contact: 'Contacto' }]
  },
  ...overrides
});

function fakeRepo({ target = { id: '2', name: 'Destino', status: 'ACTIVE' }, products = [], clients = [], suppliers = [], failOnSupplier = false } = {}) {
  const state = { target, products: [...products], clients: [...clients], suppliers: [...suppliers], audits: [] };
  const repo = {
    pool: {},
    async transaction(work) {
      const snapshot = structuredClone(state);
      try { return await work({ transaction: true }); }
      catch (failure) {
        Object.assign(state, snapshot);
        throw failure;
      }
    },
    async rows(_db, sql, values) {
      if (sql.startsWith('SELECT id, name, status FROM businesses')) return state.target ? [state.target] : [];
      if (sql.startsWith('SELECT barcode, name FROM products')) return state.products;
      if (sql.startsWith('SELECT name FROM clients')) return state.clients;
      if (sql.startsWith('SELECT name FROM suppliers')) return state.suppliers;
      if (sql.startsWith('INSERT INTO products')) {
        const [, barcode, name, category, cost, marginRetail, marginWholesale, retailPrice, wholesalePrice, stock, minStock, taxRate, active] = values;
        if (state.products.some(item => item.barcode === barcode)) {
          const failure = new Error('duplicate barcode');
          failure.code = 'ER_DUP_ENTRY';
          throw failure;
        }
        state.products.push({ business_id: values[0], barcode, name, category, cost, marginRetail, marginWholesale, retailPrice, wholesalePrice, stock, minStock, taxRate, active });
        return { insertId: String(state.products.length) };
      }
      if (sql.startsWith('INSERT INTO clients')) {
        state.clients.push({ business_id: values[0], name: values[1] });
        return { insertId: String(state.clients.length) };
      }
      if (sql.startsWith('INSERT INTO suppliers')) {
        if (failOnSupplier) throw new Error('supplier insert failed');
        state.suppliers.push({ business_id: values[0], name: values[1] });
        return { insertId: String(state.suppliers.length) };
      }
      if (sql.startsWith('INSERT INTO audit_logs')) {
        state.audits.push({ sql, values });
        return { insertId: '1' };
      }
      throw new Error('Unexpected SQL: ' + sql);
    }
  };
  return { repo, state };
}

test('basic import package validates its envelope and maps only the basic stores', () => {
  const imported = packageForImport(basicPackage());
  assert.equal(imported.products.length, 1);
  assert.equal(imported.clients.length, 1);
  assert.equal(imported.suppliers.length, 1);
  assert.equal(imported.categoriesDetected, 1);
  assert.equal(imported.products[0].category, 'Abarrotes');
  for (const value of [
    null,
    { ...basicPackage(), type: 'other' },
    { ...basicPackage(), version: 2 },
    { ...basicPackage(), data: null },
    { ...basicPackage(), data: { ...basicPackage().data, products: [{ name: '', barcode: 'x' }] } }
  ]) assert.throws(() => packageForImport(value), error => error.publicCode === 'MIGRATION_PACKAGE_INVALID');
  assert.doesNotThrow(() => packageForImport({ ...basicPackage(), data: { ...basicPackage().data, sales: {} } }));
  assert.equal(normalizeName('  Café   Central '), 'cafe central');
});

test('basic import requires system administrator authorization and explicit system-business confirmation', async () => {
  const { repo } = fakeRepo();
  const service = createSystemAdminService(repo);
  await assert.rejects(service.migrateBasic({ ...admin, username: 'other' }, '2', basicPackage(), false), error => error.publicStatus === 403);
  await assert.rejects(service.migrateBasic(admin, '1', basicPackage(), false), error => error.publicCode === 'MIGRATION_SYSTEM_BUSINESS_CONFIRMATION_REQUIRED');
  const systemRepo = fakeRepo({ target: { id: '1', name: 'Sistema', status: 'ACTIVE' } });
  const result = await createSystemAdminService(systemRepo.repo).migrateBasic(admin, '1', basicPackage(), true);
  assert.equal(result.ok, true);
});

test('basic import skips normalized duplicates and audits only the selected target', async () => {
  const { repo, state } = fakeRepo({
    products: [{ barcode: 'ABC', name: 'Café molido' }],
    clients: [{ name: 'José Pérez' }],
    suppliers: [{ name: 'Distribución Uno' }]
  });
  const service = createSystemAdminService(repo);
  const source = basicPackage({
    data: {
      products: [
        { barcode: 'ABC', name: 'Otra descripción', category: 'Alimentos' },
        { barcode: '', name: 'CAFE MOLIDO', category: 'Alimentos' },
        { barcode: 'NEW', name: 'Producto nuevo', category: 'Alimentos', stock: 2 }
      ],
      clients: [{ name: 'JOSE   PEREZ' }, { name: 'Cliente nuevo' }],
      suppliers: [{ name: 'distribucion uno' }, { name: 'Proveedor nuevo' }],
      sales: [{ id: 'must-not-be-read' }],
      purchases: [{ id: 'must-not-be-read' }],
      cashSessions: [{ id: 'must-not-be-read' }],
      inventoryMovements: [{ id: 'must-not-be-read' }],
      abonos: [{ id: 'must-not-be-read' }]
    }
  });
  const result = await service.migrateBasic(admin, '2', source, false);
  assert.deepEqual(result.created, { products: 1, clients: 1, suppliers: 1 });
  assert.deepEqual(result.skipped, { products: 2, clients: 1, suppliers: 1 });
  assert.equal(state.products.at(-1).business_id, '2');
  assert.equal(state.products.at(-1).barcode, 'NEW');
  assert.equal(state.clients.at(-1).business_id, '2');
  assert.equal(state.suppliers.at(-1).business_id, '2');
  assert.equal(state.audits.length, 1);
  assert.deepEqual(state.audits[0].values.slice(0, 4), ['2', 'MIGRATION_BASIC_IMPORT', 'businesses', '2']);
  const details = JSON.parse(state.audits[0].values[4]);
  assert.equal(details.actor.username, 'andres');
  assert.equal(details.targetBusinessId, '2');
  assert.equal(details.sourceBusinessName, 'Negocio de origen');
  assert.equal(details.packageExportedAt, '2026-10-13T12:00:00.000Z');
  assert.deepEqual(details.summary.created, result.created);
  assert.equal(state.suppliers.length, 2);
});

test('basic import rejects a missing or inactive target before inserting', async () => {
  const missing = fakeRepo({ target: null });
  const service = createSystemAdminService(missing.repo);
  await assert.rejects(service.migrateBasic(admin, 'invalid', basicPackage(), false), error => error.publicCode === 'INVALID_INPUT');
  await assert.rejects(service.migrateBasic(admin, '2', basicPackage(), false), error => error.publicCode === 'BUSINESS_NOT_FOUND');
  const inactive = fakeRepo({ target: { id: '2', name: 'Destino', status: 'INACTIVE' } });
  await assert.rejects(createSystemAdminService(inactive.repo).migrateBasic(admin, '2', basicPackage(), false), error => error.publicCode === 'MIGRATION_TARGET_INACTIVE');
  assert.equal(inactive.state.products.length, 0);
});

test('basic import rolls back its inserts and audit when any insert fails', async () => {
  const { repo, state } = fakeRepo({ failOnSupplier: true });
  const service = createSystemAdminService(repo);
  await assert.rejects(service.migrateBasic(admin, '2', basicPackage(), false), /supplier insert failed/);
  assert.equal(state.products.length, 0);
  assert.equal(state.clients.length, 0);
  assert.equal(state.suppliers.length, 0);
  assert.equal(state.audits.length, 0);
});
