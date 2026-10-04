'use strict';
function httpError(status, code) { return Object.assign(new Error(code), { publicStatus: status, publicCode: code }); }
function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  let status = error.publicStatus || 500;
  let code = error.publicCode || 'INTERNAL_ERROR';
  if (['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'PROTOCOL_CONNECTION_LOST', 'POOL_CLOSED'].includes(error.code)) { status = 503; code = 'DATABASE_UNAVAILABLE'; }
  if (error.type === 'entity.too.large') { status = 413; code = req.originalUrl?.split('?')[0] === '/api/product-images' ? 'IMAGE_TOO_LARGE' : 'PAYLOAD_TOO_LARGE'; }
  if (error.type === 'entity.parse.failed') { status = 400; code = 'INVALID_JSON'; }
  if (error.status === 415) { status = 415; code = 'UNSUPPORTED_BODY'; }
  res.status(status).json({ error: { code, ...(error.field ? { field: error.field } : {}) } });
}
module.exports = { httpError, errorHandler };
