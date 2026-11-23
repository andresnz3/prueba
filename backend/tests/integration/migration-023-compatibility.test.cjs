'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readConfig } = require('../../src/config/environment');
const { createDatabasePool } = require('../../src/config/database');
const { migrate } = require('../../src/services/schema-migrations');

const database = process.env.POS_INTEGRATION_DATABASE;
if (!/^pos_auth_test_[a-f0-9]{24}$/.test(database || '') || database === process.env.DB_NAME) throw new Error('Use isolated runner');

test('migration 023 backfills registered names and preserves existing guest rows', async t => {
  const config = readConfig();
  const pool = createDatabasePool({ ...config.database, database, connectionLimit: 2 });
  t.after(() => pool.end());

  const [actors] = await pool.execute("SELECT business_id AS businessId,id AS userId FROM users WHERE username='migration005_fixture'");
  assert.equal(actors.length, 1);
  const { businessId, userId } = actors[0];
  const clientName = 'Legacy client 023';
  const [client] = await pool.execute('INSERT INTO clients (business_id,name,credit_limit) VALUES (?,?,?)', [businessId, clientName, '50.00']);
  const [registeredSale] = await pool.execute("INSERT INTO sales (business_id,user_id,client_id,invoice_number,sale_type,payment_method,total,detail) VALUES (?,?,?,?,'CREDIT','CREDIT','12.35','legacy sale')", [businessId, userId, client.insertId, 'MIG023-CLIENT']);
  const [guestSale] = await pool.execute("INSERT INTO sales (business_id,user_id,invoice_number,sale_type,payment_method,total,detail) VALUES (?,?,'MIG023-GUEST','CASH','CASH','7.50','guest sale')", [businessId, userId]);
  const [registeredOrder] = await pool.execute("INSERT INTO sale_orders (business_id,created_by_user_id,client_id,credit_days,price_type,discount_percent,estimated_subtotal,estimated_discount,estimated_total,detail) VALUES (?,?,?,15,'RETAIL','0.0000','12.35','0.00','12.35','legacy order')", [businessId, userId, client.insertId]);
  const [guestOrder] = await pool.execute("INSERT INTO sale_orders (business_id,created_by_user_id,price_type,discount_percent,estimated_subtotal,estimated_discount,estimated_total,detail) VALUES (?,?,'RETAIL','0.0000','7.50','0.00','7.50','guest order')", [businessId, userId]);

  const applied = await migrate(pool, database, 'apply');
  assert.deepEqual(applied.find(row => row.version === '023'), { version: '023', status: 'applied', action: 'applied' });
  const [sales] = await pool.execute('SELECT id,invoice_number,customer_name,total,detail FROM sales WHERE business_id=? ORDER BY id', [businessId]);
  const [orders] = await pool.execute('SELECT id,customer_name,estimated_total,detail FROM sale_orders WHERE business_id=? ORDER BY id', [businessId]);
  assert.deepEqual(sales.map(row => [String(row.id), row.invoice_number, row.customer_name, String(row.total), row.detail]), [
    [String(registeredSale.insertId), 'MIG023-CLIENT', clientName, '12.35', 'legacy sale'],
    [String(guestSale.insertId), 'MIG023-GUEST', null, '7.50', 'guest sale']
  ]);
  assert.deepEqual(orders.map(row => [String(row.id), row.customer_name, String(row.estimated_total), row.detail]), [
    [String(registeredOrder.insertId), clientName, '12.35', 'legacy order'],
    [String(guestOrder.insertId), null, '7.50', 'guest order']
  ]);
  const rerun = await migrate(pool, database, 'apply');
  assert.deepEqual(rerun.find(row => row.version === '023'), { version: '023', status: 'applied', action: 'skipped' });
});
