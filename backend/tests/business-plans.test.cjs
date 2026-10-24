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

test('counts active seats and admins while excluding only the system administrator', async () => {
  const repo = { rows: async () => [{ activeUsers: '3', inactiveUsers: '1', activeAdmins: '1' }] };
  assert.deepEqual(await businessUserCounts(repo, {}, '1'), { activeUsers: 3, inactiveUsers: 1, activeAdmins: 1 });
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

test('system admin does not consume a seat and legacy businesses remain unassigned until chosen', () => {
  const plan = planByCode.get('CONECTADO_BASICO');
  assert.doesNotThrow(() => assertUserAddition(plan, { activeUsers: 3, activeAdmins: 1 }, { role: 'ADMIN', businessId: '1', username: 'andres' }));
  assert.deepEqual(capacityView(null, { activeUsers: 2, inactiveUsers: 1, activeAdmins: 1 }), {
    planCode: null, planName: 'Sin asignar', activeUsers: 2, inactiveUsers: 1, activeAdmins: 1, maximumUsers: null, availableUsers: null
  });
  assert.throws(() => assertWithinPlan(plan, { activeUsers: 4, activeAdmins: 1 }), error => error.publicCode === 'BUSINESS_PLAN_DOWNGRADE_BLOCKED' && error.publicDetails.maximumUsers === 3);
});
