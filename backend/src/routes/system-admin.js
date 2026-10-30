'use strict';
const { Router } = require('express');
const express = require('express');
const v = require('../middleware/validation');
const { authMiddleware } = require('../middleware/authentication');
const { createSystemAdminService, isSystemAdmin } = require('../services/system-admin');
const { createLocalLicenseService } = require('../services/local-licenses');
const { httpError } = require('../middleware/errors');
const { cookies, createSupportToken, verifySupportToken } = require('../services/tokens');

function systemAdminRoutes({ repo, config }, imageStore, localLicenseConfig = {}) {
  const router = Router();
  const middleware = authMiddleware(repo, config);
  const service = createSystemAdminService(repo, { imageStore });
  const licenses = createLocalLicenseService(repo, localLicenseConfig, isSystemAdmin);
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
  router.get('/system-admin/local-licenses', async (req, res) => {
    const status = req.query.status || '';
    if (Object.keys(req.query).some(key => key !== 'status')) v.invalid();
    res.json(await licenses.admin.list(req.auth, status));
  });
  router.post('/system-admin/local-licenses', middleware.csrf, async (req, res) => {
    const data = v.body(req.body, ['customerName', 'customerReference'], ['customerName']);
    const customerName = v.text(data.customerName, 160);
    const customerReference = data.customerReference === undefined || data.customerReference === null ? null : v.text(data.customerReference, 120);
    res.status(201).json(await licenses.admin.generate(req.auth, { customerName, customerReference }));
  });
  router.post('/system-admin/local-licenses/:licenseId/revoke', middleware.csrf, async (req, res) => {
    const data = v.body(req.body, ['reason'], ['reason']);
    res.json(await licenses.admin.revoke(req.auth, v.id(req.params.licenseId), v.text(data.reason, 500)));
  });
  router.post('/system-admin/local-licenses/:licenseId/transfer', middleware.csrf, async (req, res) => {
    const data = v.body(req.body, ['reason']);
    const reason = data.reason === undefined || data.reason === null ? null : v.text(data.reason, 500);
    res.json(await licenses.admin.transfer(req.auth, v.id(req.params.licenseId), reason));
  });
  const migrationPackageBody = express.raw({ type: 'application/vnd.pos.local-migration+json', limit: '32mb', inflate: false });
  function archiveRequest(req) {
    if (!Buffer.isBuffer(req.body)) throw httpError(415, 'UNSUPPORTED_BODY');
    let body;
    try { body = JSON.parse(req.body.toString('utf8')); } catch { throw httpError(400, 'INVALID_JSON'); }
    const data = v.body(body, ['targetBusinessId', 'package', 'packageFileSha256', 'confirmed'], ['targetBusinessId', 'package']);
    if (data.packageFileSha256 !== undefined && (typeof data.packageFileSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(data.packageFileSha256))) throw httpError(400, 'INVALID_INPUT');
    return data;
  }
  router.post('/system-admin/migration/targets', middleware.csrf, async (req, res) => {
    const data = v.body(req.body, ['name', 'planCode']);
    res.status(201).json({ business: await service.createMigrationTarget(req.auth, v.text(data.name, 160), data.planCode) });
  });
  router.get('/system-admin/migration/targets/:businessId/inspect', async (req, res) => {
    if (Object.keys(req.query).length) v.invalid();
    res.json(await service.inspectExistingMigrationTarget(req.auth, v.id(req.params.businessId)));
  });
  router.post('/system-admin/migration/targets/:businessId/prepare', middleware.csrf, async (req, res) => {
    const data = v.body(req.body, ['confirmed'], ['confirmed']);
    if (typeof data.confirmed !== 'boolean') v.invalid();
    res.status(201).json(await service.prepareExistingMigrationTarget(req.auth, v.id(req.params.businessId), data.confirmed));
  });
  router.post('/system-admin/migration/archive/preview', middleware.csrf, migrationPackageBody, async (req, res) => {
    const data = archiveRequest(req);
    res.json(await service.previewFullMigration(req.auth, v.id(data.targetBusinessId), data.package, data.packageFileSha256 || null));
  });
  router.post('/system-admin/migration/archive', middleware.csrf, migrationPackageBody, async (req, res) => {
    const data = archiveRequest(req);
    if (typeof data.confirmed !== 'boolean') v.invalid();
    res.status(201).json(await service.archiveFullMigration(req.auth, v.id(data.targetBusinessId), data.package, data.confirmed, data.packageFileSha256 || null));
  });
  router.post('/system-admin/migration/archive/:businessId/:batchId/review', middleware.csrf, async (req, res) => {
    const data = v.body(req.body, ['entity', 'sourceRecordKey', 'decision', 'attestBelongsToSource']);
    if (data.attestBelongsToSource !== undefined && typeof data.attestBelongsToSource !== 'boolean') v.invalid();
    res.json(await service.reviewMigrationIdentityRecord(req.auth, v.id(req.params.businessId), req.params.batchId,
      v.text(data.entity, 40), v.text(data.sourceRecordKey, 120), v.text(data.decision, 12), data.attestBelongsToSource === true));
  });
  router.get('/system-admin/migration/archive/:businessId/:batchId', async (req, res) => {
    if (Object.keys(req.query).length) v.invalid();
    res.json(await service.migrationBatchStatus(req.auth, v.id(req.params.businessId), req.params.batchId));
  });
  router.post('/system-admin/migration/archive/:businessId/:batchId/project/catalog', middleware.csrf, async (req, res) => {
    v.body(req.body, []);
    res.json(await service.projectMigrationCatalog(req.auth, v.id(req.params.businessId), req.params.batchId));
  });
  router.post('/system-admin/migration/archive/:businessId/:batchId/project/operations', middleware.csrf, async (req, res) => {
    v.body(req.body, []);
    res.json(await service.projectMigrationOperations(req.auth, v.id(req.params.businessId), req.params.batchId));
  });
  router.get('/system-admin/migration/archive/:businessId/:batchId/records', async (req, res) => {
    const allowed = new Set(['offset', 'limit']);
    if (Object.keys(req.query).some(key => !allowed.has(key))) v.invalid();
    res.json(await service.migrationBatchRecords(req.auth, v.id(req.params.businessId), req.params.batchId, req.query));
  });
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
  router.post('/system-admin/migration/credit/preview', middleware.csrf, async (req, res) => {
    const data = v.body(req.body, ['targetBusinessId', 'package']);
    res.json(await service.previewCreditMigration(req.auth, v.id(data.targetBusinessId), data.package));
  });
  router.post('/system-admin/migration/credit', middleware.csrf, async (req, res) => {
    const data = v.body(req.body, ['targetBusinessId', 'package', 'confirmDifferentSource'], ['targetBusinessId', 'package']);
    if (data.confirmDifferentSource !== undefined && typeof data.confirmDifferentSource !== 'boolean') v.invalid();
    res.status(201).json(await service.migrateCreditMigration(req.auth, v.id(data.targetBusinessId), data.package, { confirmDifferentSource: data.confirmDifferentSource === true }));
  });
  router.post('/system-admin/migration/sales/preview', middleware.csrf, async (req, res) => {
    const data = v.body(req.body, ['targetBusinessId', 'package']);
    res.json(await service.previewSalesMigration(req.auth, v.id(data.targetBusinessId), data.package));
  });
  router.post('/system-admin/migration/sales', middleware.csrf, async (req, res) => {
    const data = v.body(req.body, ['targetBusinessId', 'package', 'confirmDifferentSource'], ['targetBusinessId', 'package']);
    if (data.confirmDifferentSource !== undefined && typeof data.confirmDifferentSource !== 'boolean') v.invalid();
    res.status(201).json(await service.migrateSales(req.auth, v.id(data.targetBusinessId), data.package, { confirmDifferentSource: data.confirmDifferentSource === true }));
  });
  router.post('/system-admin/migration/purchases/preview', middleware.csrf, async (req, res) => {
    const data = v.body(req.body, ['targetBusinessId', 'package']);
    res.json(await service.previewPurchasesMigration(req.auth, v.id(data.targetBusinessId), data.package));
  });
  router.post('/system-admin/migration/purchases', middleware.csrf, async (req, res) => {
    const data = v.body(req.body, ['targetBusinessId', 'package']);
    res.status(201).json(await service.migratePurchases(req.auth, v.id(data.targetBusinessId), data.package));
  });
  router.get('/admin/businesses', async (req, res) => {
    if (Object.keys(req.query).length) v.invalid();
    res.json({ businesses: await service.listBusinesses(req.auth) });
  });
  router.get('/admin/businesses/:id/deletion-preview', async (req, res) => {
    if (Object.keys(req.query).length) v.invalid();
    res.json(await service.previewBusinessDeletion(req.auth, v.id(req.params.id)));
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
  router.get('/admin/businesses/:id/user-capacity', async (req, res) => {
    if (Object.keys(req.query).length) v.invalid();
    res.json({ capacity: await service.businessUserCapacity(req.auth, v.id(req.params.id)) });
  });
  router.post('/admin/businesses', middleware.csrf, async (req, res) => {
    const data = v.body(req.body, ['name', 'planCode']);
    res.status(201).json({ business: await service.createBusiness(req.auth, v.text(data.name, 160), data.planCode) });
  });
  router.patch('/admin/businesses/:id/status', middleware.csrf, async (req, res) => {
    const data = v.body(req.body, ['status']);
    if (!['ACTIVE', 'INACTIVE'].includes(data.status)) v.invalid();
    res.json({ business: await service.setBusinessStatus(req.auth, v.id(req.params.id), data.status) });
  });
  router.delete('/admin/businesses/:id', middleware.csrf, async (req, res) => {
    const data = v.body(req.body, ['confirmation', 'previewToken'], ['confirmation']);
    if (data.confirmation !== 'ELIMINAR') throw httpError(400, 'BUSINESS_DELETE_CONFIRMATION_REQUIRED');
    res.json(await service.deleteBusiness(req.auth, v.id(req.params.id), data.confirmation, data.previewToken));
  });
  router.post('/admin/businesses/:id/users', middleware.csrf, async (req, res) => {
    const input = v.newUser(req.body);
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
