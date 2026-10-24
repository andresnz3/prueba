'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { URL, URLSearchParams } = require('node:url');

function setup({ missingProtection = false } = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'api-client.js'), 'utf8');
  const calls = [];
  const session = { csrfToken: 'A'.repeat(43), expiresAt: '2026-10-22T00:00:00.000Z', user: { id: '1', businessId: '1', username: 'andres', fullName: 'Admin', role: 'ADMIN', active: true } };
  const sandbox = { window: {}, URL, URLSearchParams, TextEncoder, AbortController, setTimeout, clearTimeout,
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      if (missingProtection && url.endsWith('/migration/targets/2/inspect')) {
        return { ok: false, status: 503, json: async () => ({ error: { code: 'MIGRATION_GATE_SCHEMA_REQUIRED' } }) };
      }
      const data = url.endsWith('/auth/me') ? session
        : url.endsWith('/migration/archive/preview') ? { ok: true, targetBusinessId: '2', targetBusinessName: 'Destino', targetStatus: 'INACTIVE', targetMigrationState: 'PENDING', sourceBusinessKey: 'a'.repeat(64), packageSha256: 'b'.repeat(64), packageVersion: 2, counts: { products: 1 }, recordsExpected: 1, missingStores: [], sensitiveFieldsRemoved: 1, blockers: [], eligibleToArchive: true, legacyIdentityConfirmationRequired: false, bulkIdentityEligibleRecords: 0, identityReview: { counts: { legacy: 0 }, records: [] }, priorBatch: null }
          : url.endsWith('/migration/targets/2/inspect') ? { business: { id: '2', name: 'Negocio ñandú', status: 'ACTIVE', migrationState: 'NOT_REQUIRED' }, eligible: true, blockers: [], warnings: ['Se conservará la configuración.'], preserved: { users: 1, settings: 1, auditLogs: 0, sessions: 1, subscriptions: 0, businessPhone: true, businessAddress: false }, accessChanges: { activeSessions: 1, sessionsToRevoke: 1, authorizationsToRemove: 0 } }
            : url.endsWith('/migration/targets/2/prepare') ? { business: { id: '2', name: 'Negocio ñandú', status: 'INACTIVE', migrationState: 'PENDING' }, preserved: { users: 1, settings: 1, auditLogs: 0, sessions: 1, subscriptions: 0, businessPhone: true, businessAddress: false }, accessChanges: { activeSessions: 1, sessionsToRevoke: 1, authorizationsToRemove: 0 }, accessSuspended: true, sessionsRevoked: 1, authorizationsRemoved: 0 }
          : url.endsWith('/migration/targets') ? { business: { id: '7', name: 'Destino nuevo', status: 'INACTIVE', migrationState: 'PENDING', planCode: 'CONECTADO_BASICO' } }
          : url.endsWith('/migration/archive') ? { ok: true, batchId: '11223344-5566-7788-9900-aabbccddeeff', status: 'BLOCKED', recordsArchived: 1, pendingRecords: 1, blockers: ['revision required'], packageSha256: 'b'.repeat(64), counts: { products: 1 }, identityConfirmation: null, identityConfirmationApplied: 0 }
            : url.endsWith('/project/catalog') ? { ok: true, businessId: '2', batchId: '11223344-5566-7788-9900-aabbccddeeff', reconciliation: { complete: false, fullMigrationComplete: false, stageMatched: true, totals: { products: 1 }, pending: {}, differences: [], blockers: [], recordsByModule: {} } }
            : url.endsWith('/review') ? { ok: true, businessId: '2', batchId: '11223344-5566-7788-9900-aabbccddeeff', entity: 'products', sourceRecordKey: 'id:p1', decision: 'INCLUDE', recordStatus: 'ARCHIVED', businessStatus: 'INACTIVE', migrationState: 'PENDING' }
            : { ok: true, records: [{ entityType: 'products', sourceRecordKey: 'id:p1', payload: { id: 'p1' } }] };
      return { ok: true, status: 200, json: async () => data };
    }
  };
  vm.runInNewContext(source, sandbox);
  return { client: new sandbox.window.PosApiClient('https://example.test/api'), calls };
}

test('archive API uses bounded raw package requests and removes credentials while keeping actor labels', async () => {
  const { client, calls } = setup();
  const packageValue = { type: 'pos_local_migration_package', version: 2, business: { name: 'Local', localBusinessId: 'local-1' }, data: { products: [{ id: 'p1', usuario: 'Ana', password: 'unsafe' }], sync_queue: [{ data: '{"password":"unsafe","sale":{"id":"s1"}}' }] } };
  const original = JSON.stringify(packageValue);
  await client.me();
  const preview = await client.previewFullMigration('2', packageValue);
  assert.equal(preview.packageSha256, 'b'.repeat(64));
  await client.archiveFullMigration('2', packageValue, true);
  assert.equal(JSON.stringify(packageValue), original);
  const writes = calls.filter(item => item.options.method === 'POST');
  assert.equal(writes.length, 2);
  assert.equal(writes[0].options.headers['Content-Type'], 'application/vnd.pos.local-migration+json');
  assert.equal(writes[0].options.headers['X-CSRF-Token'], 'A'.repeat(43));
  assert.equal(writes[0].options.body.includes('unsafe'), false);
  assert.equal(JSON.parse(writes[0].options.body).package.data.products[0].usuario, 'Ana');
  const archiveBody = JSON.parse(writes[1].options.body);
  assert.equal(archiveBody.confirmed, true);
});

