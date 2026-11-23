'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  PLAN_CATALOG, businessUserCounts, assertWithinPlan, assertUserAddition,
  assertUserActivation, capacityView, planByCode
} = require('../src/services/business-plans');

test('catalog preserves local and connected seat limits', () => {
  assert.deepEqual(PLAN_CATALOG.map(({ code, includedUsers }) => [code, includedUsers]), [
    ['LOCAL', 1], ['CONECTADO_BASICO', 3], ['CONECTADO_ESTANDAR', 5], ['CONECTADO_PREMIUM', 10]
  ]);
});

test('quota counts preserve the legacy business-1 administrator exception separately from panel access', async () => {
  let query = '';
  const repo = { rows: async (_db, sql, params) => { query = sql; assert.deepEqual(params, ['1']); return [{ activeUsers: '2', inactiveUsers: '1', activeAdmins: '1' }]; } };
  assert.deepEqual(await businessUserCounts(repo, {}, '1'), { activeUsers: 2, inactiveUsers: 1, activeAdmins: 1 });
  assert.match(query, /business_id = 1 AND username = 'andres' AND role = 'ADMIN'/);
  assert.doesNotMatch(query, /MIN\s*\(/i);
});

test('active users consume seats, inactive users do not, and a business has at most one active admin', () => {
  const basic = planByCode.get('CONECTADO_BASICO');
  assert.doesNotThrow(() => assertUserAddition(basic, { activeUsers: 2, activeAdmins: 1 }, { role: 'VENDEDOR' }));
  assert.throws(() => assertUserAddition(basic, { activeUsers: 3, activeAdmins: 1 }, { role: 'VENDEDOR' }), error => error.publicCode === 'BUSINESS_PLAN_USER_LIMIT_EXCEEDED');
  assert.doesNotThrow(() => assertUserAddition(basic, { activeUsers: 3, activeAdmins: 1 }, { role: 'VENDEDOR', active: false }));
  assert.throws(() => assertUserAddition(basic, { activeUsers: 1, activeAdmins: 1 }, { role: 'ADMIN' }), error => error.publicCode === 'BUSINESS_PLAN_ADMIN_LIMIT_EXCEEDED');
});

test('reactivation and role promotion are checked against the resulting active roster', () => {
  const standard = planByCode.get('CONECTADO_ESTANDAR');
  const inactiveSeller = { business_id: '12', username: 'seller', role: 'VENDEDOR', active: false };
  assert.throws(() => assertUserActivation(standard, { activeUsers: 5, activeAdmins: 1 }, inactiveSeller, 'VENDEDOR', true), error => error.publicCode === 'BUSINESS_PLAN_USER_LIMIT_EXCEEDED');
  assert.throws(() => assertUserActivation(standard, { activeUsers: 4, activeAdmins: 1 }, { ...inactiveSeller, active: true }, 'ADMIN', true), error => error.publicCode === 'BUSINESS_PLAN_ADMIN_LIMIT_EXCEEDED');
  assert.doesNotThrow(() => assertUserActivation(standard, { activeUsers: 4, activeAdmins: 1 }, inactiveSeller, 'VENDEDOR', true));
});

test('the pre-existing commercial exception remains limited to the named business-1 administrator', () => {
  const plan = planByCode.get('CONECTADO_BASICO');
  const full = { activeUsers: 3, activeAdmins: 1 };
  assert.doesNotThrow(() => assertUserAddition(plan, full, { role: 'ADMIN', businessId: '1', username: 'andres' }));
  assert.throws(() => assertUserAddition(plan, full, { role: 'ADMIN', businessId: '1', username: 'secondary' }), error => error.publicCode === 'BUSINESS_PLAN_ADMIN_LIMIT_EXCEEDED');
  assert.throws(() => assertUserAddition(plan, { activeUsers: 3, activeAdmins: 0 }, { role: 'ADMIN', businessId: '2', username: 'andres' }), error => error.publicCode === 'BUSINESS_PLAN_USER_LIMIT_EXCEEDED');
  const legacyAdmin = { id: '7', business_id: '1', username: 'andres', role: 'ADMIN', active: true };
  const secondary = { id: '8', business_id: '1', username: 'secondary', role: 'ADMIN', active: false };
  assert.doesNotThrow(() => assertUserActivation(plan, full, legacyAdmin, 'ADMIN', true));
  assert.throws(() => assertUserActivation(plan, full, secondary, 'ADMIN', true), error => error.publicCode === 'BUSINESS_PLAN_ADMIN_LIMIT_EXCEEDED');
  assert.deepEqual(capacityView(null, { activeUsers: 2, inactiveUsers: 1, activeAdmins: 1 }), {
    planCode: null, planName: 'Sin asignar', activeUsers: 2, inactiveUsers: 1, activeAdmins: 1, maximumUsers: null, availableUsers: null
  });
  assert.throws(() => assertWithinPlan(plan, { activeUsers: 4, activeAdmins: 1 }), error => error.publicCode === 'BUSINESS_PLAN_DOWNGRADE_BLOCKED' && error.publicDetails.maximumUsers === 3);
});
