'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isSystemAdmin, requireSystemAdmin } = require('../src/services/system-admin-access');
const { authMiddleware } = require('../src/middleware/authentication');
const { createSupportToken, hashToken, randomToken } = require('../src/services/tokens');

test('only ADMIN users from business 1 satisfy the system administrator policy, regardless of username', () => {
  for (const username of ['andres', 'second-admin', 'administrator-3']) {
    assert.equal(isSystemAdmin({ username, role: 'ADMIN', business_id: '1' }), true);
    assert.doesNotThrow(() => requireSystemAdmin({ username, role: 'ADMIN', business_id: 1 }));
  }

  for (const auth of [
    { username: 'seller', role: 'VENDEDOR', business_id: '1' },
    { username: 'tenant-admin', role: 'ADMIN', business_id: '2' },
    { username: 'andres', role: 'ADMIN', business_id: '2' },
    { username: 'tenant-seller', role: 'VENDEDOR', business_id: '2' },
    null,
    undefined
  ]) {
    assert.equal(isSystemAdmin(auth), false);
    assert.throws(() => requireSystemAdmin(auth), error => error.publicStatus === 403 && error.publicCode === 'SYSTEM_ADMIN_REQUIRED');
  }
});

test('a second business-1 administrator retains a valid support session bound to that administrator session', async () => {
  const secret = 'a'.repeat(64);
  const ownerToken = randomToken();
  const supportToken = randomToken();
  const owner = {
    user_id: '12', session_id: '34', business_id: '1', token_hash: hashToken(ownerToken),
    username: 'second-admin', full_name: 'Second Admin', role: 'ADMIN', active: 1
  };
  const target = {
    user_id: '56', session_id: '78', business_id: '9', token_hash: hashToken(supportToken),
    username: 'tenant-admin', full_name: 'Tenant Admin', role: 'ADMIN', active: 1,
    business_name: 'Fictional tenant'
  };
  const supportCookie = createSupportToken(secret, owner, '9', { session_id: target.session_id, token_hash: target.token_hash }, Date.now() + 60_000);
  const repo = { session: async tokenHash => tokenHash === owner.token_hash ? owner : tokenHash === target.token_hash ? target : undefined };
  const middleware = authMiddleware(repo, {
    cookieName: 'pos_session', supportCookieName: 'pos_support_session',
    secret, production: false, sameSite: 'lax'
  });
  const req = { headers: { cookie: `pos_session=${ownerToken}; pos_support_session=${encodeURIComponent(supportCookie)}` } };
  const cleared = [];
  const res = { clearCookie: (...args) => cleared.push(args) };
  let nextCalled = false;
  await middleware.authenticate(req, res, error => { if (error) throw error; nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.deepEqual(cleared, []);
  assert.equal(req.ownerAuth.user_id, '12');
  assert.equal(req.auth.user_id, '56');
  assert.equal(req.auth.support.actor.user_id, '12');
  assert.equal(req.auth.support.actor.username, 'second-admin');
});

test('seller or administrator outside business 1 cannot retain or use a support session', async t => {
  for (const owner of [
    { user_id: '20', session_id: '30', business_id: '1', username: 'seller', role: 'VENDEDOR' },
    { user_id: '21', session_id: '31', business_id: '2', username: 'tenant-admin', role: 'ADMIN' }
  ]) {
    await t.test(`${owner.role} business ${owner.business_id}`, async () => {
      const secret = 'b'.repeat(64);
      const ownerToken = randomToken();
      const targetToken = randomToken();
      const fullOwner = { ...owner, token_hash: hashToken(ownerToken) };
      const target = { user_id: '56', session_id: '78', business_id: '9', token_hash: hashToken(targetToken), username: 'tenant-admin', full_name: 'Tenant Admin', role: 'ADMIN', active: 1, business_name: 'Fictional tenant' };
      const support = createSupportToken(secret, { ...fullOwner, session_id: owner.session_id }, '9', { session_id: target.session_id, token_hash: target.token_hash }, Date.now() + 60_000);
      const repo = { session: async tokenHash => tokenHash === fullOwner.token_hash ? fullOwner : tokenHash === target.token_hash ? target : undefined };
      const middleware = authMiddleware(repo, { cookieName: 'pos_session', supportCookieName: 'pos_support_session', secret, production: false, sameSite: 'lax' });
      const req = { headers: { cookie: `pos_session=${ownerToken}; pos_support_session=${encodeURIComponent(support)}` } };
      const cleared = [];
      const res = { clearCookie: (...args) => cleared.push(args) };
      await assert.rejects(middleware.authenticate(req, res, () => assert.fail('unauthorized support session advanced')), error => error.publicStatus === 401 && error.publicCode === 'INVALID_SUPPORT_SESSION');
      assert.equal(cleared.length, 1);
    });
  }
});
