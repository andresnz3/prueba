'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { readConfig } = require('../../src/config/environment');
const { readAuthConfig } = require('../../src/config/auth');
const { createDatabasePool } = require('../../src/config/database');
const { createAuthRepository } = require('../../src/repositories/auth');
const { createAuthService } = require('../../src/services/auth');
const { createUsersService } = require('../../src/services/users');
const { hashPassword } = require('../../src/services/passwords');
const { createApp } = require('../../src/app');

const database = process.env.POS_INTEGRATION_DATABASE;
if (!/^pos_auth_test_[a-f0-9]{24}$/.test(database || '') || database === process.env.DB_NAME) throw new Error('Use the isolated MySQL runner');

function client(base) {
  const cookies = new Map(); let csrf = '';
  async function request(path, method = 'GET', body) {
    const headers = { Cookie: [...cookies].map(([key, value]) => key + '=' + value).join('; ') };
    if (method !== 'GET') { headers['Content-Type'] = 'application/json'; if (csrf) headers['X-CSRF-Token'] = csrf; }
    const response = await fetch(base + '/api' + path, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    for (const value of response.headers.getSetCookie()) { const pair = value.split(';')[0], index = pair.indexOf('='); cookies.set(pair.slice(0, index), pair.slice(index + 1)); }
    const data = response.status === 204 ? undefined : await response.json();
    if (data?.csrfToken) csrf = data.csrfToken;
    return { status: response.status, data };
  }
  async function login(username, password) { await request('/auth/csrf'); return request('/auth/login', 'POST', { username, password }); }
  return { request, login };
}

test('connected plans enforce backend user limits, preserve accounts on downgrade, and do not gate modules', async t => {
  const config = readConfig();
  const pool = createDatabasePool({ ...config.database, database, connectionLimit: 10 });
  t.after(() => pool.end());
  const authConfig = readAuthConfig({ CSRF_SECRET: randomBytes(32).toString('hex'), AUTH_RATE_MAX: '100' });
  const rootPassword = 'Synthetic-system-admin-123!';
  const [root] = await pool.execute('INSERT INTO businesses (name) VALUES (?)', ['System business']);
  assert.equal(String(root.insertId), '1');
  await pool.execute('INSERT INTO users (business_id,username,full_name,password_hash,role) VALUES (1,?,?,?,\'ADMIN\')', ['andres', 'System owner', await hashPassword(rootPassword)]);
  await pool.execute("INSERT INTO business_subscriptions (business_id,plan_code) VALUES (1,'CONECTADO_BASICO')");
  const repo = createAuthRepository(pool, authConfig);
  const app = createApp({ config, checkDatabase: async () => {}, authentication: { repo, config: authConfig, auth: createAuthService(repo, authConfig), users: createUsersService(repo) } });
  const server = require('node:http').createServer(app).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = 'http://127.0.0.1:' + server.address().port;
  const system = client(base);
  assert.equal((await system.login('andres', rootPassword)).status, 200);

  const rootCapacity = await system.request('/admin/businesses/1/user-capacity');
  assert.equal(rootCapacity.status, 200);
  assert.deepEqual([rootCapacity.data.capacity.activeUsers, rootCapacity.data.capacity.activeAdmins], [0, 0], 'the system administrator does not consume a business seat');

  const planSpecs = [
    ['CONECTADO_BASICO', 3], ['CONECTADO_ESTANDAR', 5], ['CONECTADO_PREMIUM', 10]
  ];
  const created = [];
  for (const [planCode, cap] of planSpecs) {
    const name = 'Plan ' + planCode + ' ' + randomUUID();
    const businessResponse = await system.request('/admin/businesses', 'POST', { name, planCode });
    assert.equal(businessResponse.status, 201, JSON.stringify(businessResponse.data));
    const business = businessResponse.data.business;
    assert.equal(business.planCode, planCode);
    const adminName = 'admin_' + randomUUID().replaceAll('-', '').slice(0, 18);
    const adminPassword = 'Synthetic-plan-admin-123!';
    const adminCreated = await system.request('/admin/businesses/' + business.id + '/users', 'POST', { username: adminName, fullName: 'Plan administrator', password: adminPassword, role: 'ADMIN' });
    assert.equal(adminCreated.status, 201, JSON.stringify(adminCreated.data));
    const sellers = [];
    for (let index = 1; index < cap; index++) {
      const username = 'seller_' + randomUUID().replaceAll('-', '').slice(0, 18);
      const response = await system.request('/admin/businesses/' + business.id + '/users', 'POST', { username, fullName: 'Plan seller ' + index, password: 'Synthetic-plan-seller-123!', role: 'VENDEDOR' });
      assert.equal(response.status, 201, JSON.stringify(response.data));
      sellers.push({ id: response.data.user.id, username });
    }
    const capacity = await system.request('/admin/businesses/' + business.id + '/user-capacity');
    assert.equal(capacity.status, 200);
    assert.deepEqual([capacity.data.capacity.activeUsers, capacity.data.capacity.maximumUsers, capacity.data.capacity.activeAdmins, capacity.data.capacity.availableUsers], [cap, cap, 1, 0]);
    const extra = await system.request('/admin/businesses/' + business.id + '/users', 'POST', { username: 'extra_' + randomUUID().replaceAll('-', '').slice(0, 18), fullName: 'Extra user', password: 'Synthetic-plan-extra-123!', role: 'VENDEDOR' });
    assert.equal(extra.status, 409); assert.equal(extra.data.error.code, 'BUSINESS_PLAN_USER_LIMIT_EXCEEDED');
    const extraAdmin = await system.request('/admin/businesses/' + business.id + '/users', 'POST', { username: 'admin2_' + randomUUID().replaceAll('-', '').slice(0, 17), fullName: 'Second administrator', password: 'Synthetic-plan-extra-123!', role: 'ADMIN' });
    assert.equal(extraAdmin.status, 409); assert.equal(extraAdmin.data.error.code, 'BUSINESS_PLAN_ADMIN_LIMIT_EXCEEDED');

    const tenantAdmin = client(base);
    assert.equal((await tenantAdmin.login(adminName, adminPassword)).status, 200);
    for (const module of ['sales', 'inventory', 'purchases', 'payables', 'clients', 'suppliers', 'cash', 'expenses', 'reports', 'dashboard', 'settings']) {
      const access = await tenantAdmin.request('/auth/access/' + module);
      assert.equal(access.status, 200, planCode + ' must keep the normal ADMIN permission for ' + module);
    }
    created.push({ business, planCode, cap, adminName, adminPassword, sellers });
  }

  const standard = created[1];
  const standardAdmin = client(base);
  assert.equal((await standardAdmin.login(standard.adminName, standard.adminPassword)).status, 200);
  const extraNormalUser = await standardAdmin.request('/users', 'POST', { username: 'normal_extra_' + randomUUID().replaceAll('-', '').slice(0, 14), fullName: 'Extra normal user', password: 'Synthetic-normal-extra-123!', role: 'VENDEDOR' });
  assert.equal(extraNormalUser.status, 409); assert.equal(extraNormalUser.data.error.code, 'BUSINESS_PLAN_USER_LIMIT_EXCEEDED');
  const roleUpgrade = await standardAdmin.request('/users/' + standard.sellers[0].id, 'PATCH', { role: 'ADMIN' });
  assert.equal(roleUpgrade.status, 409); assert.equal(roleUpgrade.data.error.code, 'BUSINESS_PLAN_ADMIN_LIMIT_EXCEEDED');
  const inactiveName = 'inactive_' + randomUUID().replaceAll('-', '').slice(0, 14);
  const [inactive] = await pool.execute('INSERT INTO users (business_id,username,full_name,password_hash,role,active) VALUES (?,?,?,?,\'VENDEDOR\',FALSE)', [standard.business.id, inactiveName, 'Inactive legacy account', 'fixture-not-used']);
  const blockedNormalReactivation = await standardAdmin.request('/users/' + inactive.insertId, 'PATCH', { active: true });
  assert.equal(blockedNormalReactivation.status, 409); assert.equal(blockedNormalReactivation.data.error.code, 'BUSINESS_PLAN_USER_LIMIT_EXCEEDED');
  assert.equal((await standardAdmin.request('/users/' + standard.sellers[0].id, 'PATCH', { active: false })).status, 200);
  assert.equal((await standardAdmin.request('/users/' + inactive.insertId, 'PATCH', { active: true })).status, 200, 'an inactive user can take a seat released by another user');

  const blockedDowngrade = await system.request('/admin/businesses/' + standard.business.id + '/plan', 'PATCH', { planCode: 'CONECTADO_BASICO', nextDueDate: null });
  assert.equal(blockedDowngrade.status, 409); assert.equal(blockedDowngrade.data.error.code, 'BUSINESS_PLAN_DOWNGRADE_BLOCKED');
  const [stillStandard] = await pool.execute('SELECT plan_code FROM business_subscriptions WHERE business_id=?', [standard.business.id]);
  assert.equal(stillStandard[0].plan_code, 'CONECTADO_ESTANDAR');

  for (const seller of standard.sellers.slice(1, 3)) assert.equal((await system.request('/admin/users/' + seller.id + '/status', 'PATCH', { active: false })).status, 200);
  const lower = await system.request('/admin/businesses/' + standard.business.id + '/plan', 'PATCH', { planCode: 'CONECTADO_BASICO', nextDueDate: null });
  assert.equal(lower.status, 200);
  const blockedReactivation = await system.request('/admin/users/' + standard.sellers[1].id + '/status', 'PATCH', { active: true });
  assert.equal(blockedReactivation.status, 409); assert.equal(blockedReactivation.data.error.code, 'BUSINESS_PLAN_USER_LIMIT_EXCEEDED');
  const retained = await system.request('/admin/businesses/' + standard.business.id + '/users');
  assert.equal(retained.data.users.length, 6, 'downgrade and rejected reactivation must retain every account');
  assert.equal(retained.data.users.filter(user => !user.active).length, 3);

  const legacyName = 'legacy_no_plan_' + randomUUID().replaceAll('-', '').slice(0, 18);
  const [legacy] = await pool.execute('INSERT INTO businesses (name) VALUES (?)', ['Legacy unassigned']);
  await pool.execute('INSERT INTO users (business_id,username,full_name,password_hash,role) VALUES (?,?,?,?,\'ADMIN\')', [legacy.insertId, legacyName, 'Legacy admin', await hashPassword('Synthetic-legacy-admin-123!')]);
  const legacyAdmin = client(base);
  assert.equal((await legacyAdmin.login(legacyName, 'Synthetic-legacy-admin-123!')).status, 200);
  const legacyCreate = await legacyAdmin.request('/users', 'POST', { username: 'legacy_vendor_' + randomUUID().replaceAll('-', '').slice(0, 16), fullName: 'Legacy vendor', password: 'Synthetic-legacy-vendor-123!', role: 'VENDEDOR' });
  assert.equal(legacyCreate.status, 409); assert.equal(legacyCreate.data.error.code, 'BUSINESS_PLAN_REQUIRED');
  const [legacyPlan] = await pool.execute('SELECT COUNT(*) AS total FROM business_subscriptions WHERE business_id=?', [legacy.insertId]);
  assert.equal(Number(legacyPlan[0].total), 0, 'legacy businesses are not assigned a plan automatically');
});
