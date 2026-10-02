'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { createApp } = require('../src/app');
const { readConfig } = require('../src/config/environment');
const { createDatabasePool } = require('../src/config/database');
const { createHealthCheck } = require('../src/services/health');
const { errorHandler } = require('../src/middleware/errors');
const { createShutdown } = require('../src/services/shutdown');
const valid = { HOST: '127.0.0.1', DB_HOST: '127.0.0.1', DB_PORT: '3307', DB_NAME: 'pos_multitenant', DB_USER: 'test', DB_PASSWORD: 'test-only', CORS_ORIGINS: 'http://localhost:5500' };
async function serve(t, checkDatabase = async () => {}) {
  const server = createApp({ config: readConfig(valid), checkDatabase }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return 'http://127.0.0.1:' + server.address().port;
}
test('health 200, no cache, Helmet, sin cabecera Express', async t => {
  const response = await fetch(await serve(t) + '/api/health');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok', server: 'up', database: 'up' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-powered-by'), null);
});
test('health 503 sin revelar error de MySQL', async t => {
  const base = await serve(t, async () => { throw new Error('password=secret host=internal'); });
  const response = await fetch(base + '/api/health');
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { status: 'degraded', server: 'up', database: 'unavailable' });
});
test('CORS permite solo origen exacto y GET en preflight', async t => {
  const base = await serve(t);
  const response = await fetch(base + '/api/health', { headers: { Origin: valid.CORS_ORIGINS } });
  assert.equal(response.headers.get('access-control-allow-origin'), valid.CORS_ORIGINS);
  const denied = await fetch(base + '/api/health', { headers: { Origin: 'http://evil.example' } });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
  const preflight = await fetch(base + '/api/health', { method: 'OPTIONS', headers: { Origin: valid.CORS_ORIGINS, 'Access-Control-Request-Method': 'POST' } });
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET');
});
test('404, JSON invalido y limite JSON', async t => {
  const base = await serve(t);
  assert.equal((await fetch(base + '/missing')).status, 404);
  const invalid = await fetch(base + '/api/health', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: { code: 'INVALID_JSON' } });
  const huge = await fetch(base + '/api/health', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: 'a'.repeat(17000) }) });
  assert.equal(huge.status, 413);
  assert.deepEqual(await huge.json(), { error: { code: 'PAYLOAD_TOO_LARGE' } });
});
test('error central 500 no revela stack ni credenciales', () => {
  let status; let body;
  const res = { status(value) { status = value; return this; }, json(value) { body = value; } };
  errorHandler(new Error('secret'), {}, res, () => assert.fail());
  assert.equal(status, 500);
  assert.deepEqual(body, { error: { code: 'INTERNAL_ERROR' } });
});
for (const key of ['HOST', 'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'CORS_ORIGINS']) {
  test('config requiere ' + key, () => {
    const env = { ...valid }; delete env[key];
    assert.throws(() => readConfig(env), new RegExp(key));
  });
}
for (const [key, value] of [['DB_PORT', '3307abc'], ['PORT', '0'], ['DB_CONNECTION_LIMIT', '0'], ['DB_CONNECT_TIMEOUT_MS', '-1'], ['HEALTH_TIMEOUT_MS', 'Infinity'], ['JSON_LIMIT_BYTES', '99999999'], ['NODE_ENV', 'invalid'], ['CORS_ORIGINS', '*'], ['CORS_ORIGINS', 'https://example.com/path']]) {
  test('config rechaza ' + key + '=' + value, () => assert.throws(() => readConfig({ ...valid, [key]: value })));
}
test('config valida sin valores de credenciales por defecto', () => {
  assert.equal(readConfig(valid).database.port, 3307);
  assert.equal(readConfig(valid).database.database, 'pos_multitenant');
});
test('consulta preparada y liberacion de conexion', async () => {
  let released = 0;
  const connection = { async execute(sql, params) { assert.equal(sql, 'SELECT ? AS health'); assert.deepEqual(params, [1]); }, release() { released++; } };
  await createHealthCheck({ async getConnection() { return connection; } }, 100)();
  assert.equal(released, 1);
});
test('libera conexion si la consulta falla', async () => {
  let released = 0;
  await assert.rejects(createHealthCheck({ async getConnection() { return { async execute() { throw new Error('down'); }, release() { released++; } }; } }, 100)());
  assert.equal(released, 1);
});
test('timeout destruye conexion con consulta bloqueada', async () => {
  let destroyed = 0;
  await assert.rejects(createHealthCheck({ async getConnection() { return { execute() { return new Promise(() => {}); }, destroy() { destroyed++; }, release() { assert.fail(); } }; } }, 20)(), /timeout/);
  assert.equal(destroyed, 1);
});
test('conexion tardia tras timeout se destruye', async () => {
  let deliver; let destroyed = 0;
  const check = createHealthCheck({ getConnection() { return new Promise(resolve => { deliver = resolve; }); } }, 20);
  await assert.rejects(check(), /timeout/);
  deliver({ destroy() { destroyed++; }, execute() { assert.fail(); } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(destroyed, 1);
});
test('MySQL realmente inaccesible devuelve 503 sin tocar el POS', async t => {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const pool = createDatabasePool({ ...readConfig(valid).database, port, connectTimeout: 500 });
  t.after(() => pool.end());
  const response = await fetch(await serve(t, createHealthCheck(pool, 1000)) + '/api/health');
  assert.equal(response.status, 503);
  assert.equal((await response.json()).database, 'unavailable');
});
test('cierre idempotente: HTTP antes del pool', async () => {
  const steps = [];
  const shutdown = createShutdown({ server: { close(callback) { steps.push('http'); callback(); }, closeAllConnections() {} }, pool: { async end() { steps.push('pool'); } }, timeoutMs: 100 });
  const first = shutdown(); assert.equal(shutdown(), first);
  await first; assert.deepEqual(steps, ['http', 'pool']);
});
test('cierre forzado al superar plazo', async () => {
  let code; let closed = false; let done;
  const shutdown = createShutdown({ server: { close(callback) { done = callback; }, closeAllConnections() { closed = true; } }, pool: { async end() {} }, timeoutMs: 20, forceExit(value) { code = value; } });
  const pending = shutdown();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(code, 1); assert.equal(closed, true);
  done(); await pending;
});
