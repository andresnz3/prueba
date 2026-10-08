'use strict';
const { Router } = require('express');
const { authMiddleware } = require('../middleware/authentication');
const v = require('../middleware/validation');

function bound(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) v.invalid();
  return value.slice(0, 23).replace('T', ' ');
}

function reportsRoutes(authentication, service) {
  const router = Router(), middleware = authMiddleware(authentication.repo, authentication.config);
  router.use('/reports', middleware.authenticate, (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.get('/reports/connected', async (req, res) => {
    v.body(req.query, ['from', 'until'], []);
    const from = req.query.from === undefined ? null : bound(req.query.from);
    const until = req.query.until === undefined ? null : bound(req.query.until);
    if (from && until && from >= until) v.invalid();
    res.json({ report: await service.report(req.auth, { from, until }) });
  });
  return router;
}

module.exports = { reportsRoutes };
