'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, verifyPassword } = require('../src/services/passwords');
const { createAuthService } = require('../src/services/auth');
const tokens = require('../src/services/tokens');
const v = require('../src/middleware/validation');
const { readAuthConfig } = require('../src/config/auth');
const { createAuthRateLimit, createDistributedLoginRateLimit, createDistributedReauthorizationRateLimit, loginRateLimitKey, reauthorizationRateLimitKey } = require('../src/middleware/auth-rate-limit');
test('Argon2id con sal unica y verificacion correcta', async () => {
  const a = await hashPassword('long-unit-password'), b = await hashPassword('long-unit-password');
  assert.match(a, /^\$argon2id\$/); assert.notEqual(a, b);
  assert.equal(await verifyPassword(a, 'long-unit-password'), true);
  assert.equal(await verifyPassword(a, 'incorrect'), false);
  assert.equal(await verifyPassword('broken', 'anything'), false);
});
test('login no revela si el nombre de usuario existe', async () => {
  const passwordHash = await hashPassword('known-valid-password-123');
  const repo = {
    transaction: work => work({}),
    rows: async (_db, sql, [username]) => {
      assert.match(sql, /^SELECT u\.\*, b\.name AS business_name/);
      return username === 'known' ? [{
        id: 9, user_id: 9, business_id: 7, username: 'known', full_name: 'Test User',
        role: 'ADMIN', active: true, password_hash: passwordHash,
        business_name: 'Test Business', business_status: 'ACTIVE'
      }] : [];
    }
  };
  const auth = createAuthService(repo, { sessionSeconds: 300, absoluteSeconds: 600 });
  const results = [];
  for (const username of ['known', 'missing']) {
    try { await auth.login({ username, password: 'wrong-password' }, {}); }
    catch (error) { results.push({ status: error.publicStatus, code: error.publicCode }); }
  }
  assert.deepEqual(results, [
    { status: 401, code: 'INVALID_CREDENTIALS' },
    { status: 401, code: 'INVALID_CREDENTIALS' }
  ]);
});
test('tokens aleatorios de 256 bits y SHA256', () => {
  const a = tokens.randomToken(), b = tokens.randomToken();
  assert.notEqual(a, b); assert.equal(Buffer.from(a, 'base64url').length, 32);
  assert.match(tokens.hashToken(a), /^[a-f0-9]{64}$/);
});
test('CSRF firmado expira y rechaza manipulacion', () => {
  const secret = 'a'.repeat(64), now = 1800000000000;
  const token = tokens.loginCsrf(secret, now);
  assert.equal(tokens.validLoginCsrf(secret, token, now + 1000), true);
  assert.equal(tokens.validLoginCsrf(secret, token, now + 600001), false);
  assert.equal(tokens.validLoginCsrf(secret, token + 'x', now), false);
  assert.equal(tokens.validLoginCsrf(secret, token, now - 1), false);
  assert.notEqual(tokens.sessionCsrf(secret, 'one'), tokens.sessionCsrf(secret, 'two'));
});
test('config segura de cookies y expiracion', () => {
  assert.throws(() => readAuthConfig({}));
  assert.throws(() => readAuthConfig({ CSRF_SECRET: 'a'.repeat(64), COOKIE_SAME_SITE: 'none' }));
  assert.throws(() => readAuthConfig({ CSRF_SECRET: 'a'.repeat(64), SESSION_MAX_SECONDS: '60' }));
  const config = readAuthConfig({ CSRF_SECRET: 'a'.repeat(64), NODE_ENV: 'production', COOKIE_SAME_SITE: 'none' });
  assert.equal(config.production, true); assert.equal(config.cookieName, '__Host-pos_session');
  assert.equal(config.loginRateMax, 50);
  assert.equal(readAuthConfig({ CSRF_SECRET: 'a'.repeat(64), AUTH_LOGIN_IP_MAX: '75' }).loginRateMax, 75);
  assert.throws(() => readAuthConfig({ CSRF_SECRET: 'a'.repeat(64), AUTH_LOGIN_IP_MAX: '9' }));
  assert.deepEqual([config.reauthSessionRateMax, config.reauthUserRateMax, config.reauthIpRateMax, config.reauthRateWindowSeconds], [10, 50, 100, 900]);
  assert.equal(readAuthConfig({ CSRF_SECRET: 'a'.repeat(64), AUTH_REAUTH_SESSION_MAX: '7' }).reauthSessionRateMax, 7);
  assert.throws(() => readAuthConfig({ CSRF_SECRET: 'a'.repeat(64), AUTH_REAUTH_SESSION_MAX: '2' }));
});
test('validacion ids grandes, contrasenas y campos desconocidos', () => {
  assert.equal(v.id('18446744073709551615'), '18446744073709551615');
  for (const value of ['18446744073709551616', '1 OR 1=1', '-1', 1]) assert.throws(() => v.id(value));
  assert.throws(() => v.password('short', true)); assert.throws(() => v.password('a'.repeat(257)));
  assert.throws(() => v.body({ businessId: '2' }, [], [])); assert.throws(() => v.role('gestor'));
});
test('rate limit cuenta intentos concurrentes y vence ventana', () => {
  let now = 0; const errors = [];
  const middleware = createAuthRateLimit({ rateMax: 3, rateWindowSeconds: 60 }, () => now);
  const req = { ip: '127.0.0.1', body: { username: 'owner' } }, res = { set() {} };
  for (let i = 0; i < 4; i++) middleware(req, res, e => errors.push(e));
  assert.equal(errors[3].publicStatus, 429);
  now = 60001; middleware(req, res, e => assert.equal(e, undefined));
});

