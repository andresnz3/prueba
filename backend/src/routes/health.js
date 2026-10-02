'use strict';
const { Router } = require('express');
const { healthController } = require('../controllers/health');
function healthRoutes(checkDatabase) {
  const router = Router();
  router.get('/health', healthController(checkDatabase));
  return router;
}
module.exports = { healthRoutes };
