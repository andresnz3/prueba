'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { readAuthConfig } = require('../../src/config/auth');
const { readConfig } = require('../../src/config/environment');
const { createDatabasePool } = require('../../src/config/database');
const { createAuthRepository } = require('../../src/repositories/auth');
const { createAuthService } = require('../../src/services/auth');
const { createUsersService } = require('../../src/services/users');
const { createApp } = require('../../src/app');
const { hashPassword } = require('../../src/services/passwords');
const { createSystemAdminService } = require('../../src/services/system-admin');

const database = process.env.POS_INTEGRATION_DATABASE;
if (!/^pos_auth_test_[a-f0-9]{24}$/.test(database || '') || database === process.env.DB_NAME) throw new Error('Use the isolated MySQL runner');

test('migration destination stays blocked until an explicitly reconciled completion exists', async t => {
  const config = readConfig();
  const pool = createDatabasePool({ ...config.database, database, connectionLimit: 4 });
  t.after(() => pool.end());
  const authConfig = readAuthConfig({ CSRF_SECRET: 'd'.repeat(64) });
  const repo = createAuthRepository(pool, authConfig);
  const service = createSystemAdminService(repo);
  const admin = { username: 'andres', role: 'ADMIN', business_id: '1', user_id: '1' };
  const name = 'Migration gate ' + randomUUID();

  const target = await service.createMigrationTarget(admin, name, 'CONECTADO_BASICO');
  assert.equal(target.status, 'INACTIVE');
  assert.equal(target.migrationState, 'PENDING');
  assert.equal(target.userCount, 0);
  const businesses = await service.listBusinesses(admin);
  assert.equal(businesses.find(business => business.id === target.id)?.migrationState, 'PENDING');
  const billing = await service.listBilling(admin);
  assert.equal(billing.businesses.find(business => business.id === target.id)?.migrationState, 'PENDING');

  const username = 'mig_gate_' + randomUUID().replaceAll('-', '').slice(0, 20);
  const password = 'Synthetic-migration-password-123!';
  await service.createBusinessUser(admin, target.id, { username, fullName: 'Migration Admin', password, role: 'ADMIN' });
  const auth = createAuthService(repo, authConfig);
  await assert.rejects(auth.login({ username, password }, { ip: '127.0.0.1', agent: 'migration gate fixture' }), error => error.publicCode === 'BUSINESS_MIGRATION_PENDING');
  await assert.rejects(service.setBusinessStatus(admin, target.id, 'ACTIVE'), error => error.publicCode === 'MIGRATION_RECONCILIATION_REQUIRED');

  const [state] = await pool.execute('SELECT b.status,c.state,c.source_business_key,c.batch_id,c.completed_at FROM businesses b JOIN business_migration_controls c ON c.business_id=b.id WHERE b.id=?', [target.id]);
  assert.deepEqual(state.map(row => [row.status, row.state, row.source_business_key, row.batch_id, row.completed_at]), [['INACTIVE', 'PENDING', null, null, null]]);
  const [sessions] = await pool.execute('SELECT COUNT(*) AS count FROM sessions WHERE business_id=?', [target.id]);
  assert.equal(Number(sessions[0].count), 0);
});

