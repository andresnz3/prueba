'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { errorHandler } = require('../src/middleware/errors');
const {
  assertOperationalSchema,
  OPERATIONAL_SCHEMA_014_REQUIRED,
  ZERO_INVENTORY_SCHEMA_015_REQUIRED,
  ORDER_PRICE_SNAPSHOT_SCHEMA_016_REQUIRED
} = require('../src/services/system-admin-migration-operations');

function schemaRepo({ omitTable, omitColumn } = {}) {
  const tables = { ...OPERATIONAL_SCHEMA_014_REQUIRED, ...ZERO_INVENTORY_SCHEMA_015_REQUIRED, ...ORDER_PRICE_SNAPSHOT_SCHEMA_016_REQUIRED };
  const rows = Object.entries(tables).flatMap(([tableName, columns]) => columns
    .filter(columnName => !(tableName === omitTable && (!omitColumn || columnName === omitColumn)))
    .map(columnName => ({ tableName, columnName, isNullable: tableName === 'sale_order_items' && ['estimated_unit_price', 'estimated_subtotal'].includes(columnName) ? 'YES' : 'NO' })));
  return { rows: async (_db, _sql, names) => rows.filter(row => names.includes(row.tableName)) };
}

test('schema operativo completo pasa la validación', async () => {
  await assert.doesNotReject(() => assertOperationalSchema(schemaRepo(), {}));
});

test('schema 014 ausente conserva el error de migración 014', async () => {
  await assert.rejects(assertOperationalSchema(schemaRepo({ omitTable: 'cash_sessions', omitColumn: 'source_status' }), {}), error => {
    assert.equal(error.publicStatus, 503);
    assert.equal(error.publicCode, 'MIGRATION_OPERATIONAL_SCHEMA_REQUIRED');
    return true;
  });
});

test('schema 015 ausente informa específicamente la migración 015', async () => {
  await assert.rejects(assertOperationalSchema(schemaRepo({ omitTable: 'migration_zero_inventory_events' }), {}), error => {
    assert.equal(error.publicStatus, 503);
    assert.equal(error.publicCode, 'MIGRATION_ZERO_INVENTORY_SCHEMA_REQUIRED');
    return true;
  });
});

test('schema 016 ausente informa el requisito para conservar órdenes sin precios históricos', async () => {
  await assert.rejects(assertOperationalSchema(schemaRepo({ omitTable: 'sale_order_items', omitColumn: 'price_snapshot_available' }), {}), error => {
    assert.equal(error.publicStatus, 503);
    assert.equal(error.publicCode, 'MIGRATION_ORDER_SNAPSHOT_SCHEMA_REQUIRED');
    return true;
  });
});

test('la API comunica con claridad si falta 014, 015 o 016', () => {
  for (const [code, version, expected] of [
    ['MIGRATION_OPERATIONAL_SCHEMA_REQUIRED', '014', /migraci.n 014/],
    ['MIGRATION_ZERO_INVENTORY_SCHEMA_REQUIRED', '015', /migraci.n 015/],
    ['MIGRATION_ORDER_SNAPSHOT_SCHEMA_REQUIRED', '016', /migraci.n 016/]
  ]) {
    let response;
    const res = {
      headersSent: false,
      status(status) { this.statusCode = status; return this; },
      json(body) { response = body; return this; }
    };
    errorHandler(Object.assign(new Error(code), { publicStatus: 503, publicCode: code }), {}, res, () => {});
    assert.equal(res.statusCode, 503);
    assert.equal(response.error.code, code);
    assert.match(response.error.message, expected);
    for (const otherVersion of ['014', '015', '016'].filter(value => value !== version)) assert.equal(response.error.message.includes(otherVersion), false);
  }
});