test('archive API uses the single package checkbox for legacy identity authorization', async () => {
  const { client, calls } = setup();
  await client.me();
  const packageValue = { type: 'pos_local_migration_package', version: 2, business: { name: 'Local' }, data: { products: [{ id: 'p1', business_id: '00000000-0000-0000-0000-000000000000' }] } };
  await client.archiveFullMigration('2', packageValue, true);
  const request = calls.find(item => item.url.endsWith('/migration/archive'));
  const body = JSON.parse(request.options.body);
  assert.equal(body.confirmed, true);
  assert.equal(body.targetBusinessId, '2');
  assert.equal(body.package.data.products[0].business_id, '00000000-0000-0000-0000-000000000000');
});

test('archive API requires explicit confirmation and validates response ownership', async () => {
  const { client } = setup();
  await client.me();
  await assert.rejects(client.archiveFullMigration('2', { type: 'pos_local_migration_package', version: 2, business: { name: 'Local' }, data: {} }, false), error => error.code === 'MIGRATION_ARCHIVE_CONFIRMATION_REQUIRED');
  await assert.rejects(client.previewFullMigration('1 OR 1=1', {}), error => error.code === 'INVALID_INPUT');
});

test('individual identity decisions require an explicit confirmation before inclusion', async () => {
  const { client, calls } = setup();
  await client.me();
  await assert.rejects(client.reviewMigrationIdentityRecord('2', '11223344-5566-7788-9900-aabbccddeeff', 'products', 'id:p1', 'INCLUDE'), error => error.code === 'INVALID_INPUT');
  await client.reviewMigrationIdentityRecord('2', '11223344-5566-7788-9900-aabbccddeeff', 'products', 'id:p1', 'INCLUDE', true);
  const request = calls.find(item => item.url.endsWith('/review'));
  assert.equal(JSON.parse(request.options.body).attestBelongsToSource, true);
});

test('only system administration can create a locked migration target', async () => {
  const { client, calls } = setup();
  await client.me();
  const target = await client.createMigrationTarget('Destino nuevo', 'CONECTADO_BASICO');
  assert.deepEqual({ id: target.id, status: target.status, migrationState: target.migrationState }, { id: '7', status: 'INACTIVE', migrationState: 'PENDING' });
  assert.equal(calls.some(item => item.url.endsWith('/system-admin/migration/targets')), true);
});

test('existing-target API verifies the same ID, protection review and explicit CSRF-protected reservation', async () => {
  const { client, calls } = setup();
  await client.me();
  const inspection = await client.inspectExistingMigrationTarget('2');
  assert.equal(inspection.business.name, 'Negocio ñandú');
  assert.equal(inspection.eligible, true);
  const prepared = await client.prepareExistingMigrationTarget('2', true);
  assert.equal(prepared.business.id, '2');
  assert.equal(prepared.business.migrationState, 'PENDING');
  const write = calls.find(item => item.url.endsWith('/system-admin/migration/targets/2/prepare'));
  assert.equal(write.options.headers['X-CSRF-Token'], 'A'.repeat(43));
  assert.deepEqual(JSON.parse(write.options.body), { confirmed: true });
  await assert.rejects(client.prepareExistingMigrationTarget('2', false), error => error.code === 'MIGRATION_TARGET_CONFIRMATION_REQUIRED');
  await assert.rejects(client.inspectExistingMigrationTarget('1'), error => error.code === 'INVALID_INPUT');
});

test('missing 012/013 protection migrations is explained without hiding the server error', async () => {
  const { client } = setup({ missingProtection: true });
  await client.me();
  await assert.rejects(client.inspectExistingMigrationTarget('2'), error => error.code === 'MIGRATION_GATE_SCHEMA_REQUIRED' && error.status === 503 && error.message === 'Para usar la importación segura deben aplicarse las migraciones 012 y 013 en el servidor. No se modificó ningún negocio.');
});

test('catalog projection API is CSRF-protected and never claims full completion', async () => {
  const { client, calls } = setup();
  await client.me();
  const result = await client.projectMigrationCatalog('2', '11223344-5566-7788-9900-aabbccddeeff');
  assert.equal(result.reconciliation.complete, false);
  assert.equal(result.reconciliation.fullMigrationComplete, false);
  const request = calls.find(item => item.url.endsWith('/project/catalog'));
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['X-CSRF-Token'], 'A'.repeat(43));
  await assert.rejects(client.projectMigrationCatalog('1 OR 1=1', '11223344-5566-7788-9900-aabbccddeeff'), error => error.code === 'INVALID_INPUT');
});
