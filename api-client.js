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
    TOO_MANY_ATTEMPTS: 'Demasiados intentos. Espera antes de intentar nuevamente.',
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
  class PosApiClient {
    #csrf = null;
    #pending = Promise.resolve();
    constructor(baseUrl) {
      const url = new URL(baseUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/api')) throw new ApiError('INVALID_INPUT');
      this.baseUrl = url.href.replace(/\/$/, '');
    }
    async #request(path, method = 'GET', body) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      let response;
      try {
        response = await fetch(this.baseUrl + path, { method, credentials: 'include', cache: 'no-store', redirect: 'error', signal: controller.signal,
          headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': this.#csrf || '' },
          body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
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
    #write(path, method, body) {
      const operation = this.#pending.catch(() => {}).then(async () => {
        if (!this.#csrf) await this.csrf();
        try { return await this.#request(path, method, body); }
        catch (error) { if (error.code !== 'CSRF_FAILED') throw error; await this.csrf(); return this.#request(path, method, body); }
      });
      this.#pending = operation.then(() => undefined, () => undefined);
      return operation;
    }
    async login(businessId, username, password) {
      try { await this.me(); await this.logout(); } catch (error) { if (error.code !== 'INVALID_SESSION') throw error; }
      this.#csrf = null;
      const value = session(await this.#write('/auth/login', 'POST', { businessId, username, password })); this.#csrf = value.csrfToken; return value;
    }
    async me() { const value = session(await this.#request('/auth/me')); this.#csrf = value.csrfToken; return value; }
    async logout() { await this.#write('/auth/logout', 'POST', {}); this.#csrf = null; }
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
