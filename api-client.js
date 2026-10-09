'use strict';
(() => {
  const messages = {
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
    INVALID_CREDENTIALS: 'El usuario o la contraseña son incorrectos (Credenciales incorrectas).',
    INVALID_SESSION: 'La sesión venció o fue revocada. Inicia sesión nuevamente.',
    CSRF_FAILED: 'No se pudo validar la solicitud. Intenta nuevamente.',
    MODULE_FORBIDDEN: 'Este módulo requiere autorización de un administrador.',
    ADMIN_REQUIRED: 'Solo un administrador del negocio puede gestionar usuarios.',
    LAST_ACTIVE_ADMIN: 'Debe permanecer al menos un administrador activo.',
    USERNAME_EXISTS: 'Ese nombre de usuario ya existe en el negocio.',
    INVALID_INPUT: 'Revisa los campos ingresados.',
    PAYLOAD_TOO_LARGE: 'La solicitud es demasiado grande. Usa el selector para cargar la fotografia por separado.',
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
    return Object.freeze({ id: value.id, businessId: value.businessId, username: value.username, fullName: value.fullName, role: value.role, active: true });
  }
  function session(value) {
    if (!value || typeof value.csrfToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.csrfToken) || typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt))) throw new ApiError('INVALID_RESPONSE');
    return { user: user(value.user), expiresAt: value.expiresAt, csrfToken: value.csrfToken };
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
    #identity = null;
    #pending = Promise.resolve();
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
        const error = new ApiError(data?.error?.code || 'INTERNAL_ERROR', response.status);
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
          if (this.#identity) await this.me(); else await this.csrf();
          return this.#request(path, method, body, contentType);
        }
      });
      this.#pending = operation.then(() => undefined, () => undefined);
      return operation;
    }
    #salesResult(value) {
      const record = value?.sale || value?.cash || value?.order || value?.movement || value?.payment || value?.supplierPayment || value?.purchase || value?.overview || value;
      if (record.businessId !== this.#identity?.businessId) throw new ApiError('INVALID_RESPONSE');
      if (value.sale) {
        const sale = value.sale;
        if (!/^[1-9]\d*$/.test(sale.id || '') || !/^\d{6,20}$/.test(sale.invoiceNumber || '') || !['COMPLETED', 'CANCELLED'].includes(sale.status) || !['CASH', 'CARD', 'TRANSFER', 'CREDIT'].includes(sale.paymentMethod) || !['NOT_APPLICABLE', 'PENDING', 'CONFIRMED'].includes(sale.cashStatus) || !Array.isArray(sale.items) || !Number.isFinite(Date.parse(sale.createdAt)) || !['subtotal','discount','total','tax'].every(field => /^\d+\.\d{2}$/.test(sale[field]))) throw new ApiError('INVALID_RESPONSE');
      }
      if (value.payment) { const payment = value.payment; if (!/^[1-9]\d*$/.test(payment.id || '') || !/^[1-9]\d*$/.test(payment.saleId || '') || !/^[1-9]\d*$/.test(payment.clientId || '') || payment.businessId !== this.#identity?.businessId || !/^\d+\.\d{2}$/.test(payment.amount || '') || !['CASH','CARD','TRANSFER'].includes(payment.paymentMethod) || !['PENDING','POSTED'].includes(payment.status)) throw new ApiError('INVALID_RESPONSE'); }
      return value;
    }
    async nextInvoiceNumber() { const value = await this.#request('/sales/next-invoice'); if (value?.businessId !== this.#identity?.businessId || !/^\d{6,20}$/.test(value.invoiceNumber || '')) throw new ApiError('INVALID_RESPONSE'); return value.invoiceNumber; }
    async quoteSale(data) { const value = await this.#write('/sales/quote', 'POST', data); if (!value?.quote || value.quote.businessId !== this.#identity?.businessId || !/^[a-f0-9]{64}$/.test(value.quote.quoteToken) || !/^\d+\.\d{2}$/.test(value.quote.total) || !Array.isArray(value.quote.items)) throw new ApiError('INVALID_RESPONSE'); return value.quote; }
    async createSale(data) { return this.#salesResult(await this.#write('/sales','POST',data)); }
    async cancelSale(id,data) { return this.#salesResult(await this.#write('/sales/'+encodeURIComponent(id)+'/cancel','POST',data)); }
    async operation(key) { return this.#salesResult(await this.#request('/operations/'+encodeURIComponent(key))); }
    async resolveOperation(key) { return this.#salesResult(await this.#write('/operations/'+encodeURIComponent(key)+'/resolve','POST',{})); }
    async sales(offset=0,maxId=null) { const value=await this.#request('/sales?limit=100&offset='+offset+(maxId ? '&maxId='+encodeURIComponent(maxId) : '')); if(!Array.isArray(value?.sales)) throw new ApiError('INVALID_RESPONSE'); return value.sales.map(sale=>this.#salesResult({sale}).sale); }
    async sale(id) { const value = this.#salesResult(await this.#request('/sales/' + encodeURIComponent(id))); return value.sale; }
    async currentCash(full=false) { const value=await this.#request('/cash/current'+(full?'?full=true':'')); if(value?.cash===null) return null; return this.#salesResult(value).cash; }
    async cashSessions(offset=0) { const value=await this.#request('/cash/sessions?limit=100&offset='+offset); if(!Array.isArray(value?.sessions)) throw new ApiError('INVALID_RESPONSE'); return value.sessions.map(cash=>this.#salesResult({cash}).cash); }
    async openCash(data) { return this.#salesResult(await this.#write('/cash/sessions','POST',data)); }
    async closeCash(id,data) { return this.#salesResult(await this.#write('/cash/sessions/'+encodeURIComponent(id)+'/close','POST',data)); }
    async salesFlow() { const value=await this.#request('/business-settings/sales-flow'); if(value?.businessId!==this.#identity?.businessId||!['DIRECT','CENTRALIZED'].includes(value.salesFlow)) throw new ApiError('INVALID_RESPONSE'); return value; }
    async setSalesFlow(salesFlow) { const value=await this.#write('/business-settings/sales-flow','PUT',{salesFlow}); if(value?.businessId!==this.#identity?.businessId||value.salesFlow!==salesFlow) throw new ApiError('INVALID_RESPONSE'); return value; }
    async cashOverview() { const value=await this.#request('/cash/overview'); if(!value?.overview) throw new ApiError('INVALID_RESPONSE'); return this.#salesResult({overview:value.overview}).overview; }
    async connectedReport(from = null, until = null) {
      const query = new URLSearchParams();
      if (from) query.set('from', from);
      if (until) query.set('until', until);
      const queryString = query.toString();
      const value = await this.#request('/reports/connected' + (queryString ? '?' + queryString : ''));
      const report = value?.report;
      const moneyValue = candidate => typeof candidate === 'string' && /^-?\d{1,10}\.\d{2}$/.test(candidate);
      if (report?.businessId !== this.#identity?.businessId || !report.sales || !report.cash || !report.inventory || !report.receivables || !report.expenses || !report.purchases || !report.payables || !report.suppliers || !moneyValue(report.sales.total) || !moneyValue(report.sales.cost) || !moneyValue(report.sales.grossProfit) || !moneyValue(report.sales.netProfit) || !moneyValue(report.expenses.total) || !Number.isSafeInteger(report.expenses.count) || !Array.isArray(report.expenses.byCategory) || !Array.isArray(report.expenses.history) || !Array.isArray(report.inventory.movements) || !moneyValue(report.cash.periodIn) || !moneyValue(report.cash.periodOut) || !(report.cash.currentExpected === null || moneyValue(report.cash.currentExpected)) || !Array.isArray(report.sales.history) || !Array.isArray(report.sales.paymentMethods) || !Array.isArray(report.sales.sellers) || !Array.isArray(report.sales.topProducts) || !Array.isArray(report.cash.closures) || !Array.isArray(report.cash.movements) || !Array.isArray(report.inventory.products) || !Array.isArray(report.receivables.clients) || !Array.isArray(report.receivables.payments) || !moneyValue(report.purchases.total) || !Array.isArray(report.purchases.history) || !moneyValue(report.payables.balance) || !moneyValue(report.payables.pendingPayments) || !Array.isArray(report.payables.invoices) || !Array.isArray(report.suppliers.list) || !Array.isArray(report.suppliers.payments)) throw new ApiError('INVALID_RESPONSE');
      return report;
    }
    async confirmPayment(id,data) { return this.#salesResult(await this.#write('/cash/payments/'+encodeURIComponent(id)+'/confirm','POST',data)); }
    async prepareOrder(data) { return this.#salesResult(await this.#write('/sales/orders','POST',data)); }
    async quoteOrder(id,paymentMethod) { const value=await this.#write('/cash/orders/'+encodeURIComponent(id)+'/quote','POST',{paymentMethod}); if(!value?.quote||value.quote.businessId!==this.#identity?.businessId||value.quote.orderId!==String(id)||!/^[a-f0-9]{64}$/.test(value.quote.quoteToken)||!/^\d+\.\d{2}$/.test(value.quote.total)||!/^\d+\.\d{2}$/.test(value.quote.estimatedTotal)) throw new ApiError('INVALID_RESPONSE'); return value.quote; }
    async chargeOrder(id,data) { return this.#salesResult(await this.#write('/cash/orders/'+encodeURIComponent(id)+'/charge','POST',data)); }
    async cancelOrder(id,data) { return this.#salesResult(await this.#write('/cash/orders/'+encodeURIComponent(id)+'/cancel','POST',data)); }
    async uploadImage(file) {
      const value = await this.#write('/product-images','POST',file,file.type);
      const match = typeof value?.image === 'string' && /^\/api\/product-images\/([1-9]\d{0,19})\/[a-f0-9]{32}\.jpg$/.exec(value.image);
      if (!match || match[1] !== value.businessId || value.businessId !== this.#identity?.businessId) throw new ApiError('INVALID_RESPONSE');
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
    async login(businessId, username, password) {
      try { await this.me(); await this.logout(); } catch (error) { if (error.code !== 'INVALID_SESSION') throw error; }
      this.#csrf = null; this.#identity = null;
      const value = session(await this.#write('/auth/login', 'POST', { businessId, username, password })); this.#csrf = value.csrfToken; this.#identity = value.user; return value;
    }
    async me() {
      const value = session(await this.#request('/auth/me'));
      if (this.#identity && (this.#identity.id !== value.user.id || this.#identity.businessId !== value.user.businessId)) throw new ApiError('INVALID_SESSION', 401);
      this.#csrf = value.csrfToken; this.#identity = value.user; return value;
    }
    async logout() { await this.#write('/auth/logout', 'POST', {}); this.#csrf = null; this.#identity = null; }
    async renew() { const value = session(await this.#write('/auth/renew', 'POST', {})); this.#csrf = value.csrfToken; return value; }
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
        if (!/^[1-9]\d{0,19}$/.test(item.id || '') || item.businessId !== this.#identity?.businessId || typeof item.name !== 'string' || typeof item.active !== 'boolean' || !Number.isInteger(item.creditDays) || item.creditDays < 1 || item.creditDays > 3650 || !['creditLimit','debt','availableCredit','pendingPayments'].every(key => /^-?\d+\.\d{2}$/.test(item[key] || ''))) throw new ApiError('INVALID_RESPONSE');
        return item;
      });
    }
    async createClient(data) { const value = await this.#write('/clients', 'POST', data); if (value?.client?.businessId !== this.#identity?.businessId) throw new ApiError('INVALID_RESPONSE'); return value.client; }
    async updateClient(id, data) { const value = await this.#write('/clients/' + encodeURIComponent(id), 'PATCH', data); if (value?.client?.businessId !== this.#identity?.businessId) throw new ApiError('INVALID_RESPONSE'); return value.client; }
    async setClientActive(id, active) { const value = await this.#write('/clients/' + encodeURIComponent(id) + '/active', 'PATCH', { active }); if (value?.businessId !== this.#identity?.businessId || value.id !== String(id) || value.active !== active) throw new ApiError('INVALID_RESPONSE'); return value; }
    async receivables(offset = 0, q = '') {
      const value = await this.#request('/receivables?limit=100&offset=' + encodeURIComponent(offset) + (q ? '&q=' + encodeURIComponent(q) : ''));
      if (!Array.isArray(value?.receivables) || value.receivables.length > 100) throw new ApiError('INVALID_RESPONSE');
      for (const item of value.receivables) if (item.businessId !== this.#identity?.businessId || !['OPEN','OVERDUE','PAID','CANCELLED','PENDING_CONFIRMATION'].includes(item.status)) throw new ApiError('INVALID_RESPONSE');
      return value.receivables;
    }
    async clientStatement(id) { const value = await this.#request('/clients/' + encodeURIComponent(id) + '/statement?limit=100&offset=0'); if (value?.client?.businessId !== this.#identity?.businessId || !Array.isArray(value.invoices) || !Array.isArray(value.payments)) throw new ApiError('INVALID_RESPONSE'); return value; }
    async payReceivable(id, data) { return this.#salesResult(await this.#write('/receivables/' + encodeURIComponent(id) + '/payments', 'POST', data)); }
    async expenses(offset = 0, q = '') { const value = await this.#request('/expenses?limit=100&offset=' + encodeURIComponent(offset) + (q ? '&q=' + encodeURIComponent(q) : '')); if (!Array.isArray(value?.expenses) || value.expenses.length > 100 || value?.summary?.businessId !== this.#identity?.businessId || !['total', 'today'].every(key => /^\d+\.\d{2}$/.test(value.summary[key] || '')) || !Number.isSafeInteger(value.summary.count)) throw new ApiError('INVALID_RESPONSE'); return value; }
    async createExpense(data) { const value = await this.#write('/expenses', 'POST', data); if (value?.kind !== 'EXPENSE' || value.expense?.businessId !== this.#identity?.businessId || !/^[1-9]\d*$/.test(value.expense.id || '') || !/^\d+\.\d{2}$/.test(value.expense.amount || '')) throw new ApiError('INVALID_RESPONSE'); return value.expense; }
    async cancelExpense(id, data) { const value = await this.#write('/expenses/' + encodeURIComponent(id) + '/cancel', 'POST', data); if (value?.kind !== 'EXPENSE' || value.expense?.businessId !== this.#identity?.businessId || value.expense.id !== String(id) || value.expense.status !== 'VOID') throw new ApiError('INVALID_RESPONSE'); return value.expense; }
    async suppliers(offset = 0, q = '') {
      const value = await this.#request('/suppliers?limit=100&offset=' + encodeURIComponent(offset) + (q ? '&q=' + encodeURIComponent(q) : ''));
      if (!Array.isArray(value?.suppliers) || value.suppliers.length > 100) throw new ApiError('INVALID_RESPONSE');
      return value.suppliers.map(item => {
        if (!/^[1-9]\d{0,19}$/.test(item.id || '') || item.businessId !== this.#identity?.businessId || typeof item.name !== 'string' || typeof item.active !== 'boolean' || !['totalPurchased', 'debt', 'pendingPayments'].every(key => /^-?\d+\.\d{2}$/.test(item[key] || ''))) throw new ApiError('INVALID_RESPONSE');
        return item;
      });
    }
    async createSupplier(data) { const value = await this.#write('/suppliers', 'POST', data); if (value?.supplier?.businessId !== this.#identity?.businessId) throw new ApiError('INVALID_RESPONSE'); return value.supplier; }
    async purchaseSuppliers(offset = 0, q = '') {
      const value = await this.#request('/purchases/suppliers?limit=100&offset=' + encodeURIComponent(offset) + (q ? '&q=' + encodeURIComponent(q) : ''));
      if (!Array.isArray(value?.suppliers) || value.suppliers.length > 100) throw new ApiError('INVALID_RESPONSE');
      return value.suppliers.map(item => {
        if (!/^[1-9]\d{0,19}$/.test(item.id || '') || item.businessId !== this.#identity?.businessId || typeof item.name !== 'string' || typeof item.active !== 'boolean') throw new ApiError('INVALID_RESPONSE');
        return item;
      });
    }
    async createPurchaseSupplier(data) { const value = await this.#write('/purchases/suppliers', 'POST', data); if (value?.supplier?.businessId !== this.#identity?.businessId) throw new ApiError('INVALID_RESPONSE'); return value.supplier; }
    async updateSupplier(id, data) { const value = await this.#write('/suppliers/' + encodeURIComponent(id), 'PATCH', data); if (value?.supplier?.businessId !== this.#identity?.businessId || value.supplier.id !== String(id)) throw new ApiError('INVALID_RESPONSE'); return value.supplier; }
    async setSupplierActive(id, active) { const value = await this.#write('/suppliers/' + encodeURIComponent(id) + '/active', 'PATCH', { active }); if (value?.businessId !== this.#identity?.businessId || value.id !== String(id) || value.active !== active) throw new ApiError('INVALID_RESPONSE'); return value; }
    async supplierStatement(id) { const value = await this.#request('/suppliers/' + encodeURIComponent(id) + '/statement?limit=100&offset=0'); if (value?.supplier?.businessId !== this.#identity?.businessId || !Array.isArray(value.entries)) throw new ApiError('INVALID_RESPONSE'); return value; }
    async purchaseProducts(offset = 0, q = '') {
      const value = await this.#request('/purchases/products?limit=100&offset=' + encodeURIComponent(offset) + (q ? '&q=' + encodeURIComponent(q) : ''));
      if (!Array.isArray(value?.products) || value.products.length > 100) throw new ApiError('INVALID_RESPONSE');
      return value.products.map(item => {
        if (!/^[1-9]\d{0,19}$/.test(item.id || '') || item.businessId !== this.#identity?.businessId || typeof item.name !== 'string' || !['cost', 'marginRetail', 'marginWholesale', 'retailPrice', 'wholesalePrice', 'stock'].every(field => Number.isFinite(Number(item[field])))) throw new ApiError('INVALID_RESPONSE');
        return { ...item, business_id: item.businessId, deleted: false };
      });
    }
    async createPurchaseProduct(data) { const value = await this.#write('/purchases/products', 'POST', data); if (value?.product?.businessId !== this.#identity?.businessId || !/^[1-9]\d{0,19}$/.test(value.product.id || '')) throw new ApiError('INVALID_RESPONSE'); return value.product; }
    async purchases(offset = 0, q = '') { const value = await this.#request('/purchases?limit=100&offset=' + encodeURIComponent(offset) + (q ? '&q=' + encodeURIComponent(q) : '')); if (!Array.isArray(value?.purchases) || value.purchases.length > 100) throw new ApiError('INVALID_RESPONSE'); return value.purchases; }
    async purchase(id) { const value = await this.#request('/purchases/' + encodeURIComponent(id)); if (value?.purchase?.businessId !== this.#identity?.businessId || !Array.isArray(value.purchase.items)) throw new ApiError('INVALID_RESPONSE'); return value.purchase; }
    async createPurchase(data) { const value = this.#salesResult(await this.#write('/purchases', 'POST', data)); if (value?.purchase?.businessId !== this.#identity?.businessId) throw new ApiError('INVALID_RESPONSE'); return value.purchase; }
    async cancelPurchase(id, data) { const value = this.#salesResult(await this.#write('/purchases/' + encodeURIComponent(id) + '/cancel', 'POST', data)); if (value?.purchase?.businessId !== this.#identity?.businessId || value.purchase.status !== 'CANCELLED') throw new ApiError('INVALID_RESPONSE'); return value.purchase; }
    async payables(offset = 0, q = '') { const value = await this.#request('/payables?limit=100&offset=' + encodeURIComponent(offset) + (q ? '&q=' + encodeURIComponent(q) : '')); if (!Array.isArray(value?.payables) || value.payables.length > 100) throw new ApiError('INVALID_RESPONSE'); return value.payables; }
    async payable(id) { const value = await this.#request('/payables/' + encodeURIComponent(id)); if (value?.purchase?.businessId !== this.#identity?.businessId || value.purchase.purchaseType !== 'CREDIT' || !Array.isArray(value.purchase.items)) throw new ApiError('INVALID_RESPONSE'); return value.purchase; }
    async payablesSummary() { const value = await this.#request('/payables/summary'); if (value?.summary?.businessId !== this.#identity?.businessId || !/^\d+\.\d{2}$/.test(value.summary.balance || '') || !/^\d+\.\d{2}$/.test(value.summary.pendingPayments || '')) throw new ApiError('INVALID_RESPONSE'); return value.summary; }
    async paySupplierInvoice(id, data) { const value = await this.#write('/payables/' + encodeURIComponent(id) + '/payments', 'POST', data); if (value?.payment?.businessId !== this.#identity?.businessId || value.payment.purchaseId !== String(id) || !['CASH', 'CARD', 'TRANSFER', 'OTHER'].includes(value.payment.paymentMethod) || !['PENDING', 'POSTED'].includes(value.payment.status)) throw new ApiError('INVALID_RESPONSE'); return value.payment; }
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
  }
  window.PosApiClient = PosApiClient;
  window.PosApiError = ApiError;
})();
