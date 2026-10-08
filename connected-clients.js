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
  function actionButton(label, action, id) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-sm btn-secondary';
    button.textContent = label; button.dataset.clientAction = action; button.dataset.id = id; return button;
  }
  function renderClients() {
    const body = el('clientsTableBody'); if (!body) return;
    body.replaceChildren();
    if (!clients.length) { const row = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = 7; cell.className = 'text-center'; cell.textContent = 'No hay clientes que coincidan.'; row.append(cell); body.append(row); return; }
    for (const client of clients) {
      if (client.businessId !== window.PosRuntime.salesInput().businessId) throw new window.PosApiError('INVALID_RESPONSE');
      const row = document.createElement('tr'); row.dataset.clientId = client.id;
      appendCell(row, client.name);
      appendCell(row, [client.phone, client.ruc].filter(Boolean).join(' · ') || '-');
      appendCell(row, money(client.creditLimit));
      appendCell(row, money(client.availableCredit));
      appendCell(row, money(client.debt));
      appendCell(row, client.active ? (Number(client.debt) > 0 ? 'Activo' : 'Al día') : 'Inactivo');
      const actions = document.createElement('td');
      actions.append(actionButton('Estado de cuenta', 'statement', client.id), document.createTextNode(' '));
      actions.append(actionButton('Editar', 'edit', client.id), document.createTextNode(' '));
      actions.append(actionButton(client.active ? 'Inactivar' : 'Activar', 'toggle', client.id));
      row.append(actions); body.append(row);
    }
  }
  function renderReceivables() {
    const body = el('receivablesTableBody'); if (!body) return;
    body.replaceChildren();
    if (!receivables.length) { const row = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = 9; cell.className = 'text-center'; cell.textContent = 'No hay cuentas por cobrar que coincidan.'; row.append(cell); body.append(row); return; }
    for (const item of receivables) {
      const row = document.createElement('tr'); row.dataset.saleId = item.id;
      row.dataset.tableDate = window.PosTables.dateKey(item.date);
      appendCell(row, item.clientName); appendCell(row, '#' + item.invoiceNumber); appendCell(row, formatDate(item.date));
      appendCell(row, money(item.total)); appendCell(row, money(item.paid)); appendCell(row, money(item.balance));
      appendCell(row, formatDate(item.dueAt)); appendCell(row, statusText(item.status));
      const actions = document.createElement('td'), button = actionButton('Abonar', 'pay', item.id);
      button.disabled = item.status === 'CANCELLED' || (item.remaining === '0.00') || !window.PosConnected.canManageModule('cajaView');
      actions.append(button); row.append(actions); body.append(row);
    }
  }
  async function load(view = 'clientsView', q = el('clientSearchInput')?.value.trim() || '') {
    if (!connectedMode || view !== 'clientsView') return;
    const request = ++pageRequest; message('Cargando clientes y cuentas por cobrar...', 'info');
    el('connectedClientsControls')?.classList.remove('hidden'); el('connectedReceivablesPanel')?.classList.remove('hidden');
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
      const value = await api(client => client.clientStatement(id)); const subtitle = el('statementModalSubtitle');
      subtitle.textContent = value.client.name + ' · Deuda actual ' + money(value.client.debt) + ' · Límite ' + money(value.client.creditLimit);
      el('statementModalTitle').textContent = 'Estado de cuenta';
      const invoiceMap = new Map(value.invoices.map(invoice => [invoice.id, invoice]));
      const entries = [
        ...value.invoices.map(invoice => ({ date: invoice.date, ref: 'Factura #' + invoice.invoiceNumber, detail: statusText(invoice.status), charge: money(invoice.total), paid: '-', balance: money(invoice.balance) })),
        ...value.payments.map(payment => { const invoice = invoiceMap.get(payment.saleId); return { date: payment.createdAt, ref: 'Abono factura #' + payment.invoiceNumber, detail: payment.paymentMethod + ' · ' + statusText(payment.status), charge: '-', paid: money(payment.amount), balance: invoice ? money(invoice.balance) : '-' }; })
      ].sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
      const body = el('statementTableBody'); body.replaceChildren();
      for (const entry of entries) { const row = document.createElement('tr'); appendCell(row, new Date(entry.date).toLocaleString()); appendCell(row, entry.ref); appendCell(row, entry.detail); appendCell(row, entry.charge); appendCell(row, entry.paid); appendCell(row, entry.balance); appendCell(row, '-'); body.append(row); }
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
    if (action === 'edit') edit(id); if (action === 'toggle') toggle(id); if (action === 'statement') statement(id); if (action === 'pay') openPayment(id);
  }
  for (const id of ['addNewClientBtn', 'quickAddClientBtn']) el(id)?.addEventListener('click', () => { el('clientDebt').required = false; el('clientCreditDays').required = true; el('clientDebtField').classList.add('hidden'); el('clientCreditDaysField').classList.remove('hidden'); el('clientCreditDays').value = '30'; el('clientModalTitle').textContent = 'Nuevo cliente'; });
  el('clientsTableBody')?.addEventListener('click', routeTable);
  el('receivablesTableBody')?.addEventListener('click', routeTable);
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
  window.PosClients = Object.freeze({ load, loadCreditClients, edit, toggle, statement, save, submitPayment, openPayment, refreshCreditClients: loadCreditClients });
})();
