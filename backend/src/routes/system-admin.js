'use strict';
const { Router } = require('express');
const v = require('../middleware/validation');
const { authMiddleware } = require('../middleware/authentication');
const { createSystemAdminService } = require('../services/system-admin');
const { httpError } = require('../middleware/errors');
const { cookies, createSupportToken, verifySupportToken } = require('../services/tokens');

function systemAdminRoutes({ repo, config }) {
  const router = Router();
  const middleware = authMiddleware(repo, config);
  const service = createSystemAdminService(repo);
  router.use('/admin', middleware.authenticateOwner, (req, res, next) => {
    const allowed = service.isSystemAdmin(req.auth);
    if (!allowed && !config.production) {
      console.warn('[system-admin] access denied', {
        username: req.auth?.username ?? null,
        role: req.auth?.role ?? null,
        business_id: req.auth?.business_id ?? null,
        businessId: req.auth?.businessId ?? null,
        usernameAllowed: req.auth?.username === 'andres',
        roleAllowed: req.auth?.role === 'ADMIN',
        businessAllowed: String(req.auth?.business_id) === '1'
      });
    }
    return allowed ? next() : next(httpError(403, 'SYSTEM_ADMIN_REQUIRED'));
  });
  router.use('/system-admin', middleware.authenticateOwner, (req, res, next) =>
    service.isSystemAdmin(req.auth) ? next() : next(httpError(403, 'SYSTEM_ADMIN_REQUIRED')));
  router.post('/system-admin/migration/basic', middleware.csrf, async (req, res) => {
    const data = v.body(req.body, ['targetBusinessId', 'package', 'confirmSystemBusiness'], ['targetBusinessId', 'package']);
    if (data.confirmSystemBusiness !== undefined && typeof data.confirmSystemBusiness !== 'boolean') v.invalid();
    const result = await service.migrateBasic(req.auth, v.id(data.targetBusinessId), data.package, data.confirmSystemBusiness === true);
    res.status(201).json(result);
  });
  router.post('/system-admin/migration/inventory/preview', middleware.csrf, async (req, res) => {
    const data = v.body(req.body, ['targetBusinessId', 'package']);
    res.json(await service.previewInventoryMigration(req.auth, v.id(data.targetBusinessId), data.package));
  });
  router.post('/system-admin/migration/inventory', middleware.csrf, async (req, res) => {
    const data = v.body(req.body, ['targetBusinessId', 'package']);
    res.status(201).json(await service.migrateInventory(req.auth, v.id(data.targetBusinessId), data.package));
  });
  router.get('/admin/businesses', async (req, res) => {
    if (Object.keys(req.query).length) v.invalid();
    res.json({ businesses: await service.listBusinesses(req.auth) });
  });
  router.get('/admin/billing', async (req, res) => {
    if (Object.keys(req.query).length) v.invalid();
    res.json(await service.listBilling(req.auth));
  });
  router.patch('/admin/businesses/:id/plan', middleware.csrf, async (req, res) => {
    const data = v.body(req.body, ['planCode', 'nextDueDate']);
    res.json({ subscription: await service.setBusinessPlan(req.auth, v.id(req.params.id), data.planCode, data.nextDueDate) });
  });
  router.get('/admin/businesses/:id/payments', async (req, res) => {
    if (Object.keys(req.query).length) v.invalid();
    res.json({ payments: await service.listSubscriptionPayments(req.auth, v.id(req.params.id)) });
  });
  router.post('/admin/businesses/:id/payments', middleware.csrf, async (req, res) => {
    const data = v.body(req.body, ['amount', 'paymentDate']);
    res.status(201).json(await service.recordSubscriptionPayment(req.auth, v.id(req.params.id), data.amount, data.paymentDate));
  });
  router.post('/admin/support-session', middleware.csrf, async (req, res) => {
    const data = v.body(req.body, ['businessId']);
    const metadata = { ip: req.ip.slice(0, 45), agent: (req.get('User-Agent') || '').slice(0, 512) };
    const result = await service.startSupportSession(req.auth, v.id(data.businessId), metadata);
    const token = createSupportToken(config.secret, req.auth, result.businessId, result.supportSession, result.expiresAt);
    res.cookie(config.supportCookieName, token, { ...middleware.cookieOptions, expires: result.expiresAt });
    res.json({ support: { businessId: result.businessId, businessName: result.businessName, expiresAt: result.expiresAt.toISOString(), user: result.user } });
  });
  router.post('/admin/support-session/end', middleware.csrf, async (req, res) => {
    v.body(req.body, []);
    const claims = verifySupportToken(config.secret, cookies(req)[config.supportCookieName]);
    if (claims && claims.ownerSessionId === String(req.auth.session_id) && claims.ownerUserId === String(req.auth.user_id) && claims.ownerBusinessId === String(req.auth.business_id)) {
      await service.endSupportSession(req.auth, claims);
    }
    res.clearCookie(config.supportCookieName, middleware.cookieOptions);
    res.status(204).end();
  });
  router.get('/admin/businesses/:id/users', async (req, res) => {
    if (Object.keys(req.query).length) v.invalid();
    res.json({ users: await service.listBusinessUsers(req.auth, v.id(req.params.id)) });
  });
  router.post('/admin/businesses', middleware.csrf, async (req, res) => {
    const data = v.body(req.body, ['name']);
    res.status(201).json({ business: await service.createBusiness(req.auth, v.text(data.name, 160)) });
  });
  router.patch('/admin/businesses/:id/status', middleware.csrf, async (req, res) => {
    const data = v.body(req.body, ['status']);
    if (!['ACTIVE', 'INACTIVE'].includes(data.status)) v.invalid();
    res.json({ business: await service.setBusinessStatus(req.auth, v.id(req.params.id), data.status) });
  });
  router.delete('/admin/businesses/:id', middleware.csrf, async (req, res) => {
    const data = v.body(req.body, ['confirmation']);
    if (data.confirmation !== 'ELIMINAR') throw httpError(400, 'BUSINESS_DELETE_CONFIRMATION_REQUIRED');
    await service.deleteBusiness(req.auth, v.id(req.params.id), data.confirmation);
    res.status(204).end();
  });
  router.post('/admin/businesses/:id/users', middleware.csrf, async (req, res) => {
    const data = v.body(req.body, ['username', 'fullName', 'password', 'role']);
    const input = { username: v.username(data.username), fullName: v.text(data.fullName, 160), password: v.password(data.password, true), role: v.role(data.role) };
    res.status(201).json({ user: await service.createBusinessUser(req.auth, v.id(req.params.id), input) });
  });
  router.patch('/admin/users/:id/status', middleware.csrf, async (req, res) => {
    const data = v.body(req.body, ['active']);
    if (typeof data.active !== 'boolean') v.invalid();
    res.json({ user: await service.setUserStatus(req.auth, v.id(req.params.id), data.active) });
  });
  return router;
}

module.exports = { systemAdminRoutes };
