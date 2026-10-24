'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { authMiddleware } = require('../src/middleware/authentication');
const { createSupportToken, hashToken, randomToken, verifySupportToken } = require('../src/services/tokens');
const { createAuthRepository } = require('../src/repositories/auth');

const secret = 'a'.repeat(64);
const owner = { session_id: '81', user_id: '1', business_id: '1', token_hash: 'owner-session-hash', username: 'andres', role: 'ADMIN', active: true, expires_at: new Date(Date.now() + 600000) };
const target = { session_id: '101', token_hash: 'f'.repeat(64), expires_at: new Date(Date.now() + 15 * 60 * 1000), user_id: '22', business_id: '2', username: 'cliente-admin', full_name: 'Admin negocio dos', role: 'ADMIN', active: true, business_name: 'Negocio Dos', business_status: 'ACTIVE' };
const config = { secret, cookieName: 'pos_session', supportCookieName: 'pos_support_session', absoluteSeconds: 28800, production: false, sameSite: 'lax' };

function supportCookieHeader(sessionToken, supportToken) {
  return `pos_session=${sessionToken}; pos_support_session=${encodeURIComponent(supportToken)}`;
}

test('support cookie scopes operations to the selected business and keeps the owner session', async () => {
  const sessionToken = randomToken();
  const session = { ...owner, token_hash: hashToken(sessionToken) };
  const token = createSupportToken(secret, session, '2', target, Date.now() + 15 * 60 * 1000);
  const repo = { session: async tokenHash => tokenHash === session.token_hash ? session : target };
  const middleware = authMiddleware(repo, config);
  const req = { headers: { cookie: supportCookieHeader(sessionToken, token) } };
  let nextCalled = false;
  await middleware.authenticate(req, { clearCookie() {} }, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(req.ownerAuth.user_id, '1');
  assert.equal(req.ownerAuth.business_id, '1');
  assert.equal(req.auth.user_id, '22');
  assert.equal(req.auth.business_id, '2');
  assert.equal(req.auth.role, 'ADMIN');
  assert.equal(req.support.businessName, 'Negocio Dos');
});

test('a support cookie bound to Andres cannot change a customer session or fall through to it', async () => {
  const ownerToken = randomToken();
  const supportToken = createSupportToken(secret, { ...owner, token_hash: hashToken(ownerToken) }, '2', target, Date.now() + 15 * 60 * 1000);
  const customerToken = randomToken();
  const customer = { session_id: '91', user_id: '23', business_id: '2', token_hash: hashToken(customerToken), username: 'cliente', role: 'ADMIN', active: true };
  let cleared = false;
  const repo = { session: async () => customer };
  const middleware = authMiddleware(repo, config);
  const req = { headers: { cookie: supportCookieHeader(customerToken, supportToken) } };
  let nextCalled = false;
  await assert.rejects(middleware.authenticate(req, { clearCookie() { cleared = true; } }, () => { nextCalled = true; }), error => error.publicStatus === 401 && error.publicCode === 'INVALID_SUPPORT_SESSION');
  assert.equal(nextCalled, false);
  assert.equal(cleared, true);
  assert.equal(req.auth.user_id, '23');
  assert.equal(req.auth.business_id, '2');
  assert.equal(req.support, undefined);
});

test('a support cookie is discarded if the owner account no longer matches the temporary owner rule', async () => {
  const sessionToken = randomToken();
  const renamedOwner = { ...owner, username: 'otro-usuario', token_hash: hashToken(sessionToken) };
  const supportToken = createSupportToken(secret, renamedOwner, '2', target, Date.now() + 15 * 60 * 1000);
  let cleared = false;
  const middleware = authMiddleware({ session: async () => renamedOwner }, config);
  const req = { headers: { cookie: supportCookieHeader(sessionToken, supportToken) } };
  await assert.rejects(middleware.authenticate(req, { clearCookie() { cleared = true; } }, () => {}), error => error.publicStatus === 401 && error.publicCode === 'INVALID_SUPPORT_SESSION');
  assert.equal(cleared, true);
  assert.equal(req.auth.username, 'otro-usuario');
  assert.equal(req.support, undefined);
});

test('support tokens reject tampering, another secret, and expiry', () => {
  const expiresAt = Date.now() + 60_000;
  const token = createSupportToken(secret, owner, '2', target, expiresAt);
  assert.equal(verifySupportToken(secret, token)?.businessId, '2');
  assert.equal(verifySupportToken('b'.repeat(64), token), null);
  assert.equal(verifySupportToken(secret, token + 'x'), null);
  assert.equal(verifySupportToken(secret, token, expiresAt), null);
});

test('tenant transactions keep support audit scoped to the target and record Andres as actor', async () => {
  const statements = [];
  const db = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(sql, values) {
      statements.push({ sql, values });
      if (sql.startsWith('SELECT s.id AS session_id')) return [[String(values[1]) === '1' ? owner : target], []];
      if (sql.startsWith('SELECT id, status FROM businesses')) return [[{ id: '2', status: 'ACTIVE' }], []];
      if (sql.startsWith('SELECT COUNT(*) AS present FROM INFORMATION_SCHEMA.TABLES')) return [[{ present: 0 }], []];
      if (sql.startsWith('SELECT u.id AS user_id')) return [[target], []];
      if (sql.startsWith('INSERT INTO audit_logs')) return [{ affectedRows: 1 }, []];
      throw new Error('Unexpected SQL in support-session test');
    }
  };
  const repo = createAuthRepository({ getConnection: async () => db }, { absoluteSeconds: 28800 });
  const auth = { ...target, session_id: owner.session_id, token_hash: owner.token_hash, support: { actor: owner, expiresAt: Date.now() + 60000 } };
  const result = await repo.tenant(auth, async (connection, current) => {
    await repo.audit(connection, current, 'SUPPORT_TEST', 'businesses', '2', { checked: true });
    return current;
  });
  assert.equal(result.business_id, '2');
  const insert = statements.find(entry => entry.sql.startsWith('INSERT INTO audit_logs'));
  assert.equal(insert.values[0], '2');
  assert.equal(insert.values[1], '22');
  const details = JSON.parse(insert.values[5]);
  assert.equal(details.supportSession.actor.username, 'andres');
  assert.equal(details.supportSession.actor.userId, '1');
  assert.equal(details.supportSession.operatedAs.userId, '22');
});
