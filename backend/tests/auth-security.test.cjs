'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, verifyPassword } = require('../src/services/passwords');
const tokens = require('../src/services/tokens');
const v = require('../src/middleware/validation');
const { readAuthConfig } = require('../src/config/auth');
const { createAuthRateLimit } = require('../src/middleware/auth-rate-limit');
test('Argon2id con sal unica y verificacion correcta', async () => {
  const a = await hashPassword('long-unit-password'), b = await hashPassword('long-unit-password');
  assert.match(a, /^\$argon2id\$/); assert.notEqual(a, b);
  assert.equal(await verifyPassword(a, 'long-unit-password'), true);
  assert.equal(await verifyPassword(a, 'incorrect'), false);
  assert.equal(await verifyPassword('broken', 'anything'), false);
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
  const req = { ip: '127.0.0.1', body: { businessId: '1', username: 'owner' } }, res = { set() {} };
  for (let i = 0; i < 4; i++) middleware(req, res, e => errors.push(e));
  assert.equal(errors[3].publicStatus, 429);
  now = 60001; middleware(req, res, e => assert.equal(e, undefined));
});

test('texto rechaza todos los controles C0 y conserva Unicode y limites', () => {
  for (let code = 0; code <= 0x1f; code++) {
    assert.throws(() => v.text('Nombre' + String.fromCharCode(code) + 'Apellido', 100), { publicStatus: 400, publicCode: 'INVALID_INPUT' });
  }
  assert.equal(v.text('  Jos\u00e9 \ud83d\udce6  ', 100), 'Jos\u00e9 \ud83d\udce6');
  assert.equal(v.text('A' + String.fromCharCode(0x7f) + 'B', 100), 'A' + String.fromCharCode(0x7f) + 'B');
  for (const value of [null, 123, '', '   ', 'a'.repeat(101)]) assert.throws(() => v.text(value, 100));
});
