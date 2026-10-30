'use strict';

const { Router } = require('express');
const { httpError } = require('../middleware/errors');
const v = require('../middleware/validation');
const { createLocalLicenseService } = require('../services/local-licenses');

function localLicenseRoutes({ repo }, licenseConfig = {}, allowedOrigins = []) {
  const router = Router();
  const licenses = createLocalLicenseService(repo, licenseConfig);
  router.use('/local-license', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.method !== 'POST' || !req.is('application/json') || req.get('X-POS-License-Request') !== '1' ||
        !req.get('Origin') || !Array.isArray(allowedOrigins) || !allowedOrigins.includes(req.get('Origin'))) return next(httpError(403, 'LOCAL_LICENSE_ORIGIN_REQUIRED'));
    next();
  });
  router.post('/local-license/challenge', async (req, res) => {
    const data = v.body(req.body, ['purpose'], ['purpose']);
    res.json(await licenses.public.challenge({ purpose: data.purpose, ipAddress: req.ip }));
  });
  router.post('/local-license/activate', async (req, res) => {
    const data = v.body(req.body, ['licenseCode', 'installationId', 'localBusinessId', 'publicKey', 'challengeId', 'challenge', 'signature'], ['licenseCode', 'installationId', 'publicKey', 'challengeId', 'challenge', 'signature']);
    res.json(await licenses.public.activate(data, req.ip));
  });
  router.post('/local-license/status', async (req, res) => {
    const data = v.body(req.body, ['licenseId', 'installationId', 'localBusinessId', 'challengeId', 'challenge', 'signature'], ['licenseId', 'installationId', 'challengeId', 'challenge', 'signature']);
    res.json(await licenses.public.status(data, req.ip));
  });
  return router;
}

module.exports = { localLicenseRoutes };
