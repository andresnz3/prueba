'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { createServer } = require('node:http');
const fs = require('node:fs/promises');
const { join } = require('node:path');
const { readConfig } = require('../../src/config/environment');
const { readAuthConfig } = require('../../src/config/auth');
const { createDatabasePool } = require('../../src/config/database');
const { createAuthRepository, rows } = require('../../src/repositories/auth');
const { createAuthService } = require('../../src/services/auth');
const { createUsersService } = require('../../src/services/users');
const { hashPassword } = require('../../src/services/passwords');
const { createApp } = require('../../src/app');
const { photo, imageDirectory, removeImages } = require('../helpers/image-fixtures.cjs');

const database = process.env.POS_INTEGRATION_DATABASE;
if (!/^pos_auth_test_[a-f0-9]{24}$/.test(database || '') || database === process.env.DB_NAME) throw new Error('Usar MySQL temporal');
const password = 'Business-settings-fixture-123!';

function browserClient(base) {
  const cookies = new Map(); let csrf;
  async function request(path, method = 'GET', body, headers = {}) {
    const binary = Buffer.isBuffer(body);
    const response = await fetch(base + path, {
      method,
      headers: {
        Cookie: [...cookies].map(([name, value]) => name + '=' + value).join('; '),
        ...(method === 'GET' ? {} : { 'Content-Type': binary ? 'image/png' : 'application/json', 'X-CSRF-Token': csrf || '' }),
        ...headers
      },
      body: method === 'GET' ? undefined : (binary ? body : JSON.stringify(body ?? {}))
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0], index = pair.indexOf('='); cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
    const contentType = response.headers.get('content-type') || '';
    const data = response.status === 204 ? {} : contentType.startsWith('image/') ? Buffer.from(await response.arrayBuffer()) : await response.json();
    if (data?.csrfToken) csrf = data.csrfToken;
    return { status: response.status, data, headers: response.headers };
  }
  async function login(username) {
    await request('/api/auth/csrf');
    const result = await request('/api/auth/login', 'POST', { username, password });
    assert.equal(result.status, 200);
  }
  return { request, login };
}

test('configuración empresarial por sesión, permisos, auditoría y logo persistente', async t => {
  const root = await imageDirectory(); t.after(() => removeImages(root));
  const config = { ...readConfig(), images: { root, quota: 32 * 1024 * 1024 } };
  const authConfig = readAuthConfig({ CSRF_SECRET: randomBytes(32).toString('hex'), AUTH_RATE_MAX: '100' });
  const pool = createDatabasePool({ ...config.database, database, connectionLimit: 4 }); t.after(() => pool.end());
  const businessA = String((await rows(pool, 'INSERT INTO businesses (name) VALUES (?)', ['Settings fixture A'])).insertId);
  const businessB = String((await rows(pool, 'INSERT INTO businesses (name) VALUES (?)', ['Settings fixture B'])).insertId);
  const businessLegacy = String((await rows(pool, 'INSERT INTO businesses (name) VALUES (?)', ['Settings legacy target'])).insertId);
  const hash = await hashPassword(password);
  for (const [businessId, username, role] of [[businessA, 'settingsadmin', 'ADMIN'], [businessA, 'settingseller', 'VENDEDOR'], [businessB, 'settingsadminb', 'ADMIN'], [businessLegacy, 'settingslegacy', 'ADMIN']]) {
    await rows(pool, 'INSERT INTO users (business_id,username,full_name,password_hash,role) VALUES (?,?,?,?,?)', [businessId, username, username, hash, role]);
  }
  let server;
  async function startServer() {
    const app = createApp({ config, checkDatabase: async () => {}, authentication: {
      repo: createAuthRepository(pool, authConfig), config: authConfig,
      auth: createAuthService(createAuthRepository(pool, authConfig), authConfig),
      users: createUsersService(createAuthRepository(pool, authConfig))
    } });
    server = createServer(app);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return 'http://127.0.0.1:' + server.address().port;
  }
  async function stopServer() {
    if (!server) return;
    const active = server; server = null;
    await new Promise(resolve => { active.close(resolve); active.closeAllConnections(); });
  }
  t.after(stopServer);
  let base = await startServer();
  const admin = browserClient(base), seller = browserClient(base), other = browserClient(base), legacy = browserClient(base);
  await admin.login('settingsadmin'); await seller.login('settingseller'); await other.login('settingsadminb'); await legacy.login('settingslegacy');
  const settingsData = {
    businessName: 'Tienda Central A', legalName: 'Central A Sociedad Anónima', ruc: 'J0310000000000', phone: '2255-1234',
    address: 'Managua Centro', ticketHeader: 'Sucursal A', ticketFooter: 'Gracias por su compra', minStockDefault: 6.25
  };

  const before = {};
  for (const table of ['products', 'sales', 'purchases', 'cash_sessions', 'cash_movements', 'inventory_movements']) {
    const [count] = await pool.execute('SELECT COUNT(*) AS count FROM `' + table + '` WHERE business_id=?', [businessA]); before[table] = Number(count[0].count);
  }
  const initial = await seller.request('/api/business-settings');
  assert.equal(initial.status, 200); assert.equal(initial.data.businessId, businessA); assert.equal(initial.data.currency, 'C$');
  assert.equal((await seller.request('/api/auth/modules/settings/enter', 'POST', {})).status, 200);
  assert.equal((await seller.request('/api/business-settings', 'PUT', settingsData)).status, 403);
  assert.equal((await seller.request('/api/business-settings/logo', 'POST', Buffer.from('not-image'))).status, 403);
  assert.equal((await admin.request('/api/business-settings?businessId=' + businessB)).status, 400);

  const saved = await admin.request('/api/business-settings', 'PUT', settingsData);
  assert.equal(saved.status, 200); assert.equal(saved.data.businessName, settingsData.businessName);
  assert.equal(saved.data.legalName, settingsData.legalName); assert.equal(saved.data.currency, 'C$');
  assert.equal((await seller.request('/api/business-settings')).data.ruc, settingsData.ruc);
  assert.equal((await other.request('/api/business-settings')).data.businessName, 'Settings fixture B');
  const forged = await admin.request('/api/business-settings', 'PUT', { ...settingsData, businessId: businessB });
  assert.equal(forged.status, 400);
  const noOverwrite = await admin.request('/api/business-settings/import-legacy', 'POST', {
    sourceBusinessName: 'Tienda Central A', legalName: '', ruc: '', phone: '', address: '', ticketHeader: '', ticketFooter: '', minStockDefault: 5
  });
  assert.equal(noOverwrite.status, 409); assert.equal(noOverwrite.data.error.code, 'BUSINESS_SETTINGS_EXISTS');

  const mismatch = await legacy.request('/api/business-settings/import-legacy', 'POST', {
    sourceBusinessName: 'Another business', legalName: '', ruc: '', phone: '', address: '', ticketHeader: '', ticketFooter: '', minStockDefault: 5
  });
  assert.equal(mismatch.status, 409); assert.equal(mismatch.data.error.code, 'LEGACY_SETTINGS_BUSINESS_MISMATCH');
  const imported = await legacy.request('/api/business-settings/import-legacy', 'POST', {
    sourceBusinessName: 'Settings legacy target', legalName: 'Legacy Ltd.', ruc: 'LEGACY-01', phone: '', address: '', ticketHeader: '', ticketFooter: '', minStockDefault: 3
  });
  assert.equal(imported.status, 201); assert.equal(imported.data.businessName, 'Settings legacy target');

  const logoSource = await photo();
  const upload = await admin.request('/api/business-settings/logo', 'POST', logoSource);
  assert.equal(upload.status, 200); assert.match(upload.data.logo, new RegExp('^/api/product-images/' + businessA + '/[a-f0-9]{32}\\.jpg$'));
  assert.equal((await other.request(upload.data.logo)).status, 404);
  const logoResponse = await admin.request(upload.data.logo);
  assert.equal(logoResponse.status, 200); assert.ok(logoResponse.data.length > 0);
  await stopServer(); base = await startServer();
  const restarted = browserClient(base); await restarted.login('settingsadmin');
  assert.equal((await restarted.request('/api/business-settings')).data.logo, upload.data.logo);
  assert.equal((await restarted.request(upload.data.logo)).status, 200);

  const [audit] = await pool.execute('SELECT action FROM audit_logs WHERE business_id=? AND action IN (?,?,?) ORDER BY id', [businessA, 'UPDATE_BUSINESS_SETTINGS', 'UPDATE_BUSINESS_LOGO', 'IMPORT_LEGACY_BUSINESS_SETTINGS']);
  assert.deepEqual(audit.map(row => row.action), ['UPDATE_BUSINESS_SETTINGS', 'UPDATE_BUSINESS_LOGO']);
  for (const table of Object.keys(before)) {
    const [count] = await pool.execute('SELECT COUNT(*) AS count FROM `' + table + '` WHERE business_id=?', [businessA]);
    assert.equal(Number(count[0].count), before[table], table + ' debe permanecer igual');
  }

  await pool.execute('ALTER TABLE business_settings DROP COLUMN legal_name');
  try {
    const compatibleRead = await restarted.request('/api/business-settings');
    assert.equal(compatibleRead.status, 200); assert.equal(compatibleRead.data.schemaReady, false);
    assert.equal(compatibleRead.data.businessName, settingsData.businessName); assert.equal(compatibleRead.data.legalName, '');
    const blockedUpdate = await restarted.request('/api/business-settings', 'PUT', { ...settingsData, businessName: 'No debe guardarse' });
    assert.equal(blockedUpdate.status, 503); assert.equal(blockedUpdate.data.error.code, 'BUSINESS_SETTINGS_MIGRATION_REQUIRED');
    const storedImages = await fs.readdir(join(root, businessA));
    const blockedLogo = await restarted.request('/api/business-settings/logo', 'POST', logoSource);
    assert.equal(blockedLogo.status, 503); assert.deepEqual(await fs.readdir(join(root, businessA)), storedImages);
  } finally {
    await pool.execute('ALTER TABLE business_settings ADD COLUMN legal_name VARCHAR(160) NULL, ALGORITHM=INSTANT');
  }
});
