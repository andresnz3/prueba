'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { readConfig } = require('../../src/config/environment');
const { readAuthConfig } = require('../../src/config/auth');
const { createDatabasePool } = require('../../src/config/database');
const { createAuthRepository, rows } = require('../../src/repositories/auth');
const { createAuthService } = require('../../src/services/auth');
const { createUsersService } = require('../../src/services/users');
const { hashPassword } = require('../../src/services/passwords');
const { createApp } = require('../../src/app');
const database = process.env.POS_INTEGRATION_DATABASE;
if (!/^pos_auth_test_[a-f0-9]{24}$/.test(database || '') || database === process.env.DB_NAME) throw new Error('Usar el ejecutor aislado');
const password = '[REDACTED_TEST_FIXTURE]';

function client(base) {
  const jar = new Map(); let csrf;
  async function request(path, method = 'GET', body, headers = {}) {
    const response = await fetch(base + '/api' + path, {
      method,
      headers: { Cookie: [...jar].map(([key, value]) => key + '=' + value).join('; '), ...(method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf || '' }), ...headers },
      body: method === 'GET' ? undefined : JSON.stringify(body)
    });
    for (const cookie of response.headers.getSetCookie()) { const pair = cookie.split(';')[0], separator = pair.indexOf('='); jar.set(pair.slice(0, separator), pair.slice(separator + 1)); }
    const data = response.status === 204 ? undefined : await response.json();
    if (data?.csrfToken) csrf = data.csrfToken;
    return { status: response.status, data };
  }
  async function login(username) { await request('/auth/csrf'); assert.equal((await request('/auth/login', 'POST', { username, password })).status, 200); }
  return { request, login };
}

test('categorías de producto se administran por negocio y solo por ADMIN', async t => {
  const config = readConfig(), authConfig = readAuthConfig({ CSRF_SECRET: randomBytes(32).toString('hex'), AUTH_RATE_MAX: '100' });
  const pool = createDatabasePool({ ...config.database, database, connectionLimit: 20 }); t.after(() => pool.end());
  await t.test('la migración conserva las categorías predeterminadas para negocios existentes', async () => {
    const [fixture] = await rows(pool, 'SELECT id FROM businesses WHERE name = ?', ['Migration 005 preservation fixture']);
    assert.ok(fixture, 'el negocio de fixture debe existir antes de la migración 021');
    const seeded = await rows(pool, 'SELECT name FROM product_categories WHERE business_id = ? ORDER BY name', [String(fixture.id)]);
    assert.deepEqual(seeded.map(row => row.name), ['Abarrotes', 'Bebidas', 'Limpieza', 'Panadería Norte', 'Snacks']);
  });
  const businessA = String((await rows(pool, 'INSERT INTO businesses (name) VALUES (?)', ['Categories A'])).insertId);
  const businessB = String((await rows(pool, 'INSERT INTO businesses (name) VALUES (?)', ['Categories B'])).insertId);
  const hash = await hashPassword(password);
  for (const [businessId, username, role] of [[businessA, 'catadmin_a', 'ADMIN'], [businessA, 'catseller_a', 'VENDEDOR'], [businessB, 'catadmin_b', 'ADMIN']]) {
    await rows(pool, 'INSERT INTO users (business_id, username, full_name, password_hash, role, active) VALUES (?, ?, ?, ?, ?, TRUE)', [businessId, username, username, hash, role]);
  }
  const repo = createAuthRepository(pool, authConfig), auth = createAuthService(repo, authConfig);
  const server = createApp({ config, checkDatabase: async () => {}, authentication: { repo, auth, config: authConfig, users: createUsersService(repo) } }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = 'http://127.0.0.1:' + server.address().port;
  const admin = client(base), seller = client(base), other = client(base), anon = client(base);
  await admin.login('catadmin_a'); await seller.login('catseller_a'); await other.login('catadmin_b');

  await t.test('requiere sesión y respeta el negocio activo', async () => {
    assert.equal((await anon.request('/product-categories')).status, 401);
    assert.equal((await admin.request('/product-categories')).status, 200);
    assert.deepEqual((await admin.request('/product-categories')).data.categories, []);
  });

  await t.test('ADMIN crea categorías y los duplicados normalizados se rechazan', async () => {
    assert.equal((await anon.request('/product-categories', 'POST', { name: 'Temporal' })).status, 401);
    const first = await admin.request('/product-categories', 'POST', { name: 'Panadería' });
    assert.equal(first.status, 201); assert.equal(first.data.category.businessId, businessA);
    assert.equal((await admin.request('/product-categories', 'POST', { name: '  PANADERIA  ' })).status, 409);
    assert.equal((await admin.request('/product-categories', 'POST', { name: 'nombre\ninválido' })).status, 400);
    assert.equal((await admin.request('/product-categories', 'POST', { name: 'Otra', businessId: businessB })).status, 400);
  });

  await t.test('un vendedor sin autorización temporal no puede gestionar categorías', async () => {
    assert.equal((await seller.request('/product-categories', 'GET')).status, 403);
    assert.equal((await seller.request('/product-categories', 'POST', { name: 'Vendedor' })).status, 403);
  });

  await t.test('el vendedor con permiso de módulo solo puede leer, no modificar', async () => {
    const grant = await seller.request('/auth/authorizations', 'POST', { module: 'inventory', adminUsername: 'catadmin_a', adminPassword: password });
    assert.equal(grant.status, 201);
    assert.equal((await seller.request('/product-categories')).status, 200);
    assert.equal((await seller.request('/product-categories', 'POST', { name: 'No autorizada' })).status, 403);
  });

  await t.test('renombrar actualiza los productos del mismo negocio y conserva auditoría', async () => {
    const oldCategory = await admin.request('/product-categories', 'POST', { name: 'Abarrotes' });
    const otherCategory = await other.request('/product-categories', 'POST', { name: 'Abarrotes' });
    assert.equal(oldCategory.status, 201); assert.equal(otherCategory.status, 201);
    const product = await admin.request('/products', 'POST', { barcode: 'CAT-' + randomUUID().slice(0, 12), name: 'Producto categoría', category: 'Abarrotes', cost: '1.00', marginRetail: '0', marginWholesale: '0', retailPrice: '2.00', wholesalePrice: '2.00', stock: '1', minStock: '0', taxRate: '0', image: null, active: true });
    assert.equal(product.status, 201);
    assert.equal((await admin.request('/product-categories/' + oldCategory.data.category.id, 'PATCH', { name: 'Despensa' })).status, 200);
    assert.equal((await admin.request('/products/' + product.data.product.id)).data.product.category, 'Despensa');
    const otherList = await other.request('/product-categories');
    assert.ok(otherList.data.categories.some(category => category.id === otherCategory.data.category.id && category.name === 'Abarrotes'));
    assert.equal((await other.request('/product-categories/' + oldCategory.data.category.id, 'PATCH', { name: 'Ajena' })).status, 404);
    const [audit] = await rows(pool, 'SELECT user_id, details FROM audit_logs WHERE business_id = ? AND action = \'RENAME_PRODUCT_CATEGORY\' ORDER BY id DESC LIMIT 1', [businessA]);
    const [actor] = await rows(pool, 'SELECT id FROM users WHERE business_id = ? AND username = ?', [businessA, 'catadmin_a']);
    assert.equal(String(audit.user_id), String(actor.id));
    const auditDetails = typeof audit.details === 'string' ? JSON.parse(audit.details) : audit.details;
    assert.equal(auditDetails.productsUpdated, 1);
  });
});
