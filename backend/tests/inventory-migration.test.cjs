'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createSystemAdminService } = require('../src/services/system-admin');

const admin = { username: 'andres', role: 'ADMIN', business_id: '1', user_id: '7' };
const packageValue = (products = []) => ({
  type: 'pos_local_migration_package',
  version: 1,
  exportedAt: '2026-10-13T12:00:00.000Z',
  business: { name: 'Negocio de origen' },
  data: { products, clients: [], suppliers: [], inventoryMovements: [] }
});
const product = (overrides = {}) => ({ barcode: 'A-1', name: 'Producto A', cost: '2.50', stock: '4.000', ...overrides });
const basicAudit = () => ({
  business_id: '2',
  action: 'MIGRATION_BASIC_IMPORT',
  details: JSON.stringify({ sourceBusinessName: 'Negocio de origen', packageExportedAt: '2026-10-13T12:00:00.000Z' })
});

function fakeRepo({ target = { id: '2', name: 'Destino', status: 'ACTIVE' }, products = [], movements = [], audits = [basicAudit()], columnType = "enum('INITIAL','MIGRACION_INICIAL')", failOnMovement = false, failOnAudit = false } = {}) {
  const state = { target, products: structuredClone(products), movements: structuredClone(movements), audits: structuredClone(audits) };
  const repo = {
    pool: {},
    async transaction(work) {
      const snapshot = structuredClone(state);
      try { return await work({ transaction: true }); }
      catch (failure) { Object.assign(state, snapshot); throw failure; }
    },
    async rows(_db, sql, values) {
      if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) return columnType ? [{ columnType }] : [];
      if (sql.startsWith('SELECT id, name, status FROM businesses')) return state.target ? [state.target] : [];
      if (sql.startsWith('SELECT details FROM audit_logs')) return state.audits.filter(row => row.business_id === values[0] && row.action === 'MIGRATION_BASIC_IMPORT');
      if (sql.startsWith('SELECT id, barcode, name, stock FROM products')) return state.products.filter(row => row.business_id === values[0] && row.deleted !== true);
      if (sql.startsWith('SELECT product_id AS productId, type FROM inventory_movements')) {
        const ids = new Set(values.slice(1).map(String));
        return state.movements.filter(row => row.business_id === values[0] && ids.has(String(row.product_id))).map(row => ({ productId: row.product_id, type: row.type }));
      }
      if (sql.startsWith('INSERT INTO inventory_movements')) {
        if (failOnMovement) throw new Error('movement insert failed');
        state.movements.push({ business_id: values[0], product_id: values[1], type: values[2], quantity: values[3], stock_after: values[4], reason: values[5], unit_cost: values[6] });
        return { insertId: String(state.movements.length) };
      }
      if (sql.startsWith('INSERT INTO audit_logs')) {
        if (failOnAudit) throw new Error('audit insert failed');
        state.audits.push({ business_id: values[0], action: values[1], entity: values[2], entity_id: values[3], details: values[4] });
        return { insertId: String(state.audits.length) };
      }
      throw new Error('Unexpected SQL: ' + sql);
    }
  };
  return { repo, state };
}

test('inventory migration preview maps by barcode or normalized name and reports omissions', async () => {
  const { repo } = fakeRepo({
    products: [
      { id: '10', business_id: '2', barcode: 'A-1', name: 'Producto A', stock: '4.000' },
      { id: '11', business_id: '2', barcode: 'MIG-local', name: 'Café B', stock: '2.500' },
      { id: '12', business_id: '2', barcode: 'ZERO', name: 'Sin stock', stock: '0.000' },
      { id: '13', business_id: '2', barcode: 'HIST', name: 'Con historial', stock: '5.000' },
      { id: '14', business_id: '2', barcode: 'DONE', name: 'Ya importado', stock: '3.000' },
      { id: '15', business_id: '2', barcode: 'DIFF', name: 'Stock distinto', stock: '2.000' }
    ],
    movements: [
      { business_id: '2', product_id: '13', type: 'INITIAL' },
      { business_id: '2', product_id: '14', type: 'MIGRACION_INICIAL' }
    ]
  });
  const service = createSystemAdminService(repo);
  const result = await service.previewInventoryMigration(admin, '2', packageValue([
    product(),
    product({ barcode: '', name: 'Cafe B', stock: '2.500' }),
    product({ barcode: 'ZERO', name: 'Sin stock', stock: '0.000' }),
    product({ barcode: 'HIST', name: 'Con historial', stock: '5.000' }),
    product({ barcode: 'DONE', name: 'Ya importado', stock: '3.000' }),
    product({ barcode: 'DIFF', name: 'Stock distinto', stock: '4.000' }),
    product({ barcode: 'MISSING', name: 'No existe', stock: '1.000' }),
    product({ barcode: 'DEL', name: 'Eliminado', stock: '8.000', deleted: true })
  ]));
  assert.equal(result.ok, true);
  assert.equal(result.eligible, true);
  assert.deepEqual(result.products, { productsWithStock: 6, productsWithoutStock: 1, productsToSkip: 6, inventoryMovementsToCreate: 2 });
  assert.equal(result.warnings.length, 6);
});

