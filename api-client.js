'use strict';
(() => {
  const messages = {
    CART_EMPTY: 'El carrito está vacío. Agrega productos antes de cobrar.',
    QUANTITY_INVALID: 'Ingresa una cantidad mayor que cero, con hasta tres decimales.',
    DISCOUNT_INVALID: 'El descuento debe estar entre 0 y 100, con hasta cuatro decimales.',
    PAYMENT_METHOD_REQUIRED: 'Selecciona efectivo, tarjeta, transferencia o cr\u00e9dito.',
    PRODUCT_INACTIVE: 'El producto está inactivo. Retíralo del carrito.',
    CASH_CLOSED: 'No hay una caja abierta. Abre una caja para continuar.',
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
    CREDIT_MIGRATION_REQUIRED: 'Clientes y cuentas por cobrar requieren la migraci\u00f3n 004 aprobada. Consulta al administrador.',
    SALES_MIGRATION_REQUIRED: 'Ventas y caja requieren las migraciones 002 y 003 aprobadas. Consulta al administrador.',
    EXPENSE_CASH_CLOSED: 'Abre una caja antes de registrar un gasto en efectivo.',
    CASH_BALANCE_INSUFFICIENT: 'La caja no tiene saldo suficiente para registrar este movimiento.',
    EXPENSE_NOT_FOUND: 'No se encontró ese gasto en este negocio.',
    EXPENSE_CANCELLED: 'El gasto ya está anulado.',
    EXPENSE_CASH_MOVEMENT_MISSING: 'No se puede anular este gasto porque falta su movimiento de caja. Solicita revisión al administrador.',
    SUPPLIER_PAYMENT_MIGRATION_REQUIRED: 'Los pagos a proveedor con tarjeta o transferencia requieren la migración 005. El efectivo sigue disponible; solicita autorización antes de migrar la base principal.',
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
    PROCUREMENT_MIGRATION_REQUIRED: 'Compras y cuentas por pagar necesitan las migraciones conectadas aprobadas.',
    NETWORK_ERROR: 'No se pudo conectar con el servidor. Comprueba tu conexión',
    INVALID_RESPONSE: 'El servidor devolvió una respuesta inesperada.',
    CASH_RESPONSE_INVALID: 'La respuesta de Caja no tiene el formato esperado o pertenece a otro negocio. Actualiza la pantalla e inténtalo de nuevo.',
    INVALID_CREDENTIALS: 'El usuario o la contraseña son incorrectos (Credenciales incorrectas).',
    INVALID_SESSION: 'La sesión venció o fue revocada. Inicia sesión nuevamente.',
    CSRF_FAILED: 'No se pudo validar la solicitud. Intenta nuevamente.',
    MODULE_FORBIDDEN: 'Este módulo requiere autorización de un administrador.',
    ADMIN_REQUIRED: 'Solo un administrador del negocio puede gestionar usuarios.',
    LAST_ACTIVE_ADMIN: 'Debe permanecer al menos un administrador activo.',
    USERNAME_EXISTS: 'Ese nombre de usuario ya está en uso en otro registro.',
    SYSTEM_ADMIN_REQUIRED: 'Solo el administrador del sistema puede acceder a esta sección.',
    MIGRATION_PACKAGE_INVALID: 'El paquete no contiene los datos válidos para esta migración.',
    MIGRATION_BASIC_REQUIRED: 'Primero completa la migración básica de productos para este negocio.',
    MIGRATION_INVENTORY_SCHEMA_REQUIRED: 'La base conectada requiere la migración de inventario inicial antes de usar esta función.',
    MIGRATION_TARGET_INACTIVE: 'El negocio conectado destino no está activo.',
    MIGRATION_SYSTEM_BUSINESS_CONFIRMATION_REQUIRED: 'Confirma explícitamente que deseas importar al negocio del sistema.',
    SUPPORT_TARGET_INVALID: 'Selecciona un negocio de cliente para iniciar la sesión de soporte.',
    SUPPORT_BUSINESS_UNAVAILABLE: 'El negocio está suspendido o no disponible para soporte.',
    SUPPORT_ADMIN_REQUIRED: 'El negocio necesita un administrador activo antes de iniciar soporte.',
    SUPPORT_OWNER_SESSION_INVALID: 'La sesión del dueño venció o fue revocada. Inicia sesión nuevamente.',
    INVALID_SUPPORT_SESSION: 'La sesión de soporte venció o perdió autorización. Vuelve al panel del sistema.',
    BUSINESS_NOT_FOUND: 'No se encontró el negocio solicitado.',
    BUSINESS_PROTECTED: 'El negocio del sistema no se puede suspender.',
    BUSINESS_DELETE_PROTECTED: 'No se puede eliminar el negocio principal del sistema.',
    BUSINESS_HAS_DATA: 'No se puede eliminar porque el negocio ya tiene información registrada. Puede suspenderlo.',
    BUSINESS_DELETE_CONFIRMATION_REQUIRED: 'Eliminación cancelada. Debes escribir exactamente ELIMINAR.',
    SYSTEM_ADMIN_BILLING_MIGRATION_REQUIRED: 'La gestión de planes y pagos necesita la migración 006 aprobada. Consulta al administrador del sistema.',
    BUSINESS_PLAN_INVALID: 'Selecciona uno de los planes disponibles.',
    BUSINESS_PLAN_NOT_MONTHLY: 'Solo se pueden registrar pagos para planes conectados mensuales.',
    PAYMENT_AMOUNT_INVALID: 'Ingresa un importe en USD mayor que cero y con hasta dos decimales.',
    PAYMENT_DATE_FUTURE: 'La fecha del pago no puede estar en el futuro.',
    SYSTEM_ADMIN_PROTECTED: 'La cuenta del dueño del sistema no se puede desactivar desde este panel.',
    USER_NOT_FOUND: 'No existe un usuario con ese nombre.',
    USERNAME_AMBIGUOUS: 'Este usuario está registrado en varios negocios. Cambia uno de los nombres de usuario con un administrador.',
    USER_INACTIVE: 'Este usuario está inactivo. Contacta al administrador del negocio.',
    BUSINESS_INACTIVE: 'El negocio está suspendido o inactivo. Contacta al administrador.',
    INVALID_INPUT: 'Revisa los campos ingresados.',
    PAYLOAD_TOO_LARGE: 'La solicitud es demasiado grande. Usa el selector para cargar la fotografia por separado.',
    INVALID_JSON: 'El servidor rechaz\u00f3 la solicitud porque el JSON no es v\u00e1lido.',
    UNSUPPORTED_BODY: 'El servidor no admite el formato enviado.',
    NOT_FOUND: 'El servidor no reconoce la ruta solicitada.',
    ORIGIN_NOT_ALLOWED: 'El servidor rechaz\u00f3 la solicitud desde este origen.',
    IMAGE_REQUIRES_UPLOAD: 'La fotografia debe cargarse como archivo; no como Base64 dentro del producto.',
    IMAGE_TOO_LARGE: 'La fotografia supera el limite de 8 MiB. Elige una imagen mas pequena.',
    IMAGE_FORMAT_INVALID: 'Formato de fotografia no admitido. Usa JPEG, PNG o WebP estatico.',
    IMAGE_INVALID: 'La fotografia esta vacia, danada o no es una imagen valida.',
    IMAGE_DIMENSIONS_LIMIT: 'La fotografia supera el limite de 40 megapixeles.',
    IMAGE_REFERENCE_INVALID: 'La fotografia no pertenece a este negocio o ya no esta disponible. Vuelve a seleccionarla.',
    IMAGE_STORAGE_UNAVAILABLE: 'El almacenamiento de fotografias del servidor no esta disponible.',
    IMAGE_QUOTA_EXCEEDED: 'El negocio alcanzo su limite de almacenamiento de fotografias.',
    IMAGE_BUSY: 'El servidor esta procesando otras fotografias. Intenta nuevamente en unos segundos.',
    TOO_MANY_ATTEMPTS: 'Demasiados intentos. Espera antes de intentar nuevamente.',
    BARCODE_EXISTS: 'Ese c\u00f3digo de barras ya existe en este negocio.',
    PRODUCT_CONFLICT: 'El producto cambi\u00f3 en otra sesi\u00f3n. Actualiza el inventario y abre la edici\u00f3n nuevamente.',
    PRODUCT_NOT_FOUND: 'Producto no encontrado en este negocio.',
    INSUFFICIENT_STOCK: 'No hay existencias suficientes para esa salida.',
    STOCK_LIMIT: 'Las existencias superan el l\u00edmite permitido.',
    PRODUCT_ARCHIVED: 'El producto est\u00e1 archivado; su historial se conserva.',
    DATABASE_UNAVAILABLE: 'La base de datos no est\u00e1 disponible. Intenta consultar nuevamente.',
    RETRY_OPERATION: 'La operaci\u00f3n no se complet\u00f3 por concurrencia. Consulta el inventario antes de reintentar.',
    INTERNAL_ERROR: 'El servidor no pudo completar la solicitud.',
    REPORTS_UNAVAILABLE: 'Los reportes conectados no están disponibles con la versión actual del servidor.'
  };
  class ApiError extends Error {
    constructor(code, status = 0) { super(messages[code] || 'No se pudo completar la solicitud.'); this.code = code; this.status = status; }
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
    async #request(path, method = 'GET', body, contentType = 'application/json') {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
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
        const businessDeleteCodes = ['BUSINESS_NOT_FOUND', 'BUSINESS_DELETE_PROTECTED', 'BUSINESS_HAS_DATA', 'BUSINESS_DELETE_CONFIRMATION_REQUIRED'];
        const businessPlanCodes = ['SYSTEM_ADMIN_BILLING_MIGRATION_REQUIRED', 'BUSINESS_PLAN_INVALID', 'BUSINESS_PLAN_NOT_MONTHLY', 'PAYMENT_AMOUNT_INVALID', 'PAYMENT_DATE_FUTURE'];
        if ((businessDeleteCodes.includes(code) || businessPlanCodes.includes(code)) && typeof serverMessage === 'string' && serverMessage.trim() && serverMessage.length <= 500) error.message = serverMessage.trim();
        else if (typeof receivedCode === 'string' && !Object.prototype.hasOwnProperty.call(messages, code)) error.message = 'El servidor devolvi\u00f3 el error ' + code + '.';
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
    #write(path, method, body, contentType = 'application/json') {
      const operation = this.#pending.catch(() => {}).then(async () => {
        if (!this.#csrf) await this.csrf();
        try { return await this.#request(path, method, body, contentType); }
        catch (error) {
          if (error.code !== 'CSRF_FAILED') throw error;
          if (this.#ownerIdentity) await this.me(); else await this.csrf();
          return this.#request(path, method, body, contentType);
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
        if (!/^[1-9]\d*$/.test(sale.id || '') || !/^\d{6,20}$/.test(sale.invoiceNumber || '') || !['COMPLETED', 'CANCELLED'].includes(sale.status) || !['CASH', 'CARD', 'TRANSFER', 'CREDIT'].includes(sale.paymentMethod) || !['NOT_APPLICABLE', 'PENDING', 'CONFIRMED'].includes(sale.cashStatus) || !Array.isArray(sale.items) || !Number.isFinite(Date.parse(sale.createdAt)) || !['subtotal','discount','total','tax'].every(field => /^\d+\.\d{2}$/.test(sale[field]))) throw new ApiError('INVALID_RESPONSE');
      }
      if (value.payment) { const payment = value.payment; if (!/^[1-9]\d*$/.test(payment.id || '') || !/^[1-9]\d*$/.test(payment.saleId || '') || !/^[1-9]\d*$/.test(payment.clientId || '') || payment.businessId !== this.#effectiveBusinessId() || !/^\d+\.\d{2}$/.test(payment.amount || '') || !['CASH','CARD','TRANSFER'].includes(payment.paymentMethod) || !['PENDING','POSTED'].includes(payment.status)) throw new ApiError('INVALID_RESPONSE'); }
      return value;
    }
    #cashRecord(value) {
      const amount = candidate => (typeof candidate === 'string' || typeof candidate === 'number') && Number.isFinite(Number(candidate));
      if (!value || typeof value !== 'object' || value.businessId !== this.#effectiveBusinessId() || !/^[1-9]\d{0,19}$/.test(value.id || '') || !['OPEN', 'CLOSED'].includes(value.status) || !amount(value.openingAmount) || !amount(value.expectedAmount) || !Number.isFinite(Date.parse(value.openedAt)) || (value.closedAt !== null && value.closedAt !== undefined && !Number.isFinite(Date.parse(value.closedAt))) || (value.movements !== undefined && !Array.isArray(value.movements))) throw new ApiError('CASH_RESPONSE_INVALID');
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
    async sale(id) { const value = this.#salesResult(await this.#request('/sales/' + encodeURIComponent(id))); return value.sale; }
    async currentCash(full=false) { const value=await this.#request('/cash/current'+(full?'?full=true':'')); if(!value || !Object.prototype.hasOwnProperty.call(value, 'cash')) throw new ApiError('CASH_RESPONSE_INVALID'); if(value.cash===null) return null; return this.#cashRecord(value.cash); }
    async cashSessions(offset=0) { const value=await this.#request('/cash/sessions?limit=100&offset='+offset); if(!Array.isArray(value?.sessions)) throw new ApiError('CASH_RESPONSE_INVALID'); return value.sessions.map(cash=>this.#cashRecord(cash)); }
    async openCash(data) { return this.#cashOperation(await this.#write('/cash/sessions','POST',data), 'OPEN_CASH'); }
    async closeCash(id,data) { return this.#cashOperation(await this.#write('/cash/sessions/'+encodeURIComponent(id)+'/close','POST',data), 'CLOSE_CASH'); }
    async salesFlow() { const value=await this.#request('/business-settings/sales-flow'); if(value?.businessId!==this.#effectiveBusinessId()||!['DIRECT','CENTRALIZED'].includes(value.salesFlow)) throw new ApiError('INVALID_RESPONSE'); return value; }
    async setSalesFlow(salesFlow) { const value=await this.#write('/business-settings/sales-flow','PUT',{salesFlow}); if(value?.businessId!==this.#effectiveBusinessId()||value.salesFlow!==salesFlow) throw new ApiError('INVALID_RESPONSE'); return value; }
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
    async confirmPayment(id,data) { return this.#salesResult(await this.#write('/cash/payments/'+encodeURIComponent(id)+'/confirm','POST',data)); }
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
    async enter(module) { const value = await this.#write('/auth/modules/' + encodeURIComponent(module) + '/enter', 'POST', {}); if (value?.module !== module || value.allowed !== true) throw new ApiError('INVALID_RESPONSE'); return value; }
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
    async cancelPurchase(id, data) { const value = this.#salesResult(await this.#write('/purchases/' + encodeURIComponent(id) + '/cancel', 'POST', data)); if (value?.purchase?.businessId !== this.#effectiveBusinessId() || value.purchase.status !== 'CANCELLED') throw new ApiError('INVALID_RESPONSE'); return value.purchase; }
    async payables(offset = 0, q = '') { const value = await this.#request('/payables?limit=100&offset=' + encodeURIComponent(offset) + (q ? '&q=' + encodeURIComponent(q) : '')); if (!Array.isArray(value?.payables) || value.payables.length > 100) throw new ApiError('INVALID_RESPONSE'); return value.payables; }
    async payable(id) { const value = await this.#request('/payables/' + encodeURIComponent(id)); if (value?.purchase?.businessId !== this.#effectiveBusinessId() || value.purchase.purchaseType !== 'CREDIT' || !Array.isArray(value.purchase.items)) throw new ApiError('INVALID_RESPONSE'); return value.purchase; }
    async payablesSummary() { const value = await this.#request('/payables/summary'); if (value?.summary?.businessId !== this.#effectiveBusinessId() || !/^\d+\.\d{2}$/.test(value.summary.balance || '') || !/^\d+\.\d{2}$/.test(value.summary.pendingPayments || '')) throw new ApiError('INVALID_RESPONSE'); return value.summary; }
    async paySupplierInvoice(id, data) { const value = await this.#write('/payables/' + encodeURIComponent(id) + '/payments', 'POST', data); if (value?.payment?.businessId !== this.#effectiveBusinessId() || value.payment.purchaseId !== String(id) || !['CASH', 'CARD', 'TRANSFER', 'OTHER'].includes(value.payment.paymentMethod) || !['PENDING', 'POSTED'].includes(value.payment.status)) throw new ApiError('INVALID_RESPONSE'); return value.payment; }
    async users(offset = 0) {
      const value = await this.#request('/users?limit=100&offset=' + encodeURIComponent(offset));
      if (!Array.isArray(value?.users)) throw new ApiError('INVALID_RESPONSE');
      return value.users.map(item => {
        const validated = user({ ...item, active: true });
        if (typeof item.active !== 'boolean') throw new ApiError('INVALID_RESPONSE');
        return { ...validated, active: item.active };
      });
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
      const planCodes = ['LOCAL', 'CONECTADO_BASICO', 'CONECTADO_PREMIUM'];
      const statuses = ['UNASSIGNED', 'NOT_APPLICABLE', 'DATE_PENDING', 'OVERDUE', 'DUE_TODAY', 'DUE_SOON', 'CURRENT'];
      const summaryFields = ['activeBusinesses', 'localPlans', 'monthlyPlans', 'paymentsDueSoon', 'paymentsOverdue', 'unassignedPlans'];
      const date = candidate => candidate === null || /^\d{4}-\d{2}-\d{2}$/.test(candidate || '');
      if (!value || !Array.isArray(value.plans) || !Array.isArray(value.businesses) || !value.summary || !summaryFields.every(key => Number.isSafeInteger(value.summary[key]) && value.summary[key] >= 0) || !date(value.today)) throw new ApiError('INVALID_RESPONSE');
      if (!value.plans.every(plan => planCodes.includes(plan.code) && typeof plan.name === 'string' && typeof plan.monthly === 'boolean' && typeof plan.reminders === 'boolean' && Number.isSafeInteger(plan.includedUsers))) throw new ApiError('INVALID_RESPONSE');
      for (const business of value.businesses) {
        if (!/^[1-9]\d{0,19}$/.test(business.id || '') || typeof business.name !== 'string' || !['ACTIVE', 'INACTIVE'].includes(business.status) || !Number.isSafeInteger(business.userCount) || !(business.planCode === null || planCodes.includes(business.planCode)) || typeof business.planName !== 'string' || typeof business.monthly !== 'boolean' || !date(business.nextDueDate) || !statuses.includes(business.paymentStatus) || !(business.lastPayment === null || (date(business.lastPayment.date) && /^\d+\.\d{2}$/.test(business.lastPayment.amount || '')))) throw new ApiError('INVALID_RESPONSE');
      }
      const reminder = value.reminder;
      if (reminder !== null && (!reminder || !/^[1-9]\d{0,19}$/.test(reminder.businessId || '') || typeof reminder.businessName !== 'string' || !date(reminder.dueDate) || !Number.isSafeInteger(reminder.daysUntil) || reminder.daysUntil < 0 || reminder.daysUntil > 7)) throw new ApiError('INVALID_RESPONSE');
      return value;
    }
    async setAdminBusinessPlan(id, planCode, nextDueDate) {
      this.#requireSystemAdmin();
      if (typeof id !== 'string' || !/^[1-9]\d{0,19}$/.test(id) || !['LOCAL', 'CONECTADO_BASICO', 'CONECTADO_PREMIUM'].includes(planCode) || !(nextDueDate === null || nextDueDate === '' || /^\d{4}-\d{2}-\d{2}$/.test(nextDueDate))) throw new ApiError('INVALID_INPUT');
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
        if (!/^[1-9]\d{0,19}$/.test(item.id || '') || typeof item.name !== 'string' || !item.name.trim() || !['ACTIVE', 'INACTIVE'].includes(item.status) || !Number.isSafeInteger(item.userCount) || item.userCount < 0) throw new ApiError('INVALID_RESPONSE');
        return item;
      });
    }
    async migrateBasic(targetBusinessId, packageValue, confirmSystemBusiness = false) {
      this.#requireSystemAdmin();
      if (typeof targetBusinessId !== 'string' || !/^[1-9]\d{0,19}$/.test(targetBusinessId) ||
          !packageValue || packageValue.type !== 'pos_local_migration_package' || packageValue.version !== 1 ||
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
      if (!packageValue || packageValue.type !== 'pos_local_migration_package' || packageValue.version !== 1 ||
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
    async createAdminBusiness(name) {
      this.#requireSystemAdmin();
      const value = await this.#write('/admin/businesses', 'POST', { name });
      if (!value?.business || !/^[1-9]\d{0,19}$/.test(value.business.id || '') || value.business.name !== name.trim() || value.business.status !== 'ACTIVE') throw new ApiError('INVALID_RESPONSE');
      return value.business;
    }
    async setAdminBusinessStatus(id, status) {
      this.#requireSystemAdmin();
      if (!['ACTIVE', 'INACTIVE'].includes(status)) throw new ApiError('INVALID_INPUT');
      const value = await this.#write('/admin/businesses/' + encodeURIComponent(id) + '/status', 'PATCH', { status });
      if (value?.business?.id !== String(id) || value.business.status !== status) throw new ApiError('INVALID_RESPONSE');
      return value.business;
    }
    async deleteAdminBusiness(id, confirmation) {
      this.#requireSystemAdmin();
      if (typeof id !== 'string' || !/^[1-9]\d{0,19}$/.test(id)) throw new ApiError('INVALID_INPUT');
      if (confirmation !== 'ELIMINAR') throw new ApiError('BUSINESS_DELETE_CONFIRMATION_REQUIRED', 400);
      await this.#write('/admin/businesses/' + encodeURIComponent(id), 'DELETE', { confirmation });
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
      const value = await this.#write('/admin/businesses/' + encodeURIComponent(businessId) + '/users', 'POST', data);
      if (value?.user?.businessId !== String(businessId) || value.user.active !== true) throw new ApiError('INVALID_RESPONSE');
      return value.user;
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
})();
