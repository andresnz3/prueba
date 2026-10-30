'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readConfig } = require('../../src/config/environment');
const { createDatabasePool } = require('../../src/config/database');
const { migrate } = require('../../src/services/schema-migrations');

const database = process.env.POS_INTEGRATION_DATABASE;
if (!/^pos_auth_test_[a-f0-9]{24}$/.test(database || '') || database === process.env.DB_NAME) throw new Error('Use isolated runner');

test('ordered migrations are tracked, adopted from a compatible existing schema, and preserve supplier payments', async t => {
  const config = readConfig();
  const pool = createDatabasePool({ ...config.database, database, connectionLimit: 2 });
  t.after(() => pool.end());

  const [ledger] = await pool.execute("SELECT version,status FROM schema_migrations ORDER BY version");
  assert.deepEqual(ledger.map(row => [row.version, row.status]), Array.from({ length: 20 }, (_, index) => [String(index + 1).padStart(3, '0'), 'APPLIED']));
  const [rateLimitTable] = await pool.execute("SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='auth_login_rate_limits'");
  assert.equal(Number(rateLimitTable[0].count), 1);
  const [orderColumns] = await pool.execute("SELECT column_name AS columnName,is_nullable AS isNullable,column_default AS columnDefault FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='sale_order_items' AND column_name IN ('estimated_unit_price','estimated_subtotal','price_snapshot_available') ORDER BY ordinal_position");
  assert.deepEqual(orderColumns.map(row => [row.columnName, row.isNullable, row.columnDefault === null ? null : String(row.columnDefault)]), [
    ['estimated_unit_price', 'YES', null],
    ['estimated_subtotal', 'YES', null],
    ['price_snapshot_available', 'NO', '1']
  ]);
  const [licenseIdentityColumns] = await pool.execute("SELECT table_name AS tableName,column_name AS columnName,data_type AS dataType,character_maximum_length AS maxLength,is_nullable AS isNullable,column_default AS columnDefault,character_set_name AS characterSet,collation_name AS collationName FROM information_schema.columns WHERE table_schema=DATABASE() AND ((table_name='local_licenses' AND column_name='local_business_id_hash') OR (table_name='local_license_installations' AND column_name='local_business_id_hash')) ORDER BY table_name");
  assert.deepEqual(licenseIdentityColumns.map(row => [row.tableName, row.columnName, row.dataType, Number(row.maxLength), row.isNullable, row.columnDefault, row.characterSet, row.collationName]), [
    ['local_license_installations', 'local_business_id_hash', 'char', 64, 'YES', null, 'ascii', 'ascii_bin'],
    ['local_licenses', 'local_business_id_hash', 'char', 64, 'YES', null, 'ascii', 'ascii_bin']
  ]);

  const [existing] = await pool.execute("SELECT sp.amount,sp.payment_method,sp.status FROM supplier_payments sp JOIN users u ON u.business_id=sp.business_id AND u.id=sp.user_id WHERE u.username='migration005_fixture'");
  assert.deepEqual(existing.map(row => [row.amount, row.payment_method, row.status]), [['3.17', 'CARD', 'POSTED']]);

  const [fixture] = await pool.execute("SELECT s.business_id,s.id AS supplier_id,u.id AS user_id FROM suppliers s JOIN users u ON u.business_id=s.business_id WHERE s.name='Migration 005 supplier' AND u.username='migration005_fixture'");
  assert.equal(fixture.length, 1);
  await pool.execute("INSERT INTO supplier_payments (business_id,user_id,supplier_id,amount,payment_method,status) VALUES (?,?,?,'2.41','TRANSFER','PENDING')", [fixture[0].business_id, fixture[0].user_id, fixture[0].supplier_id]);
  const [pending] = await pool.execute("SELECT amount,payment_method,status FROM supplier_payments WHERE business_id=? AND supplier_id=? AND status='PENDING'", [fixture[0].business_id, fixture[0].supplier_id]);
  assert.deepEqual(pending.map(row => [row.amount, row.payment_method, row.status]), [['2.41', 'TRANSFER', 'PENDING']]);

  const rerun = await migrate(pool, database, 'apply');
  assert.ok(rerun.every(item => item.status === 'applied' && item.action === 'skipped'));
  const [stored] = await pool.execute('SELECT COUNT(*) AS count FROM supplier_payments WHERE business_id=? AND supplier_id=?', [fixture[0].business_id, fixture[0].supplier_id]);
  assert.equal(Number(stored[0].count), 2);

  await pool.execute('DELETE FROM schema_migrations');
  const adopted = await migrate(pool, database, 'apply');
  assert.ok(adopted.every(item => item.status === 'applied' && item.action === 'adopted'));
  const [preserved] = await pool.execute('SELECT amount,payment_method,status FROM supplier_payments WHERE business_id=? AND supplier_id=? ORDER BY id', [fixture[0].business_id, fixture[0].supplier_id]);
  assert.deepEqual(preserved.map(row => [row.amount, row.payment_method, row.status]), [['3.17', 'CARD', 'POSTED'], ['2.41', 'TRANSFER', 'PENDING']]);
});
