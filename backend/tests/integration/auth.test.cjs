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
const { reauthorizationRateLimitKey } = require('../../src/middleware/auth-rate-limit');
const { createApp } = require('../../src/app');
const database = process.env.POS_INTEGRATION_DATABASE;
if (!/^pos_auth_test_[a-f0-9]{24}$/.test(database || '') || database === process.env.DB_NAME) throw new Error('Ejecutar mediante npm run test:integration; nunca en la base principal');
const adminPassword = 'Synthetic-admin-password-123!';
const sellerPassword = 'Synthetic-seller-password-123!';
function client(base, defaultHeaders = {}) {
  const jar = new Map(); let csrf;
  async function request(route, method = 'GET', body, headers = {}) {
    const options = { method, headers: { ...defaultHeaders, Cookie: [...jar].map(([k, v]) => k + '=' + v).join('; '), ...headers } };
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
  async function login(_businessId, username = 'owner', password = adminPassword) {
    assert.equal((await request('/auth/csrf')).status, 200);
    return request('/auth/login', 'POST', { username, password });
  }
  function copySessionFrom(source) {
    for (const [name, value] of source.jar) jar.set(name, value);
    csrf = source.csrf;
  }
  return { request, login, jar, copySessionFrom, get csrf() { return csrf; } };
}
test('Integracion MySQL de autenticacion y multiempresa', async t => {
  const config = readConfig();
  const authConfig = readAuthConfig({ CSRF_SECRET: randomBytes(32).toString('hex'), AUTH_RATE_MAX: '100', AUTH_LOGIN_IP_MAX: '1000' });
  const pool = createDatabasePool({ ...config.database, database, connectionLimit: 10 });
  const secondInstancePool = createDatabasePool({ ...config.database, database, connectionLimit: 5 });
  t.after(() => pool.end());
  t.after(() => secondInstancePool.end());
  async function serve(authOptions = authConfig, appConfig = config, appPool = pool) {
    const r = createAuthRepository(appPool, authOptions);
    const server = createApp({ config: appConfig, checkDatabase: async () => {}, authentication: { repo: r, config: authOptions, auth: createAuthService(r, authOptions), users: createUsersService(r) } }).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    return 'http://127.0.0.1:' + server.address().port;
  }
  let businessA, rootId;
  await t.test('bootstrap atomico sin valores predeterminados y rechazo de repeticion', async () => {
    const result = await bootstrap(pool, { businessName: 'Synthetic A', username: 'owner', fullName: 'Admin A', password: adminPassword }, database);
    businessA = result.businessId; rootId = result.userId;
    await rows(pool, "INSERT INTO business_subscriptions (business_id,plan_code) VALUES (?,'CONECTADO_BASICO')", [businessA]);
    await assert.rejects(bootstrap(pool, { businessName: 'Duplicate', username: 'other', fullName: 'Other', password: adminPassword }, database));
    assert.equal((await rows(pool, 'SELECT id FROM businesses', [])).length, 1);
  });
  const businessB = String((await rows(pool, 'INSERT INTO businesses (name) VALUES (?)', ['Synthetic B'])).insertId);
  await rows(pool, "INSERT INTO business_subscriptions (business_id,plan_code) VALUES (?,'CONECTADO_BASICO')", [businessB]);
  const userB = String((await rows(pool, 'INSERT INTO users (business_id, username, full_name, password_hash, role) VALUES (?, ?, ?, ?, ?)', [businessB, 'owner_b', 'Admin B', await hashPassword('Other-business-password-123!'), 'ADMIN'])).insertId);
  const base = await serve();
  const admin = client(base), other = client(base);
  let sellerId;
  await t.test('login correcto con cookie HttpOnly y hash en DB, sin token en JSON', async () => {
    const result = await admin.login(businessA);
    assert.equal(result.status, 200); assert.equal(result.data.user.role, 'ADMIN');
    assert.equal(result.data.user.businessId, businessA); assert.equal(result.data.user.businessName, 'Synthetic A'); assert.equal(result.data.user.businessStatus, 'ACTIVE');
    assert.equal(result.data.token, undefined); assert.equal(result.data.user.password_hash, undefined);
    assert.match(result.headers.get('set-cookie'), /HttpOnly/); assert.match(result.headers.get('set-cookie'), /SameSite=Lax/);
    const [stored] = await rows(pool, 'SELECT token_hash FROM sessions WHERE business_id = ? AND user_id = ?', [businessA, rootId]);
    assert.equal(stored.token_hash, hashToken(admin.jar.get('pos_session')));
    assert.notEqual(stored.token_hash, admin.jar.get('pos_session'));
  });
  await t.test('login distingue usuario inexistente, contraseña incorrecta y usernames ambiguos', async () => {
    const bad = await client(base).login(businessA, 'owner', 'wrong-password');
    const missing = await client(base).login(businessA, 'missing', 'wrong-password');
    assert.equal(bad.status, 401); assert.equal(bad.data.error.code, 'INVALID_CREDENTIALS');
    assert.equal(missing.status, 401); assert.equal(missing.data.error.code, 'INVALID_CREDENTIALS');
    await rows(pool, 'UPDATE users SET username = ? WHERE business_id = ? AND id = ?', ['owner', businessB, userB]);
    const ambiguousBad = await client(base).login(businessA, 'owner', 'wrong-password');
    assert.equal(ambiguousBad.status, 401); assert.equal(ambiguousBad.data.error.code, 'INVALID_CREDENTIALS');
    const ambiguous = await client(base).login(businessA, 'owner', adminPassword);
    assert.equal(ambiguous.status, 409); assert.equal(ambiguous.data.error.code, 'USERNAME_AMBIGUOUS');
    await rows(pool, 'UPDATE users SET username = ? WHERE business_id = ? AND id = ?', ['owner_b', businessB, userB]);
  });
  await t.test('estado compartido entre instancias limita por origen sin bloquear cuentas por nombre', async () => {
    const restricted = { ...authConfig, secret: randomBytes(32).toString('hex'), rateMax: 3, loginRateMax: 3, rateWindowSeconds: 60 };
    const proxyConfig = { ...config, trustProxyHops: 1 };
    const instanceA = await serve(restricted, proxyConfig);
    const instanceB = await serve(restricted, proxyConfig, secondInstancePool);
    const sameSource = { 'X-Forwarded-For': '203.0.113.51' };
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await client(attempt % 2 ? instanceB : instanceA, sameSource).login(businessA, 'owner', 'wrong-password');
      assert.equal(result.status, 401);
      assert.equal(result.data.error.code, 'INVALID_CREDENTIALS');
    }
    const blockedAcrossInstances = await client(instanceB, sameSource).login(businessA, 'owner', adminPassword);
    assert.equal(blockedAcrossInstances.status, 429);
    assert.ok(Number(blockedAcrossInstances.headers.get('retry-after')) > 0);

    const differentSourceA = await client(instanceB, { 'X-Forwarded-For': '198.51.100.52' }).login(businessA, 'owner', adminPassword);
    const differentSourceB = await client(instanceA, { 'X-Forwarded-For': '198.51.100.53' }).login(businessB, 'owner_b', 'Other-business-password-123!');
    assert.equal(differentSourceA.status, 200);
    assert.equal(differentSourceB.status, 200);
    assert.equal(differentSourceA.data.user.businessId, businessA);
    assert.equal(differentSourceB.data.user.businessId, businessB);

    const concurrentIp = '192.0.2.54';
    const parallel = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      client(index % 2 ? instanceA : instanceB, { 'X-Forwarded-For': concurrentIp }).login(businessA, 'parallel-unknown', 'wrong-password')));
    assert.equal(parallel.filter(result => result.status === 401).length, 3);
    assert.equal(parallel.filter(result => result.status === 429).length, 9);

    const { loginRateLimitKey } = require('../../src/middleware/auth-rate-limit');
    const bucketKey = loginRateLimitKey(restricted.secret, '203.0.113.51');
    await rows(pool, 'UPDATE auth_login_rate_limits SET window_started_at = TIMESTAMPADD(SECOND, -61, UTC_TIMESTAMP(3)) WHERE bucket_hash = ?', [bucketKey]);
    const afterWindow = await client(instanceA, sameSource).login(businessA, 'owner', adminPassword);
    assert.equal(afterWindow.status, 200);
  });
  await t.test('umbral de 50 intentos por IP se comparte entre negocios e instancias con Retry-After', async () => {
    const restricted = { ...authConfig, secret: randomBytes(32).toString('hex'), rateMax: 10, loginRateMax: 50, rateWindowSeconds: 900 };
    const proxyConfig = { ...config, trustProxyHops: 1 };
    const instanceA = await serve(restricted, proxyConfig);
    const instanceB = await serve(restricted, proxyConfig, secondInstancePool);
    const sameSource = { 'X-Forwarded-For': '203.0.113.55' };
    for (let attempt = 0; attempt < 50; attempt++) {
      const businessUsername = attempt % 2 ? 'owner_b' : 'owner';
      const result = await client(attempt % 2 ? instanceB : instanceA, sameSource).login(
        attempt % 2 ? businessB : businessA,
        businessUsername,
        'wrong-password'
      );
      assert.equal(result.status, 401);
      assert.equal(result.data.error.code, 'INVALID_CREDENTIALS');
    }
    const blockedAcrossBusinesses = await client(instanceB, sameSource).login(businessB, 'owner_b', 'Other-business-password-123!');
    assert.equal(blockedAcrossBusinesses.status, 429);
    assert.equal(blockedAcrossBusinesses.data.error.code, 'TOO_MANY_ATTEMPTS');
    const retryAfter = Number(blockedAcrossBusinesses.headers.get('retry-after'));
    assert.ok(Number.isInteger(retryAfter) && retryAfter > 0 && retryAfter <= 900);

    const independentIp = await client(instanceA, { 'X-Forwarded-For': '198.51.100.55' }).login(businessB, 'owner_b', 'Other-business-password-123!');
    assert.equal(independentIp.status, 200);
    assert.equal(independentIp.data.user.businessId, businessB);
  });
  await t.test('el login falla cerrado y responde sin detalles si MySQL no puede consultar el limitador', async () => {
    await rows(pool, 'RENAME TABLE auth_login_rate_limits TO auth_login_rate_limits_test_hold', []);
    try {
      const restricted = await serve(
        { ...authConfig, secret: randomBytes(32).toString('hex'), rateMax: 3, loginRateMax: 3 },
        { ...config, trustProxyHops: 1 }
      );
      const result = await client(restricted, { 'X-Forwarded-For': '192.0.2.61' }).login(businessA, 'owner', adminPassword);
      assert.equal(result.status, 503);
      assert.equal(result.data.error.code, 'LOGIN_PROTECTION_UNAVAILABLE');
      assert.doesNotMatch(JSON.stringify(result.data), /ER_NO_SUCH_TABLE|mysql|sql|database/i);
    } finally {
      await rows(pool, 'RENAME TABLE auth_login_rate_limits_test_hold TO auth_login_rate_limits', []);
    }
  });
  await t.test('login CSRF obligatorio y solicitudes simples rechazadas', async () => {
    assert.equal((await client(base).request('/auth/login', 'POST', { businessId: businessA, username: 'owner', password: adminPassword })).status, 403);
    const legacy = client(base); await legacy.request('/auth/csrf');
    assert.equal((await legacy.request('/auth/login', 'POST', { businessId: businessA, username: 'owner', password: adminPassword })).status, 400);
    const form = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=owner' });
    assert.equal(form.status, 415);
  });
  await t.test('me requiere sesion y muestra identidad aislada', async () => {
    assert.equal((await client(base).request('/auth/me')).status, 401);
    const result = await admin.request('/auth/me'); assert.equal(result.status, 200); assert.equal(result.data.user.businessId, businessA); assert.equal(result.data.user.businessName, 'Synthetic A'); assert.equal(result.data.user.businessStatus, 'ACTIVE');
  });
  await t.test('panel global requiere andres ADMIN del negocio 1 y gestiona negocios y usuarios', async () => {
    assert.equal((await client(base).request('/admin/businesses')).status, 401);
    assert.equal((await admin.request('/admin/businesses')).status, 403);
    const ordinaryBusinessAdmin = client(base);
    assert.equal((await ordinaryBusinessAdmin.login(businessB, 'owner_b', 'Other-business-password-123!')).status, 200);
    assert.equal((await ordinaryBusinessAdmin.request('/admin/businesses')).status, 403);
    await rows(pool, 'UPDATE users SET username = ? WHERE business_id = ? AND id = ?', ['andres', businessB, userB]);
    const sameNameWrongBusiness = client(base);
    assert.equal((await sameNameWrongBusiness.login(businessB, 'andres', 'Other-business-password-123!')).status, 200);
    assert.equal((await sameNameWrongBusiness.request('/admin/businesses')).status, 403);
    await rows(pool, 'UPDATE users SET username = ? WHERE business_id = ? AND id = ?', ['owner_b', businessB, userB]);

    await rows(pool, 'UPDATE users SET username = ? WHERE business_id = ? AND id = ?', ['andres', businessA, rootId]);
    const systemOwner = client(base);
    try {
      assert.equal((await systemOwner.login(businessA, 'andres', adminPassword)).status, 200);
      const noName = await systemOwner.request('/admin/businesses', 'POST', { name: '   ' });
      assert.equal(noName.status, 400);
      const createdBusiness = await systemOwner.request('/admin/businesses', 'POST', { name: 'Panel temporary C', planCode: 'CONECTADO_BASICO' });
      assert.equal(createdBusiness.status, 201); assert.equal(createdBusiness.data.business.status, 'ACTIVE');
      const businessId = createdBusiness.data.business.id;
      assert.equal((await systemOwner.request('/admin/businesses?businessId=1')).status, 400);
      const emptyUser = await systemOwner.request('/admin/businesses/' + businessId + '/users', 'POST', { username: '', fullName: 'Empty User', password: 'Long-enough-password-123!', role: 'ADMIN' });
      const emptyPassword = await systemOwner.request('/admin/businesses/' + businessId + '/users', 'POST', { username: 'paneluser', fullName: 'Panel User', password: '', role: 'ADMIN' });
      const invalidRole = await systemOwner.request('/admin/businesses/' + businessId + '/users', 'POST', { username: 'paneluser', fullName: 'Panel User', password: 'Long-enough-password-123!', role: 'OWNER' });
      assert.equal(emptyUser.status, 400); assert.equal(emptyPassword.status, 400); assert.equal(invalidRole.status, 400);
      const duplicate = await systemOwner.request('/admin/businesses/' + businessId + '/users', 'POST', { username: 'owner_b', fullName: 'Duplicate', password: 'Long-enough-password-123!', role: 'ADMIN' });
      assert.equal(duplicate.status, 409); assert.equal(duplicate.data.error.code, 'USERNAME_EXISTS');
      const branchAdmin = await systemOwner.request('/admin/businesses/' + businessId + '/users', 'POST', { username: 'branchadmin', fullName: 'Branch Admin', password: 'Panel-admin-password-123!', role: 'ADMIN' });
      const branchSeller = await systemOwner.request('/admin/businesses/' + businessId + '/users', 'POST', { username: 'branchseller', fullName: 'Branch Seller', password: 'Panel-seller-password-123!', role: 'VENDEDOR' });
      assert.equal(branchAdmin.status, 201); assert.equal(branchAdmin.data.user.businessId, businessId);
      assert.equal(branchSeller.status, 201); assert.equal(branchSeller.data.user.role, 'VENDEDOR');
      const listedUsers = await systemOwner.request('/admin/businesses/' + businessId + '/users');
      assert.equal(listedUsers.status, 200); assert.equal(listedUsers.data.users.length, 2);
      assert.equal(JSON.stringify(listedUsers.data).includes('password_hash'), false);
      assert.equal((await systemOwner.request('/admin/businesses/999999999/users')).data.error.code, 'BUSINESS_NOT_FOUND');
      const lastAdmin = await systemOwner.request('/admin/users/' + branchAdmin.data.user.id + '/status', 'PATCH', { active: false });
      assert.equal(lastAdmin.status, 409); assert.equal(lastAdmin.data.error.code, 'LAST_ACTIVE_ADMIN');
      const sellerSession = client(base);
      assert.equal((await sellerSession.login(businessId, 'branchseller', 'Panel-seller-password-123!')).status, 200);
      assert.equal((await systemOwner.request('/admin/users/' + branchSeller.data.user.id + '/status', 'PATCH', { active: false })).status, 200);
      assert.equal((await sellerSession.request('/auth/me')).status, 401);
      assert.equal((await client(base).login(businessId, 'branchseller', 'Panel-seller-password-123!')).data.error.code, 'USER_INACTIVE');
      assert.equal((await systemOwner.request('/admin/users/' + branchSeller.data.user.id + '/status', 'PATCH', { active: true })).status, 200);
      const branchAdminSession = client(base);
      assert.equal((await branchAdminSession.login(businessId, 'branchadmin', 'Panel-admin-password-123!')).status, 200);
      const deniedSupport = await ordinaryBusinessAdmin.request('/admin/support-session', 'POST', { businessId });
      assert.equal(deniedSupport.status, 403); assert.equal(deniedSupport.data.error.code, 'SYSTEM_ADMIN_REQUIRED');
      const startedSupport = await systemOwner.request('/admin/support-session', 'POST', { businessId });
      assert.equal(startedSupport.status, 200); assert.equal(startedSupport.data.support.businessId, businessId); assert.equal(startedSupport.data.support.user.username, 'branchadmin');
      const ownerDuringSupport = await systemOwner.request('/auth/me');
      assert.equal(ownerDuringSupport.status, 200); assert.equal(ownerDuringSupport.data.user.id, rootId); assert.equal(ownerDuringSupport.data.user.businessId, businessA);
      assert.equal(ownerDuringSupport.data.support.businessId, businessId); assert.equal(ownerDuringSupport.data.support.businessName, 'Panel temporary C');
      const supportedProducts = await systemOwner.request('/products');
      assert.equal(supportedProducts.status, 200, JSON.stringify(supportedProducts.data));
      assert.equal((await systemOwner.request('/admin/support-session/end', 'POST', {})).status, 204);
      const ownerAfterSupport = await systemOwner.request('/auth/me');
      assert.equal(ownerAfterSupport.status, 200); assert.equal(ownerAfterSupport.data.user.id, rootId); assert.equal(ownerAfterSupport.data.support, undefined);
      const suspended = await systemOwner.request('/admin/businesses/' + businessId + '/status', 'PATCH', { status: 'INACTIVE' });
      assert.equal(suspended.status, 200); assert.equal(suspended.data.business.status, 'INACTIVE');
      assert.equal((await branchAdminSession.request('/auth/me')).status, 401);
      assert.equal((await client(base).login(businessId, 'branchadmin', 'Panel-admin-password-123!')).data.error.code, 'BUSINESS_INACTIVE');
      assert.equal((await systemOwner.request('/admin/businesses/' + businessId + '/status', 'PATCH', { status: 'ACTIVE' })).status, 200);
      assert.equal((await client(base).login(businessId, 'branchadmin', 'Panel-admin-password-123!')).status, 200);
      const protectedBusiness = await systemOwner.request('/admin/businesses/' + businessA + '/status', 'PATCH', { status: 'INACTIVE' });
      assert.equal(protectedBusiness.status, 409); assert.equal(protectedBusiness.data.error.code, 'BUSINESS_PROTECTED');
      const protectedUser = await systemOwner.request('/admin/users/' + rootId + '/status', 'PATCH', { active: false });
      assert.equal(protectedUser.status, 409); assert.equal(protectedUser.data.error.code, 'SYSTEM_ADMIN_PROTECTED');
      const list = await systemOwner.request('/admin/businesses');
      assert.equal(list.status, 200); assert.equal(list.data.businesses.some(business => business.id === businessId && business.userCount === 2), true);
    } finally {
      await rows(pool, 'UPDATE users SET username = ? WHERE business_id = ? AND id = ?', ['owner', businessA, rootId]);
    }
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
    assert.equal((await other.login(businessB, 'owner_b', 'Other-business-password-123!')).status, 200);
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
  await t.test('desactivar usuario revoca sesiones y bloquea login con error claro; reactivar permite login', async () => {
    assert.equal((await admin.request('/users/' + sellerId, 'PATCH', { active: false })).status, 200);
    assert.equal((await seller.request('/auth/me')).status, 401);
    const blocked = await client(base).login(businessA, 'seller', sellerPassword);
    assert.equal(blocked.status, 403); assert.equal(blocked.data.error.code, 'USER_INACTIVE');
    assert.equal((await admin.request('/users/' + sellerId, 'PATCH', { active: true })).status, 200);
    assert.equal((await seller.login(businessA, 'seller', sellerPassword)).status, 200);
  });
  await t.test('cambiar contrasena invalida sesiones y contrasena anterior', async () => {
    assert.equal((await admin.request('/users/' + sellerId + '/password', 'PUT', { password: 'New-seller-password-123!' })).status, 204);
    assert.equal((await seller.request('/auth/me')).status, 401);
    assert.equal((await client(base).login(businessA, 'seller', sellerPassword)).status, 401);
    assert.equal((await seller.login(businessA, 'seller', 'New-seller-password-123!')).status, 200);
  });
  await t.test('el plan no permite promover un segundo administrador activo', async () => {
    const promoted = await admin.request('/users/' + sellerId, 'PATCH', { role: 'ADMIN' });
    assert.equal(promoted.status, 409); assert.equal(promoted.data.error.code, 'BUSINESS_PLAN_ADMIN_LIMIT_EXCEEDED');
    assert.equal((await seller.request('/auth/me')).status, 200);
    assert.equal((await seller.request('/users')).status, 403);
    const [stored] = await rows(pool, 'SELECT role FROM users WHERE business_id=? AND id=?', [businessA, sellerId]);
    assert.equal(stored.role, 'VENDEDOR');
  });
  await t.test('desactivar una cuenta ADMIN heredada revoca sus autorizaciones', async () => {
    const create = await admin.request('/users', 'POST', { username: 'approver', fullName: 'Approver', password: adminPassword, role: 'VENDEDOR' }); assert.equal(create.status, 201);
    await rows(pool, "UPDATE users SET role='ADMIN' WHERE business_id=? AND id=?", [businessA, create.data.user.id]);
    const grant = await seller.request('/auth/authorizations', 'POST', { module: 'inventory', adminUsername: 'approver', adminPassword }); assert.equal(grant.status, 201);
    assert.equal((await admin.request('/users/' + create.data.user.id, 'PATCH', { active: false })).status, 200);
    assert.equal((await seller.request('/auth/access/inventory')).status, 403);
    assert.equal((await seller.request('/auth/authorizations', 'POST', { module: 'inventory', adminUsername: 'approver', adminPassword })).status, 401);
  });
  await t.test('negocio inactivo bloquea login y sesion existente', async () => {
    await rows(pool, 'UPDATE businesses SET status = ? WHERE id = ?', ['INACTIVE', businessB]);
    assert.equal((await other.request('/auth/me')).status, 401);
    const blocked = await client(base).login(businessB, 'owner_b', 'Other-business-password-123!');
    assert.equal(blocked.status, 403); assert.equal(blocked.data.error.code, 'BUSINESS_INACTIVE');
    await rows(pool, 'UPDATE businesses SET status = ? WHERE id = ?', ['ACTIVE', businessB]);
  });
  await t.test('limite por IP de login y limite temporal de reautorizacion', async () => {
    const restricted = await serve(
      { ...authConfig, secret: randomBytes(32).toString('hex'), rateMax: 3, loginRateMax: 3, reauthSessionRateMax: 3, reauthUserRateMax: 10, reauthIpRateMax: 10 },
      { ...config, trustProxyHops: 1 }
    );
    const attacker = client(restricted, { 'X-Forwarded-For': '203.0.113.60' });
    for (let i = 0; i < 3; i++) assert.equal((await attacker.login(businessA, 'nobody', 'wrong')).status, 401);
    assert.equal((await attacker.login(businessA, 'nobody', 'wrong')).status, 429);
    const s = client(restricted, { 'X-Forwarded-For': '198.51.100.60' });
    assert.equal((await s.login(businessA, 'seller', 'New-seller-password-123!')).status, 200);
    for (let i = 0; i < 3; i++) assert.equal((await s.request('/auth/authorizations', 'POST', { module: 'inventory', adminUsername: 'owner', adminPassword: 'wrong' })).status, 401);
    const limited = await s.request('/auth/authorizations', 'POST', { module: 'inventory', adminUsername: 'owner', adminPassword });
    assert.equal(limited.status, 429);
    assert.equal(limited.data.error.code, 'REAUTHORIZATION_RATE_LIMITED');
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
  });
  await t.test('reautorización concurrente comparte el límite entre dos instancias MySQL y limita la sesión', async () => {
    const restricted = {
      ...authConfig,
      secret: randomBytes(32).toString('hex'),
      reauthRateWindowSeconds: 900,
      reauthSessionRateMax: 3,
      reauthUserRateMax: 20,
      reauthIpRateMax: 30
    };
    const proxyConfig = { ...config, trustProxyHops: 1 };
    const instanceA = await serve(restricted, proxyConfig, pool);
    const instanceB = await serve(restricted, proxyConfig, secondInstancePool);
    const address = '192.0.2.71';
    const firstSession = client(instanceA, { 'X-Forwarded-For': address });
    assert.equal((await firstSession.login(businessA, 'seller', 'New-seller-password-123!')).status, 200);
    const secondInstanceSession = client(instanceB, { 'X-Forwarded-For': address });
    secondInstanceSession.copySessionFrom(firstSession);

    const attempts = await Promise.all(Array.from({ length: 12 }, (_, index) => {
      const session = index % 2 ? firstSession : secondInstanceSession;
      const names = ['owner', 'missing-admin', 'seller'];
      return session.request('/auth/authorizations', 'POST', {
        module: 'inventory', adminUsername: names[index % names.length], adminPassword: 'wrong-password'
      });
    }));
    assert.equal(attempts.filter(result => result.status === 401 && result.data.error.code === 'INVALID_CREDENTIALS').length, 3);
    const limited = attempts.filter(result => result.status === 429);
    assert.equal(limited.length, 9);
    assert.ok(limited.every(result => result.data.error.code === 'REAUTHORIZATION_RATE_LIMITED'));
    assert.ok(limited.every(result => Number(result.headers.get('retry-after')) > 0));

    const sessionId = String((await rows(pool, 'SELECT id FROM sessions WHERE business_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1', [businessA, sellerId]))[0].id);
    const hashes = ['ip', 'user', 'session'].map(scope => reauthorizationRateLimitKey(
      restricted.secret,
      scope,
      scope === 'ip' ? address : scope === 'user' ? businessA + ':' + sellerId : businessA + ':' + sellerId + ':' + sessionId
    ));
    const stored = await rows(pool, 'SELECT bucket_hash, attempts FROM auth_login_rate_limits WHERE bucket_hash IN (?, ?, ?)', hashes);
    assert.equal(stored.length, 3);
    assert.ok(stored.every(row => /^[a-f0-9]{64}$/.test(row.bucket_hash)));
    assert.equal(JSON.stringify(stored).includes(address), false);
  });
  await t.test('reautorización no bloquea por nombre del administrador ni mezcla negocios o sesiones', async () => {
    const restricted = {
      ...authConfig,
      secret: randomBytes(32).toString('hex'),
      reauthRateWindowSeconds: 900,
      reauthSessionRateMax: 10,
      reauthUserRateMax: 3,
      reauthIpRateMax: 20
    };
    const proxyConfig = { ...config, trustProxyHops: 1 };
    const instanceA = await serve(restricted, proxyConfig, pool);
    const instanceB = await serve(restricted, proxyConfig, secondInstancePool);
    const sharedIp = '198.51.100.72';
    const ownerSeller = client(instanceA, { 'X-Forwarded-For': sharedIp });
    assert.equal((await ownerSeller.login(businessA, 'seller', 'New-seller-password-123!')).status, 200);
    const knownName = await ownerSeller.request('/auth/authorizations', 'POST', { module: 'inventory', adminUsername: 'owner', adminPassword: 'wrong-password' });
    const absentName = await ownerSeller.request('/auth/authorizations', 'POST', { module: 'inventory', adminUsername: 'does-not-exist', adminPassword: 'wrong-password' });
    assert.deepEqual([knownName.status, knownName.data.error.code], [401, 'INVALID_CREDENTIALS']);
    assert.deepEqual([absentName.status, absentName.data.error.code], [401, 'INVALID_CREDENTIALS']);

    const anotherSession = client(instanceB, { 'X-Forwarded-For': '203.0.113.73' });
    assert.equal((await anotherSession.login(businessA, 'seller', 'New-seller-password-123!')).status, 200);
    assert.equal((await anotherSession.request('/auth/authorizations', 'POST', { module: 'inventory', adminUsername: 'owner', adminPassword: 'wrong-password' })).status, 401);
    const userLimited = await anotherSession.request('/auth/authorizations', 'POST', { module: 'inventory', adminUsername: 'unknown', adminPassword: 'wrong-password' });
    assert.equal(userLimited.status, 429);
    assert.equal(userLimited.data.error.code, 'REAUTHORIZATION_RATE_LIMITED');

    const userBucket = reauthorizationRateLimitKey(restricted.secret, 'user', businessA + ':' + sellerId);
    await rows(pool, 'UPDATE auth_login_rate_limits SET window_started_at = TIMESTAMPADD(SECOND, -901, UTC_TIMESTAMP(3)) WHERE bucket_hash = ?', [userBucket]);
    const afterWindow = await anotherSession.request('/auth/authorizations', 'POST', { module: 'inventory', adminUsername: 'owner', adminPassword });
    assert.equal(afterWindow.status, 201);

    const sellerBId = String((await rows(pool, 'INSERT INTO users (business_id, username, full_name, password_hash, role) VALUES (?, ?, ?, ?, ?)', [businessB, 'seller_b', 'Seller B', await hashPassword(sellerPassword), 'VENDEDOR'])).insertId);
    assert.ok(sellerBId);
    const isolatedBusiness = client(instanceB, { 'X-Forwarded-For': sharedIp });
    assert.equal((await isolatedBusiness.login(businessB, 'seller_b', sellerPassword)).status, 200);
    const separateTenant = await isolatedBusiness.request('/auth/authorizations', 'POST', { module: 'inventory', adminUsername: 'owner_b', adminPassword: 'wrong-password' });
    assert.equal(separateTenant.status, 401);
    assert.equal(separateTenant.data.error.code, 'INVALID_CREDENTIALS');
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
  await t.test('concurrencia no puede crear un segundo ADMIN activo mediante cambios de rol', async () => {
    const created = await admin.request('/users', 'POST', { username: 'second', fullName: 'Second', password: adminPassword, role: 'VENDEDOR' });
    assert.equal(created.status, 201);
    const results = await Promise.all([admin.request('/users/' + created.data.user.id, 'PATCH', { role: 'ADMIN' }), admin.request('/users/' + sellerId, 'PATCH', { role: 'ADMIN' })]);
    assert.equal(results.filter(r => r.status === 409 && r.data.error.code === 'BUSINESS_PLAN_ADMIN_LIMIT_EXCEEDED').length, 2);
    assert.equal((await rows(pool, 'SELECT id FROM users WHERE business_id = ? AND active = TRUE AND role = ?', [businessA, 'ADMIN'])).length, 1);
  });
});
