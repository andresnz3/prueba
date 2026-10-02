'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { readConfig } = require('../../src/config/environment');
const { readAuthConfig } = require('../../src/config/auth');
const { createDatabasePool } = require('../../src/config/database');
const { createAuthRepository, rows } = require('../../src/repositories/auth');
const { createAuthService } = require('../../src/services/auth');
const { createUsersService } = require('../../src/services/users');
const { bootstrap } = require('../../src/services/bootstrap');
const { hashPassword } = require('../../src/services/passwords');
const { hashToken } = require('../../src/services/tokens');
const { createApp } = require('../../src/app');
const database = process.env.POS_INTEGRATION_DATABASE;
if (!/^pos_auth_test_[a-f0-9]{24}$/.test(database || '') || database === process.env.DB_NAME) throw new Error('Ejecutar mediante npm run test:integration; nunca en la base principal');
const adminPassword = 'Synthetic-admin-password-123!';
const sellerPassword = 'Synthetic-seller-password-123!';
function client(base) {
  const jar = new Map(); let csrf;
  async function request(route, method = 'GET', body, headers = {}) {
    const options = { method, headers: { Cookie: [...jar].map(([k, v]) => k + '=' + v).join('; '), ...headers } };
    if (method !== 'GET') {
      options.headers['Content-Type'] = 'application/json';
      if (csrf && !Object.hasOwn(headers, 'X-CSRF-Token')) options.headers['X-CSRF-Token'] = csrf;
      options.body = JSON.stringify(body ?? {});
    }
    const response = await fetch(base + '/api' + route, options);
    for (const value of response.headers.getSetCookie()) {
      const first = value.split(';')[0]; const index = first.indexOf('=');
      jar.set(first.slice(0, index), first.slice(index + 1));
    }
    const data = response.status === 204 ? undefined : await response.json();
    if (data?.csrfToken) csrf = data.csrfToken;
    return { status: response.status, data, headers: response.headers };
  }
  async function login(businessId, username = 'owner', password = adminPassword) {
    assert.equal((await request('/auth/csrf')).status, 200);
    return request('/auth/login', 'POST', { businessId, username, password });
  }
  return { request, login, jar, get csrf() { return csrf; } };
}
test('Integracion MySQL de autenticacion y multiempresa', async t => {
  const config = readConfig();
  const authConfig = readAuthConfig({ CSRF_SECRET: randomBytes(32).toString('hex'), AUTH_RATE_MAX: '100' });
  const pool = createDatabasePool({ ...config.database, database, connectionLimit: 10 });
  t.after(() => pool.end());
  const repo = createAuthRepository(pool, authConfig);
  async function serve(authOptions = authConfig) {
    const r = createAuthRepository(pool, authOptions);
    const server = createApp({ config, checkDatabase: async () => {}, authentication: { repo: r, config: authOptions, auth: createAuthService(r, authOptions), users: createUsersService(r) } }).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    return 'http://127.0.0.1:' + server.address().port;
  }
  let businessA, rootId;
  await t.test('bootstrap atomico sin valores predeterminados y rechazo de repeticion', async () => {
    const result = await bootstrap(pool, { businessName: 'Synthetic A', username: 'owner', fullName: 'Admin A', password: adminPassword }, database);
    businessA = result.businessId; rootId = result.userId;
    await assert.rejects(bootstrap(pool, { businessName: 'Duplicate', username: 'other', fullName: 'Other', password: adminPassword }, database));
    assert.equal((await rows(pool, 'SELECT id FROM businesses', [])).length, 1);
  });
  const businessB = String((await rows(pool, 'INSERT INTO businesses (name) VALUES (?)', ['Synthetic B'])).insertId);
  const userB = String((await rows(pool, 'INSERT INTO users (business_id, username, full_name, password_hash, role) VALUES (?, ?, ?, ?, ?)', [businessB, 'owner', 'Admin B', await hashPassword('Other-business-password-123!'), 'ADMIN'])).insertId);
  const base = await serve();
  const admin = client(base), other = client(base);
  let sellerId;
  await t.test('login correcto con cookie HttpOnly y hash en DB, sin token en JSON', async () => {
    const result = await admin.login(businessA);
    assert.equal(result.status, 200); assert.equal(result.data.user.role, 'ADMIN');
    assert.equal(result.data.token, undefined); assert.equal(result.data.user.password_hash, undefined);
    assert.match(result.headers.get('set-cookie'), /HttpOnly/); assert.match(result.headers.get('set-cookie'), /SameSite=Lax/);
    const [stored] = await rows(pool, 'SELECT token_hash FROM sessions WHERE business_id = ? AND user_id = ?', [businessA, rootId]);
    assert.equal(stored.token_hash, hashToken(admin.jar.get('pos_session')));
    assert.notEqual(stored.token_hash, admin.jar.get('pos_session'));
  });
  await t.test('login incorrecto y desconocido son indistinguibles', async () => {
    const bad = await client(base).login(businessA, 'owner', 'wrong-password');
    const missing = await client(base).login(businessA, 'missing', 'wrong-password');
    const tenant = await client(base).login('999999', 'owner', 'wrong-password');
    assert.equal(bad.status, 401); assert.deepEqual(bad.data, missing.data); assert.deepEqual(bad.data, tenant.data);
  });
  await t.test('login CSRF obligatorio y solicitudes simples rechazadas', async () => {
    assert.equal((await client(base).request('/auth/login', 'POST', { businessId: businessA, username: 'owner', password: adminPassword })).status, 403);
    const form = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=owner' });
    assert.equal(form.status, 415);
  });
  await t.test('me requiere sesion y muestra identidad aislada', async () => {
    assert.equal((await client(base).request('/auth/me')).status, 401);
    const result = await admin.request('/auth/me'); assert.equal(result.status, 200); assert.equal(result.data.user.businessId, businessA);
  });
  await t.test('ADMIN crea VENDEDOR con Argon2id y listado sin hashes', async () => {
    const result = await admin.request('/users', 'POST', { username: 'seller', fullName: 'Seller A', password: sellerPassword, role: 'VENDEDOR' });
    assert.equal(result.status, 201); sellerId = result.data.user.id;
    const [stored] = await rows(pool, 'SELECT password_hash FROM users WHERE business_id = ? AND id = ?', [businessA, sellerId]);
    assert.match(stored.password_hash, /^\$argon2id\$/);
    const list = await admin.request('/users'); assert.equal(list.status, 200); assert.equal(list.data.users.length, 2);
    assert.equal(JSON.stringify(list.data).includes('password'), false);
    assert.equal(list.data.users.every(u => u.businessId === businessA), true);
  });
  const seller = client(base);
  await t.test('VENDEDOR solo Ventas; ADMIN todos los modulos', async () => {
    assert.equal((await seller.login(businessA, 'seller', sellerPassword)).status, 200);
    assert.equal((await seller.request('/auth/access/sales')).status, 200);
    assert.equal((await seller.request('/auth/access/inventory')).status, 403);
    assert.equal((await admin.request('/auth/access/inventory')).status, 200);
    assert.equal((await seller.request('/users')).status, 403);
    assert.equal((await seller.request('/users', 'POST', { username: 'attack', fullName: 'Attack', password: adminPassword, role: 'ADMIN' })).status, 403);
    assert.equal((await seller.request('/users/' + rootId, 'PATCH', { role: 'VENDEDOR' })).status, 403);
    assert.equal((await seller.request('/users/' + rootId + '/password', 'PUT', { password: sellerPassword })).status, 403);
  });
  await t.test('csrf de otra sesion y ausente rechazados', async () => {
    assert.equal((await seller.request('/auth/logout', 'POST', {}, { 'X-CSRF-Token': admin.csrf })).status, 403);
    assert.equal((await seller.request('/auth/logout', 'POST', {}, { 'X-CSRF-Token': '' })).status, 403);
  });
  await t.test('autorizar requiere ADMIN activo del mismo negocio', async () => {
    assert.equal((await seller.request('/auth/authorizations', 'POST', { module: 'inventory', adminUsername: 'owner', adminPassword: 'wrong' })).status, 401);
    assert.equal((await seller.request('/auth/authorizations', 'POST', { module: 'inventory', adminUsername: 'owner', adminPassword: 'Other-business-password-123!' })).status, 401);
    assert.equal((await seller.request('/auth/authorizations', 'POST', { module: 'inventory', adminUsername: 'seller', adminPassword: sellerPassword })).status, 401);
  });
  async function grant(module = 'inventory') {
    const result = await seller.request('/auth/authorizations', 'POST', { module, adminUsername: 'owner', adminPassword: adminPassword });
    assert.equal(result.status, 201); return result;
  }
  await t.test('permiso temporal limita modulo y registra otorgante y auditoria', async () => {
    const result = await grant(); assert.equal(result.data.grantedByUserId, rootId);
    assert.equal((await seller.request('/auth/access/inventory')).status, 200);
    assert.equal((await seller.request('/auth/access/purchases')).status, 403);
    assert.equal((await seller.request('/users')).status, 403);
    const [row] = await rows(pool, 'SELECT granted_by_user_id FROM session_authorizations WHERE business_id = ?', [businessA]); assert.equal(String(row.granted_by_user_id), rootId);
    const [log] = await rows(pool, 'SELECT details FROM audit_logs WHERE business_id = ? AND action = ?', [businessA, 'GRANT_MODULE']);
    const details = typeof log.details === 'string' ? JSON.parse(log.details) : log.details;
    assert.equal(details.grantedByUserId, rootId); assert.equal(JSON.stringify(details).includes('Password'), false);
  });
  await t.test('autorizacion no se comparte entre sesiones del mismo vendedor', async () => {
    const separate = client(base); await separate.login(businessA, 'seller', sellerPassword);
    assert.equal((await separate.request('/auth/access/inventory')).status, 403);
  });
  await t.test('revoca al abandonar modulo y al entrar en Ventas', async () => {
    assert.equal((await seller.request('/auth/authorizations/inventory', 'DELETE')).status, 204);
    assert.equal((await seller.request('/auth/access/inventory')).status, 403);
    await grant(); assert.equal((await seller.request('/auth/modules/sales/enter', 'POST')).status, 200);
    assert.equal((await seller.request('/auth/access/inventory')).status, 403);
  });
  await t.test('cambiar modulo sustituye permiso y navegar a destino rechazado revoca anterior', async () => {
    await grant(); await grant('reports'); assert.equal((await seller.request('/auth/access/inventory')).status, 403);
    assert.equal((await seller.request('/auth/modules/purchases/enter', 'POST')).status, 403);
    assert.equal((await seller.request('/auth/access/reports')).status, 403);
  });
  await t.test('expiracion de autorizacion', async () => {
    await grant(); await rows(pool, 'UPDATE session_authorizations SET expires_at = TIMESTAMPADD(SECOND, -1, UTC_TIMESTAMP(3)) WHERE business_id = ?', [businessA]);
    assert.equal((await seller.request('/auth/access/inventory')).status, 403);
  });
  await t.test('renovacion rota token y csrf; invalida anterior y revoca permisos', async () => {
    await grant(); const previous = seller.jar.get('pos_session'), oldCsrf = seller.csrf;
    const renewal = await seller.request('/auth/renew', 'POST'); assert.equal(renewal.status, 200);
    assert.notEqual(seller.jar.get('pos_session'), previous); assert.notEqual(seller.csrf, oldCsrf);
    const stale = client(base); stale.jar.set('pos_session', previous); assert.equal((await stale.request('/auth/me')).status, 401);
    assert.equal((await seller.request('/auth/access/inventory')).status, 403);
    assert.equal((await seller.request('/auth/logout', 'POST', {}, { 'X-CSRF-Token': oldCsrf })).status, 403);
  });
  await t.test('logout revoca sesion y todos sus permisos', async () => {
    await grant(); const old = seller.jar.get('pos_session');
    assert.equal((await seller.request('/auth/logout', 'POST')).status, 204);
    const stale = client(base); stale.jar.set('pos_session', old); assert.equal((await stale.request('/auth/me')).status, 401);
    assert.equal((await rows(pool, 'SELECT id FROM session_authorizations WHERE business_id = ?', [businessA])).length, 0);
    await seller.login(businessA, 'seller', sellerPassword);
  });
  await t.test('sesion expirada no puede renovarse; limite absoluto', async () => {
    const expired = client(base); await expired.login(businessA, 'seller', sellerPassword);
    await rows(pool, 'UPDATE sessions SET expires_at = TIMESTAMPADD(SECOND, -1, UTC_TIMESTAMP(3)) WHERE business_id = ? AND token_hash = ?', [businessA, hashToken(expired.jar.get('pos_session'))]);
    assert.equal((await expired.request('/auth/me')).status, 401); assert.equal((await expired.request('/auth/renew', 'POST')).status, 401);
    const absolute = client(base); await absolute.login(businessA, 'seller', sellerPassword);
    await rows(pool, 'UPDATE sessions SET created_at = TIMESTAMPADD(SECOND, -?, UTC_TIMESTAMP(3)) WHERE business_id = ? AND token_hash = ?', [authConfig.absoluteSeconds + 1, businessA, hashToken(absolute.jar.get('pos_session'))]);
    assert.equal((await absolute.request('/auth/me')).status, 401);
  });
  await t.test('aislamiento: otro negocio no se lista ni modifica; businessId extra rechazado', async () => {
    assert.equal((await other.login(businessB, 'owner', 'Other-business-password-123!')).status, 200);
    const list = await other.request('/users'); assert.equal(list.data.users.length, 1); assert.equal(list.data.users[0].id, userB);
    assert.equal((await admin.request('/users/' + userB, 'PATCH', { active: false })).status, 404);
    assert.equal((await admin.request('/users/' + userB + '/password', 'PUT', { password: adminPassword })).status, 404);
    assert.equal((await other.request('/users?businessId=' + businessA)).status, 400);
    assert.equal((await admin.request('/users', 'POST', { businessId: businessB, username: 'evil', fullName: 'Evil', password: adminPassword, role: 'ADMIN' })).status, 400);
  });
  await t.test('FK compuesta rechaza otorgante de otro negocio', async () => {
    const [s] = await rows(pool, 'SELECT id FROM sessions WHERE business_id = ? AND token_hash = ?', [businessA, hashToken(seller.jar.get('pos_session'))]);
    await assert.rejects(rows(pool, 'INSERT INTO session_authorizations (business_id, session_id, granted_by_user_id, module, expires_at) VALUES (?, ?, ?, ?, TIMESTAMPADD(SECOND, 30, UTC_TIMESTAMP(3)))', [businessA, String(s.id), userB, 'inventory']), e => e.code === 'ER_NO_REFERENCED_ROW_2');
  });
  await t.test('ultimo ADMIN activo no se desactiva ni degrada', async () => {
    assert.equal((await admin.request('/users/' + rootId, 'PATCH', { active: false })).status, 409);
    assert.equal((await admin.request('/users/' + rootId, 'PATCH', { role: 'VENDEDOR' })).status, 409);
  });
  await t.test('validacion de roles, contrasenas, ids, duplicados y cuerpos', async () => {
    for (const body of [{ username: 'valid', fullName: 'Name', password: 'short', role: 'ADMIN' }, { username: 'valid', fullName: 'Name', password: adminPassword, role: 'GESTOR' }, { username: 'x', fullName: 'Name', password: adminPassword, role: 'ADMIN' }]) assert.equal((await admin.request('/users', 'POST', body)).status, 400);
    assert.equal((await admin.request('/users', 'POST', { username: 'seller', fullName: 'Duplicate', password: adminPassword, role: 'ADMIN' })).status, 409);
    assert.equal((await admin.request('/users/1%20OR%201=1', 'PATCH', { active: false })).status, 400);
    assert.equal((await admin.request('/users/' + sellerId, 'PATCH', { active: 'false' })).status, 400);
    assert.equal((await admin.request('/auth/access/users')).status, 400);
  });
  await t.test('desactivar usuario revoca sesiones y bloquea login; reactivar permite login', async () => {
    assert.equal((await admin.request('/users/' + sellerId, 'PATCH', { active: false })).status, 200);
    assert.equal((await seller.request('/auth/me')).status, 401);
    assert.equal((await client(base).login(businessA, 'seller', sellerPassword)).status, 401);
    assert.equal((await admin.request('/users/' + sellerId, 'PATCH', { active: true })).status, 200);
    assert.equal((await seller.login(businessA, 'seller', sellerPassword)).status, 200);
  });
  await t.test('cambiar contrasena invalida sesiones y contrasena anterior', async () => {
    assert.equal((await admin.request('/users/' + sellerId + '/password', 'PUT', { password: 'New-seller-password-123!' })).status, 204);
    assert.equal((await seller.request('/auth/me')).status, 401);
    assert.equal((await client(base).login(businessA, 'seller', sellerPassword)).status, 401);
    assert.equal((await seller.login(businessA, 'seller', 'New-seller-password-123!')).status, 200);
  });
  await t.test('asignar rol revoca sesion y permisos; no cambia negocio', async () => {
    assert.equal((await admin.request('/users/' + sellerId, 'PATCH', { role: 'ADMIN' })).status, 200);
    assert.equal((await seller.request('/auth/me')).status, 401);
    await seller.login(businessA, 'seller', 'New-seller-password-123!');
    assert.equal((await seller.request('/users')).status, 200);
    assert.equal((await admin.request('/users/' + sellerId, 'PATCH', { role: 'VENDEDOR' })).status, 200);
    await seller.login(businessA, 'seller', 'New-seller-password-123!');
  });
  await t.test('cuenta otorgante desactivada elimina sus autorizaciones', async () => {
    const create = await admin.request('/users', 'POST', { username: 'approver', fullName: 'Approver', password: adminPassword, role: 'ADMIN' }); assert.equal(create.status, 201);
    const grant = await seller.request('/auth/authorizations', 'POST', { module: 'inventory', adminUsername: 'approver', adminPassword }); assert.equal(grant.status, 201);
    assert.equal((await admin.request('/users/' + create.data.user.id, 'PATCH', { active: false })).status, 200);
    assert.equal((await seller.request('/auth/access/inventory')).status, 403);
    assert.equal((await seller.request('/auth/authorizations', 'POST', { module: 'inventory', adminUsername: 'approver', adminPassword })).status, 401);
  });
  await t.test('negocio inactivo bloquea login y sesion existente', async () => {
    await rows(pool, 'UPDATE businesses SET status = ? WHERE id = ?', ['INACTIVE', businessB]);
    assert.equal((await other.request('/auth/me')).status, 401);
    assert.equal((await client(base).login(businessB, 'owner', 'Other-business-password-123!')).status, 401);
    await rows(pool, 'UPDATE businesses SET status = ? WHERE id = ?', ['ACTIVE', businessB]);
  });
  await t.test('limite intentos login y autorizacion temporal', async () => {
    const restricted = await serve({ ...authConfig, rateMax: 3 });
    const attacker = client(restricted);
    for (let i = 0; i < 3; i++) assert.equal((await attacker.login(businessA, 'nobody', 'wrong')).status, 401);
    assert.equal((await attacker.login(businessA, 'nobody', 'wrong')).status, 429);
    const s = client(restricted); await s.login(businessA, 'seller', 'New-seller-password-123!');
    for (let i = 0; i < 3; i++) assert.equal((await s.request('/auth/authorizations', 'POST', { module: 'inventory', adminUsername: 'owner', adminPassword: 'wrong' })).status, 401);
    assert.equal((await s.request('/auth/authorizations', 'POST', { module: 'inventory', adminUsername: 'owner', adminPassword })).status, 429);
  });
  await t.test('CORS autentica solo origen exacto y preflight CSRF; cookies produccion Secure', async () => {
    const allowed = await admin.request('/auth/me', 'GET', undefined, { Origin: config.origins[0] });
    assert.equal(allowed.headers.get('access-control-allow-credentials'), 'true');
    assert.equal((await admin.request('/auth/me', 'GET', undefined, { Origin: 'https://evil.example' })).status, 403);
    const preflight = await fetch(base + '/api/auth/login', { method: 'OPTIONS', headers: { Origin: config.origins[0], 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'X-CSRF-Token,Content-Type' } });
    assert.match(preflight.headers.get('access-control-allow-methods'), /POST/); assert.match(preflight.headers.get('access-control-allow-headers'), /X-CSRF-Token/);
    const production = client(await serve({ ...authConfig, production: true, cookieName: '__Host-pos_session', preCookieName: '__Host-pos_login_csrf', sameSite: 'none' }));
    const result = await production.login(businessA); assert.equal(result.status, 200);
    assert.match(result.headers.get('set-cookie'), /__Host-pos_session=/); assert.match(result.headers.get('set-cookie'), /Secure/); assert.match(result.headers.get('set-cookie'), /SameSite=None/); assert.equal(result.headers.get('set-cookie').includes('Domain='), false);
  });
  await t.test('concurrencia no elimina ultimo ADMIN activo', async () => {
    const created = await admin.request('/users', 'POST', { username: 'second', fullName: 'Second', password: adminPassword, role: 'ADMIN' });
    assert.equal(created.status, 201);
    const results = await Promise.all([admin.request('/users/' + created.data.user.id, 'PATCH', { role: 'VENDEDOR' }), admin.request('/users/' + rootId, 'PATCH', { role: 'VENDEDOR' })]);
    assert.equal(results.filter(r => r.status === 200).length, 1);
    assert.equal((await rows(pool, 'SELECT id FROM users WHERE business_id = ? AND active = TRUE AND role = ?', [businessA, 'ADMIN'])).length, 1);
  });
});