test('existing empty business can be prepared without changing its identity, users or settings', async t => {
  const config = readConfig();
  const pool = createDatabasePool({ ...config.database, database, connectionLimit: 4 });
  t.after(() => pool.end());
  const authConfig = readAuthConfig({ CSRF_SECRET: 'e'.repeat(64) });
  const repo = createAuthRepository(pool, authConfig);
  const service = createSystemAdminService(repo);
  const auth = createAuthService(repo, authConfig);
  const admin = { username: 'andres', role: 'ADMIN', business_id: '1', user_id: '1' };
  const target = await service.createBusiness(admin, 'Existing migration target ' + randomUUID(), 'CONECTADO_BASICO');
  const username = 'existing_mig_' + randomUUID().replaceAll('-', '').slice(0, 18);
  const password = 'Synthetic-existing-migration-password-123!';
  await service.createBusinessUser(admin, target.id, { username, fullName: 'Existing Business Admin', password, role: 'ADMIN' });
  await pool.execute('INSERT INTO business_settings (business_id,business_name) VALUES (?,?)', [target.id, target.name]);
  await auth.login({ username, password }, { ip: '127.0.0.1', agent: 'existing migration target fixture' });

  const inspection = await service.inspectExistingMigrationTarget(admin, target.id);
  assert.equal(inspection.business.id, target.id);
  assert.equal(inspection.business.status, 'ACTIVE');
  assert.equal(inspection.eligible, true);
  assert.equal(inspection.preserved.users, 1);
  assert.equal(inspection.preserved.settings, 1);
  assert.equal(inspection.accessChanges.activeSessions, 1);
  assert.equal(inspection.warnings.some(message => message.includes('revocarán')), true);
  await assert.rejects(service.prepareExistingMigrationTarget(admin, target.id, false), error => error.publicCode === 'MIGRATION_TARGET_CONFIRMATION_REQUIRED');

  const prepared = await service.prepareExistingMigrationTarget(admin, target.id, true);
  assert.equal(prepared.business.id, target.id);
  assert.equal(prepared.business.status, 'INACTIVE');
  assert.equal(prepared.business.migrationState, 'PENDING');
  assert.equal(prepared.accessSuspended, true);
  const [counts] = await pool.execute('SELECT (SELECT COUNT(*) FROM users WHERE business_id=?) AS users,(SELECT COUNT(*) FROM business_settings WHERE business_id=?) AS settings,(SELECT COUNT(*) FROM sessions WHERE business_id=? AND revoked_at IS NOT NULL) AS revoked_sessions,(SELECT COUNT(*) FROM business_migration_controls WHERE business_id=?) AS controls', [target.id, target.id, target.id, target.id]);
  assert.deepEqual([Number(counts[0].users), Number(counts[0].settings), Number(counts[0].revoked_sessions), Number(counts[0].controls)], [1, 1, 1, 1]);
  await assert.rejects(auth.login({ username, password }, { ip: '127.0.0.1', agent: 'existing migration target fixture' }), error => error.publicCode === 'BUSINESS_MIGRATION_PENDING');
  await assert.rejects(service.setBusinessStatus(admin, target.id, 'ACTIVE'), error => error.publicCode === 'MIGRATION_RECONCILIATION_REQUIRED');
});

test('existing business with commercial records and system business are rejected without changes', async t => {
  const config = readConfig();
  const pool = createDatabasePool({ ...config.database, database, connectionLimit: 4 });
  t.after(() => pool.end());
  const authConfig = readAuthConfig({ CSRF_SECRET: 'f'.repeat(64) });
  const repo = createAuthRepository(pool, authConfig);
  const service = createSystemAdminService(repo);
  const admin = { username: 'andres', role: 'ADMIN', business_id: '1', user_id: '1' };
  const target = await service.createBusiness(admin, 'Non-empty migration target ' + randomUUID(), 'CONECTADO_BASICO');
  await pool.execute('INSERT INTO products (business_id,barcode,name,category,stock) VALUES (?,?,?,?,?)', [target.id, 'MIG-' + randomUUID().slice(0, 12), 'Existing product', 'Fixture', 3]);
  const inspection = await service.inspectExistingMigrationTarget(admin, target.id);
  assert.equal(inspection.eligible, false);
  assert.equal(inspection.blockers.some(message => message.includes('Productos e inventario')), true);
  await assert.rejects(service.prepareExistingMigrationTarget(admin, target.id, true), error => error.publicCode === 'MIGRATION_TARGET_HAS_DATA');
  const [state] = await pool.execute('SELECT b.id,b.status,(SELECT COUNT(*) FROM products p WHERE p.business_id=b.id) AS products,(SELECT COUNT(*) FROM business_migration_controls c WHERE c.business_id=b.id) AS controls FROM businesses b WHERE b.id=?', [target.id]);
  assert.deepEqual([String(state[0].id), state[0].status, Number(state[0].products), Number(state[0].controls)], [target.id, 'ACTIVE', 1, 0]);
  await assert.rejects(service.inspectExistingMigrationTarget(admin, '1'), error => error.publicCode === 'MIGRATION_TARGET_PROTECTED');
  await assert.rejects(service.prepareExistingMigrationTarget(admin, '1', true), error => error.publicCode === 'MIGRATION_TARGET_PROTECTED');
});

