'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { readConfig } = require('../../src/config/environment');
const { readAuthConfig } = require('../../src/config/auth');
const { createDatabasePool } = require('../../src/config/database');
const { createAuthRepository } = require('../../src/repositories/auth');
const { createAuthService } = require('../../src/services/auth');
const { createUsersService } = require('../../src/services/users');
const { hashPassword } = require('../../src/services/passwords');
const { createApp } = require('../../src/app');

const database = process.env.POS_INTEGRATION_DATABASE;
if (!/^pos_auth_test_[a-f0-9]{24}$/.test(database || '') || database === process.env.DB_NAME) throw new Error('Usa únicamente el ejecutor MySQL aislado');

function client(base) {
  const jar = new Map(); let csrf;
  async function request(route, method = 'GET', body) {
    const headers = { Cookie: [...jar].map(([key, value]) => key + '=' + value).join('; ') };
    if (method !== 'GET') { headers['Content-Type'] = 'application/json'; headers['X-CSRF-Token'] = csrf || ''; }
    const response = await fetch(base + '/api' + route, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0], index = pair.indexOf('=');
      jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
    const data = response.status === 204 ? undefined : await response.json();
    if (data?.csrfToken) csrf = data.csrfToken;
    return { status: response.status, data };
  }
  async function login(username, password) {
    assert.equal((await request('/auth/csrf')).status, 200);
    return request('/auth/login', 'POST', { username, password });
  }
  return { request, login };
}

