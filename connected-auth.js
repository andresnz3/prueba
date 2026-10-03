/* global connectedMode, localDB, initApp, actualizarCatalogo, renderPosView, detenerCamaraVentas */
'use strict';
(() => {
  const el = id => document.getElementById(id);
  const mutationLock = () => { if (!identity) throw new window.PosApiError('INVALID_SESSION', 401); };
  const mode = el('authMode'); mode.value = connectedMode ? 'connected' : 'local';
  mode.addEventListener('change', () => {
    const url = new URL(location.href); if (mode.value === 'connected') url.searchParams.set('mode', 'connected'); else url.searchParams.delete('mode');
    location.assign(url.href);
  });
  if (!connectedMode) return;
  el('businessLoginGroup').classList.remove('hidden');
  el('loginBusinessId').disabled = false; el('loginBusinessId').required = true;
  el('adminUsernameGroup').classList.remove('hidden'); el('grantAdminUsername').disabled = false; el('grantAdminUsername').required = true;
  el('modeDescription').textContent = 'Acceso verificado. Productos e inventario en MySQL; ventas, compras y caja pendientes.';
  const api = new window.PosApiClient(window.POS_API_BASE_URL);
  const views = { salesView: 'sales', inventoryView: 'inventory', purchasesView: 'purchases', payablesView: 'payables', clientsView: 'clients', suppliersView: 'suppliers', historyView: 'history', cajaView: 'cash', gastosView: 'expenses', reportesView: 'reports', dashboardView: 'dashboard', configView: 'settings' };
  let identity = null, boundBusiness = null, activeView = null, grant = null, pendingView = null;
  let generation = 0;
  const assertGeneration = value => { if (generation !== value) throw new window.PosApiError('STALE_REQUEST'); };
  let expiryTimer, grantTimer, busy = false, passwordUserId = null, userPage = 0;
  function message(id, text) { el(id).textContent = text; el(id).classList.remove('hidden'); }
  function clearPasswords() { for (const id of ['loginPassword', 'gestorPassword', 'newUserPassword', 'changedUserPassword']) el(id).value = ''; }
  function canView(view) { return Boolean(identity && (view === 'salesView' || identity.role === 'ADMIN' || (grant?.view === view && grant.until > Date.now()))); }
  function expire(text = 'La sesión venció o fue revocada. Inicia sesión nuevamente.') {
    generation++; identity = null; window.PosRuntime.setUser(null); grant = null; pendingView = null; activeView = null;
    clearTimeout(expiryTimer); clearTimeout(grantTimer); clearPasswords();
    document.querySelectorAll('.modal, .view-panel').forEach(node => node.classList.add('hidden'));
    el('app').classList.add('hidden'); el('app').inert = false; el('loginScreen').classList.remove('hidden');
    el('navUsersBtn').classList.add('hidden'); el('renewSessionBtn').classList.add('hidden');
    el('loginBusinessId').disabled = false; el('authMode').disabled = false;
    detenerCamaraVentas(); if (localDB) localDB.close();
    window.PosRuntime.clearCart(); window.PosRuntime.setProducts([]); window.PosInventory.closePanels();
    message('loginError', text);
  }
  function error(error, target = 'connectedNotice') {
    if (error.code === 'STALE_REQUEST') return;
    if (error.code === 'INVALID_SESSION') { expire(); return; }
    message(target, error.message || 'No se pudo completar la solicitud.');
  }
  function scheduleExpiry(value) {
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(() => expire(), Math.max(0, Date.parse(value.expiresAt) - Date.now()));
  }
  async function establish(value) {
    const version = ++generation;
    if (boundBusiness && boundBusiness !== value.user.businessId) { location.reload(); return; }
    if (!boundBusiness) {
      boundBusiness = value.user.businessId;
      window.PosRuntime.prepareConnectedBusiness(boundBusiness, api.baseUrl);
    } else { await localDB.open(); }
    identity = value.user;
    window.PosRuntime.setUser(identity);
    scheduleExpiry(value);
    await initApp(); assertGeneration(version);
    if (Date.parse(value.expiresAt) <= Date.now()) throw new window.PosApiError('INVALID_SESSION', 401);
    el('sellerName').textContent = identity.fullName;
    document.querySelector('.seller-info span').textContent = 'Sesión verificada · inventario MySQL';
    el('roleBadge').textContent = identity.role === 'ADMIN' ? 'Administrador' : 'Usuario';
    el('businessContext').textContent = 'Conectado · Negocio ' + identity.businessId;
    el('businessContext').classList.remove('hidden');
    el('connectedNotice').textContent = 'Productos e inventario en MySQL. Ventas, compras, caja y demás escrituras pendientes están bloqueadas; no hay sincronización offline.';
    el('connectedNotice').classList.remove('hidden');
    el('navUsersBtn').classList.toggle('hidden', identity.role !== 'ADMIN'); el('renewSessionBtn').classList.remove('hidden');
    el('loginBusinessId').value = identity.businessId; el('loginBusinessId').disabled = true;
    el('loginError').classList.add('hidden');
    grant = null; await api.enter('sales'); assertGeneration(version); await window.PosInventory.load('salesView'); assertGeneration(version); activeView = 'salesView'; renderPosView(activeView); actualizarCatalogo();
    el('loginScreen').classList.add('hidden'); el('app').classList.remove('hidden');
  }
  async function verify() {
    const version = generation;
    const value = await api.me(); assertGeneration(version);
    if (!identity || value.user.businessId !== boundBusiness || value.user.id !== identity.id) throw new window.PosApiError('INVALID_SESSION', 401);
    identity = value.user; window.PosRuntime.setUser(identity);
    el('navUsersBtn').classList.toggle('hidden', identity.role !== 'ADMIN'); scheduleExpiry(value);
    return value;
  }
  async function navigate(view) {
    if (busy || !identity || (!views[view] && view !== 'usersView')) return;
    busy = true; el('app').inert = true;
    const previous = activeView; const version = generation;
    try {
      await verify();
      if (previous && previous !== view && grant) { await api.leave(views[previous]); grant = null; clearTimeout(grantTimer); }
      if (view === 'usersView') {
        // /users autoriza en el servidor; un cambio visual de rol nunca habilita esta ruta.
        userPage = 0; const users = await api.users(); assertGeneration(version);
        if (identity.role !== 'ADMIN') throw new window.PosApiError('ADMIN_REQUIRED', 403);
        activeView = view; renderPosView(view); renderUsers(users); return;
      }
      await api.enter(views[view]); assertGeneration(version);
      await window.PosInventory.load(view); assertGeneration(version);
      activeView = view; renderPosView(view); pendingView = null;
    } catch (failure) {
      if (failure.code === 'STALE_REQUEST') return;
      grant = null; clearTimeout(grantTimer);
      if (failure.code === 'MODULE_FORBIDDEN' && identity?.role === 'VENDEDOR') {
        activeView = 'salesView'; renderPosView(activeView); pendingView = view;
        el('authError').classList.add('hidden'); el('authModal').classList.remove('hidden'); el('grantAdminUsername').focus();
      } else {
        if (identity) { activeView = null; document.querySelectorAll('.view-panel').forEach(node => node.classList.add('hidden')); }
        error(failure);
      }
    } finally { busy = false; el('app').inert = false; }
  }
  async function login() {
    if (busy) return; busy = true; const button = el('loginForm').querySelector('button[type=submit]'); button.disabled = true;
    try {
      // Si una cookie valida permanecio tras una interrupcion, restaurar solo la misma identidad.
      const value = await api.login(el('loginBusinessId').value.trim(), el('loginUsername').value.trim(), el('loginPassword').value);
      clearPasswords(); await establish(value);
    } catch (failure) { if (identity) expire(failure.message); else error(failure, 'loginError'); }
    finally { clearPasswords(); button.disabled = false; busy = false; }
  }
  async function logout() {
    if (busy) return; busy = true; el('app').inert = true;
    try { await api.logout(); const url = new URL(location.href); url.searchParams.set('mode', 'connected'); location.assign(url.href); }
    catch (failure) { if (failure.code === 'INVALID_SESSION') expire(); else error(failure); }
    finally { busy = false; el('app').inert = false; }
  }
  async function authorize() {
    if (busy || !pendingView || !identity) return;
    const view = pendingView; const version = generation; busy = true; const button = el('authForm').querySelector('button[type=submit]'); button.disabled = true;
    try {
      const value = await api.authorize(views[view], el('grantAdminUsername').value.trim(), el('gestorPassword').value);
      await api.enter(views[view]); assertGeneration(version);
      await window.PosInventory.load(view); assertGeneration(version);
      grant = { view, until: Date.parse(value.expiresAt) }; activeView = view; pendingView = null;
      el('authModal').classList.add('hidden'); renderPosView(view);
      clearTimeout(grantTimer); grantTimer = setTimeout(() => { grant = null; navigate('salesView'); }, Math.max(0, grant.until - Date.now()));
    } catch (failure) { error(failure, 'authError'); }
    finally { el('gestorPassword').value = ''; button.disabled = false; busy = false; }
  }
  async function refreshUsers() { try { await verify(); renderUsers(await api.users(userPage * 100)); } catch (failure) { error(failure, 'usersMessage'); } }
  function renderUsers(users) {
    const body = el('usersTableBody'); body.replaceChildren();
    el('previousUsersBtn').disabled = userPage === 0; el('nextUsersBtn').disabled = users.length < 100;
    el('usersPage').textContent = String(userPage + 1);
    for (const user of users) {
      if (user.businessId !== boundBusiness) { expire('Se recibió una identidad de otro negocio.'); return; }
      const row = document.createElement('tr'); row.dataset.userId = user.id;
      for (const text of [user.username, user.fullName]) { const cell = document.createElement('td'); cell.textContent = text; row.append(cell); }
      const roleCell = document.createElement('td'), select = document.createElement('select'); select.setAttribute('aria-label', 'Rol de ' + user.username);
      for (const value of ['VENDEDOR', 'ADMIN']) { const option = new Option(value, value); select.add(option); } select.value = user.role; roleCell.append(select); row.append(roleCell);
      const state = document.createElement('td'); state.textContent = user.active ? 'Activo' : 'Inactivo'; row.append(state);
      const actions = document.createElement('td');
      function action(text, callback) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-secondary'; button.textContent = text;
        button.addEventListener('click', async () => { button.disabled = true; try { await callback(); } catch (failure) { error(failure, 'usersMessage'); } finally { button.disabled = false; } }); actions.append(button);
      }
      async function changed() { if (user.id === identity?.id) { await api.me(); } await refreshUsers(); }
      action('Guardar rol', async () => { await api.updateUser(user.id, { role: select.value }); await changed(); });
      action(user.active ? 'Desactivar' : 'Activar', async () => { await api.updateUser(user.id, { active: !user.active }); await changed(); });
      action('Cambiar contraseña', async () => { passwordUserId = user.id; el('passwordUserLabel').textContent = 'Cambiar contraseña de ' + user.username; el('userPasswordForm').classList.remove('hidden'); el('changedUserPassword').focus(); });
      row.append(actions); body.append(row);
    }
  }
  el('navUsersBtn').addEventListener('click', () => navigate('usersView'));
  el('refreshUsersBtn').addEventListener('click', refreshUsers);
  el('previousUsersBtn').addEventListener('click', () => { if (userPage > 0) { userPage--; refreshUsers(); } });
  el('nextUsersBtn').addEventListener('click', () => { userPage++; refreshUsers(); });
  el('createUserForm').addEventListener('submit', async event => {
    event.preventDefault(); const button = event.currentTarget.querySelector('button'); button.disabled = true;
    try {
      mutationLock(); await api.createUser({ username: el('newUsername').value.trim(), fullName: el('newFullName').value.trim(), password: el('newUserPassword').value, role: el('newUserRole').value });
      el('createUserForm').reset(); message('usersMessage', 'Usuario creado.'); await refreshUsers();
    } catch (failure) { error(failure, 'usersMessage'); } finally { el('newUserPassword').value = ''; button.disabled = false; }
  });
  el('userPasswordForm').addEventListener('submit', async event => {
    event.preventDefault(); const button = event.currentTarget.querySelector('button'); button.disabled = true;
    try { mutationLock(); await api.password(passwordUserId, el('changedUserPassword').value); el('userPasswordForm').classList.add('hidden'); message('usersMessage', 'Contraseña actualizada; sesiones revocadas.'); await verify(); }
    catch (failure) { error(failure, 'usersMessage'); } finally { el('changedUserPassword').value = ''; button.disabled = false; }
  });
  el('cancelPasswordBtn').addEventListener('click', () => { el('changedUserPassword').value = ''; passwordUserId = null; el('userPasswordForm').classList.add('hidden'); });
  el('renewSessionBtn').addEventListener('click', async () => {
    if (busy) return; busy = true;
    try { await establish(await api.renew()); clearTimeout(grantTimer); message('connectedNotice', 'Sesión renovada. Los permisos temporales deben solicitarse nuevamente.'); }
    catch (failure) { error(failure); } finally { busy = false; }
  });
  const check = async () => {
    if (!identity || busy || document.hidden) return;
    try { await verify(); if (activeView && views[activeView]) await api.access(views[activeView]); if (activeView === 'usersView') await api.users(); }
    catch (failure) {
      if (failure.code === 'MODULE_FORBIDDEN') { grant = null; await navigate('salesView'); }
      else if (failure.code === 'NETWORK_ERROR') expire('No se pudo verificar la sesión. Vuelve a conectar e inicia sesión; no se habilita acceso local automáticamente.');
      else error(failure);
    }
  };
  setInterval(check, 15000); document.addEventListener('visibilitychange', check); window.addEventListener('focus', check);
  window.addEventListener('pagehide', () => {
    // Revocacion best effort; no se confia en ella. El backend conserva el TTL.
    if (grant) api.leave(views[grant.view]).catch(() => {});
  });
  async function inventoryOperation(operation) {
    mutationLock(); const version = generation; await verify(); assertGeneration(version);
    const result = await operation(api, boundBusiness);
    assertGeneration(version); return result;
  }
  window.PosConnected = Object.freeze({ login, logout, navigate, authorize, canView, inventoryOperation, handleError: error,
    canManageModule: view => Boolean(identity && activeView && (identity.role === 'ADMIN' || ((Array.isArray(view) ? view.includes(activeView) : view === activeView) && grant?.view === activeView && grant.until > Date.now()))) });
  (async () => {
    busy = true; mode.disabled = true; el('loginForm').querySelector('button').disabled = true;
    try { await establish(await api.me()); }
    catch (failure) { if (identity) expire(failure.message); else if (failure.code !== 'INVALID_SESSION') error(failure, 'loginError'); }
    finally { busy = false; mode.disabled = false; el('loginForm').querySelector('button').disabled = false; }
  })();
})();
