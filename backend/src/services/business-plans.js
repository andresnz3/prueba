'use strict';

const { httpError } = require('../middleware/errors');

const PLAN_CATALOG = Object.freeze([
  Object.freeze({ code: 'LOCAL', name: 'Local (pago único)', billingType: 'Pago único', monthly: false, reminders: false, includedUsers: 1 }),
  Object.freeze({ code: 'CONECTADO_BASICO', name: 'Conectado Básico', billingType: 'Mensual', monthly: true, reminders: true, includedUsers: 3 }),
  Object.freeze({ code: 'CONECTADO_ESTANDAR', name: 'Conectado Estándar', billingType: 'Mensual', monthly: true, reminders: true, includedUsers: 5 }),
  Object.freeze({ code: 'CONECTADO_PREMIUM', name: 'Conectado Premium', billingType: 'Mensual', monthly: true, reminders: true, includedUsers: 10 })
]);
const planByCode = new Map(PLAN_CATALOG.map(plan => [plan.code, plan]));
const CONNECTED_PLAN_CODES = Object.freeze(['CONECTADO_BASICO', 'CONECTADO_ESTANDAR', 'CONECTADO_PREMIUM']);

async function businessPlan(repo, db, businessId, { lock = false, required = true } = {}) {
  const [row] = await repo.rows(db,
    'SELECT plan_code FROM business_subscriptions WHERE business_id = ?' + (lock ? ' FOR UPDATE' : ''), [businessId]);
  if (!row) {
    if (required) throw httpError(409, 'BUSINESS_PLAN_REQUIRED');
    return null;
  }
  const plan = planByCode.get(row.plan_code);
  if (!plan) throw httpError(503, 'BUSINESS_PLAN_SCHEMA_UNSUPPORTED');
  return plan;
}

async function businessUserCounts(repo, db, businessId) {
  const [row] = await repo.rows(db, `SELECT
    COALESCE(SUM(CASE WHEN active = TRUE AND NOT (business_id = 1 AND username = 'andres' AND role = 'ADMIN') THEN 1 ELSE 0 END), 0) AS activeUsers,
    COALESCE(SUM(CASE WHEN active = FALSE AND NOT (business_id = 1 AND username = 'andres' AND role = 'ADMIN') THEN 1 ELSE 0 END), 0) AS inactiveUsers,
    COALESCE(SUM(CASE WHEN active = TRUE AND role = 'ADMIN' AND NOT (business_id = 1 AND username = 'andres' AND role = 'ADMIN') THEN 1 ELSE 0 END), 0) AS activeAdmins
    FROM users WHERE business_id = ?`, [businessId]);
  return {
    activeUsers: Number(row.activeUsers),
    inactiveUsers: Number(row.inactiveUsers),
    activeAdmins: Number(row.activeAdmins)
  };
}

function assertWithinPlan(plan, counts, code = 'BUSINESS_PLAN_DOWNGRADE_BLOCKED') {
  if (counts.activeAdmins > 1) {
    const error = httpError(409, 'BUSINESS_PLAN_ADMIN_LIMIT_EXCEEDED');
    error.publicDetails = { activeAdmins: counts.activeAdmins, maximumAdmins: 1 };
    throw error;
  }
  if (counts.activeUsers > plan.includedUsers) {
    const error = httpError(409, code);
    error.publicDetails = { activeUsers: counts.activeUsers, maximumUsers: plan.includedUsers };
    throw error;
  }
}

function assertUserAddition(plan, counts, { role, active = true, businessId, username } = {}) {
  if (!active) return;
  if (String(businessId) === '1' && username === 'andres' && role === 'ADMIN') return;
  const next = { activeAdmins: counts.activeAdmins + (role === 'ADMIN' ? 1 : 0), activeUsers: counts.activeUsers + 1 };
  if (next.activeAdmins > 1) {
    const error = httpError(409, 'BUSINESS_PLAN_ADMIN_LIMIT_EXCEEDED');
    error.publicDetails = { activeAdmins: next.activeAdmins, maximumAdmins: 1 };
    throw error;
  }
  if (next.activeUsers > plan.includedUsers) {
    const error = httpError(409, 'BUSINESS_PLAN_USER_LIMIT_EXCEEDED');
    error.publicDetails = { activeUsers: counts.activeUsers, maximumUsers: plan.includedUsers };
    throw error;
  }
}

function assertUserActivation(plan, counts, user, nextRole, nextActive) {
  const isSystemAdmin = String(user.business_id) === '1' && user.username === 'andres' && user.role === 'ADMIN';
  if (isSystemAdmin) return;
  const seatIncrease = !user.active && nextActive;
  const adminIncrease = nextActive && nextRole === 'ADMIN' && (!user.active || user.role !== 'ADMIN');
  if (!seatIncrease && !adminIncrease) return;
  const currentUsersWithoutUser = counts.activeUsers - (user.active ? 1 : 0);
  const currentAdminsWithoutUser = counts.activeAdmins - (user.active && user.role === 'ADMIN' ? 1 : 0);
  const nextUsers = currentUsersWithoutUser + (nextActive ? 1 : 0);
  const nextAdmins = currentAdminsWithoutUser + (nextActive && nextRole === 'ADMIN' ? 1 : 0);
  if (nextAdmins > 1) {
    const error = httpError(409, 'BUSINESS_PLAN_ADMIN_LIMIT_EXCEEDED');
    error.publicDetails = { activeAdmins: nextAdmins, maximumAdmins: 1 };
    throw error;
  }
  if (nextUsers > plan.includedUsers) {
    const error = httpError(409, 'BUSINESS_PLAN_USER_LIMIT_EXCEEDED');
    error.publicDetails = { activeUsers: counts.activeUsers, maximumUsers: plan.includedUsers };
    throw error;
  }
}

function capacityView(plan, counts) {
  return {
    planCode: plan?.code || null,
    planName: plan?.name || 'Sin asignar',
    activeUsers: counts.activeUsers,
    inactiveUsers: counts.inactiveUsers,
    activeAdmins: counts.activeAdmins,
    maximumUsers: plan?.includedUsers ?? null,
    availableUsers: plan ? Math.max(0, plan.includedUsers - counts.activeUsers) : null
  };
}

module.exports = {
  PLAN_CATALOG, CONNECTED_PLAN_CODES, planByCode,
  businessPlan, businessUserCounts, assertWithinPlan, assertUserAddition, assertUserActivation, capacityView
};
