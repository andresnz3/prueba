'use strict';
function httpError(status, code) { return Object.assign(new Error(code), { publicStatus: status, publicCode: code }); }
const publicMessages = Object.freeze({
  BUSINESS_NOT_FOUND: 'No se encontr\u00f3 el negocio solicitado.',
  BUSINESS_DELETE_PROTECTED: 'No se puede eliminar el negocio principal del sistema.',
  BUSINESS_DELETE_BLOCKED: 'Otra información del sistema todavía depende de este negocio. No se realizaron cambios; revise esas relaciones antes de volver a intentarlo.',
  BUSINESS_DELETE_SCHEMA_UNSUPPORTED: 'No se pudo comprobar de forma segura la estructura para eliminar este negocio. No se realizaron cambios.',
  BUSINESS_DELETE_PREVIEW_REQUIRED: 'Vuelve a abrir el resumen antes de confirmar la eliminación.',
  BUSINESS_DELETE_PREVIEW_STALE: 'La información del negocio cambió desde que se mostró el resumen. Revisa el resumen actualizado antes de confirmar.',
  BUSINESS_DELETE_CONFIRMATION_REQUIRED: 'Debes escribir exactamente ELIMINAR para confirmar.',
  SYSTEM_ADMIN_BILLING_MIGRATION_REQUIRED: 'La gestión de planes y pagos necesita la migración 006 aprobada. Consulta al administrador del sistema.',
  MIGRATION_PACKAGE_INVALID: 'El paquete no contiene los datos básicos válidos para esta migración.',
  MIGRATION_TARGET_INACTIVE: 'El negocio conectado destino no está activo.',
  MIGRATION_GATE_SCHEMA_REQUIRED: 'Para usar la importación segura deben aplicarse las migraciones 012 y 013 en el servidor. No se modificó ningún negocio.',
  MIGRATION_OPERATIONAL_SCHEMA_REQUIRED: 'El servidor necesita la migración 014 para importar y conciliar las operaciones históricas.',
  MIGRATION_ZERO_INVENTORY_SCHEMA_REQUIRED: 'El servidor necesita la migraci\u00f3n 015 para conservar los eventos hist\u00f3ricos de inventario sin cambio de existencias.',
  MIGRATION_ORDER_SNAPSHOT_SCHEMA_REQUIRED: 'El servidor necesita la migración 016 para conservar órdenes antiguas sin inventar precios por producto.',
  MIGRATION_TARGET_PROTECTED: 'El negocio principal del sistema no puede usarse como destino.',
  MIGRATION_TARGET_ALREADY_PREPARED: 'Este negocio ya está reservado para una importación o ya tiene un proceso iniciado.',
  MIGRATION_TARGET_HAS_DATA: 'Este negocio ya contiene operaciones o información que no se puede sustituir. No se modificó.',
  MIGRATION_TARGET_CONFIRMATION_REQUIRED: 'Confirma que deseas reservar este negocio y bloquear su acceso mientras se prepara la migración.',
  MIGRATION_SYSTEM_BUSINESS_CONFIRMATION_REQUIRED: 'Confirma explícitamente que deseas importar al negocio del sistema.',
  MIGRATION_IDENTITY_CONFIRMATION_REQUIRED: 'Confirma que este registro pertenece al negocio del paquete antes de incluirlo.',
  MIGRATION_IDENTITY_REVIEW_UNAVAILABLE: 'Este registro no está disponible para resolver su identidad. Los datos siguen pendientes y el negocio permanece bloqueado.',
  MIGRATION_IDENTITY_ALREADY_REVIEWED: 'Este registro ya tiene una decisión guardada. No se reemplazó.',
  MIGRATION_RECORD_NOT_FOUND: 'No se encontró el registro pendiente en el archivo de migración.',
  MIGRATION_SALES_ORIGIN_CONFIRMATION_REQUIRED: 'El destino ya contiene ventas de otro origen. Revisa los negocios de origen y confirma la importación explícitamente.',
  BUSINESS_PLAN_INVALID: 'Selecciona uno de los planes disponibles.',
  BUSINESS_PLAN_SCHEMA_UNSUPPORTED: 'El plan guardado no es compatible con esta versión. No se modificaron los usuarios ni el negocio.',
  BUSINESS_PLAN_STANDARD_MIGRATION_REQUIRED: 'El plan Estándar requiere aplicar la migración 017 del sistema. No se modificó el negocio.',
  BUSINESS_PLAN_REQUIRED: 'Asigna un plan al negocio antes de crear o reactivar usuarios.',
  BUSINESS_PLAN_USER_LIMIT_EXCEEDED: 'Se alcanzaría el máximo de usuarios activos del plan. No se modificó el negocio.',
  BUSINESS_PLAN_ADMIN_LIMIT_EXCEEDED: 'El plan permite un administrador activo por negocio. No se modificó la cuenta ni el plan.',
  BUSINESS_PLAN_DOWNGRADE_BLOCKED: 'El negocio supera el límite del plan seleccionado. No se cambió el plan ni se desactivaron usuarios.',
  BUSINESS_PLAN_ACTIVATION_BLOCKED: 'No se puede activar el negocio hasta que su plan y usuarios activos estén dentro de los límites.',
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
  const details = error.publicDetails;
  const safeDetails = details && typeof details === 'object' && !Array.isArray(details) && Object.values(details).every(value => Number.isSafeInteger(value) && value >= 0)
    ? details : undefined;
  res.status(status).json({ error: { code, ...(publicMessages[code] ? { message: publicMessages[code] } : {}), ...(error.field ? { field: error.field } : {}), ...(safeDetails ? { details: safeDetails } : {}) } });
}
module.exports = { httpError, errorHandler };
