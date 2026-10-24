'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const mysql = require('mysql2/promise');
const { readConfig } = require('../../src/config/environment');
const { migrate } = require('../../src/services/schema-migrations');

const database = process.env.POS_INTEGRATION_DATABASE;
if (!/^pos_auth_test_[a-f0-9]{24}$/.test(database || '') || database === process.env.DB_NAME) throw new Error('Use the isolated MySQL runner');

test('migration 017 adds Standard while preserving existing subscriptions and payments', async t => {
  const config = readConfig();
  const pool = mysql.createPool({ ...config.database, database, connectionLimit: 3 });
  t.after(() => pool.end());
  const [business] = await pool.execute('INSERT INTO businesses (name) VALUES (?)', ['Plan compatibility ' + randomUUID()]);
  const businessId = String(business.insertId);
  const [user] = await pool.execute('INSERT INTO users (business_id,username,full_name,password_hash,role) VALUES (?,?,?,?,?)', [businessId, 'plan_fixture_' + randomUUID().replaceAll('-', '').slice(0, 12), 'Plan fixture', 'not-a-login-hash', 'ADMIN']);
  await pool.execute("INSERT INTO business_subscriptions (business_id,plan_code,next_due_date) VALUES (?, 'CONECTADO_BASICO', '2027-01-15')", [businessId]);
  await pool.execute("INSERT INTO business_subscription_payments (business_id,amount,payment_date,created_by_user_id) VALUES (?, '17.25', '2026-10-01', ?)", [businessId, user.insertId]);
  await assert.rejects(pool.execute("UPDATE business_subscriptions SET plan_code='CONECTADO_ESTANDAR' WHERE business_id=?", [businessId]), error => error.code === 'ER_CHECK_CONSTRAINT_VIOLATED');

  const result = await migrate(pool, database, 'apply', { throughVersion: '017' });
  assert.deepEqual(result.filter(item => item.version === '017').map(item => [item.status, item.action]), [['applied', 'applied']]);
  const [ledger] = await pool.execute("SELECT status FROM schema_migrations WHERE version='017'");
  assert.deepEqual(ledger.map(row => row.status), ['APPLIED']);
  const [subscription] = await pool.execute('SELECT plan_code,next_due_date FROM business_subscriptions WHERE business_id=?', [businessId]);
  const isoDate = value => value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
  assert.deepEqual(subscription.map(row => [row.plan_code, isoDate(row.next_due_date)]), [['CONECTADO_BASICO', '2027-01-15']]);
  const [payments] = await pool.execute('SELECT amount,payment_date FROM business_subscription_payments WHERE business_id=?', [businessId]);
  assert.deepEqual(payments.map(row => [String(row.amount), isoDate(row.payment_date)]), [['17.25', '2026-10-01']]);
  await pool.execute("UPDATE business_subscriptions SET plan_code='CONECTADO_ESTANDAR' WHERE business_id=?", [businessId]);
  await assert.rejects(pool.execute("UPDATE business_subscriptions SET plan_code='UNKNOWN' WHERE business_id=?", [businessId]), error => error.code === 'ER_CHECK_CONSTRAINT_VIOLATED');
});
