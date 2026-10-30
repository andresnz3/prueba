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
  el('adminUsernameGroup').classList.remove('hidden'); el('grantAdminUsername').disabled = false; el('grantAdminUsername').required = true;
  el('modeDescription').textContent = 'Acceso verificado. Este modo necesita conexión a internet.';
  const api = new window.PosApiClient(window.POS_API_BASE_URL);
  const views = { salesView: 'sales', inventoryView: 'inventory', purchasesView: 'purchases', payablesView: 'payables', clientsView: 'clients', suppliersView: 'suppliers', historyView: 'history', cajaView: 'cash', gastosView: 'expenses', reportesView: 'reports', dashboardView: 'reports', configView: 'settings' };
  let identity = null, ownerBusinessId = null, supportContext = null, activeView = null, grant = null, pendingView = null;
  let generation = 0;
  let systemAdminReady = false, systemAdminBusinesses = [], systemAdminUsers = [], systemAdminUserCapacity = null, systemAdminBilling = null, systemAdminLicenses = [], systemAdminActiveLocalBusinesses = null, systemAdminSelectedBusinessId = '', systemAdminMigrationTargetId = '', systemAdminTab = 'businesses';
  let systemAdminDeleteBusiness = null, systemAdminDeleteTrigger = null, systemAdminDeletePreview = null, systemAdminDeletePreviewToken = 0, systemAdminPaymentBusiness = null, systemAdminPaymentTrigger = null;
  const assertGeneration = value => { if (generation !== value) throw new window.PosApiError('STALE_REQUEST'); };
  let expiryTimer, grantTimer, busy = false, passwordUserId = null, userPage = 0;
  function message(id, text) { el(id).textContent = window.PosMessages.text(text, 'No se pudo completar la solicitud. Inténtalo nuevamente.'); el(id).classList.remove('hidden'); }
  function clearPasswords() { for (const id of ['loginPassword', 'gestorPassword', 'newUserPassword', 'changedUserPassword']) el(id).value = ''; }
  const isSystemAdmin = () => Boolean(identity && identity.username === 'andres' && identity.role === 'ADMIN' && String(identity.businessId) === '1');
  const effectiveBusinessId = () => supportContext?.businessId || ownerBusinessId;
  function syncSupportBanner(support) {
    const banner = el('supportSessionBanner');
    const allowed = isSystemAdmin() && Boolean(support && support.businessId !== '1');
    supportContext = allowed ? { businessId: support.businessId, businessName: support.businessName, expiresAt: support.expiresAt } : null;
    window.PosRuntime.setEffectiveBusinessId(effectiveBusinessId() || ownerBusinessId);
    banner.classList.toggle('hidden', !allowed);
    if (allowed) el('supportSessionBusinessName').textContent = support.businessName;
    return allowed;
  }
  function syncSystemAdminAccess() {
    const allowed = isSystemAdmin();
    el('navSystemAdminBtn').classList.toggle('hidden', !allowed);
    if (!allowed) { systemAdminReady = false; el('systemAdminView').classList.add('hidden'); window.PosMigrationPreview.reset(); }
    return allowed;
  }
  function canAccessSystemAdmin() { return isSystemAdmin() && systemAdminReady; }
  function canView(view) { return Boolean(identity && (view === 'salesView' || view === 'configView' || (view === 'systemAdminView' && canAccessSystemAdmin()) || identity.role === 'ADMIN' || (grant?.view === view && grant.until > Date.now()))); }
  function expire(text = 'La sesión venció o fue revocada. Inicia sesión nuevamente.') {
    generation++; identity = null; supportContext = null; systemAdminDeleteBusiness = null; systemAdminDeleteTrigger = null; systemAdminDeletePreview = null; systemAdminDeletePreviewToken++; systemAdminPaymentBusiness = null; systemAdminPaymentTrigger = null; if (ownerBusinessId) window.PosRuntime.setEffectiveBusinessId(ownerBusinessId); systemAdminReady = false; systemAdminBusinesses = []; systemAdminUsers = []; systemAdminUserCapacity = null; systemAdminBilling = null; systemAdminLicenses = []; systemAdminSelectedBusinessId = ''; systemAdminMigrationTargetId = ''; clearIssuedLocalLicense(); window.PosMigrationPreview.reset(); window.PosRuntime.setUser(null); grant = null; pendingView = null; activeView = null;
    clearTimeout(expiryTimer); clearTimeout(grantTimer); clearPasswords();
    document.querySelectorAll('.modal, .view-panel').forEach(node => node.classList.add('hidden'));
    el('app').classList.add('hidden'); el('app').inert = false; el('loginScreen').classList.remove('hidden');
    el('navUsersBtn').classList.add('hidden'); el('renewSessionBtn').classList.add('hidden');
    el('navSystemAdminBtn').classList.add('hidden'); el('systemAdminView').classList.add('hidden');
    el('authMode').disabled = false;
    detenerCamaraVentas(); if (localDB) localDB.close();
    window.PosRuntime.clearCart(); window.PosRuntime.setProducts([]); window.PosInventory.closePanels();
    message('loginError', text);
  }
  function error(error, target = 'connectedNotice') {
    if (error.code === 'STALE_REQUEST') return;
    if (error.code === 'INVALID_SESSION') { expire(); return; }
    message(target, window.PosMessages.fromError(error, 'No se pudo completar la solicitud. Inténtalo nuevamente.'));
  }
  function scheduleExpiry(value) {
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(() => expire(), Math.max(0, Date.parse(value.expiresAt) - Date.now()));
  }
  async function establish(value) {
    const version = ++generation;
    if (ownerBusinessId && ownerBusinessId !== value.user.businessId) { location.reload(); return; }
    if (!ownerBusinessId) {
      ownerBusinessId = value.user.businessId;
      window.PosRuntime.prepareConnectedBusiness(ownerBusinessId, api.baseUrl);
    } else if (!connectedMode && localDB) { await localDB.open(); }
    identity = value.user;
    syncSystemAdminAccess();
    syncSupportBanner(value.support);
    window.PosRuntime.setUser(identity);
    const settings = await api.businessSettings(); assertGeneration(version);
    window.PosRuntime.setBusinessSettings(settings);
    scheduleExpiry(value);
    await initApp(); assertGeneration(version);
    if (Date.parse(value.expiresAt) <= Date.now()) throw new window.PosApiError('INVALID_SESSION', 401);
    el('sellerName').textContent = identity.fullName;
    document.querySelector('.seller-info span').textContent = 'Sesión conectada';
    el('roleBadge').textContent = identity.role === 'ADMIN' ? 'Administrador' : 'Usuario';
    el('businessContext').textContent = 'Conectado · ' + settings.businessName;
    el('businessContext').classList.remove('hidden');
    el('navUsersBtn').classList.toggle('hidden', identity.role !== 'ADMIN'); syncSystemAdminAccess(); el('renewSessionBtn').classList.remove('hidden');
    el('loginError').classList.add('hidden');
    grant = null; await api.enter('sales'); assertGeneration(version); await window.PosInventory.load('salesView'); assertGeneration(version); activeView = 'salesView'; await window.PosSales.load(activeView); assertGeneration(version); renderPosView(activeView); actualizarCatalogo();
    el('loginScreen').classList.add('hidden'); el('app').classList.remove('hidden');
  }
  async function verify() {
    const version = generation;
    const value = await api.me(); assertGeneration(version);
    if (!identity || value.user.businessId !== ownerBusinessId || value.user.id !== identity.id) throw new window.PosApiError('INVALID_SESSION', 401);
    identity = value.user; window.PosRuntime.setUser(identity); syncSupportBanner(value.support);
    el('navUsersBtn').classList.toggle('hidden', identity.role !== 'ADMIN');
    if (!syncSystemAdminAccess() && activeView === 'systemAdminView') { activeView = 'salesView'; renderPosView(activeView); }
    scheduleExpiry(value);
    return value;
  }
  function clearSystemAdminMessage() { el('systemAdminMessage').textContent = ''; el('systemAdminMessage').classList.add('hidden'); }
  function systemAdminNotice(text) { message('systemAdminMessage', text); }
  function clearSystemAdminDeleteError() {
    const field = el('systemAdminDeleteInput');
    const errorText = el('systemAdminDeleteError');
    errorText.textContent = '';
    errorText.classList.add('hidden');
    field.setAttribute('aria-invalid', 'false');
  }
  function systemAdminDeleteError(text, { inputInvalid = true } = {}) {
    const field = el('systemAdminDeleteInput');
    const errorText = el('systemAdminDeleteError');
    errorText.textContent = window.PosMessages.text(text, 'No se pudo completar la eliminación. Inténtalo nuevamente.');
    errorText.classList.remove('hidden');
    if (inputInvalid) field.setAttribute('aria-invalid', 'true');
  }
  function renderSystemAdminDeleteSummary(preview) {
    const summary = el('systemAdminDeleteSummary');
    const heading = document.createElement('p');
    heading.className = 'system-admin-delete-summary-heading';
    heading.textContent = 'Se eliminarán ' + preview.totalRecords.toLocaleString('es-NI') + ' registros';
    const list = document.createElement('ul');
    list.className = 'system-admin-delete-summary-list';
    for (const item of preview.counts) {
      const row = document.createElement('li');
      row.textContent = item.label + ': ' + item.count.toLocaleString('es-NI');
      list.append(row);
    }
    const content = [heading, list];
    if (preview.retainedBilling.subscriptions || preview.retainedBilling.payments) {
      const billing = document.createElement('p');
      billing.className = 'system-admin-delete-retention';
      billing.textContent = 'Se conservará en la auditoría del sistema el historial de facturación: ' + preview.retainedBilling.subscriptions + ' planes y ' + preview.retainedBilling.payments + ' pagos.';
      content.push(billing);
    }
    if (preview.images.count) {
      const files = document.createElement('p');
      files.className = 'system-admin-delete-retention';
      files.textContent = 'Las imágenes se retirarán después del borrado y la limpieza se reintentará si fuera necesario.';
      content.push(files);
    }
    summary.replaceChildren(...content);
  }
  async function loadSystemAdminDeletePreview(business, token) {
    const confirm = el('systemAdminDeleteConfirmBtn');
    const summary = el('systemAdminDeleteSummary');
    try {
      const preview = await api.adminBusinessDeletionPreview(business.id);
      if (token !== systemAdminDeletePreviewToken || systemAdminDeleteBusiness !== business || el('systemAdminDeleteModal').classList.contains('hidden')) return;
      if (preview.business.name !== business.name || preview.business.id !== business.id) throw new window.PosApiError('INVALID_RESPONSE');
      systemAdminDeletePreview = preview;
      renderSystemAdminDeleteSummary(preview);
      confirm.disabled = false;
    } catch (failure) {
      if (token !== systemAdminDeletePreviewToken || el('systemAdminDeleteModal').classList.contains('hidden')) return;
      summary.textContent = 'No se pudo cargar el resumen. No es posible confirmar la eliminación.';
      systemAdminDeletePreview = null;
      confirm.disabled = true;
        systemAdminDeleteError(window.PosMessages.fromError(failure, 'No se pudo preparar la eliminación de forma segura. Inténtalo nuevamente.'), { inputInvalid: false });
    }
  }
  function openSystemAdminDeleteModal(business, trigger) {
    if (!canAccessSystemAdmin() || busy) return;
    clearSystemAdminMessage();
    systemAdminDeleteBusiness = business;
    systemAdminDeleteTrigger = trigger;
    systemAdminDeletePreview = null;
    const modal = el('systemAdminDeleteModal');
    const input = el('systemAdminDeleteInput');
    const confirm = el('systemAdminDeleteConfirmBtn');
    input.value = '';
    input.disabled = false;
    confirm.disabled = true;
    clearSystemAdminDeleteError();
    el('systemAdminDeleteMessage').textContent = 'Vas a eliminar definitivamente «' + business.name + '» (ID ' + business.id + '). Esta acción no se puede deshacer. Escribe exactamente ELIMINAR para continuar.';
    el('systemAdminDeleteSummary').textContent = 'Cargando el resumen de información…';

    modal.classList.remove('hidden');
    el('app').inert = true;
    if (business.id === '1') {
      input.disabled = true;
      confirm.disabled = true;
      systemAdminDeleteError('No se puede eliminar el negocio principal del sistema.');
      el('systemAdminDeleteTitle').focus();
    } else if (supportContext?.businessId === business.id) {
      input.disabled = true;
      confirm.disabled = true;
      systemAdminDeleteError('Finaliza la sesión de soporte antes de eliminar ese negocio.');
      el('systemAdminDeleteTitle').focus();
    } else {
      input.focus();
      void loadSystemAdminDeletePreview(business, ++systemAdminDeletePreviewToken);
    }
  }
  function closeSystemAdminDeleteModal({ restoreFocus = true } = {}) {
    systemAdminDeletePreviewToken++;
    el('systemAdminDeleteModal').classList.add('hidden');
    el('systemAdminDeleteModal').removeAttribute('aria-busy');
    el('app').inert = false;
    el('systemAdminDeleteInput').value = '';
    el('systemAdminDeleteSummary').replaceChildren();
    el('systemAdminDeleteInput').disabled = false;
    el('systemAdminDeleteConfirmBtn').disabled = false;
    el('systemAdminDeleteCancelBtn').disabled = false;
    clearSystemAdminDeleteError();
    const trigger = systemAdminDeleteTrigger;
    systemAdminDeleteBusiness = null;
    systemAdminDeleteTrigger = null;
    systemAdminDeletePreview = null;
    if (restoreFocus && trigger?.isConnected && canAccessSystemAdmin()) trigger.focus();
  }
  function updateSystemAdminBusinessOptions() {
    const select = el('systemAdminUserBusinessId');
    const previous = systemAdminSelectedBusinessId || select.value;
    select.replaceChildren(...systemAdminBusinesses.map(business => new Option(business.name + ' (#' + business.id + ')', business.id)));
    systemAdminSelectedBusinessId = systemAdminBusinesses.some(business => business.id === previous) ? previous : (systemAdminBusinesses[0]?.id || '');
    select.value = systemAdminSelectedBusinessId;
  }
  function continueBusinessMigration(businessId) {
    if (!canAccessSystemAdmin() || !systemAdminBusinesses.some(business => business.id === String(businessId) && business.migrationState === 'PENDING')) return;
    systemAdminMigrationTargetId = String(businessId);
    void selectSystemAdminTab('migration');
  }
  function renderSystemAdminBusinesses() {
    const body = el('systemAdminBusinessesBody'); body.replaceChildren();
    for (const business of systemAdminBusinesses) {
      const row = document.createElement('tr'); row.dataset.businessId = business.id;
      const businessStatus = business.migrationState === 'PENDING' ? 'Migración pendiente' : business.status === 'ACTIVE' ? 'Activo' : business.migrationState === 'COMPLETE' ? 'Listo para activar' : 'Suspendido';
      for (const text of [business.id, business.name, businessStatus, String(business.userCount)]) {
        const cell = document.createElement('td'); cell.textContent = text; row.append(cell);
      }
      const actions = document.createElement('td');
      const users = document.createElement('button'); users.type = 'button'; users.className = 'btn btn-secondary'; users.textContent = 'Ver usuarios';
      users.addEventListener('click', () => { systemAdminSelectedBusinessId = business.id; el('systemAdminUserBusinessId').value = business.id; updateSystemAdminBusinessOptions(); selectSystemAdminTab('users'); }); actions.append(users);
      if (business.id === '1') {
        const protectedLabel = document.createElement('span'); protectedLabel.className = 'system-admin-help'; protectedLabel.textContent = 'Negocio del sistema'; actions.append(protectedLabel);
      } else if (business.migrationState === 'PENDING') {
        const pendingHelp = document.createElement('span'); pendingHelp.className = 'system-admin-help'; pendingHelp.textContent = 'Acceso comercial bloqueado hasta completar la importación y conciliación.'; actions.append(pendingHelp);
        const resume = document.createElement('button'); resume.type = 'button'; resume.className = 'btn btn-primary'; resume.textContent = 'Continuar migración';
        resume.addEventListener('click', () => continueBusinessMigration(business.id)); actions.append(resume);
      } else {
        const manage = document.createElement('button'); manage.type = 'button'; manage.className = 'btn btn-primary'; manage.textContent = 'Administrar negocio';
        manage.disabled = business.status !== 'ACTIVE';
        manage.addEventListener('click', async () => {
          if (!canAccessSystemAdmin() || busy) return;
          busy = true; el('app').inert = true; manage.disabled = true; let enteredSupport = false;
          try {
            await verify();
            if (!isSystemAdmin()) throw new window.PosApiError('SYSTEM_ADMIN_REQUIRED', 403);
            await api.startSupportSession(business.id);
            const current = await verify(); syncSupportBanner(current.support);
            enteredSupport = true;
          } catch (failure) { error(failure, 'systemAdminMessage'); }
          finally { busy = false; el('app').inert = false; manage.disabled = business.status !== 'ACTIVE'; }
          if (enteredSupport) { await navigate('salesView'); message('connectedNotice', 'Sesión temporal de soporte iniciada.'); }
        }); actions.append(manage);
        const status = document.createElement('button'); status.type = 'button'; status.className = 'btn btn-secondary'; status.textContent = business.status === 'ACTIVE' ? 'Suspender' : 'Activar';
        status.addEventListener('click', async () => {
          if (!canAccessSystemAdmin()) return;
          status.disabled = true; clearSystemAdminMessage();
          try { await verify(); await api.setAdminBusinessStatus(business.id, business.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE'); await refreshSystemAdminBusinesses(); systemAdminNotice('Estado del negocio actualizado.'); }
          catch (failure) { error(failure, 'systemAdminMessage'); }
          finally { status.disabled = false; }
        }); actions.append(status);
      }
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn btn-danger'; remove.textContent = 'Eliminar';
      remove.addEventListener('click', () => openSystemAdminDeleteModal(business, remove));
      actions.append(remove);
      const statusAction = [...actions.querySelectorAll('button')].find(button => ['Activar', 'Suspender'].includes(button.textContent));
      const manageAction = [...actions.querySelectorAll('button')].find(button => button.textContent === 'Administrar negocio');
      if (statusAction && manageAction) actions.insertBefore(statusAction, manageAction);
      row.append(actions); body.append(row);
    }
  }
  async function refreshSystemAdminBusinesses() {
    if (!isSystemAdmin()) throw new window.PosApiError('SYSTEM_ADMIN_REQUIRED', 403);
    systemAdminBusinesses = await api.adminBusinesses();
    updateSystemAdminBusinessOptions(); renderSystemAdminBusinesses();
    return systemAdminBusinesses;
  }
  function renderSystemAdminUsers() {
    const body = el('systemAdminUsersBody'); body.replaceChildren();
    for (const user of systemAdminUsers) {
      const row = document.createElement('tr'); row.dataset.userId = user.id;
      const roleLabel = user.role === 'ADMIN' ? 'Administrador' : user.role === 'VENDEDOR' ? 'Vendedor' : 'Por revisar';
      for (const text of [user.username, user.fullName, systemAdminBusinesses.find(business => business.id === user.businessId)?.name || 'Negocio no disponible', roleLabel, user.active ? 'Activo' : 'Inactivo']) {
        const cell = document.createElement('td'); cell.textContent = text; row.append(cell);
      }
      const actions = document.createElement('td');
      if (user.username === 'andres' && user.role === 'ADMIN' && user.businessId === '1') {
        const protectedLabel = document.createElement('span'); protectedLabel.className = 'system-admin-help'; protectedLabel.textContent = 'Cuenta protegida'; actions.append(protectedLabel);
      } else {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-secondary'; button.textContent = user.active ? 'Desactivar' : 'Activar';
        button.addEventListener('click', async () => {
          if (!canAccessSystemAdmin()) return;
          button.disabled = true; clearSystemAdminMessage();
          try { await verify(); await api.setAdminUserActive(user.id, !user.active); await refreshSystemAdminUsers(); systemAdminNotice('Estado del usuario actualizado.'); }
          catch (failure) { error(failure, 'systemAdminMessage'); }
          finally { button.disabled = false; }
        }); actions.append(button);
      }
      row.append(actions); body.append(row);
    }
  }
  function adminDateLabel(value) {
    if (!value) return 'Sin fecha';
    const [year, month, day] = value.split('-');
    return day + '/' + month + '/' + year;
  }
  function adminMoneyLabel(value) {
    return 'USD ' + Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function billingStatusLabel(business) {
    const labels = { UNASSIGNED: 'Sin asignar', NOT_APPLICABLE: 'No aplica', DATE_PENDING: 'Fecha pendiente', OVERDUE: 'Vencido', DUE_TODAY: 'Vence hoy', DUE_SOON: 'Por vencer', CURRENT: 'Al día' };
    return labels[business.paymentStatus] || 'Sin estado';
  }
  function appendBillingManagementActions(actions, business) {
    if (business.id === '1') {
      const protectedLabel = document.createElement('span'); protectedLabel.className = 'system-admin-help'; protectedLabel.textContent = 'Negocio del sistema'; actions.append(protectedLabel);
    } else if (business.migrationState === 'PENDING') {
      const resume = document.createElement('button'); resume.type = 'button'; resume.className = 'btn btn-primary'; resume.textContent = 'Continuar migración';
      resume.addEventListener('click', () => continueBusinessMigration(business.id)); actions.append(resume);
    } else {
      const manage = document.createElement('button'); manage.type = 'button'; manage.className = 'btn btn-primary'; manage.textContent = 'Administrar negocio';
      manage.disabled = business.status !== 'ACTIVE';
      manage.addEventListener('click', () => administerBusiness(business, manage)); actions.append(manage);
      const status = document.createElement('button'); status.type = 'button'; status.className = 'btn btn-secondary'; status.textContent = business.status === 'ACTIVE' ? 'Suspender' : 'Activar';
      status.addEventListener('click', async () => {
        if (!canAccessSystemAdmin()) return;
        status.disabled = true; clearSystemAdminMessage();
        try { await verify(); await api.setAdminBusinessStatus(business.id, business.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE'); await refreshSystemAdminBusinesses(); await refreshSystemAdminBilling(); systemAdminNotice('Estado del negocio actualizado.'); }
        catch (failure) { error(failure, 'systemAdminMessage'); }
        finally { status.disabled = false; }
      }); actions.append(status);
    }
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn btn-danger'; remove.textContent = 'Eliminar';
    remove.addEventListener('click', () => openSystemAdminDeleteModal(business, remove)); actions.append(remove);
  }
  async function administerBusiness(business, button) {
    if (!canAccessSystemAdmin() || busy) return;
    busy = true; el('app').inert = true; button.disabled = true; let enteredSupport = false;
    try {
      await verify();
      if (!isSystemAdmin()) throw new window.PosApiError('SYSTEM_ADMIN_REQUIRED', 403);
      await api.startSupportSession(business.id);
      const current = await verify(); syncSupportBanner(current.support);
      enteredSupport = true;
    } catch (failure) { error(failure, 'systemAdminMessage'); }
    finally { busy = false; el('app').inert = false; button.disabled = business.status !== 'ACTIVE'; }
    if (enteredSupport) { await navigate('salesView'); message('connectedNotice', 'Sesión temporal de soporte iniciada.'); }
  }
  function renderSystemAdminBilling() {
    if (!systemAdminBilling) return;
    const { summary, plans, businesses, reminder } = systemAdminBilling;
    el('systemAdminBillingActive').textContent = String(summary.activeBusinesses);
    el('systemAdminBillingLocal').textContent = String(summary.localPlans);
    el('systemAdminBillingMonthly').textContent = String(summary.monthlyPlans);
    el('systemAdminBillingDue').textContent = String(summary.paymentsDueSoon);
    el('systemAdminBillingOverdue').textContent = String(summary.paymentsOverdue);
    const reminderNode = el('systemAdminBillingReminder');
    if (reminder) {
      const due = reminder.daysUntil === 0 ? 'vence hoy' : 'faltan ' + reminder.daysUntil + (reminder.daysUntil === 1 ? ' día' : ' días');
      reminderNode.textContent = 'Recordatorio de pago: vence el ' + adminDateLabel(reminder.dueDate) + ' (' + due + ') · ' + reminder.businessName;
      reminderNode.classList.remove('hidden');
    } else { reminderNode.textContent = ''; reminderNode.classList.add('hidden'); }
    el('systemAdminBillingEmpty').classList.toggle('hidden', summary.monthlyPlans > 0);
    const body = el('systemAdminBillingBody'); body.replaceChildren();
    for (const business of businesses) {
      const row = document.createElement('tr'); row.dataset.businessId = business.id;
      const name = document.createElement('td'); name.textContent = business.name;
      if (business.migrationState === 'PENDING') {
        const pending = document.createElement('small'); pending.className = 'system-admin-help'; pending.textContent = 'Migración pendiente'; name.append(document.createElement('br'), pending);
      }
      row.append(name);

      const planCell = document.createElement('td');
      const planControl = document.createElement('div'); planControl.className = 'system-admin-plan-control';
      const planSelect = document.createElement('select'); planSelect.setAttribute('aria-label', 'Plan de ' + business.name); planSelect.required = true;
      planSelect.append(new Option('Selecciona un plan', ''));
      for (const plan of plans) planSelect.append(new Option(plan.name, plan.code));
      planSelect.value = business.planCode || '';
      const included = document.createElement('small');
      const showIncluded = () => {
        const plan = plans.find(item => item.code === planSelect.value);
        if (!plan) { included.textContent = ''; return; }
        const over = Math.max(0, business.activeUserCount - plan.includedUsers);
        included.textContent = 'M\u00e1ximo ' + plan.includedUsers + ' usuarios activos (incluye al administrador). Ahora: ' + business.activeUserCount + '. ' + (over ? 'Desactiva manualmente ' + over + ' usuario(s) antes de guardar.' : 'Todos los usuarios actuales caben en el plan.');
      };
      planSelect.addEventListener('change', showIncluded); showIncluded();
      planControl.append(planSelect, included); planCell.append(planControl); row.append(planCell);

      const state = document.createElement('td');
      const badge = document.createElement('span'); badge.className = 'system-admin-payment-state'; badge.textContent = billingStatusLabel(business);
      if (['CURRENT', 'NOT_APPLICABLE'].includes(business.paymentStatus)) badge.classList.add('is-good');
      else if (['DUE_SOON', 'DUE_TODAY'].includes(business.paymentStatus)) badge.classList.add('is-due');
      else if (business.paymentStatus === 'OVERDUE') badge.classList.add('is-overdue');
      else badge.classList.add('is-pending');
      state.append(badge); row.append(state);

      const dueCell = document.createElement('td');
      const dueControl = document.createElement('div'); dueControl.className = 'system-admin-plan-control';
      const dueInput = document.createElement('input'); dueInput.type = 'date'; dueInput.value = business.nextDueDate || ''; dueInput.setAttribute('aria-label', 'Próximo vencimiento de ' + business.name);
      const updateDueAvailability = () => { const monthly = plans.find(item => item.code === planSelect.value)?.monthly === true; dueInput.disabled = !monthly; if (!monthly) dueInput.value = ''; };
      planSelect.addEventListener('change', updateDueAvailability); updateDueAvailability();
      const dueHint = document.createElement('small'); dueHint.textContent = business.monthly ? 'Edita la fecha del siguiente pago' : 'No aplica a planes locales';
      dueControl.append(dueInput, dueHint); dueCell.append(dueControl); row.append(dueCell);

      const lastPayment = document.createElement('td'); lastPayment.className = 'system-admin-billing-last-payment';
      lastPayment.textContent = business.lastPayment ? adminMoneyLabel(business.lastPayment.amount) + ' · ' + adminDateLabel(business.lastPayment.date) : 'Sin pagos'; row.append(lastPayment);

      const actions = document.createElement('td'); actions.className = 'system-admin-billing-actions';
      const save = document.createElement('button'); save.type = 'button'; save.className = 'btn btn-primary'; save.textContent = 'Guardar plan y fecha';
      save.addEventListener('click', async () => {
        if (!canAccessSystemAdmin() || busy) return;
        if (!planSelect.value) { systemAdminNotice('Selecciona un plan para ' + business.name + '.'); planSelect.focus(); return; }
        save.disabled = true; clearSystemAdminMessage();
        try { await verify(); await api.setAdminBusinessPlan(business.id, planSelect.value, dueInput.value); await refreshSystemAdminBilling(); systemAdminNotice('Plan y fecha actualizados para ' + business.name + '.'); }
        catch (failure) { error(failure, 'systemAdminMessage'); }
        finally { save.disabled = false; }
      }); actions.append(save);
      const payments = document.createElement('button'); payments.type = 'button'; payments.className = 'btn btn-secondary'; payments.textContent = business.monthly ? 'Registrar pago' : 'Ver pagos';
      payments.addEventListener('click', () => openSystemAdminPaymentModal(business, payments)); actions.append(payments);
      appendBillingManagementActions(actions, business);
      row.append(actions); body.append(row);
    }
  }
  async function refreshSystemAdminBilling() {
    if (!isSystemAdmin()) throw new window.PosApiError('SYSTEM_ADMIN_REQUIRED', 403);
    systemAdminBilling = await api.adminBilling();
    renderSystemAdminBilling();
    return systemAdminBilling;
  }
  function localLicenseDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('es-NI', { dateStyle: 'medium', timeStyle: 'short' }).format(date) : '—';
  }
  function localLicenseStatusLabel(status) {
    return ({ PENDING: 'Pendiente', ACTIVE: 'Activa', REVOKED: 'Revocada' })[status] || 'Sin estado';
  }
  function renderSystemAdminLicenses() {
    el('systemAdminActiveLocalBusinessesCount').textContent = Number.isSafeInteger(systemAdminActiveLocalBusinesses) ? String(systemAdminActiveLocalBusinesses) : '—';
    const body = el('systemAdminLicensesBody');
    body.replaceChildren();
    const select = el('systemAdminLicenseActionId');
    const previous = select.value;
    select.replaceChildren(new Option('Selecciona una licencia', ''), ...systemAdminLicenses.map(license => new Option(license.customerName + ' · ' + localLicenseStatusLabel(license.status) + ' · #' + license.id, license.id)));
    if (systemAdminLicenses.some(license => license.id === previous)) select.value = previous;
    if (!systemAdminLicenses.length) {
      const row = document.createElement('tr'), cell = document.createElement('td');
      cell.colSpan = 6; cell.textContent = 'No hay licencias para mostrar.'; row.append(cell); body.append(row);
    }
    for (const license of systemAdminLicenses) {
      const row = document.createElement('tr');
      for (const text of [license.customerName, license.customerReference || '—', localLicenseStatusLabel(license.status), localLicenseDate(license.createdAt), localLicenseDate(license.activatedAt), String(license.transferCount)]) {
        const cell = document.createElement('td'); cell.textContent = text; row.append(cell);
      }
      body.append(row);
    }
    updateSystemAdminLicenseActions();
  }
  function updateSystemAdminLicenseActions() {
    const selected = systemAdminLicenses.find(license => license.id === el('systemAdminLicenseActionId').value);
    const reasonValid = el('systemAdminLicenseActionReason').value.trim().length >= 10;
    el('systemAdminLicenseTransferBtn').disabled = !selected || selected.status !== 'ACTIVE';
    el('systemAdminLicenseRevokeBtn').disabled = !selected || selected.status === 'REVOKED' || !reasonValid;
  }
  async function refreshSystemAdminLicenses() {
    if (!isSystemAdmin()) throw new window.PosApiError('SYSTEM_ADMIN_REQUIRED', 403);
    const result = await api.localLicenses(el('systemAdminLicenseFilter').value);
    systemAdminLicenses = result.licenses;
    systemAdminActiveLocalBusinesses = result.activeLocalBusinessCount;
    renderSystemAdminLicenses();
    return systemAdminLicenses;
  }
  function licenseMessage(text, success = false) {
    const target = el('systemAdminLicenseMessage');
    target.textContent = window.PosMessages.text(text, 'No se pudo completar la gestión de licencias. Inténtalo nuevamente.');
    target.classList.toggle('error', !success);
    target.classList.toggle('success', success);
    target.classList.remove('hidden');
  }
  function clearIssuedLocalLicense() {
    el('systemAdminLicenseIssuedCode').textContent = '';
    el('systemAdminLicenseIssued').classList.add('hidden');
  }
  async function performLocalLicenseAction(action) {
    if (!canAccessSystemAdmin() || busy) return;
    const license = systemAdminLicenses.find(item => item.id === el('systemAdminLicenseActionId').value);
    const reason = el('systemAdminLicenseActionReason').value.trim();
    updateSystemAdminLicenseActions();
    if (!license) {
      licenseMessage('Selecciona una licencia antes de continuar.');
      el('systemAdminLicenseActionId').focus();
      return;
    }
    if (action === 'revoke' && (reason.length < 10 || reason.length > 500)) {
      licenseMessage('Para revocar una licencia, ingresa un motivo de al menos 10 caracteres.');
      el('systemAdminLicenseActionReason').focus();
      return;
    }
    if (action === 'transfer' && license.status !== 'ACTIVE') return;
    if (action === 'revoke' && license.status === 'REVOKED') return;
    const label = action === 'transfer' ? 'autorizar la transferencia de' : 'revocar';
    if (!window.confirm('¿Confirmas ' + label + ' la licencia de ' + license.customerName + ' (ID ' + license.id + ')?')) return;
    busy = true;
    const controls = ['systemAdminLicenseActionId', 'systemAdminLicenseActionReason', 'systemAdminLicenseTransferBtn', 'systemAdminLicenseRevokeBtn'];
    controls.forEach(id => { el(id).disabled = true; });
    el('systemAdminLicensesPanel').setAttribute('aria-busy', 'true');
    try {
      await verify();
      if (!isSystemAdmin()) throw new window.PosApiError('SYSTEM_ADMIN_REQUIRED', 403);
      if (action === 'transfer') await api.transferLocalLicense(license.id);
      else await api.revokeLocalLicense(license.id, reason);
      el('systemAdminLicenseActionReason').value = '';
      await refreshSystemAdminLicenses();
      licenseMessage(action === 'transfer' ? 'Transferencia autorizada. La instalación anterior se actualizará cuando vuelva a conectarse.' : 'Licencia revocada. El cambio se aplicará cuando la instalación vuelva a conectarse.', true);
    } catch (failure) {
      licenseMessage(window.PosMessages.fromError(failure, 'No se pudo actualizar la licencia. Inténtalo nuevamente.'));
    } finally {
      busy = false;
      el('systemAdminLicensesPanel').removeAttribute('aria-busy');
      controls.forEach(id => { el(id).disabled = false; });
      updateSystemAdminLicenseActions();
    }
  }
  function clearSystemAdminPaymentError() {
    const errorText = el('systemAdminPaymentError');
    errorText.textContent = ''; errorText.classList.add('hidden');
    for (const id of ['systemAdminPaymentAmount', 'systemAdminPaymentDate']) el(id).setAttribute('aria-invalid', 'false');
  }
  function systemAdminPaymentError(text, fieldId) {
    const errorText = el('systemAdminPaymentError'); errorText.textContent = window.PosMessages.text(text, 'No se pudo completar el pago. Revisa la información e inténtalo nuevamente.'); errorText.classList.remove('hidden');
    const field = el(fieldId); field.setAttribute('aria-invalid', 'true'); field.focus();
  }
  function closeSystemAdminPaymentModal({ restoreFocus = true } = {}) {
    el('systemAdminPaymentModal').classList.add('hidden'); el('systemAdminPaymentModal').removeAttribute('aria-busy'); el('app').inert = false;
    const trigger = systemAdminPaymentTrigger; systemAdminPaymentBusiness = null; systemAdminPaymentTrigger = null;
    if (restoreFocus && trigger?.isConnected && canAccessSystemAdmin()) trigger.focus();
  }
  async function openSystemAdminPaymentModal(business, trigger) {
    if (!canAccessSystemAdmin() || busy) return;
    systemAdminPaymentBusiness = business; systemAdminPaymentTrigger = trigger;
    const modal = el('systemAdminPaymentModal');
    el('systemAdminPaymentTitle').textContent = business.monthly ? 'Registrar pago' : 'Pagos del negocio';
    el('systemAdminPaymentDescription').textContent = business.monthly ? 'Registra el importe y la fecha del pago. El próximo vencimiento avanzará un mes desde esa fecha.' : 'Historial de pagos registrados. Los planes locales no generan mensualidades ni recordatorios.';
    el('systemAdminPaymentAmount').value = ''; el('systemAdminPaymentDate').value = systemAdminBilling?.today || new Date().toISOString().slice(0, 10);
    el('systemAdminPaymentDate').max = systemAdminBilling?.today || new Date().toISOString().slice(0, 10);
    el('systemAdminPaymentAmount').disabled = !business.monthly; el('systemAdminPaymentDate').disabled = !business.monthly;
    el('systemAdminPaymentSubmitBtn').disabled = !business.monthly; el('systemAdminPaymentSubmitBtn').classList.toggle('hidden', !business.monthly);
    el('systemAdminPaymentHistory').replaceChildren(Object.assign(document.createElement('li'), { textContent: 'Cargando pagos…' }));
    clearSystemAdminPaymentError(); modal.classList.remove('hidden'); el('app').inert = true;
    try {
      await verify();
      const payments = await api.adminSubscriptionPayments(business.id);
      renderSystemAdminPaymentHistory(payments);
      if (business.monthly) el('systemAdminPaymentAmount').focus(); else el('systemAdminPaymentTitle').focus();
    } catch (failure) {
      if (failure.code === 'INVALID_SESSION') error(failure, 'systemAdminMessage');
      else { const field = business.monthly ? 'systemAdminPaymentAmount' : 'systemAdminPaymentTitle'; systemAdminPaymentError(window.PosMessages.fromError(failure, 'No se pudo cargar el historial de pagos. Inténtalo de nuevo.'), field); }
    }
  }
  function renderSystemAdminPaymentHistory(payments) {
    const history = el('systemAdminPaymentHistory'); history.replaceChildren();
    if (!payments.length) history.append(Object.assign(document.createElement('li'), { textContent: 'No hay pagos registrados.' }));
    else for (const payment of payments) history.append(Object.assign(document.createElement('li'), { textContent: adminMoneyLabel(payment.amount) + ' · ' + adminDateLabel(payment.paymentDate) }));
  }
  async function refreshSystemAdminUsers() {
    if (!isSystemAdmin()) throw new window.PosApiError('SYSTEM_ADMIN_REQUIRED', 403);
    const businessId = el('systemAdminUserBusinessId').value;
    if (!businessId) { systemAdminUsers = []; systemAdminUserCapacity = null; el('systemAdminUsersCapacity').textContent = ''; renderSystemAdminUsers(); return systemAdminUsers; }
    systemAdminSelectedBusinessId = businessId;
    [systemAdminUsers, systemAdminUserCapacity] = await Promise.all([api.adminUsers(businessId), api.adminBusinessUserCapacity(businessId)]);
    const capacity = el('systemAdminUsersCapacity');
    capacity.textContent = systemAdminUserCapacity.maximumUsers === null
      ? 'Este negocio no tiene un plan asignado. Asígnale uno para administrar sus usuarios; no se cambió su configuración anterior.'
      : systemAdminUserCapacity.activeUsers + ' de ' + systemAdminUserCapacity.maximumUsers + ' usuarios activos · ' + systemAdminUserCapacity.activeAdmins + ' de 1 administrador · ' + systemAdminUserCapacity.availableUsers + ' cupos disponibles. Los usuarios inactivos no ocupan cupo.';
    renderSystemAdminUsers();
    return systemAdminUsers;
  }
  async function selectSystemAdminTab(tab, refresh = true) {
    if (!canAccessSystemAdmin() || !['businesses', 'users', 'billing', 'licenses', 'migration'].includes(tab)) return;
    systemAdminTab = tab;
    const tabs = { businesses: 'systemAdminBusinesses', users: 'systemAdminUsers', billing: 'systemAdminBilling', licenses: 'systemAdminLicenses', migration: 'systemAdminMigration' };
    for (const [key, prefix] of Object.entries(tabs)) {
      const selected = key === tab;
      el(prefix + 'Tab').setAttribute('aria-selected', String(selected));
      el(prefix + 'Tab').classList.toggle('btn-primary', selected); el(prefix + 'Tab').classList.toggle('btn-secondary', !selected);
      el(prefix + 'Panel').classList.toggle('hidden', !selected); el(prefix + 'Panel').setAttribute('aria-hidden', String(!selected));
    }
    clearSystemAdminMessage();
    if (refresh && ['businesses', 'users', 'billing', 'licenses'].includes(tab)) {
      try {
        await verify();
        if (tab === 'businesses') await refreshSystemAdminBusinesses();
        else if (tab === 'users') {
          // El panel de migración puede crear un negocio después de la carga
          // inicial. Refrescar aquí permite provisionar sus cuentas nuevas sin
          // confiar en una lista de destinos obsoleta.
          await refreshSystemAdminBusinesses();
          await refreshSystemAdminUsers();
        } else if (tab === 'billing') await refreshSystemAdminBilling();
        else await refreshSystemAdminLicenses();
      }
      catch (failure) { error(failure, 'systemAdminMessage'); }
    }
    if (tab === 'migration') {
      try {
        await verify();
        await refreshSystemAdminBusinesses();
        if (canAccessSystemAdmin()) {
          window.PosMigrationPreview.show({
            canAccess: canAccessSystemAdmin,
            businesses: systemAdminBusinesses,
            targetBusinessId: systemAdminMigrationTargetId,
          createMigrationTarget: (name, planCode) => api.createMigrationTarget(name, planCode),
            inspectExistingMigrationTarget: businessId => api.inspectExistingMigrationTarget(businessId),
            prepareExistingMigrationTarget: (businessId, confirmed) => api.prepareExistingMigrationTarget(businessId, confirmed),
            previewArchive: (targetBusinessId, packageValue, fileSha256) => api.previewFullMigration(targetBusinessId, packageValue, fileSha256),
            archiveFull: (targetBusinessId, packageValue, confirmed, fileSha256) => api.archiveFullMigration(targetBusinessId, packageValue, confirmed, fileSha256),
            archiveStatus: (targetBusinessId, batchId) => api.migrationBatchStatus(targetBusinessId, batchId),
            projectMigrationOperations: (targetBusinessId, batchId) => api.projectMigrationOperations(targetBusinessId, batchId),
            reviewIdentityRecord: (...args) => api.reviewMigrationIdentityRecord(...args)
          });
          systemAdminMigrationTargetId = '';
        }
      }
      catch (failure) { error(failure, 'systemAdminMessage'); }
    }
  }
  async function openSystemAdmin() {
    if (!isSystemAdmin() || busy) return;
    busy = true; el('app').inert = true; const version = generation;
    try {
      await verify(); assertGeneration(version);
      if (!isSystemAdmin()) throw new window.PosApiError('SYSTEM_ADMIN_REQUIRED', 403);
      systemAdminReady = false; systemAdminTab = 'businesses';
      await refreshSystemAdminBusinesses(); assertGeneration(version);
      systemAdminReady = true; activeView = 'systemAdminView'; pendingView = null;
      await selectSystemAdminTab('businesses', false);
      renderPosView(activeView);
    } catch (failure) {
      systemAdminReady = false;
      if (failure.code !== 'STALE_REQUEST') error(failure, 'connectedNotice');
    } finally { busy = false; el('app').inert = false; }
  }
  async function navigate(view) {
    if (busy || !identity) return;
    if (view === 'systemAdminView') { await openSystemAdmin(); return; }
    if (!views[view] && view !== 'usersView') return;
    busy = true; el('app').inert = true;
    const previous = activeView; const version = generation;
    try {
      await verify();
      if (previous && previous !== view && grant) { await api.leave(views[previous]); grant = null; clearTimeout(grantTimer); }
      if (view === 'usersView') {
        // /users autoriza en el servidor; un cambio visual de rol nunca habilita esta ruta.
        userPage = 0; const result = await api.users(); assertGeneration(version);
        if (identity.role !== 'ADMIN') throw new window.PosApiError('ADMIN_REQUIRED', 403);
        activeView = view; renderPosView(view); renderUsers(result.users); renderUserCapacity(result.capacity); return;
      }
      await api.enter(views[view]); assertGeneration(version);
      await window.PosInventory.load(view); assertGeneration(version); await window.PosSales.load(view); assertGeneration(version); await window.PosPurchases.load(view); assertGeneration(version); await window.PosExpenses.load(view); assertGeneration(version);
      if (view === 'configView') { const settings = await api.businessSettings(); assertGeneration(version); window.PosRuntime.setBusinessSettings(settings); }
      activeView = view; renderPosView(view); window.PosMigrationHistory?.activate(view); pendingView = null;
      if (view === 'reportesView') { await window.PosReports.load(); assertGeneration(version); }
      if (view === 'dashboardView') { await window.PosDashboard.load(); assertGeneration(version); }
    } catch (failure) {
      if (failure.code === 'STALE_REQUEST') return;
      grant = null; clearTimeout(grantTimer);
      if (failure.code === 'MODULE_FORBIDDEN' && identity?.role === 'VENDEDOR') {
        activeView = 'salesView'; renderPosView(activeView); pendingView = view;
        el('authError').classList.add('hidden'); el('authModal').classList.remove('hidden'); el('grantAdminUsername').focus();
      } else {
        // Conserva la vista actual si una carga falla; esconder todos los paneles
        // deja el POS en blanco y bloquea la navegación a otros módulos.
        error(failure);
      }
    } finally { busy = false; el('app').inert = false; }
  }
  async function login() {
    if (busy) return; if (!window.PosValidation.validate(el('loginForm'))) return; busy = true; const button = el('loginForm').querySelector('button[type=submit]'); button.disabled = true;
    try {
      // Si una cookie valida permanecio tras una interrupcion, restaurar solo la misma identidad.
      const value = await api.login(el('loginUsername').value.trim(), el('loginPassword').value);
      clearPasswords(); await establish(value);
    } catch (failure) { if (identity) expire(window.PosMessages.fromError(failure, 'La sesión no pudo recuperarse. Inicia sesión nuevamente.')); else error(failure, 'loginError'); }
    finally { clearPasswords(); button.disabled = false; busy = false; }
  }
  async function logout() {
    if (busy) return; busy = true; el('app').inert = true;
    try { await api.logout(); const url = new URL(location.href); url.searchParams.set('mode', 'connected'); location.assign(url.href); }
    catch (failure) { if (failure.code === 'INVALID_SESSION') expire(); else error(failure); }
    finally { busy = false; el('app').inert = false; }
  }
  el('supportSessionEndBtn').addEventListener('click', async () => {
    if (busy || !isSystemAdmin()) return;
    const button = el('supportSessionEndBtn'); busy = true; el('app').inert = true; button.disabled = true; let returned = false;
    try {
      await api.endSupportSession();
      const current = await verify(); syncSupportBanner(current.support);
      systemAdminReady = false; returned = true;
    } catch (failure) { error(failure, 'connectedNotice'); }
    finally { busy = false; el('app').inert = false; button.disabled = false; }
    if (returned) await navigate('systemAdminView');
  });
  async function authorize() {
    if (busy || !pendingView || !identity) return;
    const view = pendingView; const version = generation; busy = true; const button = el('authForm').querySelector('button[type=submit]'); button.disabled = true;
    try {
      const value = await api.authorize(views[view], el('grantAdminUsername').value.trim(), el('gestorPassword').value);
      await api.enter(views[view]); assertGeneration(version);
      await window.PosInventory.load(view); assertGeneration(version); await window.PosSales.load(view); assertGeneration(version); await window.PosPurchases.load(view); assertGeneration(version); await window.PosExpenses.load(view); assertGeneration(version);
      grant = { view, until: Date.parse(value.expiresAt) }; activeView = view; pendingView = null;
      el('authModal').classList.add('hidden'); renderPosView(view); window.PosMigrationHistory?.activate(view);
      if (view === 'reportesView') await window.PosReports.load();
      clearTimeout(grantTimer); grantTimer = setTimeout(() => { grant = null; navigate('salesView'); }, Math.max(0, grant.until - Date.now()));
    } catch (failure) { error(failure, 'authError'); }
    finally { el('gestorPassword').value = ''; button.disabled = false; busy = false; }
  }
  async function refreshUsers() { try { await verify(); const result = await api.users(userPage * 100); renderUsers(result.users); renderUserCapacity(result.capacity); } catch (failure) { error(failure, 'usersMessage'); } }
  function renderUserCapacity(capacity) {
    const node = el('usersCapacity');
    if (!capacity) { node.textContent = ''; return; }
    node.textContent = capacity.maximumUsers === null
      ? 'Este negocio no tiene un plan asignado. El administrador del sistema debe asignarlo antes de crear o reactivar usuarios.'
      : capacity.planName + ': ' + capacity.activeUsers + ' de ' + capacity.maximumUsers + ' usuarios activos (' + capacity.activeAdmins + ' de 1 administrador). ' + capacity.availableUsers + ' cupos disponibles; los usuarios inactivos no ocupan cupo.';
  }
  function renderUsers(users) {
    const body = el('usersTableBody'); body.replaceChildren();
    el('previousUsersBtn').disabled = userPage === 0; el('nextUsersBtn').disabled = users.length < 100;
    el('usersPage').textContent = String(userPage + 1);
    for (const user of users) {
      if (user.businessId !== effectiveBusinessId()) { expire('Se recibió una identidad de otro negocio.'); return; }
      const row = document.createElement('tr'); row.dataset.userId = user.id;
      for (const text of [user.username, user.fullName]) { const cell = document.createElement('td'); cell.textContent = text; row.append(cell); }
      const roleCell = document.createElement('td'), select = document.createElement('select'); select.setAttribute('aria-label', 'Rol de ' + user.username);
      for (const value of ['VENDEDOR', 'ADMIN']) { const option = new Option(value === 'ADMIN' ? 'Administrador' : 'Vendedor', value); select.add(option); } select.value = user.role; roleCell.append(select); row.append(roleCell);
      const state = document.createElement('td'); state.textContent = user.active ? 'Activo' : 'Inactivo'; row.append(state);
      const actions = document.createElement('td');
      function action(text, callback) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-secondary'; button.textContent = text;
        button.addEventListener('click', async () => { button.disabled = true; try { await callback(); } catch (failure) { error(failure, 'usersMessage'); await refreshUsers(); } finally { button.disabled = false; } }); actions.append(button);
      }
      async function changed() { if (user.id === identity?.id) { await api.me(); } await refreshUsers(); }
      action('Guardar rol', async () => { await api.updateUser(user.id, { role: select.value }); await changed(); });
      action(user.active ? 'Desactivar' : 'Activar', async () => { await api.updateUser(user.id, { active: !user.active }); await changed(); });
      action('Cambiar contraseña', async () => { passwordUserId = user.id; el('passwordUserLabel').textContent = 'Cambiar contraseña de ' + user.username; el('userPasswordForm').classList.remove('hidden'); el('changedUserPassword').focus(); });
      row.append(actions); body.append(row);
    }
  }
  el('navUsersBtn').addEventListener('click', () => navigate('usersView'));
  const systemAdminTabs = ['businesses', 'users', 'billing', 'licenses', 'migration'];
  const systemAdminTabIds = { businesses: 'Businesses', users: 'Users', billing: 'Billing', licenses: 'Licenses', migration: 'Migration' };
  for (const tab of systemAdminTabs) {
    const button = el('systemAdmin' + systemAdminTabIds[tab] + 'Tab');
    button.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const current = systemAdminTabs.indexOf(tab);
      const next = event.key === 'Home' ? systemAdminTabs[0] : event.key === 'End' ? systemAdminTabs[systemAdminTabs.length - 1] : systemAdminTabs[(current + (event.key === 'ArrowRight' ? 1 : systemAdminTabs.length - 1)) % systemAdminTabs.length];
      el('systemAdmin' + systemAdminTabIds[next] + 'Tab').focus();
      selectSystemAdminTab(next);
    });
  }
  el('systemAdminBusinessesTab').addEventListener('click', () => selectSystemAdminTab('businesses'));
  el('systemAdminUsersTab').addEventListener('click', () => selectSystemAdminTab('users'));
  el('systemAdminBillingTab').addEventListener('click', () => selectSystemAdminTab('billing'));
  el('systemAdminLicensesTab').addEventListener('click', () => selectSystemAdminTab('licenses'));
  el('systemAdminMigrationTab').addEventListener('click', () => selectSystemAdminTab('migration'));
  el('systemAdminLicenseFilter').addEventListener('change', async () => {
    if (!canAccessSystemAdmin() || systemAdminTab !== 'licenses') return;
    try { await verify(); await refreshSystemAdminLicenses(); }
    catch (failure) { licenseMessage(window.PosMessages.fromError(failure, 'No se pudo actualizar la lista de licencias.')); }
  });
  el('systemAdminLicenseActionId').addEventListener('change', updateSystemAdminLicenseActions);
  el('systemAdminLicenseActionReason').addEventListener('input', updateSystemAdminLicenseActions);
  el('systemAdminLicenseTransferBtn').addEventListener('click', () => performLocalLicenseAction('transfer'));
  el('systemAdminLicenseRevokeBtn').addEventListener('click', () => performLocalLicenseAction('revoke'));
  el('systemAdminLicenseCopyBtn').addEventListener('click', async () => {
    const code = el('systemAdminLicenseIssuedCode').textContent;
    if (!code || !canAccessSystemAdmin()) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('CLIPBOARD_UNAVAILABLE');
      await navigator.clipboard.writeText(code);
      el('systemAdminLicenseIssuedNotice').textContent = 'Código copiado. Guárdalo ahora; no volverá a mostrarse.';
    } catch {
      el('systemAdminLicenseIssuedNotice').textContent = 'No se pudo copiar automáticamente. Selecciona el código y guárdalo ahora.';
    }
  });
  el('systemAdminLicenseForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (!canAccessSystemAdmin() || busy) return;
    const customer = el('systemAdminLicenseCustomer'), reference = el('systemAdminLicenseReference');
    const name = customer.value.trim(), purchaseReference = reference.value.trim();
    if (!el('systemAdminLicenseForm').reportValidity()) return;
    if (name.length < 2 || name.length > 160 || purchaseReference.length > 120) {
      licenseMessage('Revisa el nombre del cliente y la referencia de compra.');
      (name.length < 2 || name.length > 160 ? customer : reference).focus();
      return;
    }
    busy = true;
    const button = el('systemAdminLicenseGenerateBtn');
    button.disabled = true;
    el('systemAdminLicensesPanel').setAttribute('aria-busy', 'true');
    el('systemAdminLicenseMessage').classList.add('hidden');
    clearIssuedLocalLicense();
    try {
      await verify();
      if (!isSystemAdmin()) throw new window.PosApiError('SYSTEM_ADMIN_REQUIRED', 403);
      const result = await api.generateLocalLicense(name, purchaseReference);
      el('systemAdminLicenseIssuedCode').textContent = result.code;
      el('systemAdminLicenseIssuedNotice').textContent = 'Guárdalo ahora; no volverá a mostrarse.';
      el('systemAdminLicenseIssued').classList.remove('hidden');
      el('systemAdminLicenseForm').reset();
      licenseMessage('Licencia generada. El código se muestra una sola vez.', true);
      try { await refreshSystemAdminLicenses(); }
      catch { licenseMessage('El código se generó y permanece visible. No se pudo actualizar la lista; vuelve a cargarla.', false); }
      el('systemAdminLicenseCopyBtn').focus();
    } catch (failure) {
      licenseMessage(window.PosMessages.fromError(failure, 'No se pudo generar la licencia. Inténtalo nuevamente.'));
    } finally {
      busy = false;
      el('systemAdminLicensesPanel').removeAttribute('aria-busy');
      button.disabled = false;
    }
  });
  el('systemAdminDeleteCancelBtn').addEventListener('click', () => closeSystemAdminDeleteModal());
  el('systemAdminPaymentCancelBtn').addEventListener('click', () => closeSystemAdminPaymentModal());
  el('systemAdminPaymentAmount').addEventListener('input', clearSystemAdminPaymentError);
  el('systemAdminPaymentDate').addEventListener('input', clearSystemAdminPaymentError);
  el('systemAdminPaymentForm').addEventListener('submit', async event => {
    event.preventDefault();
    const business = systemAdminPaymentBusiness;
    if (!canAccessSystemAdmin() || busy || !business || !business.monthly) return;
    const amountInput = el('systemAdminPaymentAmount'), dateInput = el('systemAdminPaymentDate');
    if (!el('systemAdminPaymentForm').reportValidity()) return;
    const amount = amountInput.value.trim(), paymentDate = dateInput.value;
    if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) { systemAdminPaymentError('Ingresa un importe en USD mayor que cero y con hasta dos decimales.', 'systemAdminPaymentAmount'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) { systemAdminPaymentError('Selecciona la fecha del pago.', 'systemAdminPaymentDate'); return; }
    busy = true;
    const modal = el('systemAdminPaymentModal'); modal.setAttribute('aria-busy', 'true');
    for (const id of ['systemAdminPaymentAmount', 'systemAdminPaymentDate', 'systemAdminPaymentSubmitBtn', 'systemAdminPaymentCancelBtn']) el(id).disabled = true;
    clearSystemAdminPaymentError();
    try {
      await verify();
      if (!isSystemAdmin()) throw new window.PosApiError('SYSTEM_ADMIN_REQUIRED', 403);
      const result = await api.recordAdminSubscriptionPayment(business.id, { amount, paymentDate });
      await refreshSystemAdminBilling();
      renderSystemAdminPaymentHistory(await api.adminSubscriptionPayments(business.id));
      amountInput.value = '';
      systemAdminNotice('Pago registrado en USD. Próximo vencimiento: ' + adminDateLabel(result.subscription.nextDueDate) + '.');
      amountInput.focus();
    } catch (failure) {
      if (failure.code === 'INVALID_SESSION') error(failure, 'systemAdminMessage');
      else {
        const fieldId = failure.field === 'paymentDate' ? 'systemAdminPaymentDate' : 'systemAdminPaymentAmount';
        systemAdminPaymentError(window.PosMessages.fromError(failure, 'No se pudo registrar el pago. Revisa la información e inténtalo nuevamente.'), fieldId);
      }
    } finally {
      busy = false; modal.removeAttribute('aria-busy');
      amountInput.disabled = !business.monthly; dateInput.disabled = !business.monthly;
      el('systemAdminPaymentSubmitBtn').disabled = !business.monthly; el('systemAdminPaymentCancelBtn').disabled = false;
      el('app').inert = !modal.classList.contains('hidden');
    }
  });
  el('systemAdminDeleteInput').addEventListener('input', clearSystemAdminDeleteError);
  el('systemAdminDeleteForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (!canAccessSystemAdmin() || busy || !systemAdminDeleteBusiness || !systemAdminDeletePreview) return;
    const business = systemAdminDeleteBusiness;
    const input = el('systemAdminDeleteInput');
    if (input.value !== 'ELIMINAR') {
      systemAdminDeleteError('Debes escribir exactamente ELIMINAR para confirmar.');
      input.focus();
      return;
    }
    busy = true;
    const modal = el('systemAdminDeleteModal');
    modal.setAttribute('aria-busy', 'true');
    input.disabled = true;
    el('systemAdminDeleteCancelBtn').disabled = true;
    el('systemAdminDeleteConfirmBtn').disabled = true;
    try {
      await verify();
      if (!isSystemAdmin()) throw new window.PosApiError('SYSTEM_ADMIN_REQUIRED', 403);
      const result = await api.deleteAdminBusiness(business.id, 'ELIMINAR', systemAdminDeletePreview.previewToken);
      closeSystemAdminDeleteModal({ restoreFocus: false });
      await refreshSystemAdminBusinesses();
      if (systemAdminTab === 'billing') await refreshSystemAdminBilling();
      systemAdminNotice(result.filesPendingCleanup
        ? 'Negocio eliminado. La limpieza de algunas imágenes quedó pendiente y se reintentará automáticamente.'
        : 'Negocio eliminado correctamente.');
      el('systemAdminRefreshBtn').focus();
    } catch (failure) {
      if (failure.code === 'INVALID_SESSION') error(failure, 'systemAdminDeleteError');
      else if (failure.code === 'BUSINESS_DELETE_PREVIEW_STALE') {
        input.value = '';
        systemAdminDeletePreview = null;
        systemAdminDeleteError('La información cambió. Actualizando el resumen…', { inputInvalid: false });
        await loadSystemAdminDeletePreview(business, ++systemAdminDeletePreviewToken);
        if (systemAdminDeletePreview) systemAdminDeleteError('La información cambió. Revisa el resumen actualizado y escribe ELIMINAR otra vez.', { inputInvalid: false });
      }
      else if (modal.classList.contains('hidden')) error(failure, 'systemAdminMessage');
      else systemAdminDeleteError(window.PosMessages.fromError(failure, 'No se pudo eliminar el negocio. Inténtalo nuevamente.'));
    } finally {
      busy = false;
      modal.removeAttribute('aria-busy');
      el('app').inert = !modal.classList.contains('hidden');
      input.disabled = false;
      el('systemAdminDeleteCancelBtn').disabled = false;
      el('systemAdminDeleteConfirmBtn').disabled = !systemAdminDeletePreview || business.id === '1' || supportContext?.businessId === business.id;
    }
  });
  el('systemAdminUserBusinessId').addEventListener('change', async () => {
    if (!canAccessSystemAdmin() || systemAdminTab !== 'users') return;
    systemAdminSelectedBusinessId = el('systemAdminUserBusinessId').value;
    clearSystemAdminMessage();
    try { await verify(); await refreshSystemAdminUsers(); }
    catch (failure) { error(failure, 'systemAdminMessage'); }
  });
  el('systemAdminRefreshBtn').addEventListener('click', async () => {
    if (!canAccessSystemAdmin()) return;
    clearSystemAdminMessage();
    try {
      await verify(); await refreshSystemAdminBusinesses();
      if (systemAdminTab === 'users') await refreshSystemAdminUsers();
      if (systemAdminTab === 'billing') await refreshSystemAdminBilling();
      if (systemAdminTab === 'licenses') await refreshSystemAdminLicenses();
      systemAdminNotice('Información actualizada.');
    } catch (failure) { error(failure, 'systemAdminMessage'); }
  });
  el('systemAdminBusinessForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!canAccessSystemAdmin() || !form.reportValidity()) return;
    const button = form.querySelector('button[type="submit"]'); button.disabled = true; clearSystemAdminMessage();
    try {
      await verify();
      const created = await api.createAdminBusiness(el('systemAdminBusinessName').value.trim(), el('systemAdminBusinessPlan').value);
      systemAdminSelectedBusinessId = created.id; form.reset();
      await refreshSystemAdminBusinesses(); systemAdminNotice('Negocio creado.');
    } catch (failure) { error(failure, 'systemAdminMessage'); }
    finally { button.disabled = false; }
  });
  const systemAdminUserFields = {
    username: ['systemAdminUsername', 'Usa de 3 a 100 caracteres: letras sin acentos, números, punto, guion o guion bajo.'],
    fullName: ['systemAdminFullName', 'Ingresa un nombre completo de hasta 160 caracteres.'],
    password: ['systemAdminPassword', 'La contraseña debe tener al menos 12 caracteres y hasta 256 bytes.'],
    role: ['systemAdminRole', 'Selecciona Administrador o Vendedor.']
  };
  el('systemAdminUserForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget, button = form.querySelector('button[type="submit"]');
    if (!canAccessSystemAdmin() || button.disabled) return;
    window.PosValidation.clear(form);
    clearSystemAdminMessage();
    const businessId = el('systemAdminUserBusinessId').value;
    const data = { username: el('systemAdminUsername').value.trim(), fullName: el('systemAdminFullName').value.trim(), password: el('systemAdminPassword').value, role: el('systemAdminRole').value };
    const valid = {
      username: /^[A-Za-z0-9_.-]{3,100}$/.test(data.username),
      fullName: Boolean(data.fullName) && data.fullName.length <= 160 && ![...data.fullName].some(character => character.charCodeAt(0) <= 0x1f),
      password: data.password.length >= 12 && new TextEncoder().encode(data.password).length <= 256,
      role: ['ADMIN', 'VENDEDOR'].includes(data.role)
    };
    if (!businessId) { systemAdminNotice('Selecciona el negocio para el nuevo usuario.'); el('systemAdminUserBusinessId').focus(); return; }
    let firstInvalid = true;
    for (const [field, allowed] of Object.entries(valid)) {
      if (!allowed) { window.PosValidation.field(...systemAdminUserFields[field], firstInvalid); firstInvalid = false; }
    }
    if (!firstInvalid) return;
    button.disabled = true;
    const businessSelect = el('systemAdminUserBusinessId'); businessSelect.disabled = true;
    try {
      await verify();
      await api.createAdminUser(businessId, data);
      form.reset(); await refreshSystemAdminUsers(); systemAdminNotice('Usuario creado.');
    } catch (failure) {
      const field = failure.code === 'USERNAME_EXISTS' ? 'username' : failure.field;
      if (Object.hasOwn(systemAdminUserFields, field)) {
        const [id, help] = systemAdminUserFields[field];
        window.PosValidation.field(id, failure.code === 'USERNAME_EXISTS' ? 'Ese usuario ya existe en uno de los negocios. Elige otro nombre.' : help);
      }
      error(failure, 'systemAdminMessage');
    } finally { el('systemAdminPassword').value = ''; businessSelect.disabled = false; button.disabled = false; }
  });
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
    try { await verify(); if (activeView && views[activeView]) await api.access(views[activeView]); if (activeView === 'usersView') await api.users(); if (activeView === 'systemAdminView') await api.adminBusinesses(); }
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
    const result = await operation(api, effectiveBusinessId());
    assertGeneration(version); return result;
  }
  async function settingsOperation(operation) {
    mutationLock(); const version = generation; await verify(); assertGeneration(version);
    const result = await operation(); assertGeneration(version);
    window.PosRuntime.setBusinessSettings(result);
    return result;
  }
  window.PosConnected = Object.freeze({ login, logout, navigate, authorize, canView, inventoryOperation, effectiveBusinessId, handleError: error, canAccessSystemAdmin,
    migrationHistory: (module, offset = 0, limit = 50) => api.migrationHistory(module, offset, limit),
    updateBusinessSettings: data => settingsOperation(() => api.updateBusinessSettings(data)),
    importLegacyBusinessSettings: data => settingsOperation(() => api.importLegacyBusinessSettings(data)),
    uploadBusinessLogo: file => settingsOperation(() => api.uploadBusinessLogo(file)),
    assetUrl: reference => api.assetUrl(reference),
    canManageModule: view => Boolean(identity && activeView && (identity.role === 'ADMIN' || ((Array.isArray(view) ? view.includes(activeView) : view === activeView) && grant?.view === activeView && grant.until > Date.now()))) });
  (async () => {
    busy = true; mode.disabled = true; el('loginForm').querySelector('button').disabled = true;
    try { await establish(await api.me()); }
    catch (failure) { if (identity) expire(window.PosMessages.fromError(failure, 'La sesión no pudo recuperarse. Inicia sesión nuevamente.')); else if (failure.code !== 'INVALID_SESSION') error(failure, 'loginError'); }
    finally { busy = false; mode.disabled = false; el('loginForm').querySelector('button').disabled = false; }
  })();
})();
