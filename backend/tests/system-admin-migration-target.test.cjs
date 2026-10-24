'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSystemAdminService } = require('../src/services/system-admin');

test('new migration destinations fail closed when required protection tables are missing', async () => {
  const calls = [];
  const repo = {
    pool: {},
    rows: async (_db, sql) => {
      calls.push(sql);
      if (sql.includes('TABLE_NAME IN (?, ?)')) return [{ tableName: 'business_subscriptions' }, { tableName: 'business_subscription_payments' }];
      return [];
    },
    transaction: async work => work({})
  };
  const service = createSystemAdminService(repo);
  const admin = { username: 'andres', role: 'ADMIN', business_id: '1', user_id: '1' };
  await assert.rejects(service.createMigrationTarget(admin, 'Fixture', 'CONECTADO_BASICO'), error => error.publicCode === 'MIGRATION_GATE_SCHEMA_REQUIRED' && error.publicStatus === 503);
  assert.equal(calls.length, 2);
});

test('the system business is rejected before any database inspection', async () => {
  let called = false;
  const repo = { pool: {}, rows: async () => { called = true; return []; }, transaction: async work => work({}) };
  const service = createSystemAdminService(repo);
  const admin = { username: 'andres', role: 'ADMIN', business_id: '1', user_id: '1' };
  await assert.rejects(service.inspectExistingMigrationTarget(admin, '1'), error => error.publicCode === 'MIGRATION_TARGET_PROTECTED');
  await assert.rejects(service.prepareExistingMigrationTarget(admin, '1', true), error => error.publicCode === 'MIGRATION_TARGET_PROTECTED');
  assert.equal(called, false);
});

test('a business administrator cannot inspect or reserve another business', async () => {
  let called = false;
  const repo = { pool: {}, rows: async () => { called = true; return []; }, transaction: async work => work({}) };
  const service = createSystemAdminService(repo);
  const tenantAdmin = { username: 'tenant-admin', role: 'ADMIN', business_id: '27', user_id: '38' };
  await assert.rejects(service.inspectExistingMigrationTarget(tenantAdmin, '29'), error => error.publicCode === 'SYSTEM_ADMIN_REQUIRED');
  await assert.rejects(service.prepareExistingMigrationTarget(tenantAdmin, '29', true), error => error.publicCode === 'SYSTEM_ADMIN_REQUIRED');
  assert.equal(called, false);
});