test('limitador compartido agrupa por origen, no por nombre de usuario, y falla cerrado', async () => {
  const buckets = new Map();
  const repo = {
    async consumeLoginRateLimit(key) {
      const attempts = (buckets.get(key) || 0) + 1;
      buckets.set(key, attempts);
      return { attempts, retryAfter: 41 };
    },
    async cleanupLoginRateLimits() {}
  };
  const config = { secret: 'a'.repeat(64), rateWindowSeconds: 900, loginRateMax: 2 };
  let now = 60000;
  const firstInstance = createDistributedLoginRateLimit({ repo, config, now: () => now });
  const secondInstance = createDistributedLoginRateLimit({ repo, config, now: () => now });
  const invoke = (middleware, req) => new Promise(resolve => {
    const headers = {};
    middleware(req, { set: (key, value) => { headers[key] = value; } }, error => resolve({ error, headers }));
  });
  const ip = '203.0.113.10';
  assert.equal(loginRateLimitKey(config.secret, ip), loginRateLimitKey(config.secret, ip));
  assert.notEqual(loginRateLimitKey(config.secret, ip), ip);
  assert.equal((await invoke(firstInstance, { ip, body: { username: 'known' } })).error, undefined);
  assert.equal((await invoke(secondInstance, { ip, body: { username: 'another-name' } })).error, undefined);
  const denied = await invoke(firstInstance, { ip, body: { username: 'known' } });
  assert.equal(denied.error.publicStatus, 429);
  assert.equal(denied.headers['Retry-After'], '41');
  assert.equal((await invoke(secondInstance, { ip: '198.51.100.11', body: { username: 'known' } })).error, undefined);
  now += 60001;

  const unavailable = createDistributedLoginRateLimit({
    repo: { consumeLoginRateLimit: async () => { throw Object.assign(new Error('private database detail'), { code: 'ER_NO_SUCH_TABLE' }); } },
    config
  });
  const failedClosed = await invoke(unavailable, { ip: '192.0.2.12', body: { username: 'owner' } });
  assert.equal(failedClosed.error.publicStatus, 503);
  assert.equal(failedClosed.error.publicCode, 'LOGIN_PROTECTION_UNAVAILABLE');
  assert.equal(failedClosed.error.message, 'LOGIN_PROTECTION_UNAVAILABLE');
});

