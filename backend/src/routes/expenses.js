'use strict';
const { Router } = require('express');
const { authMiddleware } = require('../middleware/authentication');
const v = require('../middleware/validation');
const { page } = require('../services/inventory-values');
const values = require('../services/expense-values');
const { httpError } = require('../middleware/errors');

function expensesRoutes(authentication, service) {
  const router = Router(), middleware = authMiddleware(authentication.repo, authentication.config);
  router.use('/expenses', middleware.authenticate, (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (!req.is('application/json')) throw httpError(415, 'JSON_REQUIRED');
      return middleware.csrf(req, res, next);
    }
    next();
  });
  router.get('/expenses', async (req, res) => {
    v.body(req.query, ['limit', 'offset', 'q'], []);
    const options = page(req.query, ['q']);
    const q = req.query.q === undefined ? null : v.text(req.query.q, 100);
    res.json(await service.list(req.auth, { ...options, q }));
  });
  router.post('/expenses', async (req, res) => res.status(201).json(await service.create(req.auth, values.expense(req.body))));
  router.post('/expenses/:id/cancel', async (req, res) => res.json(await service.cancel(req.auth, v.id(req.params.id), values.cancellation(req.body))));
  return router;
}

module.exports = { expensesRoutes };
