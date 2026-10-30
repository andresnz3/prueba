'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readConfig } = require('../../src/config/environment');
const { createDatabasePool } = require('../../src/config/database');

const database = process.env.POS_INTEGRATION_DATABASE;
if (!/^pos_auth_test_[a-f0-9]{24}$/.test(database || '') || database === process.env.DB_NAME) throw new Error('Use isolated runner');

test('MySQL admission bounds saturation, times out queued leases and releases every connection', async t => {
  const config = readConfig();
  const pool = createDatabasePool({ ...config.database, database, connectionLimit: 2, connectionQueueLimit: 1, acquireTimeout: 200 });
  t.after(() => pool.end());
  const first = await pool.getConnection();
  const second = await pool.getConnection();
  const queued = pool.getConnection();
  await assert.rejects(pool.getConnection(), error => error.code === 'POS_POOL_QUEUE_FULL');
  assert.equal(pool.diagnostics().active, 2);
  assert.equal(pool.diagnostics().queued, 1);
  first.release();
  const third = await queued;
  assert.equal(pool.diagnostics().active, 2);
  const [[{ healthy }]] = await third.query('SELECT 1 AS healthy');
  assert.equal(Number(healthy), 1);
  third.release(); second.release();
  assert.equal(pool.diagnostics().active, 0);

  const heldA = await pool.getConnection();
  const heldB = await pool.getConnection();
  await assert.rejects(pool.getConnection(), error => error.code === 'POS_POOL_ACQUIRE_TIMEOUT');
  assert.equal(pool.diagnostics().queued, 0);
  heldA.release(); heldB.destroy();
  const recovered = await pool.getConnection();
  const [[{ recovered: value }]] = await recovered.query('SELECT 1 AS recovered');
  assert.equal(Number(value), 1);
  recovered.release();
  assert.equal(pool.diagnostics().active, 0);
  assert.equal(pool.diagnostics().timedOut, 1);
  assert.equal(pool.diagnostics().rejected, 2);
  assert.equal(pool.diagnostics().waitCount, 2);
  assert.ok(pool.diagnostics().maxWaitMs >= 150);
  assert.ok(pool.diagnostics().statementCount >= 2);
});
