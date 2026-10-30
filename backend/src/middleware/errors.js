'use strict';
function httpError(status, code) { return Object.assign(new Error(code), { publicStatus: status, publicCode: code }); }
let lastDiagnosticAt = 0;
let suppressedDiagnostics = 0;
function logInternalFailure(error, req, status, code) {
  const now = Date.now();
  if (now - lastDiagnosticAt < 1000) { suppressedDiagnostics += 1; return; }
  const internalCode = typeof error.code === 'string' && /^[A-Z0-9_:-]{1,64}$/.test(error.code) ? error.code : undefined;
  const route = typeof req.route?.path === 'string' ? String(req.baseUrl || '') + req.route.path : '<unmatched>';
  const diagnostic = {
    event: 'request_failure', status, publicCode: code,
    errorType: typeof error.constructor?.name === 'string' && /^[A-Za-z0-9]+$/.test(error.constructor.name) ? error.constructor.name : 'Error',
    ...(internalCode ? { internalCode } : {}), route: route.slice(0, 160),
    ...(suppressedDiagnostics ? { suppressedSinceLastLog: suppressedDiagnostics } : {}),
    ...(typeof req.app?.locals?.databaseDiagnostics === 'function' ? { pool: req.app.locals.databaseDiagnostics() } : {})
  };
  suppressedDiagnostics = 0;
  lastDiagnosticAt = now;
  console.warn(JSON.stringify(diagnostic));
}
const publicMessages = Object.freeze({
  BUSINESS_NOT_FOUND: 'No se encontr\u00f3 el negocio solicitado.',
  BUSINESS_DELETE_PROTECTED: 'No se puede eliminar el negocio principal del sistema.',
  BUSINESS_DELETE_BLOCKED: 'Otra información del sistema todavía depende de este negocio. No se realizaron cambios; revise esas relaciones antes de volver a intentarlo.',
  BUSINESS_DELETE_SCHEMA_UNSUPPORTED: 'No se pudo comprobar de forma segura la estructura para eliminar este negocio. No se realizaron cambios.',
  BUSINESS_DELETE_PREVIEW_REQUIRED: 'Vuelve a abrir el resumen antes de confirmar la eliminación.',
  BUSINESS_DELETE_PREVIEW_STALE: 'La información del negocio cambió desde que se mostró el resumen. Revisa el resumen actualizado antes de confirmar.',
  BUSINESS_DELETE_CONFIRMATION_REQUIRED: 'Debes escribir exactamente ELIMINAR para confirmar.',
  SYSTEM_ADMIN_BILLING_MIGRATION_REQUIRED: 'La gestión de planes y pagos todavía no está disponible. Contacta al administrador del sistema.',
  MIGRATION_PACKAGE_INVALID: 'El paquete no contiene los datos básicos válidos para esta migración.',
  MIGRATION_TARGET_INACTIVE: 'El negocio conectado destino no está activo.',
  MIGRATION_GATE_SCHEMA_REQUIRED: 'La importación todavía no está disponible. Contacta al administrador del sistema; no se modificó ningún negocio.',
  MIGRATION_OPERATIONAL_SCHEMA_REQUIRED: 'La importación de operaciones históricas todavía no está disponible. Contacta al administrador del sistema.',
  MIGRATION_ZERO_INVENTORY_SCHEMA_REQUIRED: 'La importación de ciertos movimientos históricos todavía no está disponible. Contacta al administrador del sistema.',
  MIGRATION_ORDER_SNAPSHOT_SCHEMA_REQUIRED: 'La importación de órdenes antiguas todavía no está disponible. Contacta al administrador del sistema.',
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
  BUSINESS_PLAN_STANDARD_MIGRATION_REQUIRED: 'El plan Estándar todavía no está disponible. No se modificó el negocio; contacta al administrador del sistema.',
  BUSINESS_PLAN_REQUIRED: 'Asigna un plan al negocio antes de crear o reactivar usuarios.',
  BUSINESS_PLAN_USER_LIMIT_EXCEEDED: 'Se alcanzaría el máximo de usuarios activos del plan. No se modificó el negocio.',
  BUSINESS_PLAN_ADMIN_LIMIT_EXCEEDED: 'El plan permite un administrador activo por negocio. No se modificó la cuenta ni el plan.',
  BUSINESS_PLAN_DOWNGRADE_BLOCKED: 'El negocio supera el límite del plan seleccionado. No se cambió el plan ni se desactivaron usuarios.',
  BUSINESS_PLAN_ACTIVATION_BLOCKED: 'No se puede activar el negocio hasta que su plan y usuarios activos estén dentro de los límites.',
  BUSINESS_PLAN_NOT_MONTHLY: 'Solo se pueden registrar pagos para planes conectados mensuales.',
  PAYMENT_AMOUNT_INVALID: 'Ingresa un importe en USD mayor que cero y con hasta dos decimales.',
  PAYMENT_DATE_FUTURE: 'La fecha del pago no puede estar en el futuro.',
  HISTORICAL_PURCHASE_READ_ONLY: 'Las compras históricas se conservan sin edición operativa.',
  PURCHASE_EDIT_NOT_COMPLETED: 'Solo se pueden corregir compras completadas.',
  PURCHASE_EDIT_CREDIT_ONLY: 'Esta compra no cumple las condiciones para una corrección segura.',
  PURCHASE_HAS_PAYMENT_HISTORY: 'La compra tiene pagos o intentos de pago; debe conservarse su historial.',
  PURCHASE_HAS_CASH_MOVEMENT: 'La compra tiene movimientos de caja asociados y no admite edición directa.',
  PURCHASE_LINE_HISTORY_UNSUPPORTED: 'La factura contiene descuentos o impuestos que requieren una conciliación contable aparte.',
  PURCHASE_INVENTORY_HISTORY_MISMATCH: 'El historial de inventario no coincide con los artículos de la factura.',
  PURCHASE_HAS_SUBSEQUENT_MOVEMENTS: 'Hay movimientos posteriores de estos productos; la compra no admite edición directa.',
  PURCHASE_CURRENT_COST_CHANGED: 'El costo o precio actual del producto cambió después de esta compra.',
  PURCHASE_STOCK_MISMATCH: 'Las existencias actuales no coinciden con el último movimiento de esta compra.',
  PURCHASE_PRODUCT_UNAVAILABLE: 'Un producto de esta compra ya no está disponible para una corrección segura.',
  PURCHASE_REVISION_INVALID: 'Vuelve a abrir la compra antes de guardar la corrección.',
  PURCHASE_REVISION_CONFLICT: 'La compra cambió desde que la abriste. Actualiza la lista y revisa los datos.',
  PURCHASE_PRODUCT_SET_LOCKED: 'La corrección debe conservar los mismos productos de la factura.',
  PURCHASE_EDIT_STOCK_INSUFFICIENT: 'La corrección dejaría existencias negativas y no se realizó.',
  PURCHASE_DUPLICATE: 'Ya existe una compra con esa factura del proveedor.',
  PURCHASE_CASH_PAYMENT_UNSAFE: 'Solo se puede corregir un pago al contado en efectivo mientras su caja original siga abierta.',
  PURCHASE_CASH_SESSION_CLOSED: 'La caja original ya cerró. La compra no se modificó.',
  PURCHASE_CASH_BALANCE_INSUFFICIENT: 'La caja no tiene efectivo suficiente para registrar la diferencia. No se modificó la compra.',
  PURCHASE_CASH_REFUND_REQUIRED: 'El nuevo total es menor que el efectivo ya pagado. Registra y concilia primero la devolución del proveedor; la compra no se modificó.',
  CASH_INCONSISTENT: 'Los datos del pago y el movimiento de caja no coinciden. No se realizó ningún cambio.',
  PURCHASE_CANCEL_REQUIRES_OPEN_CASH: 'Para anular este pago en efectivo, abre la caja donde se registró o resuelve primero el cierre.',
  LOGIN_PROTECTION_UNAVAILABLE: 'El acceso no está disponible temporalmente. Inténtalo de nuevo en unos minutos.',
  REAUTHORIZATION_RATE_LIMITED: 'Se realizaron varios intentos para abrir este módulo. Espera unos minutos e inténtalo de nuevo.',
  REAUTHORIZATION_PROTECTION_UNAVAILABLE: 'No se puede verificar el permiso en este momento. Inténtalo de nuevo en unos minutos.',
  LOCAL_LICENSE_NOT_CONFIGURED: 'La activación de licencias todavía no está disponible. Tus datos no se modificaron; contacta al administrador.',
  LOCAL_LICENSE_UNAVAILABLE: 'No se pudo validar esta licencia. Revisa el código o contacta al administrador autorizado.',
  LOCAL_LICENSE_RATE_LIMITED: 'Se realizaron varios intentos. Espera unos minutos antes de probar de nuevo.',
  LOCAL_LICENSE_INVALID_REQUEST: 'No se pudo procesar la solicitud de licencia. Inténtalo nuevamente.',
  LOCAL_LICENSE_INVALID_CUSTOMER: 'Ingresa el nombre del cliente y revisa la referencia de compra.',
  LOCAL_LICENSE_REASON_REQUIRED: 'Para revocar una licencia, ingresa un motivo de al menos 10 caracteres.',
  LOCAL_LICENSE_NOT_FOUND: 'No se encontró la licencia solicitada.',
  LOCAL_LICENSE_TRANSFER_UNAVAILABLE: 'Solo se puede transferir una licencia activa.',
  LOCAL_LICENSE_ORIGIN_REQUIRED: 'No se pudo validar el origen de la solicitud.'
});
function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  let status = error.publicStatus || 500;
  let code = error.publicCode || 'INTERNAL_ERROR';
  if (['POS_POOL_QUEUE_FULL', 'POS_POOL_ACQUIRE_TIMEOUT'].includes(error.code)) { status = 503; code = 'DATABASE_BUSY'; }
  else if (['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'PROTOCOL_CONNECTION_LOST', 'POOL_CLOSED'].includes(error.code)) { status = 503; code = 'DATABASE_UNAVAILABLE'; }
  if (error.type === 'entity.too.large') { status = 413; code = req.originalUrl?.split('?')[0] === '/api/product-images' ? 'IMAGE_TOO_LARGE' : 'PAYLOAD_TOO_LARGE'; }
  if (error.type === 'entity.parse.failed') { status = 400; code = 'INVALID_JSON'; }
  if (error.status === 415) { status = 415; code = 'UNSUPPORTED_BODY'; }
  const details = error.publicDetails;
  const safeDetails = details && typeof details === 'object' && !Array.isArray(details) && Object.values(details).every(value => Number.isSafeInteger(value) && value >= 0)
    ? details : undefined;
  if (status >= 500) {
    logInternalFailure(error, req, status, code);
    if (code === 'DATABASE_BUSY') res.set?.('Retry-After', '2');
  }
  if (status === 429 && Number.isSafeInteger(error.retryAfter) && error.retryAfter > 0) res.set?.('Retry-After', String(error.retryAfter));
  res.status(status).json({ error: { code, ...(publicMessages[code] ? { message: publicMessages[code] } : {}), ...(error.field ? { field: error.field } : {}), ...(safeDetails ? { details: safeDetails } : {}) } });
}
module.exports = { httpError, errorHandler };