test('Caja histórica administrada desde el panel conserva contexto, registros y aislamiento', async t => {
  const config = readConfig();
  const authConfig = readAuthConfig({ CSRF_SECRET: randomBytes(32).toString('hex'), AUTH_RATE_MAX: '100' });
  const pool = createDatabasePool({ ...config.database, database, connectionLimit: 12 });
  t.after(() => pool.end());
  const systemPassword = 'Temporary-system-password-123!';
  const targetPassword = 'Temporary-target-password-123!';
  const otherPassword = 'Temporary-other-password-123!';
  const [root] = await pool.execute('SELECT id FROM users WHERE business_id=1 ORDER BY id LIMIT 1');
  assert.ok(root.length, 'el ejecutor debe preparar el negocio temporal del sistema');
  await pool.execute('UPDATE users SET username=?,full_name=?,password_hash=?,role=\'ADMIN\',active=TRUE WHERE business_id=1 AND id=?', ['andres', 'System admin fixture', await hashPassword(systemPassword), root[0].id]);
  const [targetBusiness] = await pool.execute('INSERT INTO businesses (name) VALUES (?)', ['Migrated cash history fixture']);
  const [targetUser] = await pool.execute('INSERT INTO users (business_id,username,full_name,password_hash,role) VALUES (?,?,?,?,\'ADMIN\')', [targetBusiness.insertId, 'cash_owner', 'Cash owner', await hashPassword(targetPassword)]);
  const [otherBusiness] = await pool.execute('INSERT INTO businesses (name) VALUES (?)', ['Other cash tenant fixture']);
  const [otherUser] = await pool.execute('INSERT INTO users (business_id,username,full_name,password_hash,role) VALUES (?,?,?,?,\'ADMIN\')', [otherBusiness.insertId, 'other_cash_owner', 'Other cash owner', await hashPassword(otherPassword)]);

  const sourceSessionIds = [];
  for (let index = 0; index < 5; index++) {
    const sourceWasOpen = index === 4;
    const openedAt = '2026-09-' + String(10 + index).padStart(2, '0') + ' 08:00:00.000';
    const closedAt = sourceWasOpen ? null : '2026-09-' + String(10 + index).padStart(2, '0') + ' 18:00:00.000';
    const expected = sourceWasOpen ? null : (20 + index).toFixed(2);
    const counted = sourceWasOpen ? null : (20 + index).toFixed(2);
    const difference = sourceWasOpen ? null : '0.00';
    const [session] = await pool.execute(
      'INSERT INTO cash_sessions (business_id,opened_by,opening_amount,opened_at,counted_amount,expected_amount,difference,closed_at,status,is_historical,source_opened_by,source_closed_by,source_status) VALUES (?,?,?, ?,?,?,?, ?,\'CLOSED\',TRUE,?,?,?)',
        [targetBusiness.insertId, targetUser.insertId, (10 + index).toFixed(2), openedAt, counted, expected, difference, closedAt, 'Legacy cashier', sourceWasOpen ? null : 'Legacy manager', sourceWasOpen ? 'abierta' : 'cerrada']
    );
    sourceSessionIds.push(String(session.insertId));
  }
  for (let index = 0; index < 32; index++) {
    const amount = (index + 1).toFixed(2);
    const direction = index % 2 === 0 ? 'IN' : 'OUT';
    await pool.execute(
      'INSERT INTO cash_movements (business_id,cash_session_id,user_id,type,direction,amount,description,status,created_at,is_historical,source_actor,source_status,source_method) VALUES (?,?,?, ?,?,?,?,\'CONFIRMED\',?,TRUE,?,\'CONFIRMED\',\'CASH\')',
      [targetBusiness.insertId, sourceSessionIds[index % sourceSessionIds.length], targetUser.insertId, direction === 'IN' ? 'MANUAL_ENTRY' : 'MANUAL_EXIT', direction, amount, 'Historical movement ' + (index + 1), '2026-09-' + String(10 + index % 5).padStart(2, '0') + ' 12:00:00.000', 'Legacy cashier']
    );
  }
  await pool.execute('INSERT INTO cash_sessions (business_id,opened_by,opening_amount,expected_amount,status,closed_at) VALUES (?,?,\'5.00\',\'5.00\',\'CLOSED\',UTC_TIMESTAMP(3))', [otherBusiness.insertId, otherUser.insertId]);

  const snapshot = async businessId => {
    const [[sessions]] = await pool.execute('SELECT COUNT(*) AS count,COALESCE(SUM(opening_amount),0.00) AS opening,COALESCE(SUM(expected_amount),0.00) AS expected FROM cash_sessions WHERE business_id=?', [businessId]);
    const [[movements]] = await pool.execute('SELECT COUNT(*) AS count,COALESCE(SUM(amount),0.00) AS amount FROM cash_movements WHERE business_id=?', [businessId]);
    return { sessions: Object.values(sessions).map(String), movements: Object.values(movements).map(String) };
  };
  const before = await snapshot(String(targetBusiness.insertId));
  const repository = createAuthRepository(pool, authConfig);
  const server = createApp({ config, checkDatabase: async () => {}, authentication: { repo: repository, auth: createAuthService(repository, authConfig), users: createUsersService(repository), config: authConfig } }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = 'http://127.0.0.1:' + server.address().port;
  const systemAdmin = client(base), otherTenant = client(base);
  assert.equal((await systemAdmin.login('andres', systemPassword)).status, 200);

  const startSupport = await systemAdmin.request('/admin/support-session', 'POST', { businessId: String(targetBusiness.insertId) });
  assert.equal(startSupport.status, 200);
  assert.equal(startSupport.data.support.businessId, String(targetBusiness.insertId));
  const identity = await systemAdmin.request('/auth/me');
  assert.equal(identity.data.user.businessId, '1');
  assert.equal(identity.data.support.businessId, String(targetBusiness.insertId));
  assert.equal(identity.data.support.user.businessId, String(targetBusiness.insertId));

  const history = await systemAdmin.request('/cash/sessions?limit=100&offset=0');
  assert.equal(history.status, 200, JSON.stringify(history.data));
  assert.equal(history.data.sessions.length, 5);
  assert.ok(history.data.sessions.every(session => session.businessId === String(targetBusiness.insertId)));
  assert.equal(history.data.sessions.flatMap(session => session.movements).length, 32);
  assert.equal(history.data.sessions.filter(session => session.expectedAmount === null).length, 1);
  assert.ok(history.data.sessions.filter(session => session.expectedAmount === null).every(session => session.isHistorical && session.status === 'CLOSED' && String(session.sourceStatus).toLowerCase() === 'abierta'));

  const overview = await systemAdmin.request('/cash/overview');
  assert.equal(overview.status, 200, JSON.stringify(overview.data));
  assert.equal(overview.data.overview.businessId, String(targetBusiness.insertId));
  assert.equal(overview.data.overview.movements.length, 32);
  assert.ok(overview.data.overview.movements.every(movement => movement.businessId === undefined || movement.businessId === String(targetBusiness.insertId)));
  assert.deepEqual(await snapshot(String(targetBusiness.insertId)), before, 'la consulta no modifica conteos ni importes');

  assert.equal((await otherTenant.login('other_cash_owner', otherPassword)).status, 200);
  const otherHistory = await otherTenant.request('/cash/sessions?limit=100&offset=0');
  assert.equal(otherHistory.status, 200);
  assert.equal(otherHistory.data.sessions.length, 1);
  assert.equal(otherHistory.data.sessions[0].businessId, String(otherBusiness.insertId));
  assert.ok(otherHistory.data.sessions.every(session => session.businessId !== String(targetBusiness.insertId)));
  const otherOverview = await otherTenant.request('/cash/overview');
  assert.equal(otherOverview.status, 200);
  assert.equal(otherOverview.data.overview.businessId, String(otherBusiness.insertId));
  assert.equal(otherOverview.data.overview.movements.length, 0);
});