test('migrated accounts use fresh credentials and an explicitly selected role; source users are ignored', async t => {
  const config = readConfig();
  const pool = createDatabasePool({ ...config.database, database, connectionLimit: 4 });
  t.after(() => pool.end());
  const authConfig = readAuthConfig({ CSRF_SECRET: randomBytes(32).toString('hex') });
  const repo = createAuthRepository(pool, authConfig);
  const service = createSystemAdminService(repo);
  const admin = { username: 'andres', role: 'ADMIN', business_id: '1', user_id: '1' };
  const target = await service.createMigrationTarget(admin, 'Account setup ' + randomUUID(), 'CONECTADO_BASICO');
  const freshPassword = 'Fresh-migration-password-123!';
  const username = 'migration_vendor_' + randomUUID().replaceAll('-', '').slice(0, 16);
  await service.createBusinessUser(admin, target.id, { username, fullName: 'Nueva cuenta elegida', password: freshPassword, role: 'VENDEDOR' });
  const sourceId = 'local-account-source-' + randomUUID();
  const sourcePackage = {
    type: 'pos_local_migration_package', version: 2, exportedAt: '2026-10-20T12:00:00.000Z',
    source: { mode: 'local', scope: { idSource: 'config', localBusinessId: sourceId, idsFound: 0, legacyRecords: 0, excludedRecords: 0, missingStores: [] } },
    business: { name: 'Local source with users', localBusinessId: sourceId },
    data: {
      products: [], clients: [], suppliers: [], sales: [], purchases: [], cashSessions: [],
      inventoryMovements: [], abonos: [], expenses: [], auditLogs: [], saleOrders: [], syncQueue: [],
      categories: [], configuration: { name: 'Local source with users', localBusinessId: sourceId, currency: 'C$' },
      users: [{ id: 'local-admin-1', username: 'unsafe-local-admin', password: 'Legacy-weak-password', role: 'ADMIN' }]
    }
  };
  const archived = await service.archiveFullMigration(admin, target.id, sourcePackage, true);
  assert.equal(archived.status, 'ARCHIVED');
  const [users] = await pool.execute('SELECT username,role,password_hash FROM users WHERE business_id=? ORDER BY id', [target.id]);
  assert.deepEqual(users.map(row => [row.username, row.role]), [[username, 'VENDEDOR']]);
  assert.match(users[0].password_hash, /^\$argon2id\$/);
  assert.notEqual(users[0].password_hash, freshPassword);
  assert.notEqual(users[0].username, 'unsafe-local-admin');
  const [sourceUsers] = await pool.execute('SELECT COUNT(*) AS count FROM migration_source_records WHERE business_id=? AND entity_type IN (\'users\',\'user\')', [target.id]);
  assert.equal(Number(sourceUsers[0].count), 0, 'el paquete no crea cuentas ni conserva credenciales locales como registros de origen');
  const [control] = await pool.execute('SELECT b.status,c.state FROM businesses b JOIN business_migration_controls c ON c.business_id=b.id WHERE b.id=?', [target.id]);
  assert.deepEqual([control[0].status, control[0].state], ['INACTIVE', 'PENDING']);
});

