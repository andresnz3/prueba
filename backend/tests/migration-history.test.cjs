'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MODULES, safePayload, createMigrationHistoryService } = require('../src/services/migration-history');

test('module history scopes archived records to the feature that can read them', () => {
  assert.deepEqual(MODULES.inventory.entities, ['products', 'inventoryMovements']);
  assert.deepEqual(MODULES.cash.entities, ['cashSessions']);
  assert.equal(MODULES.cash.permission, 'cash');
  assert.equal(MODULES.history.permission, 'history');
  assert.equal(MODULES.admin, undefined);
});

test('history payload keeps values but removes nested image bytes', () => {
  const result = safePayload({ name: 'Item', image: 'data:image/png;base64,AAAA', items: [{ logo: 'data:image/jpeg;base64,BBBB', total: '12.30' }] });
  assert.equal(result.hasImage, true);
  assert.deepEqual(result.payload, { name: 'Item', items: [{ total: '12.30' }] });
});

test('older connected schemas without a complete archive return unavailable without querying archive rows', async () => {
  const calls = [];
  const repo = {
    tenant: async (session, work) => work({}, session),
    rows: async (_db, sql) => { calls.push(sql); return []; }
  };
  const service = createMigrationHistoryService({ repo, auth: { canAccess: async () => true } });
  const result = await service.list({ business_id: '44' }, 'inventory');
  assert.equal(result.available, false);
  assert.equal(result.reconciliation.archiveIntegrity, 'UNAVAILABLE');
  assert.deepEqual(result.records, []);
  assert.equal(calls.length, 1);
});
