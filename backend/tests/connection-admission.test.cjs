'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createConnectionAdmission, installBoundedAdmission } = require('../src/config/connection-admission');

test('admission mantiene límite, cola FIFO y libera el cupo una sola vez', async () => {
  const admission = createConnectionAdmission({ limit: 1, queueLimit: 1, timeoutMs: 100 });
  const first = await admission.acquire();
  const secondPromise = admission.acquire();
  await assert.rejects(admission.acquire(), error => error.code === 'POS_POOL_QUEUE_FULL');
  assert.equal(admission.snapshot().active, 1);
  assert.equal(admission.snapshot().queued, 1);
  first.release(); first.release();
  const second = await secondPromise;
  assert.equal(admission.snapshot().active, 1);
  second.release();
  assert.equal(admission.snapshot().active, 0);
  assert.equal(admission.snapshot().peakActive, 1);
  assert.equal(admission.snapshot().rejected, 1);
  assert.equal(admission.snapshot().waitCount, 1);
  assert.ok(admission.snapshot().maxWaitMs >= admission.snapshot().averageWaitMs);
});

test('timeout retira la espera de la cola y una conexión posterior no queda reservada', async () => {
  const admission = createConnectionAdmission({ limit: 1, queueLimit: 2, timeoutMs: 15 });
  const first = await admission.acquire();
  await assert.rejects(admission.acquire(), error => error.code === 'POS_POOL_ACQUIRE_TIMEOUT');
  assert.equal(admission.snapshot().queued, 0);
  first.release();
  const next = await admission.acquire();
  assert.equal(admission.snapshot().active, 1);
  assert.equal(admission.snapshot().timedOut, 1);
  assert.equal(admission.snapshot().waitCount, 1);
  assert.ok(admission.snapshot().maxWaitMs >= 10);
  next.release();
});

test('un fallo al obtener la conexión devuelve el cupo al admisor', async () => {
  const admission = createConnectionAdmission({ limit: 1, queueLimit: 1, timeoutMs: 100 });
  const pool = { getConnection(callback) { callback(new Error('unavailable')); } };
  installBoundedAdmission(pool, admission);
  await new Promise(resolve => pool.getConnection(error => { assert.match(error.message, /unavailable/); resolve(); }));
  assert.equal(admission.snapshot().active, 0);
  const permit = await admission.acquire();
  permit.release();
});

test('liberar o destruir conexiones instrumentadas devuelve el cupo una sola vez', async () => {
  const admission = createConnectionAdmission({ limit: 1, queueLimit: 1, timeoutMs: 100 });
  let released = 0;
  const physicalConnection = { execute(_sql, _values, done) { done(null, []); }, query(_sql, _values, done) { done(null, []); }, release() { released++; }, destroy() { released++; } };
  const pool = { getConnection(callback) { callback(null, physicalConnection); } };
  installBoundedAdmission(pool, admission);
  const leased = await new Promise((resolve, reject) => pool.getConnection((error, value) => error ? reject(error) : resolve(value)));
  leased.release(); leased.release();
  assert.equal(admission.snapshot().active, 0);
  assert.equal(released, 1);
  const second = await new Promise((resolve, reject) => pool.getConnection((error, value) => error ? reject(error) : resolve(value)));
  second.destroy();
  assert.equal(admission.snapshot().active, 0);
  assert.equal(released, 2);
});