test('existing-target HTTP API enforces system-admin/CSRF checks and serves Spanish JSON as UTF-8', async t => {
  const config = readConfig();
  const pool = createDatabasePool({ ...config.database, database, connectionLimit: 6 });
  t.after(() => pool.end());
  const authConfig = readAuthConfig({ CSRF_SECRET: randomBytes(32).toString('hex'), AUTH_RATE_MAX: '40' });
  const repo = createAuthRepository(pool, authConfig);
  const auth = createAuthService(repo, authConfig);
  const username = 'andres';
  const password = 'Synthetic-system-admin-password-123!';
  await pool.execute('INSERT INTO users (business_id,username,full_name,password_hash,role) VALUES (1,?,?,?,\'ADMIN\')', [username, 'Sistema', await hashPassword(password)]);
  const service = createSystemAdminService(repo);
  const admin = { username, role: 'ADMIN', business_id: '1', user_id: '1' };
  const target = await service.createBusiness(admin, 'Negocio ágil ñandú ' + randomUUID(), 'CONECTADO_BASICO');
  const app = createApp({ config, checkDatabase: async () => {}, authentication: { repo, config: authConfig, auth, users: createUsersService(repo) } });
  const server = require('node:http').createServer(app).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = 'http://127.0.0.1:' + server.address().port + '/api';
  const cookies = new Map(); let csrf = '';
  async function request(path, method = 'GET', body) {
    const headers = { Cookie: [...cookies].map(([key, value]) => key + '=' + value).join('; ') };
    if (method !== 'GET') { headers['Content-Type'] = 'application/json'; if (csrf) headers['X-CSRF-Token'] = csrf; }
    const response = await fetch(base + path, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body) });
    for (const value of response.headers.getSetCookie()) { const pair = value.split(';')[0], index = pair.indexOf('='); cookies.set(pair.slice(0, index), pair.slice(index + 1)); }
    const text = await response.text();
    const data = text ? JSON.parse(text) : undefined;
    if (data?.csrfToken) csrf = data.csrfToken;
    return { response, data, text };
  }
  await request('/auth/csrf');
  const login = await request('/auth/login', 'POST', { username, password });
  assert.equal(login.response.status, 200);
  const inspection = await request('/system-admin/migration/targets/' + target.id + '/inspect');
  assert.equal(inspection.response.status, 200);
  assert.match(inspection.response.headers.get('content-type'), /^application\/json;\s*charset=utf-8/i);
  assert.match(inspection.text, /Negocio ágil ñandú/);
  assert.equal(inspection.data.business.id, target.id);
  const unconfirmed = await request('/system-admin/migration/targets/' + target.id + '/prepare', 'POST', { confirmed: false });
  assert.equal(unconfirmed.response.status, 409);
  assert.equal(unconfirmed.data.error.code, 'MIGRATION_TARGET_CONFIRMATION_REQUIRED');
  const prepared = await request('/system-admin/migration/targets/' + target.id + '/prepare', 'POST', { confirmed: true });
  assert.equal(prepared.response.status, 201);
  assert.equal(prepared.data.business.id, target.id);
  assert.equal(prepared.data.business.status, 'INACTIVE');
  assert.equal(prepared.data.business.migrationState, 'PENDING');

  const packageValue = {
    type: 'pos_local_migration_package', version: 2, exportedAt: '2024-04-05T11:22:33.000Z',
    source: { mode: 'local', scope: { localBusinessId: 'http-projection-source', idSource: 'config', idsFound: 1, legacyRecords: 0, excludedRecords: 0, missingStores: [] } },
    business: { name: target.name, localBusinessId: 'http-projection-source' },
    data: {
      products: [], clients: [], suppliers: [], sales: [], purchases: [], cashSessions: [], inventoryMovements: [], abonos: [],
      expenses: [], auditLogs: [], saleOrders: [], syncQueue: [], configuration: { name: target.name, currency: 'C$' }, categories: []
    }
  };
  const archived = await service.archiveFullMigration(admin, target.id, packageValue, true);
  const projected = await request('/system-admin/migration/archive/' + target.id + '/' + archived.batchId + '/project/catalog', 'POST', {});
  assert.equal(projected.response.status, 200);
  assert.equal(projected.data.reconciliation.complete, false);
  assert.equal(projected.data.reconciliation.fullMigrationComplete, false);
  assert.equal(projected.data.businessStatus, 'INACTIVE');
  assert.equal(projected.data.migrationState, 'PENDING');
});
