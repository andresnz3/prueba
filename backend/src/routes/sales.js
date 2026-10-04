'use strict';
const { Router } = require('express');
const { authMiddleware } = require('../middleware/authentication');
const v = require('../middleware/validation');
const values = require('../services/sales-values');
const { page } = require('../services/inventory-values');
const { httpError } = require('../middleware/errors');
function salesRoutes(authentication, service) {
  const router = Router(), m = authMiddleware(authentication.repo, authentication.config);
  router.use(['/sales', '/cash', '/operations', '/business-settings'], m.authenticate, (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (!req.is('application/json')) throw httpError(415, 'JSON_REQUIRED');
      return m.csrf(req, res, next);
    }
    next();
  });
  router.post('/sales/quote', async (req, res) => res.json({ quote: await service.quote(req.auth, values.quote(req.body)) }));
  router.post('/sales', async (req, res) => res.status(201).json(await service.create(req.auth, values.sale(req.body))));
  router.get('/business-settings/sales-flow', async (req, res) => res.json(await service.getSalesFlow(req.auth)));
  router.put('/business-settings/sales-flow', async (req, res) => res.json(await service.setSalesFlow(req.auth, values.salesFlow(req.body))));
  router.post('/sales/orders', async (req, res) => res.status(201).json(await service.createOrder(req.auth, values.order(req.body))));
  router.get('/sales', async (req, res) => {
    const options = page(req.query, ['maxId']); if (req.query.maxId !== undefined) options.maxId = v.id(req.query.maxId);
    res.json({ sales: await service.list(req.auth, options) });
  });
  router.get('/sales/:id', async (req, res) => { v.body(req.query, []); res.json({ sale: await service.get(req.auth, v.id(req.params.id)) }); });
  router.post('/sales/:id/cancel', async (req, res) => res.json(await service.cancel(req.auth, v.id(req.params.id), values.cancel(req.body))));
  router.post('/operations/:key/resolve', async (req, res) => { v.body(req.body, []); res.json(await service.resolveOperation(req.auth, values.operationKey(req.params.key))); });
  router.get('/operations/:key', async (req, res) => { v.body(req.query, []); res.json(await service.operation(req.auth, values.operationKey(req.params.key))); });
  router.get('/cash/current', async (req, res) => { v.body(req.query, ['full'], []); if (req.query.full !== undefined && req.query.full !== 'true') v.invalid(); res.json({ cash: await service.currentCash(req.auth, req.query.full === 'true') }); });
  router.get('/cash/overview', async (req, res) => { v.body(req.query, []); res.json({ overview: await service.cashOverview(req.auth) }); });
  router.post('/cash/payments/:id/confirm', async (req, res) => res.json(await service.confirmPayment(req.auth, v.id(req.params.id), values.paymentConfirmation(req.body))));
  router.post('/cash/orders/:id/quote', async (req, res) => res.json({ quote: await service.quoteOrder(req.auth, v.id(req.params.id), values.orderQuote(req.body)) }));
  router.post('/cash/orders/:id/charge', async (req, res) => res.status(201).json(await service.chargeOrder(req.auth, v.id(req.params.id), values.orderCharge(req.body))));
  router.post('/cash/orders/:id/cancel', async (req, res) => res.json(await service.cancelOrder(req.auth, v.id(req.params.id), values.paymentConfirmation(req.body))));
  router.get('/cash/sessions', async (req, res) => res.json({ sessions: await service.cashHistory(req.auth, page(req.query)) }));
  router.post('/cash/sessions', async (req, res) => res.status(201).json(await service.openCash(req.auth, values.cash(req.body))));
  router.post('/cash/sessions/:id/close', async (req, res) => res.json(await service.closeCash(req.auth, v.id(req.params.id), values.cash(req.body, true))));
  return router;
}
module.exports = { salesRoutes };
