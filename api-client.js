'use strict';

(() => {
  const messages = {
    HISTORICAL_PURCHASE_READ_ONLY: 'Esta compra forma parte del historial y solo se puede consultar.',
    PURCHASE_CASH_BALANCE_INSUFFICIENT: 'La caja no tiene efectivo suficiente para registrar la diferencia. La compra no se modificó.',
    PURCHASE_CASH_PAYMENT_UNSAFE: 'No se puede corregir esta compra con seguridad usando su forma de pago actual. No se modificó.',
    PURCHASE_CASH_REFUND_REQUIRED: 'El nuevo total es menor que el monto pagado. Registra y concilia la devolución del proveedor antes de corregir la compra. No se modificó.',
    PURCHASE_CASH_SESSION_CLOSED: 'La caja donde se pagó esta compra ya está cerrada. La compra no se modificó.',
    PURCHASE_CURRENT_COST_CHANGED: 'El costo o precio del producto cambió después de esta compra. Actualiza la información y vuelve a revisarla.',
    PURCHASE_EDIT_CREDIT_ONLY: 'Esta corrección solo está disponible para compras a crédito sin movimientos posteriores.',
    PURCHASE_EDIT_NOT_COMPLETED: 'Solo se pueden corregir compras completadas.',
    PURCHASE_EDIT_STOCK_INSUFFICIENT: 'La corrección dejaría existencias negativas. La compra no se modificó.',
    PURCHASE_HAS_CASH_MOVEMENT: 'Esta compra tiene movimientos de caja asociados y no se puede editar directamente.',
    PURCHASE_HAS_PAYMENT_HISTORY: 'Esta compra tiene pagos registrados y no se puede editar directamente. Su historial se conservó.',
    PURCHASE_HAS_SUBSEQUENT_MOVEMENTS: 'Hay movimientos posteriores de estos productos. La compra no se puede corregir directamente.',
    PURCHASE_INVENTORY_HISTORY_MISMATCH: 'El historial de existencias no coincide con los artículos de esta factura. No se modificó la compra; solicita una revisión.',
    PURCHASE_LINE_HISTORY_UNSUPPORTED: 'Esta factura tiene descuentos o impuestos que requieren una revisión antes de corregirla. No se modificó.',
    PURCHASE_PRODUCT_SET_LOCKED: 'La corrección debe conservar los mismos productos de la factura. No se guardaron cambios.',
    PURCHASE_PRODUCT_UNAVAILABLE: 'Uno de los productos de esta compra ya no está disponible para corregirla.',
    PURCHASE_REVISION_CONFLICT: 'La compra cambió mientras la revisabas. Actualiza la lista y comprueba los datos.',
    PURCHASE_REVISION_INVALID: 'Vuelve a abrir la compra antes de guardar la corrección.',
    PURCHASE_STOCK_MISMATCH: 'Las existencias actuales no coinciden con el historial de esta compra. No se modificó; solicita una revisión.',
    LOCAL_LICENSE_INVALID_CUSTOMER: 'Completa el nombre del cliente y revisa la referencia de compra.',
    LOCAL_LICENSE_INVALID_REQUEST: 'No se pudo procesar la solicitud de licencia. Revisa la información e inténtalo nuevamente.',
    LOCAL_LICENSE_NOT_CONFIGURED: 'La gestión de licencias no está disponible en este momento. No se modificaron tus datos; contacta al administrador.',
    LOCAL_LICENSE_NOT_FOUND: 'No se encontró la licencia solicitada. Actualiza la lista e inténtalo nuevamente.',
    LOCAL_LICENSE_ORIGIN_REQUIRED: 'No se pudo validar esta solicitud. Actualiza la pantalla e inténtalo nuevamente.',
    LOCAL_LICENSE_RATE_LIMITED: 'Se realizaron varios intentos. Espera unos minutos antes de volver a intentarlo.',
    LOCAL_LICENSE_REASON_REQUIRED: 'Para revocar una licencia, ingresa un motivo de al menos 10 caracteres.',
    LOCAL_LICENSE_TRANSFER_UNAVAILABLE: 'Solo se puede transferir una licencia activa.',
    LOCAL_LICENSE_UNAVAILABLE: 'No se pudo validar esta licencia. Revisa la información o contacta al administrador autorizado.',
    PAYMENT_ALREADY_VOID: 'Este pago ya está anulado. Actualiza el estado de cuenta.',
    PAYMENT_NOT_REVERSIBLE: 'Solo se pueden revertir pagos operativos de facturas de crédito vigentes. Los registros históricos son de consulta.',
    EXTERNAL_REFUND_REQUIRED: 'Confirma que la devolución se realizó por el mismo medio fuera del POS.',
    CASH_BALANCE_LIMIT: 'El movimiento supera el límite de efectivo admitido por la caja.',
    CART_EMPTY: 'El carrito está vacío. Agrega productos antes de cobrar.',
    QUANTITY_INVALID: 'Ingresa una cantidad mayor que cero, con hasta tres decimales.',
    DISCOUNT_INVALID: 'El descuento debe estar entre 0 y 100, con hasta cuatro decimales.',
    PAYMENT_METHOD_REQUIRED: 'Selecciona efectivo, tarjeta, transferencia o cr\u00e9dito.',
    PRODUCT_INACTIVE: 'El producto está inactivo. Retíralo del carrito.',
    CASH_CLOSED: 'Debes abrir caja antes de facturar o cobrar',
    CASH_AMBIGUOUS: 'Hay más de una caja abierta. Requiere revisión antes de cobrar.',
    CASH_ALREADY_OPEN: 'Ya hay una caja abierta en este negocio.',
    CASH_OPEN: 'Cierra la caja actual antes de cambiar el flujo de ventas.',
    PENDING_ORDERS_EXIST: 'Resuelve los pedidos pendientes antes de cambiar el flujo de ventas.',
    CASH_INVALID: 'Ingresa un monto de efectivo válido, cero o mayor, con hasta dos decimales.',
    CASH_INSUFFICIENT: 'El efectivo recibido es insuficiente para pagar esta venta.',
    CANCEL_REQUIRES_OPEN_CASH: 'Para anular esta venta debe abrir una caja, porque la devolución se registra en la caja actual.',
    CASH_REFUND_INSUFFICIENT: 'La caja actual no tiene efectivo suficiente para devolver esta venta.',
    CASH_INCONSISTENT: 'El movimiento de efectivo requiere revisión antes de anular.',
    QUOTE_CHANGED: 'Los precios o la caja cambiaron. Cancela este cobro y vuelve a comprobar los importes.',
    SALES_FLOW_CHANGED: 'El flujo de ventas cambió. Actualiza la pantalla y vuelve a intentar.',
    DIRECT_MODE_ACTIVE: 'La caja centralizada no está activa para este negocio.',
    ORDER_NOT_FOUND: 'No se encontró ese pedido en este negocio.',
    ORDER_NOT_PENDING: 'El pedido ya se cobró o canceló.',
    PAYMENT_NOT_FOUND: 'No se encontró el movimiento de pago.',
    PAYMENT_NOT_PENDING: 'Este pago ya fue confirmado, anulado o la venta fue cancelada.',
    PAYMENT_METHOD_NOT_CONFIRMABLE: 'Solo se pueden confirmar pagos pendientes de tarjeta o transferencia.',
    PAYMENT_ALREADY_CONFIRMED: 'El pago ya fue confirmado. Las devoluciones conectadas aún no están integradas.',
    OPERATION_CONFLICT: 'Esta referencia ya fue usada con otros datos o quedó descartada. Comprueba la operación.',
    OPERATION_NOT_FOUND: 'La operación todavía no está registrada. Comprueba su estado antes de volver a cobrar.',
    OPERATION_KEY_INVALID: 'No se pudo identificar la operación. Recarga y comprueba el cobro.',
    SALE_NOT_FOUND: 'No se encontró esa factura en este negocio.',
    SALE_CANCELLED: 'La venta ya está anulada. Su historial se conserva.',
    HISTORICAL_SALE_READ_ONLY: 'Las ventas históricas son de solo lectura y no se pueden anular desde el POS.',
    MIGRATION_SALES_ORIGIN_CONFIRMATION_REQUIRED: 'El destino ya contiene ventas de otro origen. Revisa el aviso y confirma explícitamente el nuevo origen.',
    INVOICE_DUPLICATE: 'La factura ya existe. Comprueba la operación antes de cobrar nuevamente.',
    INVOICE_LIMIT: 'La secuencia de facturas llegó a su límite.',
    REASON_REQUIRED: 'Ingresa el motivo de anulación.',
    TOTAL_LIMIT: 'El importe supera el límite permitido para una factura.',
    PRICE_TYPE_INVALID: 'Selecciona la tarifa de menudeo o mayoreo.',
    DETAIL_INVALID: 'El detalle admite hasta 500 caracteres, sin saltos de línea.',
    CREDIT_BLOCKED: 'No se puede anular una factura de cr\u00e9dito que ya tiene abonos.',
    CREDIT_CLIENT_REQUIRED: 'Selecciona un cliente para vender a cr\u00e9dito',
    CREDIT_LIMIT_EXCEEDED: 'El cliente supera el l\u00edmite de cr\u00e9dito disponible',
    CLIENT_DUPLICATE: 'Ya existe un cliente con ese nombre, tel\u00e9fono o identificaci\u00f3n.',
    CLIENT_NOT_FOUND: 'No se encontr\u00f3 ese cliente en este negocio.',
    CLIENT_INACTIVE: 'El cliente est\u00e1 inactivo y no puede comprar a cr\u00e9dito.',
    RECEIVABLE_NOT_CREDIT: 'La factura no tiene una cuenta por cobrar.',
    RECEIVABLE_ALREADY_PAID: 'La factura ya est\u00e1 pagada.',
    PAYMENT_EXCEEDS_BALANCE: 'El abono no puede superar el saldo de la factura.',
    PAYMENT_CONFIRMATION_PENDING: 'Hay un pago pendiente de confirmar para esta factura.',
    ORDER_PAYMENT_CHANGED: 'El medio de pago del pedido cambi\u00f3. Vuelve a cotizarlo.',
    CREDIT_HAS_PAYMENTS: 'No se puede anular la factura mientras tenga abonos registrados.',
    CREDIT_MIGRATION_REQUIRED: 'Las cuentas por cobrar todavía no están disponibles. Contacta al administrador del sistema antes de continuar.',
    SALES_MIGRATION_REQUIRED: 'Las ventas conectadas todavía no están disponibles. Contacta al administrador del sistema antes de continuar.',
    EXPENSE_CASH_CLOSED: 'Abre una caja antes de registrar un gasto en efectivo.',
    CASH_BALANCE_INSUFFICIENT: 'La caja no tiene saldo suficiente para registrar este movimiento.',
    EXPENSE_NOT_FOUND: 'No se encontró ese gasto en este negocio.',
    EXPENSE_CANCELLED: 'El gasto ya está anulado.',
    EXPENSE_CASH_MOVEMENT_MISSING: 'No se puede anular este gasto porque falta su movimiento de caja. Solicita revisión al administrador.',
    SUPPLIER_PAYMENT_MIGRATION_REQUIRED: 'Los pagos a proveedores con tarjeta o transferencia todavía no están disponibles. Contacta al administrador del sistema.',
    SUPPLIER_CASH_CLOSED: 'Abre una caja antes de registrar una compra en efectivo o pagar una factura de proveedor en efectivo.',
    PURCHASE_CANCEL_REQUIRES_OPEN_CASH: 'Abre la caja donde se registró el pago en efectivo antes de anular esta compra.',
    SUPPLIER_DUPLICATE: 'Ya existe un proveedor con ese nombre en este negocio.',
    SUPPLIER_NOT_FOUND: 'No se encontró el proveedor en este negocio.',
    SUPPLIER_INACTIVE: 'El proveedor está inactivo y no puede usarse en una compra.',
    PURCHASE_DUPLICATE: 'El número de factura ya existe. Comprueba la operación antes de intentarlo de nuevo.',
    PURCHASE_NOT_FOUND: 'No se encontró la factura de compra en este negocio.',
    PURCHASE_CANCELLED: 'La factura de compra ya está anulada.',
    PURCHASE_CANCEL_STOCK_INSUFFICIENT: 'No se puede anular la compra porque parte de esas existencias ya se consumió.',
    PAYABLE_NOT_FOUND: 'No se encontró la cuenta por pagar de esa factura.',
    PAYABLE_ALREADY_PAID: 'La factura ya está pagada.',
    PURCHASE_PRODUCT_IMAGE_UNAVAILABLE: 'La creación rápida de producto desde Compras no admite cargar una fotografía.',
    PROCUREMENT_MIGRATION_REQUIRED: 'Compras y cuentas por pagar todavía no están disponibles. Contacta al administrador del sistema.',
    NETWORK_ERROR: 'No hay conexión con el sistema. Revisa internet e inténtalo de nuevo.',
    INVALID_RESPONSE: 'No pudimos procesar la respuesta. Actualiza la pantalla e inténtalo nuevamente.',
    CASH_RESPONSE_INVALID: 'No se pudieron cargar los datos de Caja. Actualiza la pantalla e inténtalo de nuevo; si continúa, contacta al administrador.',
    INVALID_CREDENTIALS: 'El usuario o la contraseña no coinciden.',
    INVALID_SESSION: 'La sesión venció o fue revocada. Inicia sesión nuevamente.',
    CSRF_FAILED: 'No se pudo validar la solicitud. Intenta nuevamente.',
    MODULE_FORBIDDEN: 'Este módulo requiere autorización de un administrador.',
    ADMIN_REQUIRED: 'Solo un administrador del negocio puede gestionar usuarios.',
    LAST_ACTIVE_ADMIN: 'Debe permanecer al menos un administrador activo.',
    USERNAME_EXISTS: 'Ese nombre de usuario ya está en uso en otro registro.',
    SYSTEM_ADMIN_REQUIRED: 'Solo el administrador del sistema puede acceder a esta sección.',
    MIGRATION_PACKAGE_INVALID: 'El paquete no contiene los datos válidos para esta migración.',
    MIGRATION_BASIC_REQUIRED: 'Primero completa la migración básica de productos para este negocio.',
    MIGRATION_INVENTORY_SCHEMA_REQUIRED: 'Esta función todavía no está disponible. Contacta al administrador del sistema antes de continuar.',
    MIGRATION_TARGET_INACTIVE: 'El negocio conectado destino no está activo.',
    MIGRATION_GATE_SCHEMA_REQUIRED: 'La importación todavía no está disponible. Contacta al administrador del sistema; no se modificó ningún negocio.',
    MIGRATION_TARGET_PROTECTED: 'El negocio principal del sistema no puede usarse como destino.',
    MIGRATION_TARGET_ALREADY_PREPARED: 'Este negocio ya está reservado para una importación o ya tiene un proceso iniciado.',
    MIGRATION_TARGET_HAS_DATA: 'Este negocio ya contiene operaciones o información que no se puede sustituir. No se modificó.',
    MIGRATION_TARGET_CONFIRMATION_REQUIRED: 'Confirma que deseas reservar este negocio y bloquear su acceso mientras se prepara la migración.',
    MIGRATION_TARGET_REQUIRED: 'Selecciona un negocio creado para importar y que todavía esté bloqueado.',
    MIGRATION_SOURCE_MISMATCH: 'Este destino ya quedó asociado a otro negocio de origen.',
    MIGRATION_TARGET_SOURCE_NAME_MISMATCH: 'El nombre del origen no coincide con el destino seleccionado. Verifica el negocio antes de continuar.',
    MIGRATION_RECONCILIATION_REQUIRED: 'No se puede activar todavía. Completa la migración y la conciliación desde «Migración local».',
    BUSINESS_MIGRATION_PENDING: 'Este negocio todavía está en proceso de migración y no se puede abrir.',
    MIGRATION_SYSTEM_BUSINESS_CONFIRMATION_REQUIRED: 'Confirma explícitamente que deseas importar al negocio del sistema.',
    SUPPORT_TARGET_INVALID: 'Selecciona un negocio de cliente para iniciar la sesión de soporte.',
    SUPPORT_BUSINESS_UNAVAILABLE: 'El negocio está suspendido o no disponible para soporte.',
    SUPPORT_ADMIN_REQUIRED: 'El negocio necesita un administrador activo antes de iniciar soporte.',
    SUPPORT_OWNER_SESSION_INVALID: 'La sesión del dueño venció o fue revocada. Inicia sesión nuevamente.',
    INVALID_SUPPORT_SESSION: 'La sesión de soporte venció o perdió autorización. Vuelve al panel del sistema.',
    BUSINESS_NOT_FOUND: 'No se encontró el negocio solicitado.',
    BUSINESS_PROTECTED: 'El negocio del sistema no se puede suspender.',
    BUSINESS_DELETE_PROTECTED: 'No se puede eliminar el negocio principal del sistema.',
    BUSINESS_DELETE_BLOCKED: 'Otra información del sistema todavía depende de este negocio. No se realizaron cambios; revise esas relaciones antes de volver a intentarlo.',
    BUSINESS_DELETE_SCHEMA_UNSUPPORTED: 'No se pudo comprobar de forma segura la estructura para eliminar este negocio. No se realizaron cambios.',
    BUSINESS_DELETE_PREVIEW_REQUIRED: 'Vuelve a abrir el resumen antes de confirmar la eliminación.',
    BUSINESS_DELETE_PREVIEW_STALE: 'La información del negocio cambió desde que se mostró el resumen. Revisa el resumen actualizado antes de confirmar.',
    BUSINESS_DELETE_CONFIRMATION_REQUIRED: 'Eliminación cancelada. Debes escribir exactamente ELIMINAR.',
    SYSTEM_ADMIN_BILLING_MIGRATION_REQUIRED: 'La gestión de planes y pagos todavía no está disponible. Contacta al administrador del sistema.',
    BUSINESS_PLAN_INVALID: 'Selecciona uno de los planes disponibles.',
    BUSINESS_PLAN_SCHEMA_UNSUPPORTED: 'El plan guardado no es compatible. Consulta al administrador del sistema.',
    BUSINESS_PLAN_STANDARD_MIGRATION_REQUIRED: 'El plan Estándar todavía no está disponible. No se modificó el negocio; contacta al administrador del sistema.',
    BUSINESS_PLAN_REQUIRED: 'Asigna un plan al negocio antes de crear o reactivar usuarios.',
    BUSINESS_PLAN_USER_LIMIT_EXCEEDED: 'Se alcanzaría el máximo de usuarios activos del plan. No se modificó el negocio.',
    BUSINESS_PLAN_ADMIN_LIMIT_EXCEEDED: 'El plan permite un administrador activo por negocio. No se modificó la cuenta ni el plan.',
    BUSINESS_PLAN_DOWNGRADE_BLOCKED: 'El negocio supera el límite del plan seleccionado. No se cambió el plan ni se desactivaron usuarios.',
    BUSINESS_PLAN_ACTIVATION_BLOCKED: 'No se puede activar el negocio hasta que su plan y usuarios activos estén dentro de los límites.',
    BUSINESS_PLAN_NOT_MONTHLY: 'Solo se pueden registrar pagos para planes conectados mensuales.',
    PAYMENT_AMOUNT_INVALID: 'Ingresa un importe en USD mayor que cero y con hasta dos decimales.',
    PAYMENT_DATE_FUTURE: 'La fecha del pago no puede estar en el futuro.',
    SYSTEM_ADMIN_PROTECTED: 'La cuenta del dueño del sistema no se puede desactivar desde este panel.',
    USER_NOT_FOUND: 'No existe un usuario con ese nombre.',
    USERNAME_AMBIGUOUS: 'Este usuario está registrado en varios negocios. Cambia uno de los nombres de usuario con un administrador.',
    USER_INACTIVE: 'Este usuario está inactivo. Contacta al administrador del negocio.',
    BUSINESS_INACTIVE: 'El negocio está suspendido o inactivo. Contacta al administrador.',
    INVALID_INPUT: 'Revisa los campos ingresados.',
    PAYLOAD_TOO_LARGE: 'El archivo supera el tamaño permitido. Elige una copia más pequeña e inténtalo de nuevo.',
    INVALID_JSON: 'El archivo no tiene un formato válido. Revisa que sea una copia correcta e inténtalo de nuevo.',
    UNSUPPORTED_BODY: 'No se pudo procesar la información enviada. Revisa los datos e inténtalo nuevamente.',
    NOT_FOUND: 'No encontramos la información solicitada. Actualiza la pantalla e inténtalo nuevamente.',
    ORIGIN_NOT_ALLOWED: 'No se pudo validar esta solicitud. Actualiza la página e inténtalo nuevamente.',
    IMAGE_REQUIRES_UPLOAD: 'Selecciona la fotografía desde tu dispositivo y vuelve a guardarla.',
    IMAGE_TOO_LARGE: 'La fotografia supera el limite de 8 MiB. Elige una imagen mas pequena.',
    IMAGE_FORMAT_INVALID: 'Formato de fotografia no admitido. Usa JPEG, PNG o WebP estatico.',
    IMAGE_INVALID: 'La fotografia esta vacia, danada o no es una imagen valida.',
    IMAGE_DIMENSIONS_LIMIT: 'La fotografia supera el limite de 40 megapixeles.',
    IMAGE_REFERENCE_INVALID: 'La fotografia no pertenece a este negocio o ya no esta disponible. Vuelve a seleccionarla.',
    IMAGE_STORAGE_UNAVAILABLE: 'No se pudieron guardar las fotografías en este momento. Inténtalo más tarde o contacta al administrador.',
    IMAGE_QUOTA_EXCEEDED: 'El negocio alcanzo su limite de almacenamiento de fotografias.',
    IMAGE_BUSY: 'No se pudieron procesar todas las fotografías ahora. Espera unos segundos e inténtalo de nuevo.',
    BUSINESS_SETTINGS_MIGRATION_REQUIRED: 'La configuración del negocio todavía no está disponible. Contacta al administrador del sistema.',
    MIGRATION_ARCHIVE_SCHEMA_REQUIRED: 'La importación todavía no está disponible. Contacta al administrador del sistema; no se modificó el negocio.',
    MIGRATION_PACKAGE_CHANGED: 'El paquete local cambió después de iniciar la migración. Recupera el mismo archivo guardado para reanudarla.',
    MIGRATION_ARCHIVE_CONFIRMATION_REQUIRED: 'Confirma que el paquete pertenece al negocio destino.',
    MIGRATION_BATCH_CONFLICT: 'El lote de migración cambió. Consulta su estado antes de reintentar.',
    MIGRATION_OPERATIONAL_SCHEMA_REQUIRED: 'La importación de operaciones históricas todavía no está disponible. Contacta al administrador del sistema.',
    MIGRATION_ZERO_INVENTORY_SCHEMA_REQUIRED: 'La importación de ciertos movimientos históricos todavía no está disponible. Contacta al administrador del sistema.',
    MIGRATION_ORDER_SNAPSHOT_SCHEMA_REQUIRED: 'La importación de órdenes antiguas todavía no está disponible. Contacta al administrador del sistema.',
    MIGRATION_TARGET_USER_REQUIRED: 'Antes de migrar, crea una cuenta para el negocio destino con un usuario y una contraseña nuevos. No se copian las contraseñas del POS local.',
    MIGRATION_CATALOG_RECONCILIATION_REQUIRED: 'Los datos del catálogo no pudieron comprobarse. El negocio permanece bloqueado; revisa el resultado y vuelve a intentar con el mismo archivo.',
    MIGRATION_STAGE_IN_PROGRESS: 'La importación de este negocio ya está en curso. Consulta su estado antes de volver a intentarlo.',
    MIGRATION_CASH_SESSION_REFERENCE_UNRESOLVED: 'Una sesión de caja contiene referencias que no coinciden con los registros importados. No se conservó ningún movimiento parcial; revisa las relaciones del paquete.',
    MIGRATION_RECORD_CONFLICT: 'Un registro local tiene otra huella en el lote. Se detuvo para evitar sobrescribir información.',
    MIGRATION_ARCHIVE_INCOMPLETE: 'La copia del paquete no terminó de guardarse. Reintenta con el mismo archivo.',
    MIGRATION_SOURCE_SCOPE_REQUIRED: 'No se guardó la información: verifica que el paquete pertenezca a un solo negocio y no incluya registros sin identificar.',
      MIGRATION_IDENTITY_CONFIRMATION_REQUIRED: 'Confirma que este registro pertenece al negocio del paquete antes de incluirlo.',
      MIGRATION_IDENTITY_REVIEW_UNAVAILABLE: 'La información del paquete no permite resolver este registro. Sigue pendiente y el negocio permanece bloqueado.',
      MIGRATION_IDENTITY_ALREADY_REVIEWED: 'Este registro ya tiene una decisión guardada. No se reemplazó.',
      MIGRATION_RECORD_NOT_FOUND: 'No se encontró el registro pendiente en el archivo de migración.',
    MIGRATION_BATCH_NOT_FOUND: 'No se encontró el lote de migración para este negocio.',
    BUSINESS_SETTINGS_EXISTS: 'Ya hay información comercial guardada en el negocio. La copia de este dispositivo no se importó.',
    LEGACY_SETTINGS_BUSINESS_MISMATCH: 'El nombre de la configuracion local no coincide con el negocio conectado. No se importo.',
    TOO_MANY_ATTEMPTS: 'Demasiados intentos. Espera antes de intentar nuevamente.',
    LOGIN_PROTECTION_UNAVAILABLE: 'El acceso no está disponible temporalmente. Inténtalo de nuevo en unos minutos.',
    REAUTHORIZATION_RATE_LIMITED: 'Se realizaron varios intentos para abrir este módulo. Espera unos minutos e inténtalo de nuevo.',
    REAUTHORIZATION_PROTECTION_UNAVAILABLE: 'No se puede verificar el permiso en este momento. Inténtalo de nuevo en unos minutos.',
    BARCODE_EXISTS: 'Ese c\u00f3digo de barras ya existe en este negocio.',
    PRODUCT_CONFLICT: 'El producto cambi\u00f3 en otra sesi\u00f3n. Actualiza el inventario y abre la edici\u00f3n nuevamente.',
    PRODUCT_NOT_FOUND: 'Producto no encontrado en este negocio.',
    INSUFFICIENT_STOCK: 'No hay existencias suficientes para esa salida.',
    STOCK_LIMIT: 'Las existencias superan el l\u00edmite permitido.',
    PRODUCT_ARCHIVED: 'El producto est\u00e1 archivado; su historial se conserva.',
    DATABASE_UNAVAILABLE: 'El sistema está temporalmente fuera de servicio. Inténtalo de nuevo en unos minutos.',
    DATABASE_BUSY: 'El sistema est\u00e1 ocupado. Espera unos segundos y vuelve a intentarlo.',
    RETRY_OPERATION: 'La operaci\u00f3n no se complet\u00f3 por concurrencia. Consulta el inventario antes de reintentar.',
    INTERNAL_ERROR: 'Ocurrió un problema al completar la solicitud. Actualiza la pantalla y vuelve a intentarlo; si continúa, contacta al administrador.',
    REPORTS_UNAVAILABLE: 'Los reportes no están disponibles en este momento. Inténtalo más tarde o contacta al administrador.'
  };
  const technicalMessage = /\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+\b|\b(?:Internal Server Error|Bad Request|Unauthorized|Forbidden|Not Found|Method Not Allowed|Service Unavailable|Invalid Input|Request Failed|Failed to Fetch|NetworkError|Unhandled Promise Rejection|Cannot read properties|Access Denied|TypeError|ReferenceError|SyntaxError|RangeError|ConstraintError|DatabaseClosedError|DOMException|AbortError|IndexedDB|Dexie|MySQL|Docker|Node(?:\.js)?|Express|SQL(?:STATE)?|API|endpoint|database|backend|frontend|server|node_modules|ECONN[A-Z]+|ER_[A-Z0-9_]+)\b|\b(?:status(?:\s+code)?|estado|c[oó]digo de error)\s*(?:HTTP\s*)?[45]\d{2}\b|\b(?:HTTP|Error)\s*[45]\d{2}\b|\bundefined|null|NaN\b|\[object Object\]|\/api\/|\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/|\bat\s+[^\n]+\.(?:js|cjs):\d+|\b(?:ID|UUID)\s+(?:local|interno|de MySQL|de la base de datos)\b|^\s*(?:SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/im;
  const technicalCamelCase = /\b[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]*\b/;
  function containsTechnicalMessage(value) { return typeof value !== 'string' || technicalMessage.test(value) || technicalCamelCase.test(value); }
  function expectedUserError(message, fallback = 'No se pudo completar la operación. Revisa la información e inténtalo de nuevo.') {
    const value = typeof message === 'string' && message.trim() ? message.trim() : fallback;
    return Object.assign(new Error(containsTechnicalMessage(value) ? fallback : value), { userFacing: true });
  }
  function userFacingText(value, fallback = 'No se pudo completar la solicitud. Contacta al administrador si el problema continúa.') {
    return expectedUserError(value, fallback).message;
  }
  function userFacingErrorMessage(error, fallback = 'No se pudo completar la operación. Actualiza la pantalla e inténtalo nuevamente.') {
    if (error?.userFacing === true && typeof error.message === 'string' && !containsTechnicalMessage(error.message)) {
      if (typeof error.code !== 'string' || Object.hasOwn(messages, error.code)) return error.message;
    }
    return userFacingText(fallback, 'No se pudo completar la solicitud. Contacta al administrador si el problema continúa.');
  }
  class ApiError extends Error {
    constructor(code, status = 0) {
      const message = messages[code] || 'No se pudo completar la solicitud. Contacta al administrador si el problema continúa.';
      super(containsTechnicalMessage(message) ? 'No se pudo completar la solicitud. Contacta al administrador si el problema continúa.' : message);
      this.code = code; this.status = status; this.userFacing = true;
    }
  }
  function user(value) {
    if (!value || typeof value.id !== 'string' || typeof value.businessId !== 'string' || !/^[1-9]\d{0,19}$/.test(value.id) || !/^[1-9]\d{0,19}$/.test(value.businessId) || !['ADMIN', 'VENDEDOR'].includes(value.role) || typeof value.username !== 'string' || typeof value.fullName !== 'string' || value.active !== true) throw new ApiError('INVALID_RESPONSE');
    if (value.businessName !== undefined && (typeof value.businessName !== 'string' || !value.businessName.trim())) throw new ApiError('INVALID_RESPONSE');
    if (value.businessStatus !== undefined && !['ACTIVE', 'INACTIVE'].includes(value.businessStatus)) throw new ApiError('INVALID_RESPONSE');
    return Object.freeze({ id: value.id, businessId: value.businessId, username: value.username, fullName: value.fullName, role: value.role, active: true, ...(value.businessName !== undefined ? { businessName: value.businessName } : {}), ...(value.businessStatus !== undefined ? { businessStatus: value.businessStatus } : {}), ...(value.plan !== undefined ? { plan: value.plan } : {}) });
  }
  function session(value) {
    if (!value || typeof value.csrfToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.csrfToken) || typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt))) throw new ApiError('INVALID_RESPONSE');
    const support = value.support === undefined || value.support === null ? null : supportContext(value.support);
    return { user: user(value.user), support, expiresAt: value.expiresAt, csrfToken: value.csrfToken };
  }
  function supportContext(value) {
    if (!value || typeof value.businessId !== 'string' || !/^[1-9]\d{0,19}$/.test(value.businessId) || typeof value.businessName !== 'string' || !value.businessName.trim() || typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt))) throw new ApiError('INVALID_RESPONSE');
    const effectiveUser = user(value.user);
    if (effectiveUser.businessId !== value.businessId || effectiveUser.businessName !== value.businessName || effectiveUser.role !== 'ADMIN') throw new ApiError('INVALID_RESPONSE');
    return { businessId: value.businessId, businessName: value.businessName, expiresAt: value.expiresAt, user: effectiveUser };
  }
  function product(value, catalog = false, baseUrl) {
    if (!value || typeof value.id !== 'string' || typeof value.businessId !== 'string' || !/^[1-9]\d{0,19}$/.test(value.id || '') || !/^[1-9]\d{0,19}$/.test(value.businessId || '') || typeof value.active !== 'boolean' || typeof value.deleted !== 'boolean' || !['barcode', 'name', 'category'].every(field => typeof value[field] === 'string' && value[field].length > 0) || !(value.image === null || typeof value.image === 'string')) throw new ApiError('INVALID_RESPONSE');
    const result = { ...value, business_id: value.businessId, imageReference: value.image };
    if (value.image?.startsWith('/api/product-images/')) {
      const match = /^\/api\/product-images\/([1-9]\d{0,19})\/[a-f0-9]{32}\.jpg$/.exec(value.image);
      if (!match || match[1] !== value.businessId) throw new ApiError('INVALID_RESPONSE');
      result.image = new URL(value.image,baseUrl).href;
    }
    for (const field of ['cost', 'marginRetail', 'marginWholesale', 'retailPrice', 'wholesalePrice', 'stock', 'minStock', 'taxRate']) {
      if (catalog && ['cost', 'marginRetail', 'marginWholesale', 'taxRate'].includes(field)) { result[field] = 0; continue; }
      const signed = ['marginRetail', 'marginWholesale'].includes(field);
      const scale = ['stock', 'minStock'].includes(field) ? 3 : (['cost', 'retailPrice', 'wholesalePrice'].includes(field) ? 2 : 4);
      const digits = scale === 2 ? 10 : (scale === 3 ? 9 : 3);
      if (typeof value[field] !== 'string' || !(signed ? /^-?\d+\.\d+$/ : /^\d+\.\d+$/).test(value[field]) || value[field].split('.')[1].length !== scale || !Number.isFinite(Number(value[field])) || Math.abs(Number(value[field])) >= 10 ** digits) throw new ApiError('INVALID_RESPONSE');
      result[field] = Number(value[field]);
    }
    if (!catalog && !/^[a-f0-9]{64}$/.test(value.revision || '')) throw new ApiError('INVALID_RESPONSE');
    return result;
  }
  class PosApiClient {
    #csrf = null;
    #ownerIdentity = null;
    #support = null;
    #pending = Promise.resolve();
    #effectiveBusinessId() { return this.#support?.businessId ?? this.#ownerIdentity?.businessId ?? null; }
    #requireSystemAdmin() {
      const current = this.#ownerIdentity;
      if (!current || current.username !== 'andres' || current.role !== 'ADMIN' || current.businessId !== '1') throw new ApiError('SYSTEM_ADMIN_REQUIRED', 403);
    }
    #acceptSession(value) {
      this.#csrf = value.csrfToken;
      this.#ownerIdentity = value.user;
      this.#support = value.support;
      return value;
    }
    constructor(baseUrl) {
      const url = new URL(baseUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/api')) throw new ApiError('INVALID_INPUT');
      this.baseUrl = url.href.replace(/\/$/, '');
    }
    async #request(path, method = 'GET', body, contentType = 'application/json', timeoutMs = 8000) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetch(this.baseUrl + path, { method, credentials: 'include', cache: 'no-store', redirect: 'error', signal: controller.signal,
          headers: method === 'GET' ? {} : { 'Content-Type': contentType, 'X-CSRF-Token': this.#csrf || '' },
          body: method === 'GET' ? undefined : (contentType === 'application/json' ? JSON.stringify(body ?? {}) : body) });
      } catch { throw new ApiError('NETWORK_ERROR'); } finally { clearTimeout(timer); }
      let data;
      if (response.status !== 204) {
        try { data = await response.json(); } catch { throw new ApiError('INVALID_RESPONSE', response.status); }
      }
      if (!response.ok) {
        const receivedCode = data?.error?.code;
        const code = typeof receivedCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(receivedCode) ? receivedCode : 'INTERNAL_ERROR';
        const error = new ApiError(code, response.status);
        const serverMessage = data?.error?.message;
        const businessDeleteCodes = ['BUSINESS_NOT_FOUND', 'BUSINESS_DELETE_PROTECTED', 'BUSINESS_DELETE_BLOCKED', 'BUSINESS_DELETE_SCHEMA_UNSUPPORTED', 'BUSINESS_DELETE_PREVIEW_REQUIRED', 'BUSINESS_DELETE_PREVIEW_STALE', 'BUSINESS_DELETE_CONFIRMATION_REQUIRED'];
        const businessPlanCodes = ['SYSTEM_ADMIN_BILLING_MIGRATION_REQUIRED', 'BUSINESS_PLAN_INVALID', 'BUSINESS_PLAN_SCHEMA_UNSUPPORTED', 'BUSINESS_PLAN_REQUIRED', 'BUSINESS_PLAN_STANDARD_MIGRATION_REQUIRED', 'BUSINESS_PLAN_USER_LIMIT_EXCEEDED', 'BUSINESS_PLAN_ADMIN_LIMIT_EXCEEDED', 'BUSINESS_PLAN_DOWNGRADE_BLOCKED', 'BUSINESS_PLAN_ACTIVATION_BLOCKED', 'BUSINESS_PLAN_NOT_MONTHLY', 'PAYMENT_AMOUNT_INVALID', 'PAYMENT_DATE_FUTURE'];
        if ((businessDeleteCodes.includes(code) || businessPlanCodes.includes(code)) && typeof serverMessage === 'string' && serverMessage.trim() && serverMessage.length <= 500 && !containsTechnicalMessage(serverMessage)) error.message = serverMessage.trim();
        // Los códigos desconocidos se conservan para diagnóstico, pero nunca se presentan al usuario.
        const details = data?.error?.details;
        const numericDetails = details && typeof details === 'object' && !Array.isArray(details) && Object.values(details).every(item => Number.isSafeInteger(item) && item >= 0) ? details : null;
        if (numericDetails && ['BUSINESS_PLAN_USER_LIMIT_EXCEEDED', 'BUSINESS_PLAN_DOWNGRADE_BLOCKED', 'BUSINESS_PLAN_ACTIVATION_BLOCKED'].includes(code) && Number.isSafeInteger(numericDetails.activeUsers) && Number.isSafeInteger(numericDetails.maximumUsers)) {
          const excess = Math.max(0, numericDetails.activeUsers - numericDetails.maximumUsers);
          error.message = code === 'BUSINESS_PLAN_USER_LIMIT_EXCEEDED'
            ? 'El negocio ya tiene ' + numericDetails.activeUsers + ' usuarios activos y el plan permite hasta ' + numericDetails.maximumUsers + '. No se creó ni reactivó la cuenta.'
            : 'El negocio tiene ' + numericDetails.activeUsers + ' usuarios activos y el plan permite hasta ' + numericDetails.maximumUsers + '. No se cambió el plan ni se desactivó a nadie.' + (excess ? ' Desactiva manualmente ' + excess + ' usuario(s) y vuelve a intentarlo.' : '');
        } else if (numericDetails && code === 'BUSINESS_PLAN_ADMIN_LIMIT_EXCEEDED' && Number.isSafeInteger(numericDetails.activeAdmins)) {
          error.message = 'El negocio tendría ' + numericDetails.activeAdmins + ' administradores activos y el límite es uno. No se realizó el cambio.';
        }
        if (numericDetails) error.details = numericDetails;
        error.field = data?.error?.field;
        if (error.code === 'TOO_MANY_ATTEMPTS') { error.retryAfter = Number(response.headers.get('Retry-After')) || 60; error.message = 'Demasiados intentos. Intenta nuevamente en ' + error.retryAfter + ' segundos.'; }
        throw error;
      }
      return data;
    }
    async csrf() {
      const value = await this.#request('/auth/csrf');
      if (!value || typeof value.csrfToken !== 'string' || !/^[A-Za-z0-9_.-]{43,200}$/.test(value.csrfToken)) throw new ApiError('INVALID_RESPONSE');
      this.#csrf = value.csrfToken;
    }
    #write(path, method, body, contentType = 'application/json', timeoutMs = 8000) {
      const operation = this.#pending.catch(() => {}).then(async () => {
        if (!this.#csrf) await this.csrf();
        try { return await this.#request(path, method, body, contentType, timeoutMs); }
        catch (error) {
          if (error.code !== 'CSRF_FAILED') throw error;
          if (this.#ownerIdentity) await this.me(); else await this.csrf();
          return this.#request(path, method, body, contentType, timeoutMs);
        }
      });
      this.#pending = operation.then(() => undefined, () => undefined);
      return operation;
    }
    #salesResult(value) {
      const record = value?.sale || value?.cash || value?.order || value?.movement || value?.payment || value?.supplierPayment || value?.purchase || value?.overview || value;
      if (record.businessId !== this.#effectiveBusinessId()) throw new ApiError('INVALID_RESPONSE');
      if (value.sale) {
        const sale = value.sale;
        const validInvoiceNumber = /^(?:\d{6,20}|MIG-(?:[A-Za-z0-9_-]{1,18}-)?[a-f0-9]{28})$/.test(sale.invoiceNumber || '');
        if (!/^[1-9]\d*$/.test(sale.id || '') || !validInvoiceNumber || !['COMPLETED', 'CANCELLED'].includes(sale.status) || !['CASH', 'CARD', 'TRANSFER', 'CREDIT'].includes(sale.paymentMethod) || !['NOT_APPLICABLE', 'PENDING', 'CONFIRMED'].includes(sale.cashStatus) || !Array.isArray(sale.items) || !Number.isFinite(Date.parse(sale.createdAt)) || !['subtotal','discount','total','tax'].every(field => /^\d+\.\d{2}$/.test(sale[field]))) throw new ApiError('INVALID_RESPONSE');
      }
      if (value.payment) { const payment = value.payment; if (!/^[1-9]\d*$/.test(payment.id || '') || !/^[1-9]\d*$/.test(payment.saleId || '') || !/^[1-9]\d*$/.test(payment.clientId || '') || payment.businessId !== this.#effectiveBusinessId() || !/^\d+\.\d{2}$/.test(payment.amount || '') || !['CASH','CARD','TRANSFER'].includes(payment.paymentMethod) || !['PENDING','POSTED'].includes(payment.status)) throw new ApiError('INVALID_RESPONSE'); }
      return value;
    }
    #cashRecord(value) {
      const amount = candidate => (typeof candidate === 'string' || typeof candidate === 'number') && Number.isFinite(Number(candidate));
      const originalSessionWasOpen = value?.isHistorical === true && value.status === 'CLOSED' && typeof value.sourceStatus === 'string' && /^(OPEN|ABIERTA|ABIERTO|ACTIVA|ACTIVO)$/i.test(value.sourceStatus.trim());
      const expectedAmountIsValid = amount(value?.expectedAmount) || (value?.expectedAmount === null && originalSessionWasOpen);
      if (!value || typeof value !== 'object' || value.businessId !== this.#effectiveBusinessId() || !/^[1-9]\d{0,19}$/.test(value.id || '') || !['OPEN', 'CLOSED'].includes(value.status) || !amount(value.openingAmount) || !expectedAmountIsValid || !Number.isFinite(Date.parse(value.openedAt)) || (value.closedAt !== null && value.closedAt !== undefined && !Number.isFinite(Date.parse(value.closedAt))) || (value.movements !== undefined && !Array.isArray(value.movements))) throw new ApiError('CASH_RESPONSE_INVALID');
      return value;
    }
    #cashOverview(value) {
      const arrays = ['salesByUser', 'operationSales', 'operationCollections', 'pendingPayments', 'pendingOrders', 'pendingHistoricalPayments', 'pendingHistoricalOrders', 'movements'];
      const amount = candidate => (typeof candidate === 'string' || typeof candidate === 'number') && Number.isFinite(Number(candidate));
      if (!value || typeof value !== 'object' || value.businessId !== this.#effectiveBusinessId() || !['DIRECT', 'CENTRALIZED'].includes(value.salesFlow) || !arrays.every(field => Array.isArray(value[field])) || !(value.currentCashSessionId === null || /^[1-9]\d{0,19}$/.test(value.currentCashSessionId || '')) || !['expectedAmount', 'customerCollections', 'lastDifference'].every(field => amount(value[field]))) throw new ApiError('CASH_RESPONSE_INVALID');
      return value;
    }
    #cashOperation(value, kind) {
      if (!value || value.kind !== kind || !value.cash) throw new ApiError('CASH_RESPONSE_INVALID');
      this.#cashRecord(value.cash);
      return value;
    }
    async nextInvoiceNumber() { const value = await this.#request('/sales/next-invoice'); if (value?.businessId !== this.#effectiveBusinessId() || !/^\d{6,20}$/.test(value.invoiceNumber || '')) throw new ApiError('INVALID_RESPONSE'); return value.invoiceNumber; }
    async quoteSale(data) { const value = await this.#write('/sales/quote', 'POST', data); if (!value?.quote || value.quote.businessId !== this.#effectiveBusinessId() || !/^[a-f0-9]{64}$/.test(value.quote.quoteToken) || !/^\d+\.\d{2}$/.test(value.quote.total) || !Array.isArray(value.quote.items)) throw new ApiError('INVALID_RESPONSE'); return value.quote; }
    async createSale(data) { return this.#salesResult(await this.#write('/sales','POST',data)); }
    async cancelSale(id,data) { return this.#salesResult(await this.#write('/sales/'+encodeURIComponent(id)+'/cancel','POST',data)); }
    async operation(key) { return this.#salesResult(await this.#request('/operations/'+encodeURIComponent(key))); }
    async resolveOperation(key) { return this.#salesResult(await this.#write('/operations/'+encodeURIComponent(key)+'/resolve','POST',{})); }
    async sales(offset=0,maxId=null) { const value=await this.#request('/sales?limit=100&offset='+offset+(maxId ? '&maxId='+encodeURIComponent(maxId) : '')); if(!Array.isArray(value?.sales)) throw new ApiError('INVALID_RESPONSE'); return value.sales.map(sale=>this.#salesResult({sale}).sale); }
    async historicalOrders(offset=0) { const value=await this.#request('/sales/orders/history?limit=100&offset='+offset); if(!Array.isArray(value?.orders)||value.orders.some(order=>order.businessId!==this.#effectiveBusinessId()||!order.isHistorical||!['PENDING','COMPLETED','CANCELLED'].includes(order.status)||!Array.isArray(order.items))) throw new ApiError('INVALID_RESPONSE'); return value.orders; }
    async sale(id) { const value = this.#salesResult(await this.#request('/sales/' + encodeURIComponent(id))); return value.sale; }
    async currentCash(full=false) { const value=await this.#request('/cash/current'+(full?'?full=true':'')); if(!value || !Object.prototype.hasOwnProperty.call(value, 'cash')) throw new ApiError('CASH_RESPONSE_INVALID'); if(value.cash===null) return null; return this.#cashRecord(value.cash); }
    async cashSessions(offset=0) { const value=await this.#request('/cash/sessions?limit=100&offset='+offset); if(!Array.isArray(value?.sessions)) throw new ApiError('CASH_RESPONSE_INVALID'); return value.sessions.map(cash=>this.#cashRecord(cash)); }
    async openCash(data) { return this.#cashOperation(await this.#write('/cash/sessions','POST',data), 'OPEN_CASH'); }
    async closeCash(id,data) { return this.#cashOperation(await this.#write('/cash/sessions/'+encodeURIComponent(id)+'/close','POST',data), 'CLOSE_CASH'); }
    async salesFlow() { const value=await this.#request('/business-settings/sales-flow'); if(value?.businessId!==this.#effectiveBusinessId()||!['DIRECT','CENTRALIZED'].includes(value.salesFlow)) throw new ApiError('INVALID_RESPONSE'); return value; }
    async setSalesFlow(salesFlow) { const value=await this.#write('/business-settings/sales-flow','PUT',{salesFlow}); if(value?.businessId!==this.#effectiveBusinessId()||value.salesFlow!==salesFlow) throw new ApiError('INVALID_RESPONSE'); return value; }
    #businessSettings(value) {
      const businessId = this.#effectiveBusinessId();
      const strings = ['businessName','legalName','ruc','phone','address','invoicePrefix','ticketHeader','ticketFooter'];
      if (!value || value.businessId !== businessId || !/^[1-9]\d{0,19}$/.test(value.businessId || '') || value.currency !== 'C$' || typeof value.hasStoredSettings !== 'boolean' || typeof value.schemaReady !== 'boolean' || !strings.every(field => typeof value[field] === 'string') || !['retailMarginDefault','wholesaleMarginDefault','minStockDefault','taxRateDefault'].every(field => Number.isFinite(Number(value[field]))) || !(value.logo === null || typeof value.logo === 'string')) throw new ApiError('INVALID_RESPONSE');
      if (value.logo !== null) {
        const match = /^\/api\/product-images\/([1-9]\d{0,19})\/[a-f0-9]{32}\.jpg$/.exec(value.logo);
        if (!match || match[1] !== businessId) throw new ApiError('INVALID_RESPONSE');
      }
      return value;
    }
    async businessSettings() { return this.#businessSettings(await this.#request('/business-settings')); }
    async updateBusinessSettings(data) { return this.#businessSettings(await this.#write('/business-settings','PUT',data)); }
    async importLegacyBusinessSettings(data) { return this.#businessSettings(await this.#write('/business-settings/import-legacy','POST',data)); }
    async uploadBusinessLogo(file) {
      if (!(file instanceof Blob) || !['image/jpeg','image/png','image/webp'].includes(file.type) || file.size < 1 || file.size > 8 * 1024 * 1024) throw new ApiError('IMAGE_FORMAT_INVALID', 400);
      return this.#businessSettings(await this.#write('/business-settings/logo','POST',file,file.type));
    }
    assetUrl(reference) {
      const match = typeof reference === 'string' && /^\/api\/product-images\/([1-9]\d{0,19})\/[a-f0-9]{32}\.jpg$/.exec(reference);
      const base = new URL(this.baseUrl);
      if (!match || match[1] !== this.#effectiveBusinessId()) throw new ApiError('INVALID_RESPONSE');
      const url = new URL(reference, base);
      if (url.origin !== base.origin) throw new ApiError('INVALID_RESPONSE');
      return url.href;
    }
    async cashOverview() { const value=await this.#request('/cash/overview'); if(!value?.overview) throw new ApiError('CASH_RESPONSE_INVALID'); return this.#cashOverview(value.overview); }
    async connectedReport(from = null, until = null) {
      const query = new URLSearchParams();
      if (from) query.set('from', from);
      if (until) query.set('until', until);
      const queryString = query.toString();
      const value = await this.#request('/reports/connected' + (queryString ? '?' + queryString : ''));
      const report = value?.report;
      const moneyValue = candidate => typeof candidate === 'string' && /^-?\d{1,10}\.\d{2}$/.test(candidate);
      if (report?.businessId !== this.#effectiveBusinessId() || !report.sales || !report.cash || !report.inventory || !report.receivables || !report.expenses || !report.purchases || !report.payables || !report.suppliers || !moneyValue(report.sales.total) || !moneyValue(report.sales.cost) || !moneyValue(report.sales.grossProfit) || !moneyValue(report.sales.netProfit) || !moneyValue(report.expenses.total) || !Number.isSafeInteger(report.expenses.count) || !Array.isArray(report.expenses.byCategory) || !Array.isArray(report.expenses.history) || !Array.isArray(report.inventory.movements) || !moneyValue(report.cash.periodIn) || !moneyValue(report.cash.periodOut) || !(report.cash.currentExpected === null || moneyValue(report.cash.currentExpected)) || !Array.isArray(report.sales.history) || !Array.isArray(report.sales.paymentMethods) || !Array.isArray(report.sales.sellers) || !Array.isArray(report.sales.topProducts) || !Array.isArray(report.cash.closures) || !Array.isArray(report.cash.movements) || !Array.isArray(report.inventory.products) || !Array.isArray(report.receivables.clients) || !Array.isArray(report.receivables.payments) || !moneyValue(report.purchases.total) || !Array.isArray(report.purchases.history) || !moneyValue(report.payables.balance) || !moneyValue(report.payables.pendingPayments) || !Array.isArray(report.payables.invoices) || !Array.isArray(report.suppliers.list) || !Array.isArray(report.suppliers.payments)) throw new ApiError('INVALID_RESPONSE');
      return report;
    }
    async confirmPayment(id,data) {
      const value = this.#salesResult(await this.#write('/cash/payments/'+encodeURIComponent(id)+'/confirm','POST',data));
      if (value?.kind !== 'CONFIRM_PAYMENT' || value.movement?.businessId !== this.#effectiveBusinessId() || value.movement.id !== String(id) || value.movement.status !== 'CONFIRMED' || !['CARD','TRANSFER'].includes(value.movement.paymentMethod)) throw new ApiError('INVALID_RESPONSE');
      if (value.supplierPayment && (value.supplierPayment.businessId !== this.#effectiveBusinessId() || !/^[1-9]\d*$/.test(value.supplierPayment.id || '') || value.supplierPayment.status !== 'POSTED' || !['CARD','TRANSFER'].includes(value.supplierPayment.paymentMethod))) throw new ApiError('INVALID_RESPONSE');
      return value;
    }
    async prepareOrder(data) { return this.#salesResult(await this.#write('/sales/orders','POST',data)); }
    async quoteOrder(id,paymentMethod) { const value=await this.#write('/cash/orders/'+encodeURIComponent(id)+'/quote','POST',{paymentMethod}); if(!value?.quote||value.quote.businessId!==this.#effectiveBusinessId()||value.quote.orderId!==String(id)||!/^[a-f0-9]{64}$/.test(value.quote.quoteToken)||!/^\d+\.\d{2}$/.test(value.quote.total)||!/^\d+\.\d{2}$/.test(value.quote.estimatedTotal)) throw new ApiError('INVALID_RESPONSE'); return value.quote; }
    async chargeOrder(id,data) { return this.#salesResult(await this.#write('/cash/orders/'+encodeURIComponent(id)+'/charge','POST',data)); }
    async cancelOrder(id,data) { return this.#salesResult(await this.#write('/cash/orders/'+encodeURIComponent(id)+'/cancel','POST',data)); }
    async uploadImage(file) {
      const value = await this.#write('/product-images','POST',file,file.type);
      const match = typeof value?.image === 'string' && /^\/api\/product-images\/([1-9]\d{0,19})\/[a-f0-9]{32}\.jpg$/.exec(value.image);
      if (!match || match[1] !== value.businessId || value.businessId !== this.#effectiveBusinessId()) throw new ApiError('INVALID_RESPONSE');
      return value.image;
    }
    async products(catalog = false, offset = 0) {
      const value = await this.#request((catalog ? '/catalog/products' : '/products') + '?limit=100&offset=' + encodeURIComponent(offset));
      if (!Array.isArray(value?.products) || value.products.length > 100) throw new ApiError('INVALID_RESPONSE');
      return value.products.map(item => product(item, catalog, this.baseUrl));
    }
    async product(id) { const value = await this.#request('/products/' + encodeURIComponent(id)); return product(value?.product, false, this.baseUrl); }
    async createProduct(data) { const value = await this.#write('/products', 'POST', data); return product(value?.product, false, this.baseUrl); }
    async updateProduct(id, data) { const value = await this.#write('/products/' + encodeURIComponent(id), 'PATCH', data); return product(value?.product, false, this.baseUrl); }
    async adjustProduct(id, data) { const value = await this.#write('/products/' + encodeURIComponent(id) + '/movements', 'POST', data); return product(value?.product, false, this.baseUrl); }
    async movements(id, offset = 0, maxId = null) {
      const value = await this.#request('/inventory/movements?limit=100&offset=' + encodeURIComponent(offset) + '&productId=' + encodeURIComponent(id) + (maxId ? '&maxId=' + encodeURIComponent(maxId) : ''));
      if (!Array.isArray(value?.movements) || value.movements.length > 100) throw new ApiError('INVALID_RESPONSE');
      return value.movements.map(item => {
        if (!/^[1-9]\d{0,19}$/.test(item.id || '') || !/^[1-9]\d{0,19}$/.test(item.businessId || '') || item.productId !== String(id) || !(item.userId === null || /^[1-9]\d{0,19}$/.test(item.userId)) || typeof item.userName !== 'string' || !['PURCHASE', 'SALE', 'WASTE', 'ADJUSTMENT', 'SALE_CANCEL', 'PURCHASE_CANCEL', 'INITIAL', 'MANUAL_EDIT'].includes(item.type) || typeof item.reason !== 'string' || !Number.isFinite(Date.parse(item.createdAt)) || !/^-?\d+\.\d{3}$/.test(item.quantity || '') || !(item.stockAfter === null || /^\d+\.\d{3}$/.test(item.stockAfter)) || !(item.unitCost === null || /^\d+\.\d{2}$/.test(item.unitCost))) throw new ApiError('INVALID_RESPONSE');
        return { ...item, quantity: Number(item.quantity), stockAfter: item.stockAfter === null ? null : Number(item.stockAfter), unitCost: Number(item.unitCost || 0) };
      });
    }
    async login(username, password) {
      try { await this.me(); await this.logout(); } catch (error) {
        if (!['INVALID_SESSION', 'SUPPORT_BUSINESS_UNAVAILABLE', 'INVALID_SUPPORT_SESSION', 'SUPPORT_OWNER_SESSION_INVALID'].includes(error.code)) throw error;
        this.#csrf = null;
        await this.csrf();
        try { await this.#write('/admin/support-session/end', 'POST', {}); }
        catch (recoveryError) { if (!['INVALID_SESSION', 'SYSTEM_ADMIN_REQUIRED'].includes(recoveryError.code)) throw recoveryError; }
        try { await this.#write('/auth/logout', 'POST', {}); }
        catch (recoveryError) { if (!['INVALID_SESSION', 'SYSTEM_ADMIN_REQUIRED'].includes(recoveryError.code)) throw recoveryError; }
      }
      this.#csrf = null; this.#ownerIdentity = null; this.#support = null;
      return this.#acceptSession(session(await this.#write('/auth/login', 'POST', { username, password })));
    }
    async me() {
      const value = session(await this.#request('/auth/me'));
      if (this.#ownerIdentity && (this.#ownerIdentity.id !== value.user.id || this.#ownerIdentity.businessId !== value.user.businessId)) throw new ApiError('INVALID_SESSION', 401);
      return this.#acceptSession(value);
    }
    async logout() { await this.#write('/auth/logout', 'POST', {}); this.#csrf = null; this.#ownerIdentity = null; this.#support = null; }
    async renew() { return this.#acceptSession(session(await this.#write('/auth/renew', 'POST', {}))); }
    async enter(module) {
      const value = await this.#write('/auth/modules/' + encodeURIComponent(module) + '/enter', 'POST', {});
      if (value?.module !== module || value.allowed !== true) throw new ApiError('INVALID_RESPONSE');
      const current = session(value);
      if (this.#ownerIdentity && (this.#ownerIdentity.id !== current.user.id || this.#ownerIdentity.businessId !== current.user.businessId)) throw new ApiError('INVALID_SESSION', 401);
      this.#acceptSession(current);
      return { ...current, module, allowed: true };
    }
    async access(module) { const value = await this.#request('/auth/access/' + encodeURIComponent(module)); if (value?.module !== module || value.allowed !== true) throw new ApiError('INVALID_RESPONSE'); return value; }
    async authorize(module, adminUsername, adminPassword) {
      const value = await this.#write('/auth/authorizations', 'POST', { module, adminUsername, adminPassword });
      if (value?.module !== module || !Number.isFinite(Date.parse(value.expiresAt)) || !/^[1-9]\d*$/.test(value.grantedByUserId)) throw new ApiError('INVALID_RESPONSE'); return value;
    }
    leave(module) { return this.#write('/auth/authorizations/' + encodeURIComponent(module), 'DELETE', {}); }
    async creditClients(offset = 0, q = '') { const value = await this.#request('/sales/clients?limit=100&offset=' + encodeURIComponent(offset) + (q ? '&q=' + encodeURIComponent(q) : '')); if (!Array.isArray(value?.clients) || value.clients.length > 100) throw new ApiError('INVALID_RESPONSE'); return value.clients; }
    async clients(offset = 0, q = '') {
      const value = await this.#request('/clients?limit=100&offset=' + encodeURIComponent(offset) + (q ? '&q=' + encodeURIComponent(q) : ''));
      if (!Array.isArray(value?.clients) || value.clients.length > 100) throw new ApiError('INVALID_RESPONSE');
      return value.clients.map(item => {
        if (!/^[1-9]\d{0,19}$/.test(item.id || '') || item.businessId !== this.#effectiveBusinessId() || typeof item.name !== 'string' || typeof item.active !== 'boolean' || !Number.isInteger(item.creditDays) || item.creditDays < 1 || item.creditDays > 3650 || !['creditLimit','debt','availableCredit','pendingPayments'].every(key => /^-?\d+\.\d{2}$/.test(item[key] || ''))) throw new ApiError('INVALID_RESPONSE');
        return item;
      });
    }
    async createClient(data) { const value = await this.#write('/clients', 'POST', data); if (value?.client?.businessId !== this.#effectiveBusinessId()) throw new ApiError('INVALID_RESPONSE'); return value.client; }
    async updateClient(id, data) { const value = await this.#write('/clients/' + encodeURIComponent(id), 'PATCH', data); if (value?.client?.businessId !== this.#effectiveBusinessId()) throw new ApiError('INVALID_RESPONSE'); return value.client; }
    async setClientActive(id, active) { const value = await this.#write('/clients/' + encodeURIComponent(id) + '/active', 'PATCH', { active }); if (value?.businessId !== this.#effectiveBusinessId() || value.id !== String(id) || value.active !== active) throw new ApiError('INVALID_RESPONSE'); return value; }
    async receivables(offset = 0, q = '') {
      const value = await this.#request('/receivables?limit=100&offset=' + encodeURIComponent(offset) + (q ? '&q=' + encodeURIComponent(q) : ''));
      if (!Array.isArray(value?.receivables) || value.receivables.length > 100) throw new ApiError('INVALID_RESPONSE');
      for (const item of value.receivables) if (item.businessId !== this.#effectiveBusinessId() || !['OPEN','OVERDUE','PAID','CANCELLED','PENDING_CONFIRMATION'].includes(item.status)) throw new ApiError('INVALID_RESPONSE');
      return value.receivables;
    }
    async clientStatement(id) { const value = await this.#request('/clients/' + encodeURIComponent(id) + '/statement?limit=100&offset=0'); if (value?.client?.businessId !== this.#effectiveBusinessId() || !Array.isArray(value.invoices) || !Array.isArray(value.payments)) throw new ApiError('INVALID_RESPONSE'); return value; }
    async payReceivable(id, data) { return this.#salesResult(await this.#write('/receivables/' + encodeURIComponent(id) + '/payments', 'POST', data)); }
    async expenses(offset = 0, q = '') { const value = await this.#request('/expenses?limit=100&offset=' + encodeURIComponent(offset) + (q ? '&q=' + encodeURIComponent(q) : '')); if (!Array.isArray(value?.expenses) || value.expenses.length > 100 || value?.summary?.businessId !== this.#effectiveBusinessId() || !['total', 'today'].every(key => /^\d+\.\d{2}$/.test(value.summary[key] || '')) || !Number.isSafeInteger(value.summary.count)) throw new ApiError('INVALID_RESPONSE'); return value; }
    async resolveFinancialOperation(key, kind) {
      const value = await this.#write('/financial/operations/' + encodeURIComponent(key) + '/resolve', 'POST', { kind });
      const record = value?.purchase || value?.expense || value?.payment || value?.movement || value;
      if (record?.businessId !== this.#effectiveBusinessId() || !['PURCHASE', 'CANCEL_PURCHASE', 'EXPENSE', 'SUPPLIER_PAYMENT', 'CUSTOMER_PAYMENT_VOID', 'SUPPLIER_PAYMENT_VOID', 'CASH_MANUAL', 'ABANDONED'].includes(value?.kind)) throw new ApiError('INVALID_RESPONSE');
      if (value.kind === 'ABANDONED') {
        if (value.operationKind !== kind) throw new ApiError('INVALID_RESPONSE');
      } else {
        if (value.kind !== (kind === 'CANCEL_EXPENSE' ? 'EXPENSE' : kind) || !/^[1-9]\d{0,19}$/.test(record.id || '')) throw new ApiError('INVALID_RESPONSE');
        if (value.purchase && (!Array.isArray(record.items) || !['COMPLETED', 'CANCELLED'].includes(record.purchaseStatus) || !['OPEN', 'PARTIAL', 'PAID', 'OVERDUE', 'PENDING_CONFIRMATION', 'CANCELLED'].includes(record.status) || !/^\d+\.\d{2}$/.test(record.total || ''))) throw new ApiError('INVALID_RESPONSE');
        if (!value.purchase && (!/^\d+\.\d{2}$/.test(record.amount || '') || !['POSTED', 'PENDING', 'VOID', 'CONFIRMED'].includes(record.status))) throw new ApiError('INVALID_RESPONSE');
      }
      return value;
    }
    async manualCashMovement(data) {
      const value = await this.#write('/financial/cash/movements', 'POST', data);
      if (value?.kind !== 'CASH_MANUAL' || value.movement?.businessId !== this.#effectiveBusinessId() || !/^[1-9]\d{0,19}$/.test(value.movement.id || '') || !['MANUAL_ENTRY', 'MANUAL_EXIT'].includes(value.movement.type) || !/^\d+\.\d{2}$/.test(value.expectedAmount || '')) throw new ApiError('INVALID_RESPONSE');
      return value;
    }
    async reverseFinancialPayment(type, id, data) {
      if (!['customer', 'supplier'].includes(type)) throw new ApiError('INVALID_INPUT');
      const value = await this.#write('/financial/' + type + '-payments/' + encodeURIComponent(id) + '/reverse', 'POST', data);
      if (value?.kind !== (type === 'customer' ? 'CUSTOMER_PAYMENT_VOID' : 'SUPPLIER_PAYMENT_VOID') || value.payment?.businessId !== this.#effectiveBusinessId() || value.payment.id !== String(id) || value.payment.status !== 'VOID') throw new ApiError('INVALID_RESPONSE');
      return value;
    }
    async createExpense(data) { const value = await this.#write('/expenses', 'POST', data); if (value?.kind !== 'EXPENSE' || value.expense?.businessId !== this.#effectiveBusinessId() || !/^[1-9]\d*$/.test(value.expense.id || '') || !/^\d+\.\d{2}$/.test(value.expense.amount || '')) throw new ApiError('INVALID_RESPONSE'); return value.expense; }
    async cancelExpense(id, data) { const value = await this.#write('/expenses/' + encodeURIComponent(id) + '/cancel', 'POST', data); if (value?.kind !== 'EXPENSE' || value.expense?.businessId !== this.#effectiveBusinessId() || value.expense.id !== String(id) || value.expense.status !== 'VOID') throw new ApiError('INVALID_RESPONSE'); return value.expense; }
    async suppliers(offset = 0, q = '') {
      const value = await this.#request('/suppliers?limit=100&offset=' + encodeURIComponent(offset) + (q ? '&q=' + encodeURIComponent(q) : ''));
      if (!Array.isArray(value?.suppliers) || value.suppliers.length > 100) throw new ApiError('INVALID_RESPONSE');
      return value.suppliers.map(item => {
        if (!/^[1-9]\d{0,19}$/.test(item.id || '') || item.businessId !== this.#effectiveBusinessId() || typeof item.name !== 'string' || typeof item.active !== 'boolean' || !['totalPurchased', 'debt', 'pendingPayments'].every(key => /^-?\d+\.\d{2}$/.test(item[key] || ''))) throw new ApiError('INVALID_RESPONSE');
        return item;
      });
    }
    async createSupplier(data) { const value = await this.#write('/suppliers', 'POST', data); if (value?.supplier?.businessId !== this.#effectiveBusinessId()) throw new ApiError('INVALID_RESPONSE'); return value.supplier; }
    async purchaseSuppliers(offset = 0, q = '') {
      const value = await this.#request('/purchases/suppliers?limit=100&offset=' + encodeURIComponent(offset) + (q ? '&q=' + encodeURIComponent(q) : ''));
      if (!Array.isArray(value?.suppliers) || value.suppliers.length > 100) throw new ApiError('INVALID_RESPONSE');
      return value.suppliers.map(item => {
        if (!/^[1-9]\d{0,19}$/.test(item.id || '') || item.businessId !== this.#effectiveBusinessId() || typeof item.name !== 'string' || typeof item.active !== 'boolean') throw new ApiError('INVALID_RESPONSE');
        return item;
      });
    }
    async createPurchaseSupplier(data) { const value = await this.#write('/purchases/suppliers', 'POST', data); if (value?.supplier?.businessId !== this.#effectiveBusinessId()) throw new ApiError('INVALID_RESPONSE'); return value.supplier; }
    async updateSupplier(id, data) { const value = await this.#write('/suppliers/' + encodeURIComponent(id), 'PATCH', data); if (value?.supplier?.businessId !== this.#effectiveBusinessId() || value.supplier.id !== String(id)) throw new ApiError('INVALID_RESPONSE'); return value.supplier; }
    async setSupplierActive(id, active) { const value = await this.#write('/suppliers/' + encodeURIComponent(id) + '/active', 'PATCH', { active }); if (value?.businessId !== this.#effectiveBusinessId() || value.id !== String(id) || value.active !== active) throw new ApiError('INVALID_RESPONSE'); return value; }
    async supplierStatement(id) {
      const value = await this.#request('/suppliers/' + encodeURIComponent(id) + '/statement?limit=100&offset=0');
      const moneyValue = candidate => typeof candidate === 'string' && /^\d+\.\d{2}$/.test(candidate);
      const runningBalanceValue = candidate => typeof candidate === 'string' && /^-?\d+\.\d{2}$/.test(candidate);
      if (value?.supplier?.businessId !== this.#effectiveBusinessId() || !Array.isArray(value.entries) || value.entries.some(entry => {
        if (!entry || !runningBalanceValue(entry.runningBalance)) return true;
        if (entry.kind !== 'PURCHASE') return entry.kind !== 'PAYMENT';
        return typeof entry.purchaseId !== 'string' || !['CREDIT', 'CASH'].includes(entry.purchaseType) || typeof entry.status !== 'string' ||
          !['total', 'paidConfirmed', 'pendingPayments', 'balance', 'availableBalance'].every(key => moneyValue(entry[key])) || typeof entry.canPay !== 'boolean';
      })) throw new ApiError('INVALID_RESPONSE');
      return value;
    }
    async purchaseProducts(offset = 0, q = '') {
      const value = await this.#request('/purchases/products?limit=100&offset=' + encodeURIComponent(offset) + (q ? '&q=' + encodeURIComponent(q) : ''));
      if (!Array.isArray(value?.products) || value.products.length > 100) throw new ApiError('INVALID_RESPONSE');
      return value.products.map(item => {
        if (!/^[1-9]\d{0,19}$/.test(item.id || '') || item.businessId !== this.#effectiveBusinessId() || typeof item.name !== 'string' || !['cost', 'marginRetail', 'marginWholesale', 'retailPrice', 'wholesalePrice', 'stock'].every(field => Number.isFinite(Number(item[field])))) throw new ApiError('INVALID_RESPONSE');
        return { ...item, business_id: item.businessId, deleted: false };
      });
    }
    async createPurchaseProduct(data) { const value = await this.#write('/purchases/products', 'POST', data); if (value?.product?.businessId !== this.#effectiveBusinessId() || !/^[1-9]\d{0,19}$/.test(value.product.id || '')) throw new ApiError('INVALID_RESPONSE'); return value.product; }
    async purchases(offset = 0, q = '') { const value = await this.#request('/purchases?limit=100&offset=' + encodeURIComponent(offset) + (q ? '&q=' + encodeURIComponent(q) : '')); if (!Array.isArray(value?.purchases) || value.purchases.length > 100) throw new ApiError('INVALID_RESPONSE'); return value.purchases; }
    async purchase(id) { const value = await this.#request('/purchases/' + encodeURIComponent(id)); if (value?.purchase?.businessId !== this.#effectiveBusinessId() || !Array.isArray(value.purchase.items)) throw new ApiError('INVALID_RESPONSE'); return value.purchase; }
    async createPurchase(data) { const value = this.#salesResult(await this.#write('/purchases', 'POST', data)); if (value?.purchase?.businessId !== this.#effectiveBusinessId()) throw new ApiError('INVALID_RESPONSE'); return value.purchase; }
    async updatePurchase(id, data) { const value = this.#salesResult(await this.#write('/purchases/' + encodeURIComponent(id), 'PATCH', data)); if (value?.kind !== 'EDIT_PURCHASE' || value.purchase?.businessId !== this.#effectiveBusinessId() || value.purchase.id !== String(id) || !Array.isArray(value.purchase.items)) throw new ApiError('INVALID_RESPONSE'); return value; }
    async cancelPurchase(id, data) { const value = this.#salesResult(await this.#write('/purchases/' + encodeURIComponent(id) + '/cancel', 'POST', data)); if (value?.purchase?.businessId !== this.#effectiveBusinessId() || value.purchase.status !== 'CANCELLED') throw new ApiError('INVALID_RESPONSE'); return value.purchase; }
    async payables(offset = 0, q = '') { const value = await this.#request('/payables?limit=100&offset=' + encodeURIComponent(offset) + (q ? '&q=' + encodeURIComponent(q) : '')); if (!Array.isArray(value?.payables) || value.payables.length > 100) throw new ApiError('INVALID_RESPONSE'); return value.payables; }
    async payable(id) { const value = await this.#request('/payables/' + encodeURIComponent(id)); if (value?.purchase?.businessId !== this.#effectiveBusinessId() || value.purchase.purchaseType !== 'CREDIT' || !Array.isArray(value.purchase.items)) throw new ApiError('INVALID_RESPONSE'); return value.purchase; }
    async payablesSummary() { const value = await this.#request('/payables/summary'); if (value?.summary?.businessId !== this.#effectiveBusinessId() || !/^\d+\.\d{2}$/.test(value.summary.balance || '') || !/^\d+\.\d{2}$/.test(value.summary.pendingPayments || '')) throw new ApiError('INVALID_RESPONSE'); return value.summary; }
    async paySupplierInvoice(id, data) { const value = await this.#write('/payables/' + encodeURIComponent(id) + '/payments', 'POST', data); if (value?.payment?.businessId !== this.#effectiveBusinessId() || value.payment.purchaseId !== String(id) || !['CASH', 'CARD', 'TRANSFER', 'OTHER'].includes(value.payment.paymentMethod) || !['PENDING', 'POSTED'].includes(value.payment.status)) throw new ApiError('INVALID_RESPONSE'); return value.payment; }
    async users(offset = 0) {
      const value = await this.#request('/users?limit=100&offset=' + encodeURIComponent(offset));
      if (!Array.isArray(value?.users)) throw new ApiError('INVALID_RESPONSE');
      const users = value.users.map(item => {
        const validated = user({ ...item, active: true });
        if (typeof item.active !== 'boolean') throw new ApiError('INVALID_RESPONSE');
        return { ...validated, active: item.active };
      });
      const capacity = value.capacity;
      if (!capacity || !(capacity.planCode === null || ['LOCAL', 'CONECTADO_BASICO', 'CONECTADO_ESTANDAR', 'CONECTADO_PREMIUM'].includes(capacity.planCode)) || typeof capacity.planName !== 'string' || !Number.isSafeInteger(capacity.activeUsers) || !Number.isSafeInteger(capacity.inactiveUsers) || !Number.isSafeInteger(capacity.activeAdmins) || !(capacity.maximumUsers === null || Number.isSafeInteger(capacity.maximumUsers)) || !(capacity.availableUsers === null || Number.isSafeInteger(capacity.availableUsers))) throw new ApiError('INVALID_RESPONSE');
      return { users, capacity };
    }
    async createUser(data) { const value = await this.#write('/users', 'POST', data); return user(value?.user); }
    async updateUser(id, data) { const value = await this.#write('/users/' + encodeURIComponent(id), 'PATCH', data); if (typeof value?.user?.active !== 'boolean') throw new ApiError('INVALID_RESPONSE'); return { ...user({ ...value.user, active: true }), active: value.user.active }; }
    password(id, password) { return this.#write('/users/' + encodeURIComponent(id) + '/password', 'PUT', { password }); }
    async startSupportSession(businessId) {
      this.#requireSystemAdmin();
      if (typeof businessId !== 'string' || !/^[1-9]\d{0,19}$/.test(businessId)) throw new ApiError('INVALID_INPUT');
      const value = await this.#write('/admin/support-session', 'POST', { businessId });
      const support = supportContext(value?.support);
      if (support.businessId !== businessId || Date.parse(support.expiresAt) <= Date.now()) throw new ApiError('INVALID_RESPONSE');
      this.#support = support;
      return support;
    }
    async endSupportSession() {
      this.#requireSystemAdmin();
      await this.#write('/admin/support-session/end', 'POST', {});
      this.#support = null;
      await this.me();
    }
    async adminBilling() {
      this.#requireSystemAdmin();
      const value = await this.#request('/admin/billing');
      const planCodes = ['LOCAL', 'CONECTADO_BASICO', 'CONECTADO_ESTANDAR', 'CONECTADO_PREMIUM'];
      const statuses = ['UNASSIGNED', 'NOT_APPLICABLE', 'DATE_PENDING', 'OVERDUE', 'DUE_TODAY', 'DUE_SOON', 'CURRENT'];
      const summaryFields = ['activeBusinesses', 'localPlans', 'monthlyPlans', 'paymentsDueSoon', 'paymentsOverdue', 'unassignedPlans'];
      const date = candidate => candidate === null || /^\d{4}-\d{2}-\d{2}$/.test(candidate || '');
      if (!value || !Array.isArray(value.plans) || !Array.isArray(value.businesses) || !value.summary || !summaryFields.every(key => Number.isSafeInteger(value.summary[key]) && value.summary[key] >= 0) || !date(value.today)) throw new ApiError('INVALID_RESPONSE');
      const planLimits = { LOCAL: 1, CONECTADO_BASICO: 3, CONECTADO_ESTANDAR: 5, CONECTADO_PREMIUM: 10 };
      if (value.plans.length !== 4 || !value.plans.every(plan => planCodes.includes(plan.code) && typeof plan.name === 'string' && typeof plan.monthly === 'boolean' && typeof plan.reminders === 'boolean' && plan.includedUsers === planLimits[plan.code])) throw new ApiError('INVALID_RESPONSE');
      for (const business of value.businesses) {
        if (!/^[1-9]\d{0,19}$/.test(business.id || '') || typeof business.name !== 'string' || !['ACTIVE', 'INACTIVE'].includes(business.status) || !['NOT_REQUIRED', 'PENDING', 'COMPLETE'].includes(business.migrationState) || !Number.isSafeInteger(business.userCount) || !Number.isSafeInteger(business.activeUserCount) || !Number.isSafeInteger(business.inactiveUserCount) || !Number.isSafeInteger(business.activeAdminCount) || !(business.planCode === null || planCodes.includes(business.planCode)) || typeof business.planName !== 'string' || typeof business.monthly !== 'boolean' || !date(business.nextDueDate) || !statuses.includes(business.paymentStatus) || !(business.lastPayment === null || (date(business.lastPayment.date) && /^\d+\.\d{2}$/.test(business.lastPayment.amount || '')))) throw new ApiError('INVALID_RESPONSE');
      }
      const reminder = value.reminder;
      if (reminder !== null && (!reminder || !/^[1-9]\d{0,19}$/.test(reminder.businessId || '') || typeof reminder.businessName !== 'string' || !date(reminder.dueDate) || !Number.isSafeInteger(reminder.daysUntil) || reminder.daysUntil < 0 || reminder.daysUntil > 7)) throw new ApiError('INVALID_RESPONSE');
      return value;
    }
    async setAdminBusinessPlan(id, planCode, nextDueDate) {
      this.#requireSystemAdmin();
      if (typeof id !== 'string' || !/^[1-9]\d{0,19}$/.test(id) || !['LOCAL', 'CONECTADO_BASICO', 'CONECTADO_ESTANDAR', 'CONECTADO_PREMIUM'].includes(planCode) || !(nextDueDate === null || nextDueDate === '' || /^\d{4}-\d{2}-\d{2}$/.test(nextDueDate))) throw new ApiError('INVALID_INPUT');
      const value = await this.#write('/admin/businesses/' + encodeURIComponent(id) + '/plan', 'PATCH', { planCode, nextDueDate: nextDueDate || null });
      if (value?.subscription?.businessId !== id || value.subscription.planCode !== planCode || (planCode === 'LOCAL' && value.subscription.nextDueDate !== null) || (value.subscription.nextDueDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(value.subscription.nextDueDate))) throw new ApiError('INVALID_RESPONSE');
      return value.subscription;
    }
    async adminSubscriptionPayments(id) {
      this.#requireSystemAdmin();
      if (typeof id !== 'string' || !/^[1-9]\d{0,19}$/.test(id)) throw new ApiError('INVALID_INPUT');
      const value = await this.#request('/admin/businesses/' + encodeURIComponent(id) + '/payments');
      if (!Array.isArray(value?.payments) || !value.payments.every(payment => /^[1-9]\d{0,19}$/.test(payment.id || '') && /^\d+\.\d{2}$/.test(payment.amount || '') && /^\d{4}-\d{2}-\d{2}$/.test(payment.paymentDate || ''))) throw new ApiError('INVALID_RESPONSE');
      return value.payments;
    }
    async localLicenses(status = '') {
      this.#requireSystemAdmin();
      if (!['', 'PENDING', 'ACTIVE', 'REVOKED'].includes(status)) throw new ApiError('INVALID_INPUT');
      const value = await this.#request('/system-admin/local-licenses' + (status ? '?status=' + encodeURIComponent(status) : ''));
      if (!Array.isArray(value?.licenses) || value.licenses.length > 200) throw new ApiError('INVALID_RESPONSE');
      const activeLocalBusinessCount = value.activeLocalBusinessCount === undefined ? null : value.activeLocalBusinessCount;
      if (activeLocalBusinessCount !== null && (!Number.isSafeInteger(activeLocalBusinessCount) || activeLocalBusinessCount < 0)) throw new ApiError('INVALID_RESPONSE');
      const licenses = value.licenses.map(item => {
        if (!item || !/^[1-9]\d{0,19}$/.test(item.id || '') || typeof item.customerName !== 'string' ||
            !(item.customerReference === null || typeof item.customerReference === 'string') ||
            !['PENDING', 'ACTIVE', 'REVOKED'].includes(item.status) || !Number.isFinite(Date.parse(item.createdAt)) ||
            !(item.activatedAt === null || Number.isFinite(Date.parse(item.activatedAt))) ||
            !(item.revokedAt === null || Number.isFinite(Date.parse(item.revokedAt))) ||
            !Number.isSafeInteger(item.transferCount) || item.transferCount < 0) throw new ApiError('INVALID_RESPONSE');
        return item;
      });
      return { licenses, activeLocalBusinessCount };
    }
    async generateLocalLicense(customerName, customerReference = '') {
      this.#requireSystemAdmin();
      if (typeof customerName !== 'string' || customerName.trim().length < 2 || customerName.trim().length > 160 ||
          typeof customerReference !== 'string' || customerReference.trim().length > 120) throw new ApiError('INVALID_INPUT');
      const value = await this.#write('/system-admin/local-licenses', 'POST', {
        customerName: customerName.trim(), customerReference: customerReference.trim() || null
      });
      const license = value?.license;
      if (!license || !/^[1-9]\d{0,19}$/.test(license.id || '') || license.customerName !== customerName.trim() ||
          license.customerReference !== (customerReference.trim() || null) || license.status !== 'PENDING' ||
          !/^POSL-(?:[A-F0-9]{4}-){11}[A-F0-9]{4}$/.test(value.code || '')) throw new ApiError('INVALID_RESPONSE');
      return { license, code: value.code };
    }
    async revokeLocalLicense(id, reason) {
      this.#requireSystemAdmin();
      if (typeof id !== 'string' || !/^[1-9]\d{0,19}$/.test(id) || typeof reason !== 'string' || reason.trim().length < 10 || reason.trim().length > 500) throw new ApiError('INVALID_INPUT');
      const value = await this.#write('/system-admin/local-licenses/' + encodeURIComponent(id) + '/revoke', 'POST', { reason: reason.trim() });
      if (String(value?.id) !== id || value.status !== 'REVOKED') throw new ApiError('INVALID_RESPONSE');
      return value;
    }
    async transferLocalLicense(id) {
      this.#requireSystemAdmin();
      if (typeof id !== 'string' || !/^[1-9]\d{0,19}$/.test(id)) throw new ApiError('INVALID_INPUT');
      const value = await this.#write('/system-admin/local-licenses/' + encodeURIComponent(id) + '/transfer', 'POST', {});
      if (String(value?.id) !== id || value.status !== 'PENDING' || !Number.isSafeInteger(value.transferCount) || value.transferCount < 1) throw new ApiError('INVALID_RESPONSE');
      return value;
    }
    async recordAdminSubscriptionPayment(id, data) {
      this.#requireSystemAdmin();
      if (typeof id !== 'string' || !/^[1-9]\d{0,19}$/.test(id) || !data || typeof data.amount !== 'string' || !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(data.amount) || !/^\d{4}-\d{2}-\d{2}$/.test(data.paymentDate || '')) throw new ApiError('INVALID_INPUT');
      const value = await this.#write('/admin/businesses/' + encodeURIComponent(id) + '/payments', 'POST', data);
      if (!value?.payment || !/^[1-9]\d{0,19}$/.test(value.payment.id || '') || !/^\d+\.\d{2}$/.test(value.payment.amount || '') || value.payment.currency !== 'USD' || value.payment.paymentDate !== data.paymentDate || !value.subscription || value.subscription.businessId !== id || !/^\d{4}-\d{2}-\d{2}$/.test(value.subscription.nextDueDate || '')) throw new ApiError('INVALID_RESPONSE');
      return value;
    }
    async adminBusinesses() {
      this.#requireSystemAdmin();
      const value = await this.#request('/admin/businesses');
      if (!Array.isArray(value?.businesses)) throw new ApiError('INVALID_RESPONSE');
      return value.businesses.map(item => {
        if (!/^[1-9]\d{0,19}$/.test(item.id || '') || typeof item.name !== 'string' || !item.name.trim() || !['ACTIVE', 'INACTIVE'].includes(item.status) || !['NOT_REQUIRED', 'PENDING', 'COMPLETE'].includes(item.migrationState) || !Number.isSafeInteger(item.userCount) || item.userCount < 0) throw new ApiError('INVALID_RESPONSE');
        return item;
      });
    }
    async migrateBasic(targetBusinessId, packageValue, confirmSystemBusiness = false) {
      this.#requireSystemAdmin();
      if (typeof targetBusinessId !== 'string' || !/^[1-9]\d{0,19}$/.test(targetBusinessId) ||
          !packageValue || packageValue.type !== 'pos_local_migration_package' || ![1, 2].includes(packageValue.version) ||
          !packageValue.data || !Array.isArray(packageValue.data.products) ||
          !Array.isArray(packageValue.data.clients) || !Array.isArray(packageValue.data.suppliers) ||
          (targetBusinessId === '1' && confirmSystemBusiness !== true)) throw new ApiError('INVALID_INPUT');
      const fields = (records, allowed) => records.map(record => {
        if (!record || typeof record !== 'object' || Array.isArray(record)) return record;
        return Object.fromEntries(allowed.filter(key => Object.hasOwn(record, key)).map(key => [key, record[key]]));
      });
      const safePackage = {
        type: packageValue.type,
        version: packageValue.version,
        exportedAt: packageValue.exportedAt,
        business: { name: packageValue.business?.name },
        data: {
          products: fields(packageValue.data.products, ['barcode', 'codigo', 'code', 'name', 'nombre', 'category', 'categoria', 'cost', 'marginRetail', 'retailMargin', 'retail_margin', 'marginWholesale', 'wholesaleMargin', 'wholesale_margin', 'retailPrice', 'retail_price', 'retail', 'wholesalePrice', 'wholesale_price', 'wholesale', 'stock', 'minStock', 'min_stock', 'taxRate', 'tax_rate', 'active', 'deleted']).map((product, index) => ({
            ...product,
            ...(packageValue.data.products[index]?.image ? { image: 'omitted' } : {})
          })),
          clients: fields(packageValue.data.clients, ['name', 'nombre', 'phone', 'ruc', 'address', 'active']),
          suppliers: fields(packageValue.data.suppliers, ['name', 'nombre', 'contact', 'phone', 'ruc', 'address', 'active'])
        }
      };
      const value = await this.#write('/system-admin/migration/basic', 'POST', {
        targetBusinessId,
        package: safePackage,
        confirmSystemBusiness
      });
      const validCounts = counts => counts && ['products', 'clients', 'suppliers'].every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0);
      if (value?.ok !== true || !validCounts(value.created) || !validCounts(value.skipped) ||
          !Number.isSafeInteger(value.categoriesDetected) || value.categoriesDetected < 0 ||
          !Array.isArray(value.warnings) || !value.warnings.every(warning => typeof warning === 'string')) throw new ApiError('INVALID_RESPONSE');
      return value;
    }
    #safeInventoryMigrationPackage(packageValue) {
      if (!packageValue || packageValue.type !== 'pos_local_migration_package' || ![1, 2].includes(packageValue.version) ||
          !packageValue.business || typeof packageValue.business !== 'object' || Array.isArray(packageValue.business) ||
          !packageValue.data || !Array.isArray(packageValue.data.products) || packageValue.data.products.length > 50000 ||
          (packageValue.data.inventoryMovements !== undefined && (!Array.isArray(packageValue.data.inventoryMovements) || packageValue.data.inventoryMovements.length > 50000))) throw new ApiError('INVALID_INPUT');
      const fields = (records, allowed) => records.map(record => {
        if (!record || typeof record !== 'object' || Array.isArray(record)) return record;
        return Object.fromEntries(allowed.filter(key => Object.hasOwn(record, key)).map(key => [key, record[key]]));
      });
      return {
        type: packageValue.type,
        version: packageValue.version,
        exportedAt: packageValue.exportedAt,
        business: { name: packageValue.business.name },
        data: {
          products: fields(packageValue.data.products, ['barcode', 'codigo', 'code', 'name', 'nombre', 'cost', 'stock', 'active', 'deleted']),
          clients: [],
          suppliers: [],
          // El historial del paquete nunca se envía ni se copia; solo se usa el saldo del producto.
          inventoryMovements: []
        }
      };
    }
    async previewInventoryMigration(targetBusinessId, packageValue) {
      this.#requireSystemAdmin();
      if (typeof targetBusinessId !== 'string' || !/^[1-9]\d{0,19}$/.test(targetBusinessId)) throw new ApiError('INVALID_INPUT');
      const safePackage = this.#safeInventoryMigrationPackage(packageValue);
      const value = await this.#write('/system-admin/migration/inventory/preview', 'POST', { targetBusinessId, package: safePackage });
      const counts = value?.products;
      if (value?.ok !== true || typeof value.eligible !== 'boolean' ||
          !counts || !['productsWithStock', 'productsWithoutStock', 'productsToSkip', 'inventoryMovementsToCreate'].every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0) ||
          !Array.isArray(value.warnings) || !value.warnings.every(warning => typeof warning === 'string')) throw new ApiError('INVALID_RESPONSE');
      return value;
    }
    async migrateInventory(targetBusinessId, packageValue) {
      this.#requireSystemAdmin();
      if (typeof targetBusinessId !== 'string' || !/^[1-9]\d{0,19}$/.test(targetBusinessId)) throw new ApiError('INVALID_INPUT');
      const safePackage = this.#safeInventoryMigrationPackage(packageValue);
      const value = await this.#write('/system-admin/migration/inventory', 'POST', { targetBusinessId, package: safePackage });
      const validCounts = counts => counts && Number.isSafeInteger(counts.inventoryMovements) && counts.inventoryMovements >= 0;
      if (value?.ok !== true || !validCounts(value.created) || !validCounts(value.skipped) ||
          !Array.isArray(value.warnings) || !value.warnings.every(warning => typeof warning === 'string')) throw new ApiError('INVALID_RESPONSE');
      return value;
    }
    #safeSalesMigrationPackage(packageValue, compact = false) {
      if (!packageValue || packageValue.type !== 'pos_local_migration_package' || ![1, 2].includes(packageValue.version) ||
          !packageValue.business || typeof packageValue.business !== 'object' || Array.isArray(packageValue.business) ||
          !packageValue.data || !Array.isArray(packageValue.data.products) || packageValue.data.products.length > 50000 ||
          !Array.isArray(packageValue.data.clients) || packageValue.data.clients.length > 50000 ||
          !Array.isArray(packageValue.data.sales) || packageValue.data.sales.length > 50000) throw new ApiError('INVALID_INPUT');
      const fields = (records, allowed) => records.map(record => {
        if (!record || typeof record !== 'object' || Array.isArray(record)) return record;
        return Object.fromEntries(allowed.filter(key => Object.hasOwn(record, key)).map(key => [key, record[key]]));
      });
      if (compact) {
        const valueFor = (record, aliases) => {
          for (const key of aliases) if (record && record[key] !== undefined && record[key] !== null && record[key] !== '') return record[key];
          return undefined;
        };
        const copy = (record, target, name, aliases) => {
          const value = valueFor(record, aliases);
          if (value !== undefined) target[name] = value;
        };
        const compactProducts = packageValue.data.products.map(source => {
          if (!source || typeof source !== 'object' || Array.isArray(source)) return source;
          const target = {};
          copy(source, target, 'id', ['id', 'productId', 'productoId', 'product_id']);
          copy(source, target, 'barcode', ['barcode', 'codigo', 'code']);
          copy(source, target, 'name', ['name', 'nombre']);
          copy(source, target, 'cost', ['cost']);
          copy(source, target, 'taxRate', ['taxRate', 'tax_rate', 'tax']);
          return target;
        });
        const compactProductsById = new Map(compactProducts
          .filter(product => product && product.id !== undefined && product.id !== null)
          .map(product => [String(product.id), product]));
        const compactClients = packageValue.data.clients.map(source => {
          if (!source || typeof source !== 'object' || Array.isArray(source)) return source;
          const target = {};
          copy(source, target, 'id', ['id', 'clientId', 'clienteId', 'client_id']);
          copy(source, target, 'name', ['name', 'nombre']);
          return target;
        });
        const compactClientsById = new Map(compactClients
          .filter(client => client && client.id !== undefined && client.id !== null)
          .map(client => [String(client.id), client]));
        const compactSales = packageValue.data.sales.map(source => {
          if (!source || typeof source !== 'object' || Array.isArray(source)) return source;
          const target = {};
          copy(source, target, 'id', ['id', 'saleId', 'ventaId', 'sale_id', 'venta_id']);
          copy(source, target, 'invoiceNumber', ['invoiceNumber', 'numeroFactura', 'factura', 'invoice', 'comprobante', 'numero']);
          copy(source, target, 'createdAt', ['createdAt', 'created_at', 'fechaTS', 'fecha', 'date', 'timestamp']);
          copy(source, target, 'clientId', ['clientId', 'clienteId', 'client_id', 'cliente_id']);
          const rawClient = valueFor(source, ['client', 'cliente', 'customer']);
          const clientName = valueFor(source, ['clientName', 'clienteNombre', 'nombreCliente', 'customerName']) ??
            (typeof rawClient === 'string' ? rawClient : valueFor(rawClient, ['name', 'nombre']));
          const sourceClient = target.clientId === undefined ? null : compactClientsById.get(String(target.clientId));
          if (clientName !== undefined && clientName !== sourceClient?.name) target.clientName = clientName;
          for (const [name, aliases] of [
            ['subtotal', ['subtotal', 'subTotal', 'base']],
            ['discount', ['discount', 'descuento', 'discountAmount', 'descuentoMonto']],
            ['discountPercent', ['discountPercent', 'descuentoPorcentaje', 'porcentajeDescuento', 'descuentoPct']],
            ['tax', ['tax', 'impuesto']],
            ['total', ['total', 'grandTotal', 'totalVenta', 'montoTotal', 'importeTotal']],
            ['paymentMethod', ['paymentMethod', 'metodoPago', 'metodo', 'payment_method', 'medioPago']],
            ['saleType', ['saleType', 'tipoVenta', 'sale_type', 'tipo']],
            ['status', ['status', 'estado', 'saleStatus']],
            ['priceType', ['priceType', 'tipoPrecio', 'sale_price_type', 'tarifa']],
            ['detail', ['detail', 'nota', 'note']],
            ['cancelledAt', ['cancelledAt', 'fechaAnulacion', 'cancelDate']],
            ['cancelReason', ['cancelReason', 'motivoAnulacion']],
            ['dueAt', ['dueAt', 'fechaVencimiento', 'vencimiento']]
          ]) copy(source, target, name, aliases);
          if (target.status === undefined) copy(source, target, 'anulada', ['anulada', 'cancelled', 'cancelado']);
          const rawItems = valueFor(source, ['items', 'detalleProductos', 'detalles', 'products', 'lineItems']);
          if (Array.isArray(rawItems)) target.items = rawItems.map(line => {
            if (!line || typeof line !== 'object' || Array.isArray(line)) return line;
            const compactLine = {};
            const nestedProduct = valueFor(line, ['product', 'producto']);
            copy(line, compactLine, 'productId', ['productId', 'productoId', 'product_id', 'producto_id', 'id']);
            if (compactLine.productId === undefined) copy(nestedProduct, compactLine, 'productId', ['id', 'productId']);
            const sourceProduct = compactLine.productId === undefined ? null : compactProductsById.get(String(compactLine.productId));
            const barcode = valueFor(line, ['barcode', 'codigo', 'code']) ?? valueFor(nestedProduct, ['barcode', 'codigo', 'code']);
            const productName = valueFor(line, ['productName', 'nombreProducto', 'name', 'nombre', 'descripcion']) ?? valueFor(nestedProduct, ['name', 'nombre']);
            if (barcode !== undefined && barcode !== sourceProduct?.barcode) compactLine.barcode = barcode;
            if (productName !== undefined && productName !== sourceProduct?.name) compactLine.productName = productName;
            const linePriceType = valueFor(line, ['tarifa', 'priceType', 'tipoPrecio']) ?? target.priceType;
            const priceToken = String(linePriceType ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
            const priceAliases = /MAYOREO|MAYORISTA|WHOLESALE/.test(priceToken) ? ['wholesalePrice', 'precio2'] : ['retailPrice', 'precio1'];
            copy(line, compactLine, 'unitPrice', ['unitPrice', 'precioUnitario', 'price', 'precio', 'precioVenta', ...priceAliases]);
            for (const [name, aliases] of [
              ['quantity', ['quantity', 'cantidad', 'qty']],
              ['subtotal', ['subtotal', 'subTotal']],
              ['discount', ['discount', 'descuento', 'discountAmount', 'descuentoMonto']],
              ['discountPercent', ['discountPercent', 'descuentoPorcentaje', 'porcentajeDescuento', 'descuentoPct']],
              ['tax', ['tax', 'impuesto']],
              ['total', ['total', 'importe', 'monto']],
            ]) copy(line, compactLine, name, aliases);
            const costAtSale = valueFor(line, ['costAtSale', 'cost', 'costo']);
            if (costAtSale !== undefined && (sourceProduct?.cost === undefined || Number(costAtSale) !== Number(sourceProduct.cost))) compactLine.costAtSale = costAtSale;
            const taxRate = valueFor(line, ['taxRate', 'tax_rate', 'impuestoPorcentaje']);
            if (taxRate !== undefined && (sourceProduct?.taxRate === undefined || Number(taxRate) !== Number(sourceProduct.taxRate))) compactLine.taxRate = taxRate;
            return compactLine;
          });
          return target;
        });
        const sourceBusinessId = ['localBusinessId', 'businessId', 'business_id', 'id', 'negocioId']
          .find(key => Object.hasOwn(packageValue.business, key));
        return {
          type: packageValue.type,
          version: packageValue.version,
          exportedAt: packageValue.exportedAt,
          business: { name: packageValue.business.name, ...(sourceBusinessId ? { id: packageValue.business[sourceBusinessId] } : {}) },
          data: { products: compactProducts, clients: compactClients, suppliers: [], sales: compactSales, inventoryMovements: [] }
        };
      }
      const productFields = ['id', 'productId', 'productoId', 'product_id', 'barcode', 'codigo', 'code', 'name', 'nombre', 'cost', 'taxRate', 'tax_rate', 'tax'];
      const clientFields = ['id', 'clientId', 'clienteId', 'client_id', 'name', 'nombre'];
      const saleFields = ['id', 'saleId', 'ventaId', 'sale_id', 'venta_id', 'numero', 'createdAt', 'created_at', 'fechaTS', 'fecha', 'date', 'timestamp',
        'clientId', 'clienteId', 'client_id', 'cliente_id', 'clientName', 'clienteNombre', 'nombreCliente', 'customerName',
        'subtotal', 'subTotal', 'base', 'discount', 'descuento', 'discountAmount', 'descuentoMonto', 'discountPercent', 'descuentoPorcentaje', 'porcentajeDescuento', 'descuentoPct',
        'tax', 'impuesto', 'total', 'grandTotal', 'totalVenta', 'montoTotal', 'importeTotal', 'paymentMethod', 'metodoPago', 'metodo', 'payment_method',
        'medioPago', 'saleType', 'tipoVenta', 'sale_type', 'tipo', 'status', 'estado', 'saleStatus', 'priceType', 'tipoPrecio', 'sale_price_type', 'tarifa', 'anulada',
        'detail', 'nota', 'note', 'invoiceNumber', 'numeroFactura', 'factura', 'invoice', 'comprobante',
        'cancelledAt', 'fechaAnulacion', 'cancelDate', 'cancelReason', 'motivoAnulacion', 'dueAt', 'fechaVencimiento', 'vencimiento', 'vencimientoTS'];
      const itemFields = ['id', 'productId', 'productoId', 'product_id', 'producto_id', 'barcode', 'codigo', 'code', 'productName', 'nombreProducto',
        'name', 'nombre', 'descripcion', 'quantity', 'cantidad', 'qty', 'unitPrice', 'precioUnitario', 'price', 'precio', 'precioVenta',
        'retailPrice', 'wholesalePrice', 'tarifa', 'precio1', 'precio2', 'total', 'importe', 'monto', 'subtotal', 'subTotal', 'discount', 'descuento', 'discountAmount', 'descuentoMonto', 'discountPercent', 'descuentoPct', 'tax', 'impuesto',
        'costAtSale', 'cost', 'costo', 'taxRate', 'tax_rate', 'impuestoPorcentaje'];
      const sales = packageValue.data.sales.map(sale => {
        if (!sale || typeof sale !== 'object' || Array.isArray(sale)) return sale;
        const safe = Object.fromEntries(saleFields.filter(key => Object.hasOwn(sale, key)).map(key => [key, sale[key]]));
        for (const key of ['items', 'detalleProductos', 'detalles', 'products', 'lineItems']) {
          if (!Object.hasOwn(sale, key)) continue;
          safe[key] = Array.isArray(sale[key]) ? sale[key].map(item => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
            const clean = Object.fromEntries(itemFields.filter(field => Object.hasOwn(item, field)).map(field => [field, item[field]]));
            for (const productKey of ['product', 'producto']) {
              const product = item[productKey];
              if (product && typeof product === 'object' && !Array.isArray(product)) {
                clean[productKey] = Object.fromEntries(['id', 'productId', 'barcode', 'codigo', 'code', 'name', 'nombre', 'retailPrice', 'wholesalePrice', 'tarifa']
                  .filter(field => Object.hasOwn(product, field)).map(field => [field, product[field]]));
              } else if (typeof product === 'string') clean[productKey] = product;
            }
            return clean;
          }) : sale[key];
        }
        for (const key of ['client', 'cliente', 'customer']) {
          const client = sale[key];
          if (typeof client === 'string') safe[key] = client;
          else if (client && typeof client === 'object' && !Array.isArray(client)) {
            safe[key] = Object.fromEntries(['id', 'clientId', 'clienteId', 'name', 'nombre']
              .filter(field => Object.hasOwn(client, field)).map(field => [field, client[field]]));
          }
        }
        return safe;
      });
      const sourceBusinessId = ['localBusinessId', 'businessId', 'business_id', 'id', 'negocioId']
        .find(key => Object.hasOwn(packageValue.business, key));
      return {
        type: packageValue.type,
        version: packageValue.version,
        exportedAt: packageValue.exportedAt,
        business: { name: packageValue.business.name, ...(sourceBusinessId ? { id: packageValue.business[sourceBusinessId] } : {}) },
        data: {
          products: fields(packageValue.data.products, productFields),
          clients: fields(packageValue.data.clients, clientFields),
          suppliers: [],
          sales,
          inventoryMovements: []
        }
      };
    }
    #safePurchasesMigrationPackage(packageValue, compact = false) {
      const data = packageValue?.data;
      if (!packageValue || packageValue.type !== 'pos_local_migration_package' || ![1, 2].includes(packageValue.version) ||
          !packageValue.business || typeof packageValue.business !== 'object' || !data || typeof data !== 'object' ||
          !Array.isArray(data.products) || data.products.length > 50000 || !Array.isArray(data.suppliers) || data.suppliers.length > 50000 ||
          !Array.isArray(data.purchases) || data.purchases.length > 50000) throw new ApiError('INVALID_INPUT');
      const fields = (records, allowed) => records.map(record => {
        if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
        return Object.fromEntries(allowed.filter(key => Object.hasOwn(record, key)).map(key => [key, record[key]]));
      });
      if (compact) {
        const valueFor = (record, aliases) => {
          for (const key of aliases) if (record && record[key] !== undefined && record[key] !== null && record[key] !== '') return record[key];
          return undefined;
        };
        const copy = (record, target, name, aliases) => {
          const value = valueFor(record, aliases);
          if (value !== undefined) target[name] = value;
        };
        const compactProducts = data.products.map(source => {
          if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
          const target = {};
          copy(source, target, 'id', ['id', 'productId', 'productoId', 'product_id']);
          copy(source, target, 'barcode', ['barcode', 'codigo', 'code']);
          copy(source, target, 'name', ['name', 'nombre']);
          return target;
        });
        const compactSuppliers = data.suppliers.map(source => {
          if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
          const target = {};
          copy(source, target, 'id', ['id', 'supplierId', 'proveedorId', 'supplier_id', 'proveedor_id']);
          copy(source, target, 'name', ['name', 'nombre']);
          return target;
        });
        const compactPurchases = data.purchases.map(source => {
          if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
          const target = {};
          copy(source, target, 'id', ['id', 'purchaseId', 'compraId', 'purchase_id', 'compra_id']);
          copy(source, target, 'invoiceNumber', ['supplierInvoiceNumber', 'invoiceNumber', 'invoice_number', 'factura', 'facturaNumero', 'numeroFactura', 'numero', 'comprobante', 'referencia']);
          copy(source, target, 'createdAt', ['createdAt', 'created_at', 'fechaTS', 'fecha', 'date', 'timestamp']);
          copy(source, target, 'supplierId', ['supplierId', 'proveedorId', 'supplier_id', 'proveedor_id']);
          const rawSupplier = valueFor(source, ['supplier', 'proveedor']);
          const supplierName = valueFor(source, ['supplierName', 'proveedorNombre']) ??
            (typeof rawSupplier === 'string' ? rawSupplier : valueFor(rawSupplier, ['name', 'nombre']));
          if (supplierName !== undefined) target.supplierName = supplierName;
          for (const [name, aliases] of [
            ['purchaseType', ['purchaseType', 'purchase_type', 'tipoCompra', 'tipo_compra', 'tipo']],
            ['status', ['status', 'estado']],
            ['anulada', ['anulada', 'cancelled', 'cancelado']],
            ['subtotal', ['subtotal', 'subTotal', 'base']],
            ['discount', ['discount', 'descuento', 'discountAmount', 'descuentoMonto']],
            ['discountPercent', ['discountPercent', 'descuentoPorcentaje', 'porcentajeDescuento', 'descuentoPct']],
            ['tax', ['tax', 'impuesto', 'taxAmount', 'impuestoMonto']],
            ['total', ['total', 'grandTotal', 'totalCompra', 'montoTotal', 'importeTotal']],
            ['dueAt', ['vencimientoTS', 'dueAt', 'due_at', 'vencimiento', 'fechaVencimiento', 'fecha_vencimiento']],
            ['notes', ['notes', 'note', 'detail', 'observaciones', 'nota']]
          ]) copy(source, target, name, aliases);
          const rawItems = valueFor(source, ['items', 'detalles', 'detalleProductos', 'products', 'lineItems']);
          if (Array.isArray(rawItems)) target.items = rawItems.map(line => {
            if (!line || typeof line !== 'object' || Array.isArray(line)) return null;
            const compactLine = {};
            const nestedProduct = valueFor(line, ['product', 'producto']);
            copy(line, compactLine, 'productId', ['productId', 'productoId', 'product_id', 'producto_id', 'id']);
            if (compactLine.productId === undefined) copy(nestedProduct, compactLine, 'productId', ['id', 'productId']);
            copy(line, compactLine, 'barcode', ['barcode', 'codigo', 'code']);
            if (compactLine.barcode === undefined) copy(nestedProduct, compactLine, 'barcode', ['barcode', 'codigo', 'code']);
            copy(line, compactLine, 'productName', ['productName', 'nombreProducto', 'name', 'nombre', 'descripcion']);
            if (compactLine.productName === undefined) {
              const nestedName = typeof nestedProduct === 'string' ? nestedProduct : valueFor(nestedProduct, ['name', 'nombre']);
              if (nestedName !== undefined) compactLine.productName = nestedName;
            }
            for (const [name, aliases] of [
              ['quantity', ['quantity', 'cantidad', 'qty']],
              ['unitCost', ['unitCost', 'unit_cost', 'cost', 'costo', 'costoUnitario', 'precioCosto']],
              ['subtotal', ['subtotal', 'subTotal']],
              ['discount', ['discount', 'descuento', 'discountAmount', 'descuentoMonto']],
              ['discountPercent', ['discountPercent', 'descuentoPorcentaje', 'porcentajeDescuento', 'descuentoPct']],
              ['tax', ['tax', 'impuesto', 'taxAmount', 'impuestoMonto']],
              ['total', ['total', 'importe', 'monto']]
            ]) copy(line, compactLine, name, aliases);
            return compactLine;
          });
          return target;
        });
        const sourceBusinessId = ['localBusinessId', 'businessId', 'business_id', 'id', 'negocioId'].find(key => Object.hasOwn(packageValue.business, key));
        return {
          type: packageValue.type, version: packageValue.version, exportedAt: packageValue.exportedAt,
          business: { name: packageValue.business.name, ...(sourceBusinessId ? { id: packageValue.business[sourceBusinessId] } : {}) },
          data: { products: compactProducts, clients: [], suppliers: compactSuppliers, purchases: compactPurchases }
        };
      }
      const products = ['id', 'productId', 'productoId', 'product_id', 'barcode', 'codigo', 'code', 'name', 'nombre'];
      const suppliers = ['id', 'supplierId', 'proveedorId', 'supplier_id', 'proveedor_id', 'name', 'nombre'];
      const purchaseFields = ['id', 'purchaseId', 'compraId', 'purchase_id', 'compra_id', 'supplierId', 'proveedorId', 'supplier_id', 'proveedor_id',
        'supplierName', 'proveedorNombre', 'factura', 'facturaNumero', 'numeroFactura', 'numero', 'invoice', 'invoiceNumber', 'invoice_number', 'supplierInvoiceNumber', 'comprobante', 'referencia',
        'createdAt', 'created_at', 'fechaTS', 'fecha', 'date', 'timestamp', 'purchaseType', 'purchase_type', 'tipoCompra', 'tipo_compra', 'tipo',
        'status', 'estado', 'anulada', 'cancelled', 'cancelado', 'subtotal', 'subTotal', 'base', 'discount', 'descuento', 'discountAmount', 'descuentoMonto',
        'discountPercent', 'descuentoPorcentaje', 'porcentajeDescuento', 'descuentoPct', 'tax', 'impuesto', 'taxAmount', 'impuestoMonto', 'total', 'grandTotal', 'totalCompra', 'montoTotal', 'importeTotal',
        'dueAt', 'due_at', 'vencimiento', 'vencimientoTS', 'fechaVencimiento', 'fecha_vencimiento', 'notes', 'note', 'detail', 'observaciones', 'nota'];
      const itemFields = ['id', 'productId', 'productoId', 'product_id', 'producto_id', 'barcode', 'codigo', 'code', 'productName', 'nombreProducto', 'name', 'nombre', 'descripcion',
        'quantity', 'cantidad', 'qty', 'unitCost', 'unit_cost', 'cost', 'costo', 'costoUnitario', 'precioCosto', 'subtotal', 'subTotal', 'discount', 'descuento', 'discountAmount', 'descuentoMonto',
        'discountPercent', 'descuentoPorcentaje', 'porcentajeDescuento', 'descuentoPct', 'tax', 'impuesto', 'taxAmount', 'impuestoMonto', 'total', 'importe', 'monto'];
      const purchases = data.purchases.map(purchase => {
        if (!purchase || typeof purchase !== 'object' || Array.isArray(purchase)) return null;
        const safe = Object.fromEntries(purchaseFields.filter(key => Object.hasOwn(purchase, key)).map(key => [key, purchase[key]]));
        for (const key of ['items', 'detalles', 'detalleProductos', 'products', 'lineItems']) {
          if (!Object.hasOwn(purchase, key)) continue;
          safe[key] = Array.isArray(purchase[key]) ? purchase[key].map(item => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
            const clean = Object.fromEntries(itemFields.filter(field => Object.hasOwn(item, field)).map(field => [field, item[field]]));
            for (const productKey of ['product', 'producto']) {
              const product = item[productKey];
              if (product && typeof product === 'object' && !Array.isArray(product)) clean[productKey] = Object.fromEntries(['id', 'productId', 'barcode', 'codigo', 'code', 'name', 'nombre'].filter(field => Object.hasOwn(product, field)).map(field => [field, product[field]]));
              else if (typeof product === 'string') clean[productKey] = product;
            }
            return clean;
          }) : [];
        }
        for (const key of ['supplier', 'proveedor']) {
          const supplier = purchase[key];
          if (typeof supplier === 'string') safe[key] = supplier;
          else if (supplier && typeof supplier === 'object' && !Array.isArray(supplier)) safe[key] = Object.fromEntries(['id', 'supplierId', 'proveedorId', 'name', 'nombre'].filter(field => Object.hasOwn(supplier, field)).map(field => [field, supplier[field]]));
        }
        return safe;
      });
      const sourceBusinessId = ['localBusinessId', 'businessId', 'business_id', 'id', 'negocioId'].find(key => Object.hasOwn(packageValue.business, key));
      return {
        type: packageValue.type, version: packageValue.version, exportedAt: packageValue.exportedAt,
        business: { name: packageValue.business.name, ...(sourceBusinessId ? { id: packageValue.business[sourceBusinessId] } : {}) },
        data: { products: fields(data.products, products), clients: [], suppliers: fields(data.suppliers, suppliers), purchases, sales: [], inventoryMovements: [] }
      };
    }
    #safeCreditMigrationPackage(packageValue) {
      if (!Array.isArray(packageValue?.data?.abonos) || packageValue.data.abonos.length > 50000) throw new ApiError('INVALID_INPUT');
      const safePackage = this.#safeSalesMigrationPackage(packageValue, true);
      const pick = (row, keys) => row && typeof row === 'object' && !Array.isArray(row) ? Object.fromEntries(keys.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]])) : null;
      safePackage.data.clients = packageValue.data.clients.map(row => pick(row, ['id', 'clientId', 'clienteId', 'client_id', 'name', 'nombre', 'debt', 'deudaSinFactura']));
      safePackage.data.sales.forEach((row, index) => {
        const source = packageValue.data.sales[index];
        if (row && source) {
          const dueAt = ['vencimientoTS', 'dueAt', 'due_at', 'fechaVencimiento', 'fecha_vencimiento', 'vencimiento'].find(key => Object.hasOwn(source, key));
          if (dueAt) row.dueAt = source[dueAt];
        }
      });
      safePackage.data.abonos = packageValue.data.abonos.map(row => pick(row, ['id', 'tipo', 'referenciaId', 'facturaId', 'monto', 'metodoPago', 'estado', 'fechaTS', 'createdAt', 'fecha', 'anulado']));
      return safePackage;
    }
    async previewCreditMigration(targetBusinessId, packageValue) {
      this.#requireSystemAdmin();
      if (typeof targetBusinessId !== 'string' || !/^[1-9]\d{0,19}$/.test(targetBusinessId)) throw new ApiError('INVALID_INPUT');
      const safePackage = this.#safeCreditMigrationPackage(packageValue);
      const value = await this.#write('/system-admin/migration/credit/preview', 'POST', { targetBusinessId, package: safePackage });
      if (value?.ok !== true || value.previewOnly !== true || typeof value.canImport !== 'boolean' || typeof value.eligible !== 'boolean' || typeof value.financiallyConsistent !== 'boolean' || !['invoices', 'payments', 'clients', 'issues', 'otherOrigins'].every(key => Array.isArray(value[key])) || !value.totals) throw new ApiError('INVALID_RESPONSE');
      return value;
    }
    async migrateCreditMigration(targetBusinessId, packageValue, confirmDifferentSource = false) {
      this.#requireSystemAdmin();
      if (typeof targetBusinessId !== 'string' || !/^[1-9]\d{0,19}$/.test(targetBusinessId) || typeof confirmDifferentSource !== 'boolean') throw new ApiError('INVALID_INPUT');
      const safePackage = this.#safeCreditMigrationPackage(packageValue);
      const value = await this.#write('/system-admin/migration/credit', 'POST', { targetBusinessId, package: safePackage, confirmDifferentSource });
      const counts = item => item && Number.isSafeInteger(item.invoices) && item.invoices >= 0 && Number.isSafeInteger(item.payments) && item.payments >= 0;
      if (value?.ok !== true || !counts(value.created) || !counts(value.skipped) || !value.financial || !Array.isArray(value.warnings) || !value.warnings.every(warning => typeof warning === 'string')) throw new ApiError('INVALID_RESPONSE');
      return value;
    }
    async previewSalesMigration(targetBusinessId, packageValue) {
      this.#requireSystemAdmin();
      if (typeof targetBusinessId !== 'string' || !/^[1-9]\d{0,19}$/.test(targetBusinessId)) throw new ApiError('INVALID_INPUT');
      const safePackage = this.#safeSalesMigrationPackage(packageValue, true);
      const value = await this.#write('/system-admin/migration/sales/preview', 'POST', { targetBusinessId, package: safePackage });
      const counts = value?.sales, gates = value?.gates;
      if (value?.ok !== true || typeof value.eligible !== 'boolean' ||
          !counts || !['detected', 'couldMigrate', 'toSkip'].every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0) ||
          !gates || !['basic', 'inventory', 'schema', 'targetUser'].every(key => typeof gates[key] === 'boolean') ||
          !Array.isArray(value.warnings) || !value.warnings.every(warning => typeof warning === 'string') ||
          (value.sourceOriginConflict !== undefined && (!value.sourceOriginConflict || typeof value.sourceOriginConflict.required !== 'boolean' || typeof value.sourceOriginConflict.incomingSourceBusinessName !== 'string' || !/^[a-f0-9]{64}$/.test(value.sourceOriginConflict.incomingSourceBusinessKey || '') || !Array.isArray(value.sourceOriginConflict.existingSources) || !value.sourceOriginConflict.existingSources.every(source => /^[a-f0-9]{64}$/.test(source.sourceBusinessKey || '') && (source.sourceBusinessName === null || typeof source.sourceBusinessName === 'string') && Number.isSafeInteger(source.saleCount) && source.saleCount >= 0)))) throw new ApiError('INVALID_RESPONSE');
      return value;
    }
    async migrateSales(targetBusinessId, packageValue, confirmDifferentSource = false) {
      this.#requireSystemAdmin();
      if (typeof targetBusinessId !== 'string' || !/^[1-9]\d{0,19}$/.test(targetBusinessId) || typeof confirmDifferentSource !== 'boolean') throw new ApiError('INVALID_INPUT');
      const safePackage = this.#safeSalesMigrationPackage(packageValue, true);
      const value = await this.#write('/system-admin/migration/sales', 'POST', { targetBusinessId, package: safePackage, confirmDifferentSource });
      const validCounts = counts => counts && Number.isSafeInteger(counts.sales) && counts.sales >= 0;
      if (value?.ok !== true || !validCounts(value.created) || !validCounts(value.skipped) ||
          !Array.isArray(value.warnings) || !value.warnings.every(warning => typeof warning === 'string')) throw new ApiError('INVALID_RESPONSE');
      return value;
    }
    async previewPurchasesMigration(targetBusinessId, packageValue) {
      this.#requireSystemAdmin();
      if (typeof targetBusinessId !== 'string' || !/^[1-9]\d{0,19}$/.test(targetBusinessId)) throw new ApiError('INVALID_INPUT');
      const safePackage = this.#safePurchasesMigrationPackage(packageValue, true);
      const value = await this.#write('/system-admin/migration/purchases/preview', 'POST', { targetBusinessId, package: safePackage });
      const counts = value?.purchases, gates = value?.gates, diagnostics = value?.diagnostics;
      const keys = ['suppliersUnmatched', 'suppliersAmbiguous', 'productsUnmatched', 'productsAmbiguous', 'duplicateInvoices', 'missingCosts', 'inconsistentTotals', 'unsupportedStatuses'];
      if (value?.ok !== true || typeof value.eligible !== 'boolean' ||
          !counts || !['detected', 'couldMigrate', 'toSkip'].every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0) ||
          !gates || !['basic', 'schema', 'targetUser'].every(key => typeof gates[key] === 'boolean') ||
          !diagnostics || !keys.every(key => Number.isSafeInteger(diagnostics[key]) && diagnostics[key] >= 0) ||
          !Array.isArray(value.warnings) || !value.warnings.every(warning => typeof warning === 'string')) throw new ApiError('INVALID_RESPONSE');
      return value;
    }
    async migratePurchases(targetBusinessId, packageValue) {
      this.#requireSystemAdmin();
      if (typeof targetBusinessId !== 'string' || !/^[1-9]\d{0,19}$/.test(targetBusinessId)) throw new ApiError('INVALID_INPUT');
      const safePackage = this.#safePurchasesMigrationPackage(packageValue, true);
      const value = await this.#write('/system-admin/migration/purchases', 'POST', { targetBusinessId, package: safePackage });
      const counts = item => item && Number.isSafeInteger(item.purchases) && item.purchases >= 0;
      if (value?.ok !== true || !counts(value.created) || !counts(value.skipped) ||
          !Array.isArray(value.warnings) || !value.warnings.every(warning => typeof warning === 'string')) throw new ApiError('INVALID_RESPONSE');
      return value;
    }
    #scrubArchiveValue(value) {
      if (Array.isArray(value)) return value.map(item => this.#scrubArchiveValue(item));
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
          try { return JSON.stringify(this.#scrubArchiveValue(JSON.parse(trimmed))); } catch { return value; }
        }
        return value;
      }
      if (!value || typeof value !== 'object') return value;
      const clean = {};
      for (const [key, nested] of Object.entries(value)) {
        const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
        if (/(password|passwd|secret|credential|token|sessiontoken|privatekey|signingkey|encryptionkey|salt|username|userid|useragent|accesskey|apikey)/.test(normalized) || /^(user|usuario|vendedor|cajero|seller|cashier)id$/.test(normalized)) continue;
        clean[key] = this.#scrubArchiveValue(nested);
      }
      return clean;
    }
    #migrationArchivePackage(targetBusinessId, packageValue, confirmed, fileSha256 = null) {
      this.#requireSystemAdmin();
      if (typeof targetBusinessId !== 'string' || !/^[1-9]\d{0,19}$/.test(targetBusinessId) ||
          !packageValue || packageValue.type !== 'pos_local_migration_package' || ![1, 2].includes(packageValue.version) ||
          !packageValue.business || typeof packageValue.business !== 'object' || Array.isArray(packageValue.business) ||
          !packageValue.data || typeof packageValue.data !== 'object' || Array.isArray(packageValue.data) ||
          (fileSha256 !== null && !/^[a-f0-9]{64}$/.test(fileSha256)) ||
          (confirmed !== null && typeof confirmed !== 'boolean')) throw new ApiError('INVALID_INPUT');
      const body = JSON.stringify({ targetBusinessId, package: this.#scrubArchiveValue(packageValue), ...(fileSha256 ? { packageFileSha256: fileSha256 } : {}), ...(confirmed !== null ? { confirmed } : {}) });
      if (new TextEncoder().encode(body).length > 32 * 1024 * 1024) throw new ApiError('PAYLOAD_TOO_LARGE');
      return body;
    }
    async previewFullMigration(targetBusinessId, packageValue, fileSha256 = null) {
      const body = this.#migrationArchivePackage(targetBusinessId, packageValue, null, fileSha256);
      const value = await this.#write('/system-admin/migration/archive/preview', 'POST', body, 'application/vnd.pos.local-migration+json', 120000);
      const counts = value?.counts;
      if (value?.ok !== true || value.targetBusinessId !== targetBusinessId || value.targetStatus !== 'INACTIVE' || value.targetMigrationState !== 'PENDING' || !/^[a-f0-9]{64}$/.test(value.packageSha256 || '') ||
          !/^[a-f0-9]{64}$/.test(value.sourceBusinessKey || '') || !counts || Object.values(counts).some(count => !Number.isSafeInteger(count) || count < 0) ||
          !Number.isSafeInteger(value.recordsExpected) || value.recordsExpected < 0 || !Array.isArray(value.blockers) || !value.blockers.every(item => typeof item === 'string') ||
          !Array.isArray(value.missingStores) || typeof value.eligibleToArchive !== 'boolean' || typeof value.legacyIdentityConfirmationRequired !== 'boolean' || !Number.isSafeInteger(value.bulkIdentityEligibleRecords) || value.bulkIdentityEligibleRecords < 0 ||
          (value.fileSha256 !== null && value.fileSha256 !== undefined && !/^[a-f0-9]{64}$/.test(value.fileSha256)) ||
          (fileSha256 && value.fileSha256 !== fileSha256) || !value.identityReview || !value.identityReview.counts || !Array.isArray(value.identityReview.records)) throw new ApiError('INVALID_RESPONSE');
      return value;
    }
    async archiveFullMigration(targetBusinessId, packageValue, confirmed, fileSha256 = null) {
      if (confirmed !== true) throw new ApiError('MIGRATION_ARCHIVE_CONFIRMATION_REQUIRED', 409);
      const body = this.#migrationArchivePackage(targetBusinessId, packageValue, true, fileSha256);
      const value = await this.#write('/system-admin/migration/archive', 'POST', body, 'application/vnd.pos.local-migration+json', 120000);
      if (value?.ok !== true || !/^[0-9a-f-]{36}$/i.test(value.batchId || '') ||
          !['ARCHIVED', 'BLOCKED'].includes(value.status) || !/^[a-f0-9]{64}$/.test(value.packageSha256 || '') ||
          !Number.isSafeInteger(value.recordsArchived) || value.recordsArchived < 0 || !Array.isArray(value.blockers) || !value.blockers.every(item => typeof item === 'string') || !Number.isSafeInteger(value.identityConfirmationApplied) || value.identityConfirmationApplied < 0 ||
          (fileSha256 && value.fileSha256 !== fileSha256) || (value.identityConfirmation !== null && (value.identityConfirmation?.confirmed !== true || !/^[a-f0-9]{64}$/.test(value.identityConfirmation.packageSha256 || '') || (value.identityConfirmation.fileSha256 !== null && value.identityConfirmation.fileSha256 !== undefined && !/^[a-f0-9]{64}$/.test(value.identityConfirmation.fileSha256)) || typeof value.identityConfirmation.targetBusinessId !== 'string' || typeof value.identityConfirmation.confirmedAt !== 'string'))) throw new ApiError('INVALID_RESPONSE');
      return value;
    }
    async reviewMigrationIdentityRecord(targetBusinessId, batchId, entity, sourceRecordKey, decision, attestBelongsToSource = false) {
      this.#requireSystemAdmin();
      if (typeof targetBusinessId !== 'string' || !/^[1-9]\d{0,19}$/.test(targetBusinessId) || !/^[0-9a-f-]{36}$/i.test(batchId || '') ||
          typeof entity !== 'string' || typeof sourceRecordKey !== 'string' || !sourceRecordKey.trim() || sourceRecordKey.length > 120 ||
          !['INCLUDE', 'EXCLUDE'].includes(decision) || typeof attestBelongsToSource !== 'boolean' || (decision === 'INCLUDE' && attestBelongsToSource !== true)) throw new ApiError('INVALID_INPUT');
      const value = await this.#write(`/system-admin/migration/archive/${encodeURIComponent(targetBusinessId)}/${encodeURIComponent(batchId)}/review`, 'POST', {
        entity, sourceRecordKey, decision, attestBelongsToSource
      });
      if (value?.ok !== true || value.businessId !== targetBusinessId || value.batchId !== batchId || value.entity !== entity || value.sourceRecordKey !== sourceRecordKey || value.decision !== decision ||
          !['ARCHIVED', 'EXCLUDED', 'PENDING'].includes(value.recordStatus) || value.businessStatus !== 'INACTIVE' || value.migrationState !== 'PENDING') throw new ApiError('INVALID_RESPONSE');
      return value;
    }
    async createMigrationTarget(name, planCode) {
      this.#requireSystemAdmin();
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 160 || !['CONECTADO_BASICO', 'CONECTADO_ESTANDAR', 'CONECTADO_PREMIUM'].includes(planCode)) throw new ApiError('INVALID_INPUT');
      const value = await this.#write('/system-admin/migration/targets', 'POST', { name: name.trim(), planCode });
      const business = value?.business;
      if (!business || !/^[1-9]\d{0,19}$/.test(business.id || '') || business.name !== name.trim() || business.status !== 'INACTIVE' || business.migrationState !== 'PENDING' || business.planCode !== planCode) throw new ApiError('INVALID_RESPONSE');
      return business;
    }
    async inspectExistingMigrationTarget(businessId) {
      this.#requireSystemAdmin();
      if (typeof businessId !== 'string' || !/^[1-9]\d{0,19}$/.test(businessId) || businessId === '1') throw new ApiError('INVALID_INPUT');
      const value = await this.#request('/system-admin/migration/targets/' + encodeURIComponent(businessId) + '/inspect');
      const business = value?.business, preserved = value?.preserved;
      const countsValid = preserved && ['users', 'settings', 'auditLogs', 'sessions', 'subscriptions'].every(key => Number.isSafeInteger(preserved[key]) && preserved[key] >= 0);
      const accessChanges = value?.accessChanges;
      const accessChangesValid = accessChanges && ['activeSessions', 'sessionsToRevoke', 'authorizationsToRemove'].every(key => Number.isSafeInteger(accessChanges[key]) && accessChanges[key] >= 0);
      if (!business || String(business.id) !== businessId || !['ACTIVE', 'INACTIVE'].includes(business.status) || business.migrationState !== 'NOT_REQUIRED' || typeof value.eligible !== 'boolean' || !Array.isArray(value.blockers) || !value.blockers.every(item => typeof item === 'string') || !Array.isArray(value.warnings) || !value.warnings.every(item => typeof item === 'string') || !countsValid || !accessChangesValid || typeof preserved.businessPhone !== 'boolean' || typeof preserved.businessAddress !== 'boolean') throw new ApiError('INVALID_RESPONSE');
      return value;
    }
    async prepareExistingMigrationTarget(businessId, confirmed) {
      this.#requireSystemAdmin();
      if (typeof businessId !== 'string' || !/^[1-9]\d{0,19}$/.test(businessId) || businessId === '1') throw new ApiError('INVALID_INPUT');
      if (confirmed !== true) throw new ApiError('MIGRATION_TARGET_CONFIRMATION_REQUIRED', 409);
      const value = await this.#write('/system-admin/migration/targets/' + encodeURIComponent(businessId) + '/prepare', 'POST', { confirmed });
      const business = value?.business, preserved = value?.preserved;
      const countsValid = preserved && ['users', 'settings', 'auditLogs', 'sessions', 'subscriptions'].every(key => Number.isSafeInteger(preserved[key]) && preserved[key] >= 0);
      const accessChanges = value?.accessChanges;
      const accessChangesValid = accessChanges && ['activeSessions', 'sessionsToRevoke', 'authorizationsToRemove'].every(key => Number.isSafeInteger(accessChanges[key]) && accessChanges[key] >= 0);
      if (!business || String(business.id) !== businessId || business.status !== 'INACTIVE' || business.migrationState !== 'PENDING' || value.accessSuspended !== true || !countsValid || !accessChangesValid || typeof value.sessionsRevoked !== 'number' || typeof value.authorizationsRemoved !== 'number') throw new ApiError('INVALID_RESPONSE');
      return value;
    }
    async migrationBatchStatus(targetBusinessId, batchId) {
      this.#requireSystemAdmin();
      if (typeof targetBusinessId !== 'string' || !/^[1-9]\d{0,19}$/.test(targetBusinessId) || !/^[0-9a-f-]{36}$/i.test(batchId || '')) throw new ApiError('INVALID_INPUT');
      const value = await this.#request('/system-admin/migration/archive/' + encodeURIComponent(targetBusinessId) + '/' + encodeURIComponent(batchId));
      if (value?.ok !== true || value.batch?.id !== batchId || value.batch.business_id !== undefined && String(value.batch.business_id) !== targetBusinessId || !value.records || typeof value.records !== 'object') throw new ApiError('INVALID_RESPONSE');
      return value;
    }
    async projectMigrationCatalog(targetBusinessId, batchId) {
      this.#requireSystemAdmin();
      if (typeof targetBusinessId !== 'string' || !/^[1-9]\d{0,19}$/.test(targetBusinessId) || !/^[0-9a-f-]{36}$/i.test(batchId || '')) throw new ApiError('INVALID_INPUT');
      const value = await this.#write('/system-admin/migration/archive/' + encodeURIComponent(targetBusinessId) + '/' + encodeURIComponent(batchId) + '/project/catalog', 'POST', {});
      const reconciliation = value?.reconciliation;
      if (value?.ok !== true || value.businessId !== targetBusinessId || value.batchId !== batchId || !reconciliation || reconciliation.complete !== false || reconciliation.fullMigrationComplete !== false || !Array.isArray(reconciliation.differences) || !Array.isArray(reconciliation.blockers) || !reconciliation.totals || !reconciliation.pending) throw new ApiError('INVALID_RESPONSE');
      return value;
    }
    async projectMigrationOperations(targetBusinessId, batchId) {
      this.#requireSystemAdmin();
      if (typeof targetBusinessId !== 'string' || !/^[1-9]\d{0,19}$/.test(targetBusinessId) || !/^[0-9a-f-]{36}$/i.test(batchId || '')) throw new ApiError('INVALID_INPUT');
      const value = await this.#write('/system-admin/migration/archive/' + encodeURIComponent(targetBusinessId) + '/' + encodeURIComponent(batchId) + '/project/operations', 'POST', {});
      const reconciliation = value?.reconciliation;
      if (value?.ok !== true || value.businessId !== targetBusinessId || value.batchId !== batchId || !reconciliation || typeof reconciliation.complete !== 'boolean' || reconciliation.fullMigrationComplete !== reconciliation.complete || !Array.isArray(reconciliation.differences) || !Array.isArray(reconciliation.blockers) || typeof reconciliation.unresolved !== 'boolean') throw new ApiError('INVALID_RESPONSE');
      return value;
    }
    async migrationBatchRecords(targetBusinessId, batchId, offset = 0, limit = 100) {
      this.#requireSystemAdmin();
      if (typeof targetBusinessId !== 'string' || !/^[1-9]\d{0,19}$/.test(targetBusinessId) || !/^[0-9a-f-]{36}$/i.test(batchId || '') || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 250) throw new ApiError('INVALID_INPUT');
      const query = new URLSearchParams({ offset: String(offset), limit: String(limit) });
      const value = await this.#request('/system-admin/migration/archive/' + encodeURIComponent(targetBusinessId) + '/' + encodeURIComponent(batchId) + '/records?' + query);
      if (value?.ok !== true || !Array.isArray(value.records) || value.records.some(record => !record || typeof record.entityType !== 'string' || typeof record.sourceRecordKey !== 'string' || !record.payload || typeof record.payload !== 'object')) throw new ApiError('INVALID_RESPONSE');
      return value.records;
    }
    async migrationHistory(module, offset = 0, limit = 50) {
      const allowed = new Set(['inventory', 'purchases', 'payables', 'clients', 'history', 'cash', 'expenses', 'settings', 'reports']);
      if (!allowed.has(module) || !Number.isInteger(offset) || offset < 0 || offset > 1000000 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError('INVALID_INPUT');
      const query = new URLSearchParams({ offset: String(offset), limit: String(limit) });
      const value = await this.#request('/migration-history/' + encodeURIComponent(module) + '?' + query);
      const reconciliation = value?.reconciliation;
      if (value?.businessId !== this.#effectiveBusinessId() || typeof value.available !== 'boolean' || !Array.isArray(value.records) || !Number.isSafeInteger(value.total) || value.offset !== offset || value.limit !== limit || !reconciliation || reconciliation.complete !== false || !['MATCH', 'DIFFERENT', 'UNAVAILABLE', 'NO_ARCHIVE'].includes(reconciliation.archiveIntegrity) || reconciliation.operationalComparison !== 'NOT_RUN' || !Array.isArray(reconciliation.differences)) throw new ApiError('INVALID_RESPONSE');
      if (value.records.some(record => !record || !/^[0-9a-f-]{36}$/i.test(record.batchId || '') || typeof record.sourceBusinessName !== 'string' || typeof record.entityType !== 'string' || typeof record.sourceRecordKey !== 'string' || !['ARCHIVED', 'PROJECTED', 'PENDING', 'EXCLUDED'].includes(record.recordStatus) || !record.payload || typeof record.payload !== 'object' || Array.isArray(record.payload) || typeof record.hasImage !== 'boolean')) throw new ApiError('INVALID_RESPONSE');
      return value;
    }
    async createAdminBusiness(name, planCode) {
      this.#requireSystemAdmin();
      if (typeof name !== 'string' || !name.trim() || !['CONECTADO_BASICO', 'CONECTADO_ESTANDAR', 'CONECTADO_PREMIUM'].includes(planCode)) throw new ApiError('INVALID_INPUT');
      const value = await this.#write('/admin/businesses', 'POST', { name: name.trim(), planCode });
      if (!value?.business || !/^[1-9]\d{0,19}$/.test(value.business.id || '') || value.business.name !== name.trim() || value.business.status !== 'ACTIVE' || value.business.planCode !== planCode) throw new ApiError('INVALID_RESPONSE');
      return value.business;
    }
    async adminBusinessUserCapacity(businessId) {
      this.#requireSystemAdmin();
      const value = await this.#request('/admin/businesses/' + encodeURIComponent(businessId) + '/user-capacity');
      const capacity = value?.capacity;
      if (!capacity || capacity.businessId !== String(businessId) || !(capacity.planCode === null || ['LOCAL', 'CONECTADO_BASICO', 'CONECTADO_ESTANDAR', 'CONECTADO_PREMIUM'].includes(capacity.planCode)) || typeof capacity.planName !== 'string' || !Number.isSafeInteger(capacity.activeUsers) || !Number.isSafeInteger(capacity.inactiveUsers) || !Number.isSafeInteger(capacity.activeAdmins) || !(capacity.maximumUsers === null || Number.isSafeInteger(capacity.maximumUsers)) || !(capacity.availableUsers === null || Number.isSafeInteger(capacity.availableUsers))) throw new ApiError('INVALID_RESPONSE');
      return capacity;
    }
    async setAdminBusinessStatus(id, status) {
      this.#requireSystemAdmin();
      if (!['ACTIVE', 'INACTIVE'].includes(status)) throw new ApiError('INVALID_INPUT');
      const value = await this.#write('/admin/businesses/' + encodeURIComponent(id) + '/status', 'PATCH', { status });
      if (value?.business?.id !== String(id) || value.business.status !== status) throw new ApiError('INVALID_RESPONSE');
      return value.business;
    }
    async adminBusinessDeletionPreview(id) {
      this.#requireSystemAdmin();
      if (typeof id !== 'string' || !/^[1-9]\d{0,19}$/.test(id)) throw new ApiError('INVALID_INPUT');
      const value = await this.#request('/admin/businesses/' + encodeURIComponent(id) + '/deletion-preview');
      const safeCount = item => Number.isSafeInteger(item) && item >= 0;
      if (value?.business?.id !== id || typeof value.business.name !== 'string' || !['ACTIVE', 'INACTIVE'].includes(value.business.status) || !Array.isArray(value.counts) || !safeCount(value.totalRecords) || !safeCount(value.sessions) || !value.images || !safeCount(value.images.count) || !safeCount(value.images.bytes) || !value.retainedBilling || !safeCount(value.retainedBilling.subscriptions) || !safeCount(value.retainedBilling.payments) || typeof value.previewToken !== 'string' || !/^[a-f0-9]{64}$/.test(value.previewToken)) throw new ApiError('INVALID_RESPONSE');
      if (value.counts.some(item => !item || typeof item.table !== 'string' || typeof item.label !== 'string' || !safeCount(item.count))) throw new ApiError('INVALID_RESPONSE');
      return value;
    }
    async deleteAdminBusiness(id, confirmation, previewToken) {
      this.#requireSystemAdmin();
      if (typeof id !== 'string' || !/^[1-9]\d{0,19}$/.test(id)) throw new ApiError('INVALID_INPUT');
      if (confirmation !== 'ELIMINAR') throw new ApiError('BUSINESS_DELETE_CONFIRMATION_REQUIRED', 400);
      if (previewToken !== undefined && (typeof previewToken !== 'string' || !/^[a-f0-9]{64}$/.test(previewToken))) throw new ApiError('INVALID_INPUT');
      const body = { confirmation, ...(previewToken ? { previewToken } : {}) };
      const value = await this.#write('/admin/businesses/' + encodeURIComponent(id), 'DELETE', body);
      if (value?.id !== id || typeof value.name !== 'string' || !Array.isArray(value.counts) || !Number.isSafeInteger(value.totalDeletedRecords) || value.totalDeletedRecords < 1 || !Number.isSafeInteger(value.revokedSessions) || value.revokedSessions < 0 || typeof value.filesPendingCleanup !== 'boolean') throw new ApiError('INVALID_RESPONSE');
      return value;
    }
    async adminUsers(businessId) {
      this.#requireSystemAdmin();
      const value = await this.#request('/admin/businesses/' + encodeURIComponent(businessId) + '/users');
      if (!Array.isArray(value?.users)) throw new ApiError('INVALID_RESPONSE');
      return value.users.map(item => {
        if (!/^[1-9]\d{0,19}$/.test(item.id || '') || item.businessId !== String(businessId) || !['ADMIN', 'VENDEDOR'].includes(item.role) || typeof item.username !== 'string' || typeof item.fullName !== 'string' || typeof item.active !== 'boolean') throw new ApiError('INVALID_RESPONSE');
        return item;
      });
    }
    async createAdminUser(businessId, data) {
      this.#requireSystemAdmin();
      if (typeof businessId !== 'string' || !/^[1-9]\d{0,19}$/.test(businessId) || BigInt(businessId) > 18446744073709551615n) throw new ApiError('INVALID_INPUT');
      const value = await this.#write('/admin/businesses/' + encodeURIComponent(businessId) + '/users', 'POST', data);
      const created = user(value?.user);
      if (created.businessId !== businessId || created.role !== data.role || created.username !== data.username) throw new ApiError('INVALID_RESPONSE');
      return created;
    }
    async setAdminUserActive(id, active) {
      this.#requireSystemAdmin();
      const value = await this.#write('/admin/users/' + encodeURIComponent(id) + '/status', 'PATCH', { active });
      if (value?.user?.id !== String(id) || value.user.active !== active) throw new ApiError('INVALID_RESPONSE');
      return value.user;
    }
  }
  window.PosApiClient = PosApiClient;
  window.PosApiError = ApiError;
  window.PosMessages = Object.freeze({ expected: expectedUserError, fromError: userFacingErrorMessage, text: userFacingText, isTechnical: containsTechnicalMessage });
})();
