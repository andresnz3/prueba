/* global connectedMode */
'use strict';
(() => {
  if (!connectedMode) return;
  const el = id => document.getElementById(id);
  let clients = [], creditClients = [], receivables = [], selectedSale = null, pageRequest = 0, creditRequest = 0, clientSearchTimer = null, selectedClientSuggestionId = null;
  let creditAutocomplete = null, clientAutocomplete = null;
  const api = action => window.PosConnected.inventoryOperation(action);
  const money = value => 'C$' + Number(value || 0).toFixed(2);
  const formatDate = value => value ? new Date(value).toLocaleDateString() : '-';
  const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLocaleLowerCase();
  const clientMatches = (client, query) => [client.name, client.phone, client.ruc, client.id].some(value => normalize(value).includes(normalize(query)));
  const statusText = value => ({ OPEN: 'Pendiente', OVERDUE: 'Vencida', PAID: 'Pagada', CANCELLED: 'Anulada', PENDING_CONFIRMATION: 'Abono pendiente de confirmar' }[value] || value);
  function message(text, kind = 'success') {
    const node = el('clientsNotice'); if (!node) return;
    node.textContent = text; node.className = 'message ' + kind;
    node.classList.toggle('hidden', !text);
  }
  async function allPages(method, q = '') {
    return api(async client => {
      const result = [];
      for (let offset = 0; offset < 5000; offset += 100) {
        const page = await client[method](offset, q);
        result.push(...page);
        if (page.length < 100) return result;
      }
      return result;
    });
  }
  function appendCell(row, value) { const cell = document.createElement('td'); cell.textContent = value ?? '-'; row.append(cell); return cell; }
  function actionButton(label, action, id, variant = 'secondary') {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-sm btn-' + variant;
    button.textContent = label; button.dataset.clientAction = action; button.dataset.id = id; return button;
  }
  function renderClients() {
    const body = el('clientsTableBody'); if (!body) return;
    body.replaceChildren();
    if (!clients.length) { const row = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = 7; cell.className = 'text-center'; cell.textContent = 'No hay clientes que coincidan.'; row.append(cell); body.append(row); return; }
    for (const client of clients) {
      if (client.businessId !== window.PosRuntime.salesInput().businessId) throw new window.PosApiError('INVALID_RESPONSE');
      const row = document.createElement('tr'); row.dataset.clientId = client.id;
      const nameCell = appendCell(row, client.name), clientName = document.createElement('strong');
      clientName.textContent = client.name; nameCell.replaceChildren(clientName);
      const contactCell = appendCell(row, client.phone || '-');
      if (client.ruc) { const identifier = document.createElement('small'); identifier.textContent = 'RUC: ' + client.ruc; contactCell.append(document.createElement('br'), identifier); }
      appendCell(row, money(client.creditLimit));
      const availableCell = appendCell(row, money(client.availableCredit));
      availableCell.style.color = Number(client.availableCredit) < 0 ? 'red' : 'green'; availableCell.style.fontWeight = 'bold';
      const debtCell = appendCell(row, money(client.debt));
      debtCell.style.cssText = 'color:red;font-weight:bold;font-size:1.1em;';
      appendCell(row, client.active ? (Number(client.debt) > 0 ? 'Activo' : 'Al día') : 'Inactivo');
      if (!client.active) { row.style.backgroundColor = '#f9f9f9'; row.style.opacity = '0.8'; }
      const actions = document.createElement('td'), actionGroup = document.createElement('div');
      actionGroup.className = 'connected-client-actions';
      actionGroup.append(actionButton('Historial', 'statement', client.id, 'info'));
      actionGroup.append(actionButton('Editar', 'edit', client.id, 'primary'));
      actionGroup.append(actionButton(client.active ? 'Inactivar' : 'Activar', 'toggle', client.id, client.active ? 'warning' : 'success'));
      actions.append(actionGroup); row.append(actions); body.append(row);
    }
  }
  function renderReceivables() {
    const body = el('receivablesTableBody'); if (!body) return;
    body.replaceChildren();
    const range = window.PosPeriodFilters?.range('receivables') || { from: '', until: '' };
    const visibleReceivables = receivables.filter(item => window.PosPeriodFilters?.matches(item.date, range));
    if (!visibleReceivables.length) { const row = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = 9; cell.className = 'text-center'; cell.textContent = receivables.length ? 'No hay facturas en este período.' : 'No hay cuentas por cobrar que coincidan.'; row.append(cell); body.append(row); return; }
    for (const item of visibleReceivables) {
      const row = document.createElement('tr'); row.dataset.saleId = item.id;
      row.dataset.tableDate = window.PosTables.dateKey(item.date);
      appendCell(row, item.clientName); appendCell(row, '#' + item.invoiceNumber); appendCell(row, formatDate(item.date));
      appendCell(row, money(item.total)); appendCell(row, money(item.paid)); appendCell(row, money(item.balance));
      appendCell(row, formatDate(item.dueAt)); appendCell(row, statusText(item.status));
      const actions = document.createElement('td'), button = actionButton('Abonar', 'pay', item.id, 'success');
      button.disabled = item.status === 'CANCELLED' || (item.remaining === '0.00') || !window.PosConnected.canManageModule('cajaView');
      actions.append(button); row.append(actions); body.append(row);
    }
  }
  async function load(view = 'clientsView', q = el('clientSearchInput')?.value.trim() || '') {
    if (!connectedMode || view !== 'clientsView') return;
    const request = ++pageRequest; message('Cargando clientes y cuentas por cobrar...', 'info');
    el('connectedClientsControls')?.classList.remove('hidden');
    try {
      const [nextClients, nextReceivables] = await Promise.all([allPages('clients', q), allPages('receivables', q)]);
      if (request !== pageRequest || q !== (el('clientSearchInput')?.value.trim() || '')) return;
      clients = nextClients; receivables = nextReceivables;
      renderClients(); renderReceivables(); message('');
      if (document.activeElement === el('clientSearchInput') && !selectedClientSuggestionId) clientAutocomplete?.refresh();
    } catch (error) { if (request === pageRequest) message(error.message, 'error'); if (error.code === 'INVALID_SESSION') window.PosConnected.handleError(error); }
  }
  function fillCreditSelect(values, selected) {
    const select = el('creditClientSelect'); if (!select) return;
    select.replaceChildren(new Option('Selecciona un cliente', ''));
    creditClients = values;
    for (const client of values) {
      if (!client.active) continue;
      const option = new Option(client.name + ' · Disponible ' + money(client.availableCredit), client.id);
      select.add(option);
    }
    if (selected && values.some(client => client.id === String(selected) && client.active)) select.value = String(selected);
    const chosen = values.find(client => client.id === select.value);
    el('creditDays').value = chosen ? String(chosen.creditDays) : '30';
    if (document.activeElement === el('creditClientSearch')) creditAutocomplete?.refresh();
  }
  async function loadCreditClients(selectedId) {
    const explicitSelection = selectedId !== undefined && selectedId !== null && String(selectedId) !== '';
    const request = ++creditRequest, selected = explicitSelection ? String(selectedId) : el('creditClientSelect')?.value;
    try {
      const values = await allPages('creditClients');
      if (request !== creditRequest) return;
      const current = values.find(client => client.id === String(selected) && client.active);
      const keepSelection = explicitSelection || (current && normalize(current.name) === normalize(el('creditClientSearch')?.value));
      fillCreditSelect(values, keepSelection ? selected : '');
    }
    catch (error) { if (error.code === 'INVALID_SESSION') window.PosConnected.handleError(error); else window.showAlert(error.message); }
  }
  function edit(id) {
    const client = clients.find(item => item.id === String(id)); if (!client) return;
    el('clientId').value = client.id; el('clientName').value = client.name; el('clientPhone').value = client.phone || '';
    el('clientRuc').value = client.ruc || ''; el('clientAddress').value = client.address || '';
    el('clientLimit').value = client.creditLimit; el('clientCreditDays').value = String(client.creditDays); el('clientDebt').required = false; el('clientCreditDays').required = true; el('clientCreditDaysField').classList.remove('hidden');
    el('clientDebt').value = client.debt; el('clientDebtField').classList.add('hidden');
    el('clientModalTitle').textContent = 'Editar cliente'; el('clientModal').classList.remove('hidden'); el('clientName').focus();
  }
  async function save() {
    const id = el('clientId').value;
    const data = { name: el('clientName').value.trim(), phone: el('clientPhone').value.trim(), ruc: el('clientRuc').value.trim(),
      address: el('clientAddress').value.trim(), creditLimit: el('clientLimit').value, creditDays: Number(el('clientCreditDays').value) };
    if (!data.name || !/^\d+(?:\.\d{1,2})?$/.test(data.creditLimit) || Number(data.creditLimit) < 0 || !Number.isInteger(data.creditDays) || data.creditDays < 1 || data.creditDays > 3650) { message('Revisa nombre, límite y plazo de crédito.', 'error'); return; }
    const button = el('clientForm').querySelector('button[type=submit]'); button.disabled = true;
    try {
      const value = await api(client => id ? client.updateClient(id, data) : client.createClient(data));
      el('clientModal').classList.add('hidden'); el('clientForm').reset(); el('clientId').value = ''; el('clientDebt').required = true; el('clientCreditDays').required = false; el('clientDebtField').classList.remove('hidden');
      el('clientModalTitle').textContent = 'Nuevo Cliente (Cuenta por Cobrar)'; el('clientCreditDaysField').classList.add('hidden');
      await load('clientsView', el('clientSearchInput').value.trim());
      await loadCreditClients(value?.id);
      if (value?.id) el('creditClientSearch').value = value.name;
      message(id ? 'Cliente actualizado.' : 'Cliente creado.');
    } catch (error) { message(error.message, 'error'); if (error.code === 'INVALID_SESSION') window.PosConnected.handleError(error); }
    finally { button.disabled = false; }
  }
  async function toggle(id) {
    const client = clients.find(item => item.id === String(id)); if (!client) return;
    try { await api(apiClient => apiClient.setClientActive(id, !client.active)); await load(); await loadCreditClients(); message(client.active ? 'Cliente inactivado.' : 'Cliente activado.'); }
    catch (error) { message(error.message, 'error'); if (error.code === 'INVALID_SESSION') window.PosConnected.handleError(error); }
  }
  async function statement(id) {
    try {
      const value = await api(client => client.clientStatement(id));
      el('statementModalTitle').textContent = 'Historial: ' + value.client.name;
      el('statementModalSubtitle').textContent = 'Límite: ' + money(value.client.creditLimit) + ' | Deuda Actual: ' + money(value.client.debt);
      const invoiceMap = new Map(value.invoices.map(invoice => [invoice.id, invoice]));
      const entries = [
        ...value.invoices.map(invoice => ({
          type: 'charge', date: invoice.date, ref: '#' + String(invoice.invoiceNumber).padStart(6, '0'),
          detail: invoice.status === 'CANCELLED' ? 'Factura Anulada' : 'Factura de crédito · Total ' + money(invoice.total) + ' · Abonado ' + money(invoice.paid) + ' · Pendiente ' + money(invoice.balance),
          amount: Number(invoice.total), dueAt: invoice.dueAt, saleId: invoice.id, cancelled: invoice.status === 'CANCELLED'
        })),
        ...value.payments.map(payment => {
          const invoice = invoiceMap.get(payment.saleId);
          const method = ({ CASH: 'Efectivo', CARD: 'Tarjeta', TRANSFER: 'Transferencia' })[payment.paymentMethod] || payment.paymentMethod;
          const status = payment.status === 'PENDING' ? ' · Abono pendiente de confirmar' : '';
          return { type: 'payment', date: payment.createdAt, ref: 'Abono #' + String(payment.invoiceNumber).padStart(6, '0'),
            detail: 'Pago recibido por ' + method + (payment.userName ? ' (' + payment.userName + ')' : '') + status,
            amount: Number(payment.amount), paymentStatus: payment.status, saleId: payment.saleId, invoice };
        })
      ].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
      const body = el('statementTableBody'); body.replaceChildren();
      if (!entries.length) {
        const row = document.createElement('tr'), cell = document.createElement('td');
        cell.colSpan = 7; cell.className = 'text-center'; cell.textContent = 'No hay movimientos registrados.'; row.append(cell); body.append(row);
      }
      let runningBalance = 0;
      for (const entry of entries) {
        if (entry.type === 'charge' && !entry.cancelled) runningBalance += entry.amount;
        if (entry.type === 'payment' && entry.paymentStatus === 'POSTED') runningBalance = Math.max(0, runningBalance - entry.amount);
        const row = document.createElement('tr');
        row.dataset.periodDate = window.PosPeriodFilters?.dateKey(entry.date) || '';
        if (entry.saleId) row.dataset.saleId = entry.saleId;
        const dateCell = document.createElement('td');
        dateCell.append(document.createTextNode(new Date(entry.date).toLocaleString()));
        if (entry.type === 'charge') {
          const due = document.createElement('small'); due.textContent = 'Vence: ' + (entry.dueAt ? formatDate(entry.dueAt) : '-');
          if (entry.dueAt && new Date(entry.dueAt).getTime() < Date.now() && !entry.cancelled) due.style.cssText = 'display:block;color:#d32f2f;font-weight:bold;';
          else due.style.display = 'block';
          dateCell.append(document.createElement('br'), due);
        }
        row.append(dateCell);
        const ref = appendCell(row, entry.ref); ref.style.fontWeight = 'bold';
        appendCell(row, entry.detail);
        const charge = appendCell(row, entry.type === 'charge' ? money(entry.amount) : '');
        if (entry.type === 'charge') charge.style.cssText = 'color:#d32f2f;font-weight:bold;';
        const paid = appendCell(row, entry.type === 'payment' ? money(entry.amount) : '');
        if (entry.type === 'payment') paid.style.cssText = 'color:#28a745;font-weight:bold;';
        const balance = appendCell(row, money(runningBalance)); balance.style.cssText = 'font-weight:bold;font-size:1.1em;';
        const actions = appendCell(row, '');
        const invoice = entry.type === 'charge' && receivables.find(item => String(item.id) === String(entry.saleId));
        if (invoice) {
          actions.append(actionButton('Ver Factura', 'invoice', invoice.id, 'info'));
          if (Number(invoice.remaining) > 0 && invoice.status !== 'CANCELLED') actions.append(actionButton('Abonar', 'pay', invoice.id, 'success'));
        }
        body.append(row);
      }
      window.PosPeriodFilters?.filterTable('statementTableBody', window.PosPeriodFilters.range('statement'));
      el('statementModal').classList.remove('hidden');
    } catch (error) { message(error.message, 'error'); }
  }
  function openPayment(id) {
    const item = receivables.find(value => value.id === String(id)); if (!item || item.status === 'CANCELLED' || item.remaining === '0.00') return;
    selectedSale = item.id; el('paySaleId').value = item.id; el('paySaleNumero').textContent = '#' + item.invoiceNumber;
    el('paySaleCliente').textContent = item.clientName; el('paySaleTotal').textContent = money(item.total);
    el('paySalePaid').textContent = money(item.paid); el('paySaleSaldo').textContent = money(item.balance);
    const input = el('paySaleAmount'); input.value = ''; input.max = item.remaining; input.disabled = false;
    el('paymentSaleForm').querySelector('button[type=submit]').disabled = false;
    el('paymentSaleModal').classList.remove('hidden'); input.focus();
  }
  async function submitPayment() {
    if (!selectedSale) return;
    const amount = el('paySaleAmount').value, raw = el('paySaleMethod').value.toLowerCase();
    if (!/^\d+(?:\.\d{1,2})?$/.test(amount) || Number(amount) <= 0 || Number(amount) > Number(el('paySaleAmount').max)) { window.showAlert('El abono debe ser mayor que cero y no superar el saldo disponible.'); return; }
    const method = ({ efectivo: 'CASH', tarjeta: 'CARD', transferencia: 'TRANSFER' })[raw];
    if (!method) return;
    await window.PosSales.payReceivable(selectedSale, { amount, paymentMethod: method });
  }
  async function routeTable(event) {
    const button = event.target.closest('button[data-client-action]'); if (!button) return;
    const { clientAction: action, id } = button.dataset;
    if (action === 'edit') edit(id);
    if (action === 'toggle') toggle(id);
    if (action === 'statement') statement(id);
    if (action === 'invoice') { el('statementModal').classList.add('hidden'); setTimeout(() => window.PosSales.viewInvoice(id), 100); }
    if (action === 'pay') { el('statementModal').classList.add('hidden'); setTimeout(() => openPayment(id), 100); }
  }
  for (const id of ['addNewClientBtn', 'quickAddClientBtn']) el(id)?.addEventListener('click', () => { el('clientDebt').required = false; el('clientCreditDays').required = true; el('clientDebtField').classList.add('hidden'); el('clientCreditDaysField').classList.remove('hidden'); el('clientCreditDays').value = '30'; el('clientModalTitle').textContent = 'Nuevo cliente'; });
  el('clientsTableBody')?.addEventListener('click', routeTable);
  el('receivablesTableBody')?.addEventListener('click', routeTable);
  el('statementTableBody')?.addEventListener('click', routeTable);
  clientAutocomplete = window.PosAutocomplete?.setup(el('clientSearchInput'), {
    getItems: query => clients.filter(client => clientMatches(client, query)),
    getLabel: client => client.name,
    getMeta: client => [client.phone, client.ruc ? 'RUC: ' + client.ruc : '', 'ID: ' + client.id].filter(Boolean).join(' · '),
    onInput: () => {
      selectedClientSuggestionId = null;
      clearTimeout(clientSearchTimer);
      clientSearchTimer = setTimeout(() => load('clientsView'), 250);
    },
    onSelect: client => {
      selectedClientSuggestionId = client.id;
      load('clientsView', client.name);
    }
  });
  creditAutocomplete = window.PosAutocomplete?.setup(el('creditClientSearch'), {
    getItems: query => creditClients.filter(client => client.active && clientMatches(client, query)),
    getLabel: client => client.name,
    getMeta: client => [client.phone, client.ruc ? 'RUC: ' + client.ruc : '', 'ID: ' + client.id, 'Disponible: ' + money(client.availableCredit)].filter(Boolean).join(' · '),
    onInput: query => {
      const select = el('creditClientSelect');
      const selected = creditClients.find(client => client.id === select.value);
      if (selected && normalize(selected.name) !== normalize(query)) {
        select.value = '';
        el('creditDays').value = '30';
      }
    },
    onSelect: client => {
      el('creditClientSelect').value = client.id;
      el('creditClientSelect').dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  el('creditClientSelect')?.addEventListener('change', () => {
    const client = creditClients.find(value => value.id === el('creditClientSelect').value && value.active);
    el('creditDays').value = client ? String(client.creditDays) : '30';
    if (client) el('creditClientSearch').value = client.name;
    creditAutocomplete?.close();
  });
  el('creditDays').readOnly = true;
  el('clientModal')?.querySelector('.close-modal-btn')?.addEventListener('click', () => { el('clientDebt').required = true; el('clientCreditDays').required = false; el('clientDebtField').classList.remove('hidden'); el('clientCreditDaysField').classList.add('hidden'); });
  document.addEventListener('pos:period-changed', event => {
    if (event.detail?.id === 'receivables') renderReceivables();
    if (event.detail?.id === 'statement') window.PosPeriodFilters?.filterTable('statementTableBody', event.detail.range);
  });
  window.PosClients = Object.freeze({ load, loadCreditClients, edit, toggle, statement, save, submitPayment, openPayment, refreshCreditClients: loadCreditClients });
})();
