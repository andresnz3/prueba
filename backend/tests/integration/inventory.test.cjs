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
const { hashPassword } = require('../../src/services/passwords');
const { createApp } = require('../../src/app');
const database = process.env.POS_INTEGRATION_DATABASE;
if (!/^pos_auth_test_[a-f0-9]{24}$/.test(database || '') || database === process.env.DB_NAME) throw new Error('Usar el ejecutor aislado');
const password = 'Inventory-fixture-password-123!';
function client(base) {
  const jar = new Map(); let csrf;
  async function request(path, method = 'GET', body, headers = {}) {
    const response = await fetch(base + '/api' + path, { method, headers: { Cookie: [...jar].map(([key, value]) => key + '=' + value).join('; '), ...(method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf || '' }), ...headers }, body: method === 'GET' ? undefined : JSON.stringify(body) });
    for (const cookie of response.headers.getSetCookie()) { const pair = cookie.split(';')[0], separator = pair.indexOf('='); jar.set(pair.slice(0, separator), pair.slice(separator + 1)); }
    const data = response.status === 204 ? undefined : await response.json();
    if (data?.csrfToken) csrf = data.csrfToken;
    return { status: response.status, data, headers: response.headers };
  }
  async function login(businessId, username) { await request('/auth/csrf'); assert.equal((await request('/auth/login', 'POST', { businessId, username, password })).status, 200); }
  return { request, login };
}
const input = overrides => ({ barcode: 'INV-1', name: 'Producto API', category: 'Bebidas', cost: '10.50', marginRetail: '17.1234', marginWholesale: '8.0000', retailPrice: '12.31', wholesalePrice: '11.34', stock: '10.125', minStock: '2.001', taxRate: '1.5000', image: null, active: true, ...overrides });
test('Integracion MySQL productos e inventario', async t => {
  const config = readConfig(), authConfig = readAuthConfig({ CSRF_SECRET: randomBytes(32).toString('hex'), AUTH_RATE_MAX: '100' });
  const pool = createDatabasePool({ ...config.database, database, connectionLimit: 20 }); t.after(() => pool.end());
  const business = String((await rows(pool, 'INSERT INTO businesses (name) VALUES (?)', ['Inventory A'])).insertId);
  const businessB = String((await rows(pool, 'INSERT INTO businesses (name) VALUES (?)', ['Inventory B'])).insertId);
  const hash = await hashPassword(password);
  for (const [tenant, username, role] of [[business, 'invadmin', 'ADMIN'], [business, 'invseller', 'VENDEDOR'], [businessB, 'invadmin', 'ADMIN']]) await rows(pool, 'INSERT INTO users (business_id, username, full_name, password_hash, role) VALUES (?, ?, ?, ?, ?)', [tenant, username, username, hash, role]);
  const repo = createAuthRepository(pool, authConfig), auth = createAuthService(repo, authConfig);
  let productLockRequested;
  const originalRows = repo.rows;
  repo.rows = (db, sql, values) => { if (productLockRequested && sql.startsWith('SELECT * FROM products') && sql.endsWith('FOR UPDATE')) { productLockRequested(); productLockRequested = null; } return originalRows(db, sql, values); };
  const server = createApp({ config, checkDatabase: async () => {}, authentication: { repo, auth, config: authConfig, users: createUsersService(repo) } }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve)); t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = 'http://127.0.0.1:' + server.address().port;
  const admin = client(base), other = client(base), seller = client(base), anon = client(base);
  await admin.login(business, 'invadmin'); await other.login(businessB, 'invadmin'); await seller.login(business, 'invseller');
  let product;
  const fresh = async () => (await admin.request('/products/' + product.id)).data.product;
  const ledger = async () => rows(pool, 'SELECT * FROM inventory_movements WHERE business_id = ? AND product_id = ? ORDER BY id', [business, product.id]);
  await t.test('sin sesion o CSRF no hay escrituras', async () => {
    assert.equal((await anon.request('/products')).status, 401);
    assert.equal((await admin.request('/products', 'POST', input(), { 'X-CSRF-Token': 'invalid' })).status, 403);
  });
  await t.test('crear preserva precios, margenes, decimales y registra stock inicial y actor', async () => {
    const result = await admin.request('/products', 'POST', input()); assert.equal(result.status, 201); product = result.data.product;
    for (const field of ['cost', 'marginRetail', 'marginWholesale', 'retailPrice', 'wholesalePrice', 'stock', 'minStock', 'taxRate']) assert.equal(product[field], input()[field]);
    assert.equal(product.businessId, business); assert.match(product.revision, /^[a-f0-9]{64}$/);
    const [entry] = await ledger(); assert.equal(entry.type, 'INITIAL'); assert.equal(entry.quantity, '10.125'); assert.equal(entry.stock_after, '10.125'); assert.ok(entry.user_id);
  });
  await t.test('listar, buscar y consultar existencias', async () => {
    const result = await admin.request('/products?limit=1&search=INV-1'); assert.equal(result.status, 200); assert.equal(result.data.products[0].id, product.id); assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal((await admin.request('/products/' + product.id + '/stock')).data.stock, '10.125');
    assert.equal((await admin.request('/products?limit=101')).status, 400);
  });
  await t.test('codigo unico por negocio incluyendo colacion e inactivos', async () => {
    assert.equal((await admin.request('/products', 'POST', input({ barcode: 'inv-1' }))).status, 409);
    assert.equal((await other.request('/products', 'POST', input())).status, 201);
  });
  await t.test('edicion manual de stock registra delta y conserva precios independientes', async () => {
    const result = await admin.request('/products/' + product.id, 'PATCH', { revision: product.revision, name: 'Editado', stock: '11.126', retailPrice: '12.00', marginRetail: '33.3333' }); assert.equal(result.status, 200);
    product = result.data.product; assert.equal(product.marginRetail, '33.3333'); assert.equal(product.retailPrice, '12.00'); assert.equal(product.wholesalePrice, '11.34');
    const entries = await ledger(); assert.equal(entries.at(-1).type, 'MANUAL_EDIT'); assert.equal(entries.at(-1).quantity, '1.001');
  });
  await t.test('ediciones simultaneas con misma revision no pierden cambios', async () => {
    const revision = (await fresh()).revision;
    const results = await Promise.all(['Primero', 'Segundo'].map(name => admin.request('/products/' + product.id, 'PATCH', { revision, name })));
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  });
  await t.test('inactivar y activar conserva existencias e historial', async () => {
    const before = await fresh(), count = (await ledger()).length;
    const off = await admin.request('/products/' + product.id, 'PATCH', { revision: before.revision, active: false }); assert.equal(off.status, 200);
    assert.equal(off.data.product.stock, before.stock); assert.equal((await ledger()).length, count);
    assert.equal((await admin.request('/products', 'POST', input())).status, 409);
    assert.equal((await seller.request('/catalog/products')).data.products.some(p => p.id === product.id), false);
    assert.equal((await admin.request('/products/' + product.id, 'PATCH', { revision: off.data.product.revision, active: true })).status, 200);
  });
  await t.test('ajustes positivos y negativos exactos sin recalcular precios', async () => {
    const before = await fresh();
    assert.equal((await admin.request('/products/' + product.id + '/movements', 'POST', { type: 'ADJUSTMENT', quantity: '0.001', reason: 'Conteo' })).data.product.stock, '11.127');
    const result = await admin.request('/products/' + product.id + '/movements', 'POST', { type: 'ADJUSTMENT', quantity: '-0.001', reason: 'Correccion' }); assert.equal(result.data.product.stock, '11.126'); assert.equal(result.data.product.retailPrice, before.retailPrice);
  });
  await t.test('merma superior al stock no deja cambios parciales', async () => {
    const before = await fresh(), count = (await ledger()).length;
    const result = await admin.request('/products/' + product.id + '/movements', 'POST', { type: 'WASTE', quantity: '12', reason: 'Rotura' }); assert.equal(result.status, 409); assert.equal(result.data.error.code, 'INSUFFICIENT_STOCK'); assert.equal((await fresh()).stock, before.stock); assert.equal((await ledger()).length, count);
  });
  await t.test('ajustes concurrentes acumulan todas las unidades', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => admin.request('/products/' + product.id + '/movements', 'POST', { type: 'ADJUSTMENT', quantity: '1', reason: 'Paralelo' })));
    assert.ok(results.every(result => result.status === 201)); assert.equal((await fresh()).stock, '17.126');
  });
  await t.test('mermas concurrentes compiten por stock sin producir negativos', async () => {
    const results = await Promise.all(Array.from({ length: 2 }, () => admin.request('/products/' + product.id + '/movements', 'POST', { type: 'WASTE', quantity: '10', reason: 'Paralelo' })));
    assert.deepEqual(results.map(result => result.status).sort(), [201, 409]); assert.equal((await fresh()).stock, '7.126');
  });
  await t.test('historial paginado conserva usuario, costo y stock resultante', async () => {
    const result = await admin.request('/inventory/movements?productId=' + product.id + '&limit=2'); assert.equal(result.status, 200); assert.equal(result.data.movements.length, 2);
    assert.ok(result.data.movements.every(entry => entry.businessId === business && entry.userName === 'invadmin' && entry.userId && entry.unitCost === '10.50'));
    const anchor = result.data.movements[0].id;
    const url = '/inventory/movements?productId=' + product.id + '&limit=2&offset=2&maxId=' + anchor;
    const before = (await admin.request(url)).data.movements.map(entry => entry.id);
    await admin.request('/products/' + product.id + '/movements', 'POST', { type: 'ADJUSTMENT', quantity: '0.001', reason: 'Durante paginacion' });
    assert.deepEqual((await admin.request(url)).data.movements.map(entry => entry.id), before);
  });
  await t.test('validacion estricta sin truncado ni campos de autoridad', async () => {
    for (const change of [{ stock: '-1' }, { cost: '1.001' }, { stock: '1.0001' }, { marginRetail: '1000' }, { name: ' ' }, { businessId: businessB }, { userId: '1' }, { supplier: 'Proveedor' }, { image: 'javascript:alert(1)' }]) assert.equal((await admin.request('/products', 'POST', input({ barcode: 'BAD', ...change }))).status, 400);
    assert.equal((await admin.request('/products/' + product.id, 'PATCH', { active: false })).status, 400);
    assert.equal((await admin.request('/products/' + product.id + '/movements', 'POST', { type: 'SALE', quantity: '-1', reason: 'Sin implementar' })).status, 400);
  });
  await t.test('catalogo de vendedor no filtra costos ni permisos de inventario', async () => {
    assert.equal((await seller.request('/products')).status, 403);
    const visible = (await seller.request('/catalog/products')).data.products.find(p => p.id === product.id); assert.ok(visible); assert.equal(visible.cost, undefined); assert.equal(visible.marginRetail, undefined);
  });
  await t.test('autorizacion de otro modulo no permite productos', async () => {
    await seller.request('/auth/authorizations', 'POST', { module: 'purchases', adminUsername: 'invadmin', adminPassword: password });
    assert.equal((await seller.request('/products', 'POST', input({ barcode: 'SELLER' }))).status, 403);
  });
  await t.test('autorizacion inventory permite movimientos y revocacion al salir los impide', async () => {
    assert.equal((await seller.request('/auth/authorizations', 'POST', { module: 'inventory', adminUsername: 'invadmin', adminPassword: password })).status, 201);
    const result = await seller.request('/products/' + product.id + '/movements', 'POST', { type: 'ADJUSTMENT', quantity: '0.001', reason: 'Vendedor autorizado' }); assert.equal(result.status, 201);
    assert.equal((await seller.request('/auth/modules/sales/enter', 'POST', {})).status, 200);
    assert.equal((await seller.request('/products/' + product.id + '/movements', 'POST', { type: 'ADJUSTMENT', quantity: '1', reason: 'Sin permiso' })).status, 403);
  });
  await t.test('otro negocio no puede consultar ni modificar producto o movimientos ajenos', async () => {
    assert.equal((await other.request('/products/' + product.id)).status, 404);
    assert.equal((await other.request('/inventory/movements?productId=' + product.id)).status, 404);
    assert.equal((await other.request('/products/' + product.id, 'PATCH', { revision: (await fresh()).revision, name: 'Ataque' })).status, 404);
    assert.equal((await other.request('/products?businessId=' + business)).status, 400);
  });
  await t.test('fallo de insercion de movimiento revierte stock y ledger', async () => {
    const before = await fresh(), count = (await ledger()).length;
    await pool.query("CREATE TRIGGER inventory_test_failure BEFORE INSERT ON inventory_movements FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'private failure'");
    try { const result = await admin.request('/products/' + product.id + '/movements', 'POST', { type: 'ADJUSTMENT', quantity: '1', reason: 'Rollback' }); assert.equal(result.status, 500); assert.equal(result.data.error.code, 'INTERNAL_ERROR'); } finally { await pool.query('DROP TRIGGER inventory_test_failure'); }
    assert.equal((await fresh()).stock, before.stock); assert.equal((await ledger()).length, count);
  });
  await t.test('permiso que expira esperando el bloqueo revierte la escritura', async () => {
    await seller.request('/auth/authorizations', 'POST', { module: 'inventory', adminUsername: 'invadmin', adminPassword: password });
    await rows(pool, 'UPDATE session_authorizations SET expires_at = TIMESTAMPADD(MICROSECOND, 1500000, UTC_TIMESTAMP(3)) WHERE business_id = ?', [business]);
    const before = await fresh(), count = (await ledger()).length;
    const blocker = await pool.getConnection(); await blocker.beginTransaction();
    await rows(blocker, 'SELECT id FROM products WHERE business_id = ? AND id = ? FOR UPDATE', [business, product.id]);
    let request;
    try {
      const barrier = new Promise(resolve => { productLockRequested = resolve; });
      request = seller.request('/products/' + product.id + '/movements', 'POST', { type: 'ADJUSTMENT', quantity: '1', reason: 'Expira esperando' });
      await Promise.race([barrier, request.then(() => { throw new Error('No se alcanzo el bloqueo esperado'); })]); await rows(blocker, 'SELECT SLEEP(?)', [2]); await blocker.commit();
      const result = await request; assert.equal(result.status, 403); assert.equal(result.data.error.code, 'MODULE_FORBIDDEN');
    } finally { productLockRequested = null; await blocker.rollback(); blocker.release(); }
    assert.equal((await fresh()).stock, before.stock); assert.equal((await ledger()).length, count);
  });
  await t.test('sesion expirada no modifica inventario', async () => {
    await rows(pool, 'UPDATE sessions SET expires_at = TIMESTAMPADD(SECOND, -1, UTC_TIMESTAMP(3)) WHERE business_id = ? AND user_id IN (SELECT id FROM users WHERE business_id = ? AND username = ?)', [business, business, 'invseller']);
    assert.equal((await seller.request('/products')).status, 401);
  });
});
