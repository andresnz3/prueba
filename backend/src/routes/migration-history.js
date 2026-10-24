'use strict';

const { Router } = require('express');
const { authMiddleware } = require('../middleware/authentication');
const { httpError } = require('../middleware/errors');
const v = require('../middleware/validation');

function migrationHistoryRoutes(authentication) {
  const router = Router();
  const middleware = authMiddleware(authentication.repo, authentication.config);
  const service = require('../services/migration-history').createMigrationHistoryService(authentication);
  router.use('/migration-history', middleware.authenticate, (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.get('/migration-history/:module', async (req, res) => {
    v.body(req.query, ['offset', 'limit'], []);
    for (const value of Object.values(req.query)) {
      if (typeof value !== 'string' || !/^\d{1,7}$/.test(value)) throw httpError(400, 'INVALID_INPUT');
    }
    res.json(await service.list(req.auth, req.params.module, req.query));
  });
  return router;
}

module.exports = { migrationHistoryRoutes };
