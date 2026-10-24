'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readConfig } = require('../../src/config/environment');
const { createDatabasePool } = require('../../src/config/database');
const { migrate } = require('../../src/services/schema-migrations');

const database = process.env.POS_INTEGRATION_DATABASE;
if (!/^pos_auth_test_[a-f0-9]{24}$/.test(database || '') || database === process.env.DB_NAME) throw new Error('Use isolated runner');

test('migration 016 preserves old order prices and explicitly stores unavailable snapshots', async t => {
  const config = readConfig();
  const pool = createDatabasePool({ ...config.database, database, connectionLimit: 2 });
  t.after(() => pool.end());
  const [beforeLedger] = await pool.execute("SELECT version FROM schema_migrations WHERE version='016'");
  const migrationAlreadyApplied = beforeLedger.length === 1;

  const [fixture] = await pool.execute("SELECT business_id,id AS userId FROM users WHERE username='migration005_fixture'");
  assert.equal(fixture.length, 1);
  const businessId = fixture[0].business_id;
  const userId = fixture[0].userId;
  const [product] = await pool.execute("INSERT INTO products (business_id,barcode,name,category,cost,retail_price,wholesale_price,stock) VALUES (?,?,?,?,?,?,?,?)", [businessId, 'MIG016-COMPAT', 'Compatibility product', 'General', '4.00', '14.50', '12.00', '3.000']);
  const [order] = await pool.execute("INSERT INTO sale_orders (business_id,created_by_user_id,status,price_type,discount_percent,estimated_subtotal,estimated_discount,estimated_total,is_historical) VALUES (?,?,'CANCELLED','RETAIL','0.0000','29.00','0.00','29.00',TRUE)", [businessId, userId]);
  await pool.execute('INSERT INTO sale_order_items (business_id,order_id,line_number,product_id,product_name,barcode,quantity,estimated_unit_price,estimated_subtotal) VALUES (?,?,?,?,?,?,?,?,?)', [businessId, order.insertId, 1, product.insertId, 'Compatibility product', 'MIG016-COMPAT', '2.000', '14.50', '29.00']);

  const applied = await migrate(pool, database, 'apply');
  assert.deepEqual(applied.find(result => result.version === '016'), { version: '016', status: 'applied', action: migrationAlreadyApplied ? 'skipped' : 'applied' });
  const [preserved] = await pool.execute('SELECT estimated_unit_price,estimated_subtotal,price_snapshot_available FROM sale_order_items WHERE business_id=? AND order_id=? AND line_number=1', [businessId, order.insertId]);
  assert.deepEqual(preserved.map(row => [String(row.estimated_unit_price), String(row.estimated_subtotal), Number(row.price_snapshot_available)]), [['14.50', '29.00', 1]]);

  await pool.execute('INSERT INTO sale_order_items (business_id,order_id,line_number,product_id,product_name,barcode,quantity,estimated_unit_price,estimated_subtotal,price_snapshot_available) VALUES (?,?,?,?,?,?,?,?,?,0)', [businessId, order.insertId, 2, product.insertId, 'Compatibility product', 'MIG016-COMPAT', '1.000', null, null]);
  const [unknown] = await pool.execute('SELECT estimated_unit_price,estimated_subtotal,price_snapshot_available FROM sale_order_items WHERE business_id=? AND order_id=? AND line_number=2', [businessId, order.insertId]);
  assert.deepEqual(unknown.map(row => [row.estimated_unit_price, row.estimated_subtotal, Number(row.price_snapshot_available)]), [[null, null, 0]]);
  await assert.rejects(pool.execute('INSERT INTO sale_order_items (business_id,order_id,line_number,product_id,product_name,barcode,quantity,estimated_unit_price,estimated_subtotal,price_snapshot_available) VALUES (?,?,?,?,?,?,?,?,?,0)', [businessId, order.insertId, 3, product.insertId, 'Compatibility product', 'MIG016-COMPAT', '1.000', '14.50', '14.50']));

  const rerun = await migrate(pool, database, 'apply');
  assert.ok(rerun.every(result => result.status === 'applied' && result.action === 'skipped'));
  const [after] = await pool.execute('SELECT estimated_unit_price,estimated_subtotal,price_snapshot_available FROM sale_order_items WHERE business_id=? AND order_id=? ORDER BY line_number', [businessId, order.insertId]);
  assert.deepEqual(after.map(row => [row.estimated_unit_price === null ? null : String(row.estimated_unit_price), row.estimated_subtotal === null ? null : String(row.estimated_subtotal), Number(row.price_snapshot_available)]), [['14.50', '29.00', 1], [null, null, 0]]);
});
