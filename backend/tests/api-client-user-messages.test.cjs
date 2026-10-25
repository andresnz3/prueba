'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { URL, URLSearchParams } = require('node:url');

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'api-client.js'), 'utf8');

function createClient() {
  const session = {
    csrfToken: 'A'.repeat(43),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    user: { id: '1', businessId: '1', username: 'andres', fullName: 'Administrador', role: 'ADMIN', active: true }
  };
  const sandbox = {
    window: {}, URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    fetch: async url => url.endsWith('/auth/me')
      ? { ok: true, status: 200, json: async () => session }
      : { ok: false, status: 500, json: async () => ({ error: { code: 'INTERNAL_SQL_COLUMN_012', message: 'SELECT password FROM users' } }) }
  };
  vm.runInNewContext(source, sandbox);
  return { client: new sandbox.window.PosApiClient('https://example.test/api'), messages: sandbox.window.PosMessages };
}

test('los códigos y detalles inesperados del servidor no aparecen en los mensajes visibles', async () => {
  const { client } = createClient();
  await client.me();
  await assert.rejects(client.products(), error => {
    assert.equal(error.code, 'INTERNAL_SQL_COLUMN_012');
    assert.equal(error.status, 500);
    assert.equal(error.message, 'No se pudo completar la solicitud. Contacta al administrador si el problema continúa.');
    assert.equal(error.message.includes('INTERNAL_SQL_COLUMN_012'), false);
    assert.equal(error.message.includes('SELECT password'), false);
    return true;
  });
});

test('el traductor conserva mensajes comerciales aprobados y reemplaza excepciones técnicas', () => {
  const { messages } = createClient();
  const approved = messages.expected('No hay existencias suficientes para completar la venta.');
  assert.equal(messages.fromError(approved, 'No se pudo completar la operación.'), 'No hay existencias suficientes para completar la venta.');
  const technical = messages.expected('DatabaseClosedError: IndexedDB is closed', 'No se pudo guardar el producto. Inténtalo nuevamente.');
  assert.equal(messages.fromError(technical, 'No se pudo guardar el producto. Inténtalo nuevamente.'), 'No se pudo guardar el producto. Inténtalo nuevamente.');
  assert.equal(messages.fromError(new Error('TypeError: Cannot read properties of null'), 'No se pudo cargar Caja.'), 'No se pudo cargar Caja.');
  const unknownApiFailure = Object.assign(new Error('No se pudo completar la solicitud. Contacta al administrador si el problema continúa.'), { code: 'UNLISTED_TEST_FAILURE', userFacing: true });
  assert.equal(messages.fromError(unknownApiFailure, 'No se pudieron cargar los productos. Revisa la conexión e inténtalo de nuevo.'), 'No se pudieron cargar los productos. Revisa la conexión e inténtalo de nuevo.');
});

test('el traductor también bloquea códigos internos, estados HTTP y consultas sin formato de error conocido', () => {
  const { messages } = createClient();
  const fallback = 'No se pudo completar la operación. Inténtalo nuevamente.';
  for (const detail of [
    'PURCHASE_CASH_REFUND_REQUIRED',
    'responseStatus403',
    'El servidor informó status code 500',
    'SQLSTATE[42S02]: SELECT * FROM private_table',
    'GET /api/private/users at routes/users.js:42'
  ]) {
    const error = messages.expected(detail, fallback);
    assert.equal(messages.fromError(error, fallback), fallback, detail);
    assert.equal(messages.isTechnical(error.message), false, detail);
  }
});

test('los errores conocidos de infraestructura y disponibilidad están expresados para el usuario', () => {
  const { messages } = createClient();
  const sandbox = { window: {}, URL, URLSearchParams, AbortController, setTimeout, clearTimeout, fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) };
  vm.runInNewContext(source, sandbox);
  for (const code of ['NETWORK_ERROR', 'INVALID_RESPONSE', 'DATABASE_UNAVAILABLE', 'INTERNAL_ERROR', 'REPORTS_UNAVAILABLE', 'CASH_RESPONSE_INVALID', 'BUSINESS_SETTINGS_EXISTS', 'PROCUREMENT_MIGRATION_REQUIRED', 'MIGRATION_GATE_SCHEMA_REQUIRED', 'MIGRATION_OPERATIONAL_SCHEMA_REQUIRED', 'MIGRATION_ZERO_INVENTORY_SCHEMA_REQUIRED', 'MIGRATION_ORDER_SNAPSHOT_SCHEMA_REQUIRED']) {
    const error = new sandbox.window.PosApiError(code);
    assert.equal(messages.isTechnical(error.message), false, code + ' debe producir una explicación segura');
  }
});

test('todos los mensajes de error conocidos del cliente están escritos para el usuario final', () => {
  const start = source.indexOf('const messages = {');
  assert.notEqual(start, -1, 'el catálogo de mensajes debe permanecer identificable para esta revisión');
  const end = source.indexOf('};', start);
  assert.notEqual(end, -1);
  const codes = [...source.slice(start, end).matchAll(/^\s+([A-Z][A-Z0-9_]+):/gm)].map(match => match[1]);
  assert.ok(codes.length > 50, 'se revisó el catálogo completo, no una lista parcial');
  const sandbox = { window: {}, URL, URLSearchParams, AbortController, setTimeout, clearTimeout, fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) };
  vm.runInNewContext(source, sandbox);
  for (const code of codes) {
    const error = new sandbox.window.PosApiError(code);
    assert.equal(sandbox.window.PosMessages.isTechnical(error.message), false, code);
    assert.ok(error.message.trim().length > 0, code + ' requiere una explicación visible');
  }
});
