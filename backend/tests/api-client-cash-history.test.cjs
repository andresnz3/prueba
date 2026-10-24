'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { URL, URLSearchParams } = require('node:url');

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'api-client.js'), 'utf8');

function apiFor(sessions) {
  const owner = {
    user: { id: '1', businessId: '1', username: 'andres', fullName: 'System Admin', role: 'ADMIN', active: true },
    support: {
      businessId: '9', businessName: 'Migrated business', expiresAt: new Date(Date.now() + 60_000).toISOString(),
      user: { id: '3', businessId: '9', businessName: 'Migrated business', username: 'owner', fullName: 'Business Admin', role: 'ADMIN', active: true }
    },
    expiresAt: new Date(Date.now() + 60_000).toISOString(), csrfToken: 'A'.repeat(43)
  };
  const sandbox = {
    window: {}, URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    fetch: async url => {
      const data = url.endsWith('/auth/me') ? owner : { sessions };
      return { ok: true, status: 200, json: async () => data };
    }
  };
  vm.runInNewContext(source, sandbox);
  return new sandbox.window.PosApiClient('https://example.test/api');
}

const session = (id, changes = {}) => ({
  id: String(id), businessId: '9', status: 'CLOSED', isHistorical: true, sourceStatus: 'CLOSED',
  openingAmount: '10.00', expectedAmount: '12.00', countedAmount: '12.00', difference: '0.00',
  openedAt: '2026-01-01T10:00:00.000Z', closedAt: '2026-01-01T18:00:00.000Z', movements: [],
  ...changes
});

test('Caja conserva sesiones históricas sin cierre original sin convertir importes ausentes en cero', async () => {
  const sessions = [
    session(1, { sourceStatus: 'abierta', expectedAmount: null, countedAmount: null, difference: null, closedAt: null }),
    session(2, { sourceStatus: 'ABIERTA', expectedAmount: null, countedAmount: null, difference: null, closedAt: null }),
    session(3, { sourceStatus: 'CLOSED', movements: [{ id: '1', amount: '2.00' }] })
  ];
  const client = apiFor(sessions);
  await client.me();

  const result = await client.cashSessions();

  assert.equal(result.length, 3);
  assert.equal(result[0].businessId, '9');
  assert.equal(result[0].expectedAmount, null);
  assert.equal(result[0].countedAmount, null);
  assert.equal(result[0].closedAt, null);
  assert.equal(result[2].expectedAmount, '12.00');
});

test('Caja sigue rechazando cierres sin importes y respuestas de otro negocio', async () => {
  const incompleteClosedSession = session(1, { sourceStatus: 'cerrada', expectedAmount: null });
  const client = apiFor([incompleteClosedSession]);
  await client.me();
  await assert.rejects(client.cashSessions(), error => error.code === 'CASH_RESPONSE_INVALID');

  const otherBusiness = apiFor([session(1, { businessId: '10' })]);
  await otherBusiness.me();
  await assert.rejects(otherBusiness.cashSessions(), error => error.code === 'CASH_RESPONSE_INVALID');
});
