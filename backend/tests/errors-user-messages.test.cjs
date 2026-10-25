'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { errorHandler } = require('../src/middleware/errors');

function responseRecorder() {
  return {
    statusCode: null,
    body: null,
    headersSent: false,
    status(code) { this.statusCode = code; return this; },
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
