'use strict';
const { Router } = require('express');
const { authMiddleware } = require('../middleware/authentication');
const v = require('../middleware/validation');
const values = require('../services/sales-values');
const { httpError } = require('../middleware/errors');
function financialRoutes(authentication) {
  const router = Router(), m = authMiddleware(authentication.repo, authentication.config);
  const service = require('../services/financial-operations').createFinancialService(authentication);
  router.use('/financial', m.authenticate, (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!req.is('application/json')) throw httpError(415, 'JSON_REQUIRED');
    return m.csrf(req, res, next);
  });
  router.post('/financial/operations/:key/resolve', async (req, res) => {
    const data = v.body(req.body, ['kind']);
    res.json(await service.resolve(req.auth, values.operationKey(req.params.key), data.kind));
  });
  router.post('/financial/cash/movements', async (req, res) => res.status(201).json(await service.manualCash(req.auth, require('../services/financial-values').manualCash(req.body))));
  for (const type of ['customer', 'supplier']) router.post('/financial/' + type + '-payments/:id/reverse', async (req, res) => {
    const data = v.body(req.body, ['operationKey', 'reason', 'externalRefundConfirmed'], ['operationKey', 'reason']);
    if (data.externalRefundConfirmed !== undefined && typeof data.externalRefundConfirmed !== 'boolean') v.invalid();
    res.json(await service.reversePayment(req.auth, type, v.id(req.params.id), { operationKey: values.operationKey(data.operationKey), reason: v.text(data.reason, 500), externalRefundConfirmed: data.externalRefundConfirmed === true }));
  });
  return router;
}
module.exports = { financialRoutes };
