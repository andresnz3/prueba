'use strict';
const express = require('express');
const { authMiddleware } = require('../middleware/authentication');
const { httpError } = require('../middleware/errors');
const { createAuthRateLimit } = require('../middleware/auth-rate-limit');
const v = require('../middleware/validation');
const values = require('../services/business-settings-values');
const { MAX_SOURCE } = require('../services/product-images');

function businessSettingsRoutes(authentication, service) {
  const router = express.Router(), m = authMiddleware(authentication.repo, authentication.config);
  const rate = createAuthRateLimit({ rateMax: 12, rateWindowSeconds: 60 });
  let inFlight = 0;
  router.use('/business-settings', m.authenticate, (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['GET','HEAD','OPTIONS'].includes(req.method)) return m.csrf(req, res, next);
    next();
  });
  router.get('/business-settings', async (req, res) => { v.body(req.query, []); res.json(await service.get(req.auth)); });
  router.put('/business-settings', m.admin, async (req, res) => res.json(await service.save(req.auth, values.settings(req.body))));
  router.post('/business-settings/import-legacy', m.admin, async (req, res) => res.status(201).json(await service.importLegacy(req.auth, values.legacySettings(req.body))));
  router.post('/business-settings/logo', m.admin, rate, (req, res, next) => {
    v.body(req.query, []);
    if (!['image/jpeg','image/png','image/webp'].includes(req.get('Content-Type'))) throw httpError(415, 'IMAGE_FORMAT_INVALID');
    if (inFlight >= 2) { res.set('Retry-After', '2'); throw httpError(429, 'IMAGE_BUSY'); }
    inFlight++;
    let released = false;
    const release = () => { if (!released) { released = true; inFlight--; } };
    res.once('finish', release); res.once('close', release); next();
  }, express.raw({ type: () => true, limit: MAX_SOURCE, inflate: false }), async (req, res) => {
    res.json(await service.uploadLogo(req.auth, req.body, req.get('Content-Type')));
  });
  return router;
}
module.exports = { businessSettingsRoutes };
