'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { readConfig } = require('../../src/config/environment');
const { readAuthConfig } = require('../../src/config/auth');
const { createDatabasePool } = require('../../src/config/database');
const { createAuthRepository } = require('../../src/repositories/auth');
const { createAuthService } = require('../../src/services/auth');
const { createMigrationHistoryService } = require('../../src/services/migration-history');
const { hashToken } = require('../../src/services/tokens');

const database = process.env.POS_INTEGRATION_DATABASE;
if (!/^pos_auth_test_[a-f0-9]{24}$/.test(database || '') || database === process.env.DB_NAME) throw new Error('Use the isolated MySQL runner');

async function seedArchive(repo, businessId, actorUserId, sourceName, productName, expectedRecords = 2) {
  const batchId = randomUUID();
  const sourceBusinessKey = createHash('sha256').update(sourceName).digest('hex');
  const manifest = { recordsExpected: expectedRecords, sourceCounts: { products: 1, inventoryMovements: 1 }, blockers: [], securityBlockers: [] };
  await repo.rows(repo.pool, 'INSERT INTO migration_import_batches (id,business_id,source_business_key,source_business_name,package_sha256,package_version,status,current_stage,actor_business_id,actor_user_id,manifest,stage_results,created_at,updated_at) VALUES (?,?,?,?,?,2,\'BLOCKED\',\'REVIEW_REQUIRED\',?,?,?,JSON_OBJECT(),UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))', [batchId, businessId, sourceBusinessKey, sourceName, createHash('sha256').update(batchId).digest('hex'), businessId, actorUserId, JSON.stringify(manifest)]);
  for (const [entityType, sourceRecordKey, payload] of [
    ['products', 'id:p1', { id: 'p1', name: productName, barcode: 'HISTORY-1', stock: '2.500', image: 'data:image/png;base64,AAAA' }],
    ['inventoryMovements', 'id:m1', { id: 'm1', producto: productName, tipo: 'AJUSTE', cantidad: '-0.500', stock_anterior: '3.000', stock_nuevo: '2.500' }]
  ]) {
    await repo.rows(repo.pool, 'INSERT INTO migration_source_records (business_id,batch_id,entity_type,source_record_key,source_fingerprint,record_status,source_payload,created_at,updated_at) VALUES (?,?,?, ?,?,\'ARCHIVED\',?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))', [businessId, batchId, entityType, sourceRecordKey, createHash('sha256').update(JSON.stringify(payload)).digest('hex'), JSON.stringify(payload)]);
  }
  return batchId;
}

async function createSession(repo, businessId, role, username) {
  const user = await repo.rows(repo.pool, 'INSERT INTO users (business_id,username,full_name,password_hash,role,active) VALUES (?,?,?,? ,?,TRUE)', [businessId, username, username, 'test-only-invalid-password-hash', role]);
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  const session = await repo.rows(repo.pool, 'INSERT INTO sessions (business_id,user_id,token_hash,expires_at,created_at) VALUES (?,?,?,TIMESTAMPADD(HOUR,1,UTC_TIMESTAMP(3)),UTC_TIMESTAMP(3))', [businessId, user.insertId, tokenHash]);
  return { business_id: String(businessId), user_id: String(user.insertId), session_id: String(session.insertId), token_hash: tokenHash };
}

test('historical module query is read-only, permission-gated, and isolated by authenticated business', async t => {
  const config = readConfig();
  const pool = createDatabasePool({ ...config.database, database, connectionLimit: 8 });
  t.after(() => pool.end());
  const repo = createAuthRepository(pool, readAuthConfig({ CSRF_SECRET: 'a'.repeat(64) }));
  const targetA = String((await repo.rows(pool, 'INSERT INTO businesses (name) VALUES (?)', ['History tenant A'])).insertId);
  const targetB = String((await repo.rows(pool, 'INSERT INTO businesses (name) VALUES (?)', ['History tenant B'])).insertId);
  const tenantA = await createSession(repo, targetA, 'ADMIN', 'history-admin-a');
  const tenantB = await createSession(repo, targetB, 'ADMIN', 'history-admin-b');
  const vendor = await createSession(repo, targetA, 'VENDEDOR', 'history-vendor-a');
  const savedA = await seedArchive(repo, targetA, tenantA.user_id, 'Negocio A', 'Negocio A producto');
  const savedB = await seedArchive(repo, targetB, tenantB.user_id, 'Negocio B', 'Negocio B producto', 3);
  const auth = createAuthService(repo, readAuthConfig({ CSRF_SECRET: 'a'.repeat(64) }));
  const service = createMigrationHistoryService({ repo, auth });

  const before = await repo.rows(pool, 'SELECT record_status AS status,target_table AS targetTable FROM migration_source_records WHERE business_id=? AND batch_id=? AND entity_type=\'products\'', [targetA, savedA]);
  const viewA = await service.list(tenantA, 'inventory', { offset: 0, limit: 20 });
  assert.equal(viewA.businessId, targetA);
  assert.equal(viewA.records.length, 2);
  assert.equal(viewA.records.some(row => row.sourceBusinessName === 'Negocio B'), false);
  assert.equal(viewA.records.find(row => row.entityType === 'products').hasImage, true);
  assert.equal(Object.hasOwn(viewA.records.find(row => row.entityType === 'products').payload, 'image'), false);
  assert.equal(viewA.reconciliation.complete, false);
  assert.equal(viewA.reconciliation.operationalComparison, 'NOT_RUN');
  assert.equal(viewA.reconciliation.unresolvedRecords, 2);
  const viewB = await service.list(tenantB, 'inventory', { offset: 0, limit: 20 });
  assert.equal(viewB.records.length, 2);
  assert.equal(viewB.records.every(row => row.sourceBusinessName === 'Negocio B'), true);
  assert.equal(viewB.reconciliation.archiveIntegrity, 'DIFFERENT');
  assert.equal(viewB.reconciliation.differences.some(item => item.origin === 'Negocio B' && item.expected === 3 && item.found === 2), true);

  await assert.rejects(service.list(vendor, 'inventory', { offset: 0, limit: 20 }), error => error.publicCode === 'MODULE_FORBIDDEN');
  await repo.rows(pool, 'INSERT INTO session_authorizations (business_id,session_id,granted_by_user_id,module,expires_at,created_at) VALUES (?,?,?,\'inventory\',TIMESTAMPADD(MINUTE,5,UTC_TIMESTAMP(3)),UTC_TIMESTAMP(3))', [targetA, vendor.session_id, tenantA.user_id]);
  const allowed = await service.list(vendor, 'inventory', { offset: 0, limit: 20 });
  assert.equal(allowed.records.length, 2);
  await assert.rejects(service.list(vendor, 'cash', { offset: 0, limit: 20 }), error => error.publicCode === 'MODULE_FORBIDDEN');

  const after = await repo.rows(pool, 'SELECT record_status AS status,target_table AS targetTable FROM migration_source_records WHERE business_id=? AND batch_id=? AND entity_type=\'products\'', [targetA, savedA]);
  assert.deepEqual(after, before);
  const [operational] = await repo.rows(pool, 'SELECT (SELECT COUNT(*) FROM products WHERE business_id=? AND barcode=?) AS products,(SELECT COUNT(*) FROM sales WHERE business_id=?) AS sales,(SELECT COUNT(*) FROM cash_sessions WHERE business_id=?) AS cash', [targetA, 'HISTORY-1', targetA, targetA]);
  assert.deepEqual(Object.values(operational).map(Number), [0, 0, 0]);
  assert.notEqual(savedA, savedB);
});