test('reautorizacion compartida separa login y limita IP, usuario autenticado y sesion entre instancias', async () => {
  const buckets = new Map();
  const repo = {
    async consumeSharedRateLimit(key, windowSeconds) {
      assert.equal(windowSeconds, 900);
      const attempts = (buckets.get(key) || 0) + 1;
      buckets.set(key, attempts);
      return { attempts, retryAfter: 37 };
    },
    async cleanupSharedRateLimits() {}
  };
  const config = {
    secret: 'b'.repeat(64), reauthRateWindowSeconds: 900,
    reauthSessionRateMax: 2, reauthUserRateMax: 5, reauthIpRateMax: 8
  };
  const firstInstance = createDistributedReauthorizationRateLimit({ repo, config });
  const secondInstance = createDistributedReauthorizationRateLimit({ repo, config });
  const invoke = (middleware, req) => new Promise(resolve => {
    const headers = {};
    middleware(req, { set: (key, value) => { headers[key] = value; } }, error => resolve({ error, headers }));
  });
  const auth = { business_id: '12', user_id: '34', session_id: '56' };
  const ip = '203.0.113.20';
  assert.notEqual(reauthorizationRateLimitKey(config.secret, 'ip', ip), loginRateLimitKey(config.secret, ip));
  assert.notEqual(reauthorizationRateLimitKey(config.secret, 'session', '12:34:56'), ip);
  const two = await Promise.all([
    invoke(firstInstance, { auth, ip, body: { adminUsername: 'owner-a' } }),
    invoke(secondInstance, { auth, ip, body: { adminUsername: 'owner-b' } })
  ]);
  assert.deepEqual(two.map(result => result.error), [undefined, undefined]);
  const blocked = await invoke(secondInstance, { auth, ip, body: { adminUsername: 'missing-user' } });
  assert.equal(blocked.error.publicStatus, 429);
  assert.equal(blocked.error.publicCode, 'REAUTHORIZATION_RATE_LIMITED');
  assert.equal(blocked.headers['Retry-After'], '37');

  const otherSession = await invoke(secondInstance, { auth: { ...auth, session_id: '57' }, ip: '198.51.100.20' });
  assert.equal(otherSession.error, undefined);
  const otherBusiness = await invoke(firstInstance, { auth: { ...auth, business_id: '13' }, ip });
  assert.equal(otherBusiness.error, undefined);
});

test('reautorizacion falla cerrada cuando no hay contador compartido', async () => {
  const middleware = createDistributedReauthorizationRateLimit({
    repo: { consumeSharedRateLimit: async () => { throw Object.assign(new Error('private database detail'), { code: 'ER_NO_SUCH_TABLE' }); } },
    config: { secret: 'c'.repeat(64), reauthRateWindowSeconds: 900, reauthSessionRateMax: 10, reauthUserRateMax: 50, reauthIpRateMax: 100 }
  });
  const result = await new Promise(resolve => middleware(
    { auth: { business_id: '1', user_id: '2', session_id: '3' }, ip: '192.0.2.30' },
    { set() {} },
    error => resolve(error)
  ));
  assert.equal(result.publicStatus, 503);
  assert.equal(result.publicCode, 'REAUTHORIZATION_PROTECTION_UNAVAILABLE');
  assert.equal(result.message, 'REAUTHORIZATION_PROTECTION_UNAVAILABLE');
});

test('texto rechaza todos los controles C0 y conserva Unicode y limites', () => {
  for (let code = 0; code <= 0x1f; code++) {
    assert.throws(() => v.text('Nombre' + String.fromCharCode(code) + 'Apellido', 100), { publicStatus: 400, publicCode: 'INVALID_INPUT' });
  }
  assert.equal(v.text('  Jos\u00e9 \ud83d\udce6  ', 100), 'Jos\u00e9 \ud83d\udce6');
  assert.equal(v.text('A' + String.fromCharCode(0x7f) + 'B', 100), 'A' + String.fromCharCode(0x7f) + 'B');
  for (const value of [null, 123, '', '   ', 'a'.repeat(101)]) assert.throws(() => v.text(value, 100));
});
