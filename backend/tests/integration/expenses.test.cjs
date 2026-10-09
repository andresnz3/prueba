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
if (!/^pos_auth_test_[a-f0-9]{24}$/.test(database || '') || database === process.env.DB_NAME) throw new Error('Use isolated runner');

function client(base) {
  const jar = new Map(); let csrf;
  async function request(path, method = 'GET', body) {
    const response = await fetch(base + '/api' + path, { method, headers: { Cookie: [...jar].map(([key, value]) => key + '=' + value).join('; '), ...(method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf || '' }) }, body: method === 'GET' ? undefined : JSON.stringify(body) });
    for (const cookie of response.headers.getSetCookie()) { const pair = cookie.split(';')[0], index = pair.indexOf('='); jar.set(pair.slice(0, index), pair.slice(index + 1)); }
    const data = response.status === 204 ? undefined : await response.json(); if (data?.csrfToken) csrf = data.csrfToken;
    return { status: response.status, data };
  }
  async function login(businessId, username, password) { await request('/auth/csrf'); assert.equal((await request('/auth/login', 'POST', { businessId, username, password })).status, 200); }
  return { request, login };
}

test('Integración MySQL gastos conectados, caja, auditoría y permisos', async t => {
  const config = readConfig(), authConfig = readAuthConfig({ CSRF_SECRET: randomBytes(32).toString('hex'), AUTH_RATE_MAX: '100' });
  const pool = createDatabasePool({ ...config.database, database, connectionLimit: 20 }); t.after(() => pool.end());
  const business = String((await rows(pool, 'INSERT INTO businesses (name) VALUES (?)', ['Expenses A'])).insertId);
  const password = 'Expenses-fixture-password-123!', passwordHash = await hashPassword(password);
  const adminId = String((await rows(pool, 'INSERT INTO users (business_id,username,full_name,password_hash,role) VALUES (?,?,?,?,?)', [business, 'expensesadmin', 'Gastos Admin', passwordHash, 'ADMIN'])).insertId);
  const sellerId = String((await rows(pool, 'INSERT INTO users (business_id,username,full_name,password_hash,role) VALUES (?,?,?,?,?)', [business, 'expensesseller', 'Gastos Vendedor', passwordHash, 'VENDEDOR'])).insertId);
  const repo = createAuthRepository(pool, authConfig), auth = createAuthService(repo, authConfig);
  const server = createApp({ config, checkDatabase: async () => {}, authentication: { repo, auth, config: authConfig, users: createUsersService(repo) } }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = 'http://127.0.0.1:' + server.address().port, admin = client(base), seller = client(base);
  await admin.login(business, 'expensesadmin', password); await seller.login(business, 'expensesseller', password);

  const blocked = await admin.request('/expenses', 'POST', { operationKey: randomUUID(), category: 'Servicios Básicos', description: 'Luz', receiptReference: '', amount: '5.00', paymentMethod: 'CASH' });
  assert.equal(blocked.status, 409); assert.equal(blocked.data.error.code, 'EXPENSE_CASH_CLOSED');
  assert.equal((await seller.request('/expenses')).data.error.code, 'MODULE_FORBIDDEN');

  const opened = await admin.request('/cash/sessions', 'POST', { operationKey: randomUUID(), openingAmount: '20.00' });
  assert.equal(opened.status, 201, JSON.stringify(opened.data));
  const bank = await admin.request('/expenses', 'POST', { operationKey: randomUUID(), category: 'Servicios Básicos', description: 'Internet', receiptReference: 'REC-101', amount: '3.00', paymentMethod: 'BANK' });
  assert.equal(bank.status, 201, JSON.stringify(bank.data)); assert.equal(bank.data.expense.userName, 'Gastos Admin');
  const cashInput = { operationKey: randomUUID(), category: 'Transporte', description: 'Taxi proveedor', receiptReference: '', amount: '10.00', paymentMethod: 'CASH' };
  const cash = await admin.request('/expenses', 'POST', cashInput);
  assert.equal(cash.status, 201, JSON.stringify(cash.data));
  assert.equal((await admin.request('/expenses', 'POST', cashInput)).data.expense.id, cash.data.expense.id, 'el reintento conserva una sola operación');
  const short = await admin.request('/expenses', 'POST', { ...cashInput, operationKey: randomUUID(), amount: '11.00' });
  assert.equal(short.status, 409); assert.equal(short.data.error.code, 'CASH_BALANCE_INSUFFICIENT');
  const [stored] = await rows(pool, 'SELECT e.user_id AS expenseUser,m.user_id AS movementUser,m.direction,m.amount,m.type FROM expenses e JOIN cash_movements m ON m.business_id=e.business_id AND m.expense_id=e.id WHERE e.business_id=? AND e.id=?', [business, cash.data.expense.id]);
  assert.equal(String(stored.expenseUser), adminId); assert.equal(String(stored.movementUser), adminId); assert.equal(stored.direction, 'OUT'); assert.equal(stored.type, 'EXPENSE');
  const current = await admin.request('/cash/current?full=true'); assert.equal(current.data.cash.expectedAmount, '10.00');

  assert.equal((await admin.request('/expenses?limit=100')).data.summary.total, '13.00');

  const cancelled = await admin.request('/expenses/' + cash.data.expense.id + '/cancel', 'POST', { operationKey: randomUUID(), reason: 'Registro duplicado' });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.data)); assert.equal(cancelled.data.expense.status, 'VOID');
  assert.equal((await admin.request('/cash/current?full=true')).data.cash.expectedAmount, '20.00');
  const [reversal] = await rows(pool, "SELECT COUNT(*) AS count FROM cash_movements WHERE business_id=? AND expense_id=? AND type='REVERSAL' AND direction='IN'", [business, cash.data.expense.id]);
  assert.equal(Number(reversal.count), 1);
  const [audit] = await rows(pool, "SELECT COUNT(*) AS count FROM audit_logs WHERE business_id=? AND user_id=? AND action IN ('CREATE_EXPENSE','CANCEL_EXPENSE')", [business, adminId]);
  assert.equal(Number(audit.count), 3);
  assert.equal(Number((await rows(pool, 'SELECT COUNT(*) AS count FROM expenses WHERE business_id=? AND id=? AND user_id=?', [business, bank.data.expense.id, adminId]))[0].count), 1);
  assert.equal(sellerId.length > 0, true);
});
