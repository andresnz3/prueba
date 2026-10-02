'use strict';
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { healthRoutes } = require('./routes/health');
const { httpError, errorHandler } = require('./middleware/errors');
function createApp({ config, checkDatabase, authentication }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({
    origin(origin, callback) {
      if (!origin) return callback(null, false);
      if (config.origins.includes(origin)) return callback(null, true);
      callback(httpError(403, 'ORIGIN_NOT_ALLOWED'));
    }, methods: authentication ? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] : ['GET'], credentials: Boolean(authentication), allowedHeaders: ['Content-Type', 'X-CSRF-Token'], maxAge: 600
  }));
  app.use(express.json({ limit: config.jsonLimit, strict: true, inflate: false }));
  app.use('/api', healthRoutes(checkDatabase));
  if (authentication) app.use('/api', require('./routes/auth').authRoutes(authentication));
  app.use((req, res, next) => next(httpError(404, 'NOT_FOUND')));
  app.use(errorHandler);
  return app;
}
module.exports = { createApp };
