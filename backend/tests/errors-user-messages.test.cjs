'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { errorHandler } = require('../src/middleware/errors');

function responseRecorder() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    headersSent: false,
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    json(body) { this.body = body; return this; }
  };
}

test('el backend no envía detalles de excepciones inesperadas en la respuesta visible', () => {
  const response = responseRecorder();
  const failure = new Error('SELECT password FROM users');
  failure.stack = 'Error: SELECT password FROM users\n    at backend/src/routes/users.js:42';
  errorHandler(failure, { originalUrl: '/api/users' }, response, () => {});

  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.body, { error: { code: 'INTERNAL_ERROR' } });
  assert.doesNotMatch(JSON.stringify(response.body), /SELECT|password|stack|users\.js/i);
});

test('una falla de conexión se presenta con un código estable y sin detalles del motor', () => {
  const response = responseRecorder();
  const failure = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3306'), { code: 'ECONNREFUSED' });
  errorHandler(failure, { originalUrl: '/api/health' }, response, () => {});

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.body, { error: { code: 'DATABASE_UNAVAILABLE' } });
  assert.doesNotMatch(JSON.stringify(response.body), /ECONNREFUSED|127\.0\.0\.1|3306/i);
});

test('la reautorización comparte un límite temporal y devuelve mensajes públicos seguros', () => {
  const limited = responseRecorder();
  errorHandler(Object.assign(new Error('private username and database details'), {
    publicStatus: 429, publicCode: 'REAUTHORIZATION_RATE_LIMITED', retryAfter: 37
  }), { originalUrl: '/api/auth/authorizations' }, limited, () => {});
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.headers['Retry-After'], '37');
  assert.match(limited.body.error.message, /módulo|modulo/i);
  assert.doesNotMatch(JSON.stringify(limited.body), /private|database|username/i);

  const unavailable = responseRecorder();
  errorHandler(Object.assign(new Error('ER_NO_SUCH_TABLE auth_login_rate_limits'), {
    publicStatus: 503, publicCode: 'REAUTHORIZATION_PROTECTION_UNAVAILABLE'
  }), { originalUrl: '/api/auth/authorizations' }, unavailable, () => {});
  assert.equal(unavailable.statusCode, 503);
  assert.match(unavailable.body.error.message, /verificar el permiso/i);
  assert.doesNotMatch(JSON.stringify(unavailable.body), /ER_NO_SUCH_TABLE|mysql|sql|database/i);
});

test('pool saturation returns a bounded retry and logs safe internal diagnostics only', async () => {
  await new Promise(resolve => setTimeout(resolve, 1010));
  const response = responseRecorder();
  const previous = console.warn;
  const records = [];
  console.warn = value => records.push(value);
  try {
    const failure = Object.assign(new Error('No connections available. secret=private'), { code: 'POS_POOL_QUEUE_FULL' });
    errorHandler(failure, { originalUrl: '/api/private/123', route: { path: '/sales/:saleId' }, baseUrl: '/api' }, response, () => {});
  } finally { console.warn = previous; }
  assert.equal(response.statusCode, 503);
  assert.equal(response.headers['Retry-After'], '2');
  assert.deepEqual(response.body, { error: { code: 'DATABASE_BUSY' } });
  assert.doesNotMatch(JSON.stringify(response.body), /POS_POOL|secret|private|connections/i);
  assert.equal(records.length, 1);
  assert.match(records[0], /"internalCode":"POS_POOL_QUEUE_FULL"/);
  assert.doesNotMatch(records[0], /secret=private|123|No connections available/);
});