test('inventory migration creates only initial movements, audits, and safely skips duplicates on retry', async () => {
  const { repo, state } = fakeRepo({
    products: [
      { id: '10', business_id: '2', barcode: 'A-1', name: 'Producto A', stock: '4.000' },
      { id: '11', business_id: '2', barcode: 'MIG-local', name: 'Café B', stock: '2.500' },
      { id: '12', business_id: '2', barcode: 'ZERO', name: 'Sin stock', stock: '0.000' },
      { id: '13', business_id: '2', barcode: 'HIST', name: 'Con historial', stock: '5.000' }
    ],
    movements: [{ business_id: '2', product_id: '13', type: 'ADJUSTMENT' }]
  });
  const service = createSystemAdminService(repo);
  const source = packageValue([
    product(), product({ barcode: '', name: 'Cafe B', stock: '2.500', cost: '1.10' }),
    product({ barcode: 'ZERO', name: 'Sin stock', stock: '0.000' }),
    product({ barcode: 'HIST', name: 'Con historial', stock: '5.000' })
  ]);
  const first = await service.migrateInventory(admin, '2', source);
  assert.deepEqual(first.created, { inventoryMovements: 2 });
  assert.deepEqual(first.skipped, { inventoryMovements: 2 });
  const initial = state.movements.filter(row => row.type === 'MIGRACION_INICIAL');
  assert.equal(initial.length, 2);
  assert.deepEqual(initial.map(row => [row.business_id, row.product_id, row.quantity, row.stock_after, row.reason, row.unit_cost]), [
    ['2', '10', '4.000', '4.000', 'Migración inicial desde paquete local', '2.50'],
    ['2', '11', '2.500', '2.500', 'Migración inicial desde paquete local', '1.10']
  ]);
  assert.equal(state.audits.at(-1).action, 'MIGRATION_INVENTORY_IMPORT');
  const details = JSON.parse(state.audits.at(-1).details);
  assert.equal(details.actor.username, 'andres');
  assert.equal(details.targetBusinessId, '2');
  assert.equal(details.sourceBusinessName, 'Negocio de origen');
  assert.equal(details.packageExportedAt, '2026-10-13T12:00:00.000Z');
  assert.deepEqual(details.summary, { created: first.created, skipped: first.skipped });

  const retry = await service.migrateInventory(admin, '2', source);
  assert.deepEqual(retry.created, { inventoryMovements: 0 });
  assert.deepEqual(retry.skipped, { inventoryMovements: 4 });
  assert.equal(state.movements.filter(row => row.type === 'MIGRACION_INICIAL').length, 2);
});

test('inventory migration requires system admin, a matching basic import, active target, and schema migration', async () => {
  const { repo, state } = fakeRepo();
  const service = createSystemAdminService(repo);
  await assert.rejects(service.previewInventoryMigration({ ...admin, username: 'other' }, '2', packageValue([product()])), error => error.publicStatus === 403);
  await assert.rejects(service.migrateInventory(admin, 'invalid', packageValue([product()])), error => error.publicCode === 'INVALID_INPUT');
  await assert.rejects(service.migrateInventory(admin, '2', { ...packageValue([product()]), data: { ...packageValue([product()]).data, inventoryMovements: null } }), error => error.publicCode === 'MIGRATION_PACKAGE_INVALID');

  state.audits = [];
  const noBasic = await service.previewInventoryMigration(admin, '2', packageValue([product()]));
  assert.equal(noBasic.eligible, false);
  await assert.rejects(service.migrateInventory(admin, '2', packageValue([product()])), error => error.publicCode === 'MIGRATION_BASIC_REQUIRED');

  const inactive = fakeRepo({ target: { id: '2', name: 'Destino', status: 'INACTIVE' } });
  await assert.rejects(createSystemAdminService(inactive.repo).migrateInventory(admin, '2', packageValue([product()])), error => error.publicCode === 'MIGRATION_TARGET_INACTIVE');
  const missingSchema = fakeRepo({ columnType: "enum('INITIAL')" });
  await assert.rejects(createSystemAdminService(missingSchema.repo).migrateInventory(admin, '2', packageValue([product()])), error => error.publicCode === 'MIGRATION_INVENTORY_SCHEMA_REQUIRED');
});

test('inventory movement and audit writes roll back together', async () => {
  const { repo, state } = fakeRepo({ products: [{ id: '10', business_id: '2', barcode: 'A-1', name: 'Producto A', stock: '4.000' }], failOnAudit: true });
  const service = createSystemAdminService(repo);
  await assert.rejects(service.migrateInventory(admin, '2', packageValue([product()])), /audit insert failed/);
  assert.equal(state.movements.length, 0);
  assert.equal(state.audits.length, 1);
});
