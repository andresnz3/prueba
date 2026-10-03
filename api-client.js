'use strict';
(() => {
  const messages = {
    NETWORK_ERROR: 'No se pudo conectar con el servidor. Revisa la conexión e intenta de nuevo.',
    INVALID_RESPONSE: 'El servidor devolvió una respuesta inesperada.',
    INVALID_CREDENTIALS: 'Credenciales incorrectas o cuenta no disponible.',
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
    INTERNAL_ERROR: 'El servidor no pudo completar la solicitud.'
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
      if (!response.ok) throw new ApiError(data?.error?.code || 'INTERNAL_ERROR', response.status);
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
