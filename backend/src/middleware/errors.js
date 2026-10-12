'use strict';
function httpError(status, code) { return Object.assign(new Error(code), { publicStatus: status, publicCode: code }); }
const publicMessages = Object.freeze({
  BUSINESS_NOT_FOUND: 'No se encontr\u00f3 el negocio solicitado.',
  BUSINESS_DELETE_PROTECTED: 'No se puede eliminar el negocio principal del sistema.',
  BUSINESS_HAS_DATA: 'No se puede eliminar porque el negocio ya tiene informaci\u00f3n registrada. Puede suspenderlo.',
  BUSINESS_DELETE_CONFIRMATION_REQUIRED: 'Debes escribir exactamente ELIMINAR para confirmar.',
  SYSTEM_ADMIN_BILLING_MIGRATION_REQUIRED: 'La gestión de planes y pagos necesita la migración 006 aprobada. Consulta al administrador del sistema.',
  BUSINESS_PLAN_INVALID: 'Selecciona uno de los planes disponibles.',
  BUSINESS_PLAN_NOT_MONTHLY: 'Solo se pueden registrar pagos para planes conectados mensuales.',
  PAYMENT_AMOUNT_INVALID: 'Ingresa un importe en USD mayor que cero y con hasta dos decimales.',
  PAYMENT_DATE_FUTURE: 'La fecha del pago no puede estar en el futuro.'
});
function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  let status = error.publicStatus || 500;
  let code = error.publicCode || 'INTERNAL_ERROR';
  if (['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'PROTOCOL_CONNECTION_LOST', 'POOL_CLOSED'].includes(error.code)) { status = 503; code = 'DATABASE_UNAVAILABLE'; }
  if (error.type === 'entity.too.large') { status = 413; code = req.originalUrl?.split('?')[0] === '/api/product-images' ? 'IMAGE_TOO_LARGE' : 'PAYLOAD_TOO_LARGE'; }
  if (error.type === 'entity.parse.failed') { status = 400; code = 'INVALID_JSON'; }
  if (error.status === 415) { status = 415; code = 'UNSUPPORTED_BODY'; }
  res.status(status).json({ error: { code, ...(publicMessages[code] ? { message: publicMessages[code] } : {}), ...(error.field ? { field: error.field } : {}) } });
}
module.exports = { httpError, errorHandler };
