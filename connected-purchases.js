/* global connectedMode */
'use strict';
(() => {
  if (!connectedMode) return;
  const el = id => document.getElementById(id);
  el('connectedPurchaseNumberField')?.classList.remove('hidden');
  if (el('purchInvoice')) el('purchInvoice').required = false;
  const money = value => 'C$' + Number(value || 0).toFixed(2);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const dateTime = value => { const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('es-NI'); };
  const date = value => { const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleDateString('es-NI'); };
  const purchaseNumber = purchase => purchase.purchaseNumber || 'COMP-' + String(purchase.id).padStart(6, '0');
  const purchaseReference = purchase => '<strong>' + esc(purchaseNumber(purchase)) + '</strong>' + (purchase.supplierInvoiceNumber ? '<br><small>Factura proveedor: ' + esc(purchase.supplierInvoiceNumber) + '</small>' : '');
  const dayKey = value => window.PosPeriodFilters?.dateKey(value) || (() => { const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? '' : parsed.getFullYear() + '-' + String(parsed.getMonth() + 1).padStart(2, '0') + '-' + String(parsed.getDate()).padStart(2, '0'); })();
  const statusLabel = value => ({ COMPLETED: 'Completada', CANCELLED: 'Anulada', PAID: 'Pagada', PARTIAL: 'Parcial', OPEN: 'Pendiente', OVERDUE: 'Vencida', PENDING_CONFIRMATION: 'Pago por confirmar', PENDING: 'Pendiente', POSTED: 'Registrado', VOID: 'Anulado' })[value] || value || '—';
  const uuid = () => crypto.randomUUID();
  const state = { suppliers: [], products: [], purchasesOffset: 0, payablesOffset: 0, purchaseHasNext: false, payableHasNext: false, quickSupplier: false, cart: [], purchaseSearchTimer: 0, supplierSearchTimer: 0, payableSearchTimer: 0, operationKey: null, currentView: null, loadedPurchase: null };
  const pageSize = 100;

  async function allPages(fetchPage, business) {
    const values = [];
    for (let offset = 0; ; offset += pageSize) {
      const page = await fetchPage(offset);
      if (page.some(value => value.businessId !== business)) throw new window.PosApiError('INVALID_SESSION', 401);
      values.push(...page);
      if (page.length < pageSize) return values;
    }
  }
  function setTable(bodyId, columns, rows, empty) {
    const body = el(bodyId);
    if (!body) return;
    body.innerHTML = rows.length ? rows.join('') : '<tr><td colspan="' + columns + '" class="text-center">' + esc(empty) + '</td></tr>';
    window.PosTables?.setDataTableExportEnabled(body, rows.length > 0);
    window.PosTables?.refreshDataTable(body);
  }
  function setConnectedView() {
    document.querySelectorAll('.local-procurement-content').forEach(node => node.classList.add('hidden'));
    document.querySelectorAll('.connected-procurement-content').forEach(node => node.classList.remove('hidden'));
    for (const id of ['connectedPurchasesControls', 'connectedPayablesControls', 'connectedSuppliersControls']) el(id)?.classList.add('hidden');
    el('connectedPayablesSummary')?.classList.add('hidden');
  }
  async function request(operation) {
    try { return await window.PosConnected.inventoryOperation(operation); }
    catch (error) {
      if (error.code === 'INVALID_SESSION') window.PosConnected.handleError(error);
      throw error;
    }
  }
  function showError(error, statusId) {
    if (statusId && el(statusId)) { el(statusId).textContent = error.message || 'No se pudo completar la solicitud.'; }
    else window.showAlert?.(error.message || 'No se pudo completar la solicitud.');
  }
  function refreshDerived() {
    document.dispatchEvent(new Event('connected:report-data-changed'));
  }
  async function loadSuppliers(modulePurchase = false, query = '') {
    state.suppliers = await request(async (api, business) => allPages(offset => modulePurchase ? api.purchaseSuppliers(offset, query) : api.suppliers(offset, query), business));
    return state.suppliers;
  }
  async function loadProducts() {
    state.products = await request(async (api, business) => allPages(offset => api.purchaseProducts(offset), business));
    window.PosRuntime.setProducts(state.products);
    return state.products;
  }
  async function renderPurchases(query = '') {
    const offset = state.purchasesOffset;
    const result = await request((api, business) => allPages(pageOffset => api.purchases(pageOffset, query), business));
    const range = window.PosPeriodFilters?.range('purchases') || { from: '', until: '' };
    const filtered = result.filter(purchase => window.PosPeriodFilters?.matches(purchase.createdAt, range));
    const page = filtered;
    state.purchaseHasNext = offset + pageSize < filtered.length;
    el('connectedPurchasesPrev').disabled = offset === 0;
    el('connectedPurchasesNext').disabled = !state.purchaseHasNext;
    el('connectedPurchasesPage').textContent = String(Math.floor(offset / pageSize) + 1);
    setTable('connectedPurchasesTableBody', 7, page.map(purchase => {
      const status = purchase.status === 'CANCELLED' ? 'Anulada' : purchase.purchaseType === 'CREDIT' ? statusLabel(purchase.status) + (purchase.dueAt ? ' · vence ' + date(purchase.dueAt) : '') : 'Contado';
      const total = purchase.status === 'CANCELLED' ? '<del>' + money(purchase.total) + '</del>' : money(purchase.total);
      const actions = '<button type="button" class="btn btn-sm btn-info" data-purchase-action="view" data-purchase-id="' + esc(purchase.id) + '">Ver factura</button>' + (purchase.status === 'CANCELLED' ? '' : ' <button type="button" class="btn btn-sm btn-danger" data-purchase-action="cancel" data-purchase-id="' + esc(purchase.id) + '">Anular</button>');
      return '<tr data-table-date="' + esc(dayKey(purchase.createdAt)) + '"><td>' + esc(dateTime(purchase.createdAt)) + '</td><td>' + purchaseReference(purchase) + '</td><td>' + esc(purchase.supplierName) + '</td><td>' + Number(purchase.itemCount || 0) + ' productos</td><td>' + total + '</td><td>' + esc(status) + '</td><td>' + actions + '</td></tr>';
    }), 'No hay facturas de compra registradas.');
    el('connectedPurchasesStatus').textContent = filtered.length + ' compra(s) dentro del período seleccionado.';
  }
  async function renderPayables() {
    const results = await request(async (api, business) => {
      const [rows, summary] = await Promise.all([allPages(offset => api.payables(offset), business), api.payablesSummary()]);
      if (summary.businessId !== business) throw new window.PosApiError('INVALID_SESSION', 401);
      return { rows, summary };
    });
    const range = window.PosPeriodFilters?.range('payables') || { from: '', until: '' };
    const allOpen = results.rows.filter(purchase => Number(purchase.balance) > 0);
    const inPeriod = allOpen.filter(purchase => window.PosPeriodFilters?.matches(purchase.dueAt, range));
    const groups = new Map();
    for (const invoice of inPeriod) {
      const id = String(invoice.supplierId);
      const group = groups.get(id) || { id, name: invoice.supplierName, invoices: [], nextDueAt: invoice.dueAt };
      group.invoices.push(invoice);
      if (Date.parse(invoice.dueAt) < Date.parse(group.nextDueAt)) group.nextDueAt = invoice.dueAt;
      groups.set(id, group);
    }
    const rows = [...groups.values()].sort((a, b) => Date.parse(a.nextDueAt) - Date.parse(b.nextDueAt)).map(group => {
      const supplier = state.suppliers.find(item => String(item.id) === group.id);
      const balance = allOpen.filter(invoice => String(invoice.supplierId) === group.id).reduce((total, invoice) => total + Number(invoice.balance || 0), 0);
      const action = '<button type="button" class="btn btn-sm btn-info" data-supplier-action="statement" data-supplier-id="' + esc(group.id) + '">Ver Facturas</button>';
      return '<tr><td><strong>' + esc(supplier?.name || group.name) + '</strong></td><td>' + esc(supplier?.phone || '—') + '</td><td style="color:#d32f2f;font-weight:bold;">' + esc(date(group.nextDueAt)) + '</td><td style="color:#d32f2f;font-weight:bold;font-size:1.1em;">' + money(balance) + '</td><td>' + action + '</td></tr>';
    });
    setTable('connectedPayablesTableBody', 5, rows, 'No hay facturas pendientes con vencimiento en este período.');
    const status = el('connectedPayablesStatus');
    if (status) status.textContent = inPeriod.length + ' factura(s) con vencimiento dentro del período seleccionado.';
  }
  function renderSuppliers(rows = state.suppliers) {
    setTable('connectedSuppliersTableBody', 6, rows.map(supplier => {
      const active = supplier.active !== false;
      const actions = '<div class="connected-supplier-actions">' +
        '<button type="button" class="btn btn-sm btn-info" data-supplier-action="statement" data-supplier-id="' + esc(supplier.id) + '">Edo. Cuenta</button>' +
        '<button type="button" class="btn btn-sm btn-primary" data-supplier-action="edit" data-supplier-id="' + esc(supplier.id) + '">Editar</button>' +
        '<button type="button" class="btn btn-sm ' + (active ? 'btn-warning' : 'btn-success') + '" data-supplier-action="toggle" data-supplier-id="' + esc(supplier.id) + '">' + (active ? 'Inactivar' : 'Activar') + '</button></div>';
      const inactiveStyle = active ? '' : ' style="background-color:#f9f9f9;opacity:0.8;"';
      return '<tr' + inactiveStyle + '><td><strong>' + esc(supplier.name) + '</strong><br><small>RUC: ' + esc(supplier.ruc || 'N/A') + '</small></td>' +
        '<td>' + esc(supplier.contact || '—') + '<br><small>' + esc(supplier.phone || '') + '</small></td>' +
        '<td><small>' + esc(supplier.address || '—') + '</small></td>' +
        '<td><strong class="connected-supplier-purchases">' + money(supplier.totalPurchased) + '</strong><br><small>' + Number(supplier.purchaseCount || 0) + ' compras</small></td>' +
        '<td><strong class="connected-supplier-debt">' + money(supplier.debt) + '</strong></td><td>' + actions + '</td></tr>';
    }), 'No hay proveedores registrados.');
    const list = el('supplierDataList');
    if (list) list.innerHTML = state.suppliers.filter(row => row.active).map(row => '<option value="' + esc(row.name) + '"></option>').join('');
  }
  async function load(view) {
    state.currentView = view;
    if (!['purchasesView', 'payablesView', 'suppliersView'].includes(view)) return false;
    setConnectedView();
    try {
      if (view === 'purchasesView') {
        state.purchasesOffset = 0;
        await Promise.all([loadSuppliers(true), loadProducts()]);
        await renderPurchases(el('connectedPurchasesSearch').value.trim());
      } else if (view === 'payablesView') {
        state.payablesOffset = 0;
        await loadSuppliers(false);
        await renderPayables(el('connectedPayablesSearch').value.trim());
      } else {
        await loadSuppliers(false);
        renderSuppliers();
      }
      return true;
    } catch (error) { showError(error, view === 'purchasesView' ? 'connectedPurchasesStatus' : view === 'payablesView' ? 'connectedPayablesStatus' : 'connectedSuppliersStatus'); return false; }
  }
  function renderCart() {
    const rows = state.cart.map((item, index) => '<tr><td><strong>' + esc(item.name) + '</strong></td><td>' + item.quantity.toFixed(3) + '</td><td>' + money(item.unitCost) + '</td><td>' + money(item.quantity * item.unitCost) + '</td><td><button type="button" class="btn btn-sm btn-secondary" data-cart-remove="' + index + '" aria-label="Quitar ' + esc(item.name) + '">Quitar</button></td></tr>');
    setTable('purchCartBody', 5, rows, 'Aún no hay productos en esta factura.');
    el('purchTotalDisplay').textContent = money(state.cart.reduce((sum, item) => sum + item.quantity * item.unitCost, 0));
  }
  function clearOperationKey() { state.operationKey = null; }
  function openPurchase() {
    el('purchaseForm').reset(); el('purchId').value = ''; state.cart = []; clearOperationKey();
    if (!state.suppliers.length || !state.products.length) { window.showAlert('Agrega al menos un proveedor y un producto activo antes de registrar una compra.'); return; }
    el('purchPaymentMethodContainer').classList.remove('hidden');
    el('purchPaymentMethodContainer').classList.toggle('hidden', el('purchType').value !== 'contado');
    el('purchDaysContainer').style.display = 'none';
    el('connectedPurchaseHint').textContent = 'La compra actualizará existencias y costo. Si compras o abonas en efectivo, debe haber una caja abierta.';
    el('connectedPurchaseHint').classList.remove('hidden');
    renderCart(); el('purchaseModal').classList.remove('hidden'); el('purchSupplier').focus();
  }
  function closePurchase() { el('purchaseModal')?.classList.add('hidden'); state.cart = []; clearOperationKey(); if (el('purchInternalNumber')) el('purchInternalNumber').value = 'Se asigna al guardar'; }
  function resolveProduct(query) {
    const value = String(query || '').trim(), normalize = window.PosProductSearch.normalize;
    if (!value) return { product: null, ambiguous: false };
    const exactCodes = window.PosProductSearch.exactCodeMatches(state.products, value);
    const matches = exactCodes.length ? exactCodes : state.products.filter(product => normalize(product.name) === normalize(value));
    return { product: matches.length === 1 ? matches[0] : null, ambiguous: matches.length > 1 };
  }
  function addPurchaseItem() {
    const input = el('purchProductTemp'), text = input.value.trim(), result = resolveProduct(text);
    const quantity = Number(el('purchQtyTemp').value), unitCost = Number(el('purchCostTemp').value);
    if (!text || !result.product || !Number.isFinite(quantity) || quantity <= 0 || !/^\d+(?:\.\d{1,3})?$/.test(el('purchQtyTemp').value) || !Number.isFinite(unitCost) || unitCost < 0 || !/^\d+(?:\.\d{1,2})?$/.test(el('purchCostTemp').value)) {
      window.showAlert(result.ambiguous ? 'El código coincide con varios productos. Escribe el nombre exacto.' : !result.product ? 'Selecciona un producto existente o créalo desde Compras.' : 'Revisa cantidad y costo; admite hasta 3 decimales y 2 decimales.'); return false;
    }
    if (state.cart.some(item => item.productId === result.product.id)) { window.showAlert('Ese producto ya está en la factura. Ajusta su cantidad antes de volver a agregarlo.'); return false; }
    state.cart.push({ productId: result.product.id, name: result.product.name, quantity, unitCost });
    input.value = ''; input.dataset.productId = ''; el('purchQtyTemp').value = '1'; el('purchCostTemp').value = '';
    clearOperationKey(); renderCart(); input.focus(); return true;
  }
  async function savePurchase() {
    const supplier = state.suppliers.find(item => item.active && item.name.toLocaleLowerCase('es') === el('purchSupplier').value.trim().toLocaleLowerCase('es'));
    const supplierInvoiceNumber = el('purchInvoice').value.trim(), credit = el('purchType').value === 'credito';
    const total = state.cart.reduce((sum, item) => sum + item.quantity * item.unitCost, 0);
    if (!supplier) return window.showAlert('Selecciona un proveedor activo de la lista.');
    if (/^COMP-\d{6,}$/i.test(supplierInvoiceNumber)) return window.showAlert('Ese formato está reservado para el número interno de compra.');
    if (!state.cart.length || total <= 0) return window.showAlert('Agrega al menos un producto con importe mayor que cero.');
    if (credit && (!/^\d+$/.test(el('purchDays').value) || Number(el('purchDays').value) < 1 || Number(el('purchDays').value) > 3650)) return window.showAlert('El plazo debe ser de 1 a 3,650 días.');
    const button = el('purchaseForm').querySelector('button[type="submit"]'); button.disabled = true;
    const data = { operationKey: state.operationKey || (state.operationKey = uuid()), supplierId: supplier.id, supplierInvoiceNumber: supplierInvoiceNumber || null, purchaseType: credit ? 'CREDIT' : 'CASH', items: state.cart.map(item => ({ productId: item.productId, quantity: item.quantity.toFixed(3), unitCost: item.unitCost.toFixed(2) })) };
    if (credit) data.dueDays = Number(el('purchDays').value);
    else data.paymentMethod = el('purchPaymentMethod').value;
    try {
      const purchase = await request((api, business) => api.createPurchase(data).then(row => { if (row.businessId !== business) throw new window.PosApiError('INVALID_SESSION', 401); return row; }));
      state.operationKey = null; closePurchase(); await Promise.all([renderPurchases(el('connectedPurchasesSearch').value.trim()), loadProducts()]);
      const reference = purchaseNumber(purchase) + (purchase.supplierInvoiceNumber ? ' (factura del proveedor ' + purchase.supplierInvoiceNumber + ')' : '');
      refreshDerived(); window.showAlert('Compra ' + reference + ' registrada. Existencias y costo actualizados.');
    } catch (error) { showError(error, 'connectedPurchasesStatus'); }
    finally { button.disabled = false; }
  }
  function viewPurchase(purchase) {
    const lines = (purchase.items || []).map(item => '<div style="display:flex;justify-content:space-between;gap:12px;margin:5px 0"><span>' + Number(item.quantity).toFixed(3) + ' × ' + esc(item.name) + ' · costo ' + money(item.unitCost) + '</span><strong>' + money(item.total) + '</strong></div>').join('');
    const status = purchase.status === 'CANCELLED' ? '<p style="color:#b91c1c;font-weight:700">Factura anulada: ' + esc(purchase.cancelReason || '') + '</p>' : '';
    el('ticketContent').innerHTML = '<div id="imprimibleTicket" style="font-family:system-ui;background:#fff;border:1px dashed #cbd5e1;padding:22px;width:100%;max-width:440px;color:#172033"><h3 style="text-align:center;margin:0">COMPROBANTE DE COMPRA</h3><p style="text-align:center">Proveedor: ' + esc(purchase.supplierName) + '</p><hr><p>N° compra interno: <strong>' + esc(purchaseNumber(purchase)) + '</strong></p>' + (purchase.supplierInvoiceNumber ? '<p>Factura del proveedor: <strong>' + esc(purchase.supplierInvoiceNumber) + '</strong></p>' : '') + '<p>Fecha: ' + esc(dateTime(purchase.createdAt)) + '</p><p>Condición: ' + (purchase.purchaseType === 'CREDIT' ? 'Crédito · vence ' + esc(date(purchase.dueAt)) : 'Contado') + '</p>' + status + '<hr>' + lines + '<hr><p style="text-align:right"><strong>Total ' + money(purchase.total) + '</strong></p><p>Abonado: ' + money(purchase.paid) + ' · Saldo: ' + money(purchase.balance) + '</p></div>';
    el('ticketModal').classList.remove('hidden');
  }
  async function viewPurchaseById(id) {
    try { const purchase = await request(async (api, business) => { const row = state.currentView === 'payablesView' ? await api.payable(id) : await api.purchase(id); if (row.businessId !== business) throw new window.PosApiError('INVALID_SESSION', 401); return row; }); viewPurchase(purchase); }
    catch (error) { showError(error); }
  }
  function askCancel(purchase) {
    state.loadedPurchase = purchase;
    el('cancelConnectedPurchaseId').value = purchase.id;
    el('cancelConnectedPurchaseDescription').textContent = 'Compra ' + purchaseNumber(purchase) + (purchase.supplierInvoiceNumber ? ' · factura del proveedor ' + purchase.supplierInvoiceNumber : '') + ' por ' + money(purchase.total) + '. Se revertirá inventario. Los pagos en efectivo requieren la caja donde se registraron aún abierta.';
    el('cancelConnectedPurchaseReason').value = '';
    el('cancelConnectedPurchaseModal').classList.remove('hidden');
    el('cancelConnectedPurchaseReason').focus();
  }
  async function cancelPurchase(event) {
    event.preventDefault();
    const id = el('cancelConnectedPurchaseId').value, reason = el('cancelConnectedPurchaseReason').value.trim();
    if (!reason) return;
    const button = event.currentTarget.querySelector('button[type="submit"]'); button.disabled = true;
    try {
      const result = await request((api, business) => api.cancelPurchase(id, { operationKey: uuid(), reason }).then(row => { if (row.businessId !== business) throw new window.PosApiError('INVALID_SESSION', 401); return row; }));
      el('cancelConnectedPurchaseModal').classList.add('hidden');
      await Promise.all([renderPurchases(el('connectedPurchasesSearch').value.trim()), loadProducts()]);
      refreshDerived(); window.showAlert('Compra ' + purchaseNumber(result) + ' anulada. Se revirtió el inventario.');
    } catch (error) { showError(error); }
    finally { button.disabled = false; }
  }
  function newSupplier(quick = false) {
    state.quickSupplier = quick;
    el('supplierForm').reset(); el('supplierId').value = '';
    el('supplierModalTitle').textContent = quick ? 'Agregar proveedor para esta compra' : 'Nuevo proveedor';
    el('supplierModal').classList.remove('hidden'); el('suppName').focus();
  }
  function editSupplier(id) {
    const supplier = state.suppliers.find(row => row.id === String(id)); if (!supplier) return;
    state.quickSupplier = false;
    el('supplierModalTitle').textContent = 'Editar proveedor';
    el('supplierId').value = supplier.id; el('suppName').value = supplier.name; el('suppContact').value = supplier.contact || '';
    el('suppPhone').value = supplier.phone || ''; el('suppRuc').value = supplier.ruc || ''; el('suppAddress').value = supplier.address || '';
    el('supplierModal').classList.remove('hidden'); el('suppName').focus();
  }
  async function saveSupplier() {
    const data = { name: el('suppName').value.trim(), contact: el('suppContact').value.trim(), phone: el('suppPhone').value.trim(), ruc: el('suppRuc').value.trim(), address: el('suppAddress').value.trim() };
    if (!data.name) return window.showAlert('Ingresa el nombre del proveedor.');
    const id = el('supplierId').value, quick = state.quickSupplier, button = el('supplierForm').querySelector('button[type="submit"]'); button.disabled = true;
    try {
      await request(async api => {
        if (id) return api.updateSupplier(id, data);
        return quick ? api.createPurchaseSupplier(data) : api.createSupplier(data);
      });
      el('supplierModal').classList.add('hidden');
      await loadSuppliers(quick || state.currentView === 'purchasesView');
      if (state.currentView === 'suppliersView') renderSuppliers();
      if (quick) el('purchSupplier').value = data.name;
      refreshDerived(); window.showAlert(id ? 'Proveedor actualizado.' : 'Proveedor guardado.');
    } catch (error) { showError(error); }
    finally { button.disabled = false; }
  }
  async function toggleSupplier(id) {
    const supplier = state.suppliers.find(row => row.id === String(id)); if (!supplier) return;
    window.showConfirm('¿Deseas ' + (supplier.active ? 'inactivar' : 'activar') + ' al proveedor ' + supplier.name + '?', async () => {
      try { await request(api => api.setSupplierActive(id, !supplier.active)); await loadSuppliers(false); renderSuppliers(); }
      catch (error) { showError(error); }
    });
  }
  async function supplierStatement(id) {
    try {
      const data = await request(api => api.supplierStatement(id));
      el('statementModalTitle').textContent = 'Estado de cuenta: ' + data.supplier.name;
      el('statementModalSubtitle').textContent = 'Deuda actual: ' + money(data.supplier.debt) + ' · Compras registradas: ' + Number(data.supplier.purchaseCount || 0);
      const payableRows = [];
      const renderedRows = data.entries.map(entry => {
        const charge = Number(entry.charge || 0), paid = Number(entry.paid || 0);
        const canPay = entry.kind === 'PURCHASE' && entry.canPay === true;
        payableRows.push(canPay);
        const buttons = entry.kind === 'PURCHASE' ? '<button type="button" class="btn btn-sm btn-info" data-statement-action="view" data-purchase-id="' + esc(entry.purchaseId) + '">Ver factura</button>' + (canPay ? ' <button type="button" class="btn btn-sm btn-success" data-statement-action="pay" data-purchase-id="' + esc(entry.purchaseId) + '">Abonar</button>' : '') : '';
        return '<tr data-period-date="' + esc(window.PosPeriodFilters?.dateKey(entry.date) || '') + '"><td>' + esc(dateTime(entry.date)) + '</td><td>' + esc(entry.reference || '—') + '</td><td>' + esc(entry.description || '—') + (entry.pending ? '<br><small>Por confirmar ' + money(entry.pending) + '</small>' : '') + '</td><td>' + (charge ? money(charge) : '—') + '</td><td>' + (paid ? money(paid) : '—') + '</td><td>' + money(entry.runningBalance) + '</td><td>' + buttons + '</td></tr>';
      });
      const orderedRows = [...renderedRows.filter((_, index) => payableRows[index]), ...renderedRows.filter((_, index) => !payableRows[index])];
      setTable('statementTableBody', 7, orderedRows, 'No hay movimientos registrados.');
      window.PosPeriodFilters?.filterTable('statementTableBody', window.PosPeriodFilters.range('statement'));
      el('statementModal').classList.remove('hidden');
    } catch (error) { showError(error); }
  }
  async function openInvoicePayment(id) {
    try {
      const purchase = await request(api => state.currentView === 'payablesView' ? api.payable(id) : api.purchase(id));
      if (purchase.purchaseType !== 'CREDIT' || Number(purchase.balance) <= 0) return window.showAlert('Esta factura no tiene saldo pendiente.');
      el('payInvoiceId').value = purchase.id; el('payInvoiceNumero').textContent = purchaseNumber(purchase) + (purchase.supplierInvoiceNumber ? ' · Factura proveedor ' + purchase.supplierInvoiceNumber : ''); el('payInvoiceProveedor').textContent = purchase.supplierName;
      el('payInvoiceTotal').textContent = money(purchase.total); el('payInvoicePaid').textContent = money(purchase.paid); el('payInvoiceSaldo').textContent = money(purchase.balance);
      const available = Math.max(0, Number(purchase.balance) - Number(purchase.pendingPayments || 0));
      el('payInvoiceAmount').value = ''; el('payInvoiceAmount').max = available.toFixed(2); el('payInvoiceAmount').disabled = available <= 0;
      const submit = el('paymentInvoiceForm').querySelector('button[type="submit"]'); submit.disabled = available <= 0;
      const hint = el('connectedPaymentHint');
      if (hint) { hint.textContent = available <= 0 ? 'Hay un pago esperando confirmación en Caja.' : 'Los pagos con tarjeta o transferencia quedan pendientes hasta confirmarlos en Caja.'; hint.classList.remove('hidden'); }
      el('paymentInvoiceModal').classList.remove('hidden'); el('payInvoiceAmount').focus();
    } catch (error) { showError(error); }
  }
  async function payInvoice(event) {
    event?.preventDefault();
    const id = el('payInvoiceId').value, amount = el('payInvoiceAmount').value;
    if (!/^\d+(?:\.\d{1,2})?$/.test(amount) || Number(amount) <= 0 || Number(amount) > Number(el('payInvoiceAmount').max)) return window.showAlert('Ingresa un pago válido que no supere el saldo disponible.');
    const methodMap = { efectivo: 'CASH', tarjeta: 'CARD', transferencia: 'TRANSFER' }, paymentMethod = methodMap[el('payInvoiceMethod').value] || 'OTHER';
    const button = el('paymentInvoiceForm').querySelector('button[type="submit"]'); button.disabled = true;
    try {
      const payment = await request(api => api.paySupplierInvoice(id, { operationKey: uuid(), amount: Number(amount).toFixed(2), paymentMethod }));
      el('paymentInvoiceModal').classList.add('hidden');
      if (state.currentView === 'payablesView') await renderPayables(el('connectedPayablesSearch').value.trim());
      refreshDerived(); window.showAlert(payment.status === 'PENDING' ? 'Pago pendiente de confirmar en Caja.' : 'Pago registrado.');
    } catch (error) { showError(error); }
    finally { button.disabled = false; }
  }
  function viewPurchaseAction(event) {
    const button = event.target.closest('[data-purchase-action]'); if (!button) return;
    const id = button.dataset.purchaseId;
    if (button.dataset.purchaseAction === 'view') viewPurchaseById(id);
    if (button.dataset.purchaseAction === 'pay') openInvoicePayment(id);
    if (button.dataset.purchaseAction === 'cancel') {
      const row = button.closest('tr');
      state.loadedPurchase = { id, invoiceNumber: row.cells[1]?.textContent || row.cells[0]?.textContent, total: 0 };
      request(api => api.purchase(id)).then(purchase => askCancel(purchase)).catch(showError);
    }
  }
  el('connectedPurchasesTableBody').addEventListener('click', viewPurchaseAction);
  el('connectedPayablesTableBody').addEventListener('click', viewPurchaseAction);
  el('connectedPayablesTableBody').addEventListener('click', event => {
    const button = event.target.closest('[data-supplier-action="statement"]');
    if (button) supplierStatement(button.dataset.supplierId);
  });
  el('statementTableBody').addEventListener('click', event => {
    const button = event.target.closest('[data-statement-action]'); if (!button) return;
    el('statementModal').classList.add('hidden');
    if (button.dataset.statementAction === 'view') viewPurchaseById(button.dataset.purchaseId);
    else openInvoicePayment(button.dataset.purchaseId);
  });
  el('connectedSuppliersTableBody').addEventListener('click', event => {
    const button = event.target.closest('[data-supplier-action]'); if (!button) return;
    const id = button.dataset.supplierId;
    if (button.dataset.supplierAction === 'statement') supplierStatement(id);
    if (button.dataset.supplierAction === 'edit') editSupplier(id);
    if (button.dataset.supplierAction === 'toggle') toggleSupplier(id);
  });
  el('purchCartBody').addEventListener('click', event => {
    const button = event.target.closest('[data-cart-remove]'); if (!button) return;
    state.cart.splice(Number(button.dataset.cartRemove), 1); clearOperationKey(); renderCart();
  });
  el('purchType').addEventListener('change', () => {
    el('purchPaymentMethodContainer').classList.toggle('hidden', el('purchType').value !== 'contado');
    clearOperationKey();
  });
  el('purchaseForm').addEventListener('input', clearOperationKey);
  el('purchProductTemp').addEventListener('input', () => {
    const result = resolveProduct(el('purchProductTemp').value);
    const list = el('productDataList');
    if (list) list.innerHTML = state.products.filter(product => window.PosProductSearch.normalize(product.name).includes(window.PosProductSearch.normalize(el('purchProductTemp').value)) || String(product.barcode || '').includes(el('purchProductTemp').value)).slice(0, 25).map(product => '<option value="' + esc(product.name) + '" label="' + esc(product.barcode || '') + '"></option>').join('');
    if (result.product) el('purchProductTemp').dataset.productId = result.product.id; else delete el('purchProductTemp').dataset.productId;
  });
  el('quickEditProductFromPurchBtn').classList.add('hidden');
  el('cancelConnectedPurchaseForm').addEventListener('submit', cancelPurchase);
  el('cancelConnectedPurchaseClose').addEventListener('click', () => el('cancelConnectedPurchaseModal').classList.add('hidden'));
  function applyPeriod(view) {
    if (view === 'purchasesView') { state.purchasesOffset = 0; return renderPurchases(el('connectedPurchasesSearch').value.trim()).catch(error => showError(error, 'connectedPurchasesStatus')); }
    if (view === 'payablesView') { state.payablesOffset = 0; return renderPayables(el('connectedPayablesSearch').value.trim()).catch(error => showError(error, 'connectedPayablesStatus')); }
    return Promise.resolve();
  }
  document.addEventListener('pos:period-changed', event => {
    if (event.detail?.id === 'purchases' && state.currentView === 'purchasesView') applyPeriod('purchasesView');
    if (event.detail?.id === 'payables' && state.currentView === 'payablesView') applyPeriod('payablesView');
    if (event.detail?.id === 'statement') window.PosPeriodFilters?.filterTable('statementTableBody', event.detail.range);
  });
  el('connectedPurchasesPrev').addEventListener('click', () => { state.purchasesOffset = Math.max(0, state.purchasesOffset - pageSize); renderPurchases(el('connectedPurchasesSearch').value.trim()).catch(error => showError(error, 'connectedPurchasesStatus')); });
  el('connectedPurchasesNext').addEventListener('click', () => { if (!state.purchaseHasNext) return; state.purchasesOffset += pageSize; renderPurchases(el('connectedPurchasesSearch').value.trim()).catch(error => showError(error, 'connectedPurchasesStatus')); });
  el('connectedPayablesPrev').addEventListener('click', () => { state.payablesOffset = Math.max(0, state.payablesOffset - pageSize); renderPayables(el('connectedPayablesSearch').value.trim()).catch(error => showError(error, 'connectedPayablesStatus')); });
  el('connectedPayablesNext').addEventListener('click', () => { if (!state.payableHasNext) return; state.payablesOffset += pageSize; renderPayables(el('connectedPayablesSearch').value.trim()).catch(error => showError(error, 'connectedPayablesStatus')); });
  el('connectedPurchasesSearch').addEventListener('input', () => { clearTimeout(state.purchaseSearchTimer); state.purchasesOffset = 0; state.purchaseSearchTimer = setTimeout(() => renderPurchases(el('connectedPurchasesSearch').value.trim()).catch(error => showError(error, 'connectedPurchasesStatus')), 250); });
  el('connectedPayablesSearch').addEventListener('input', () => { clearTimeout(state.payableSearchTimer); state.payablesOffset = 0; state.payableSearchTimer = setTimeout(() => renderPayables(el('connectedPayablesSearch').value.trim()).catch(error => showError(error, 'connectedPayablesStatus')), 250); });
  el('connectedSuppliersSearch').addEventListener('input', () => { clearTimeout(state.supplierSearchTimer); state.supplierSearchTimer = setTimeout(() => {
    const query = el('connectedSuppliersSearch').value.trim().toLocaleLowerCase('es');
    renderSuppliers(state.suppliers.filter(item => [item.name, item.contact, item.phone, item.ruc, item.address].some(value => String(value || '').toLocaleLowerCase('es').includes(query))));
  }, 100); });

  window.PosPurchases = Object.freeze({ load, openPurchase, closePurchase, addItem: addPurchaseItem, addPurchaseItem, savePurchase, applyPeriod, supplierOptions: () => state.suppliers, quickEditProduct() { window.showAlert('Editar productos requiere entrar a Inventario.'); }, productCreated(product) { if (!state.products.some(row => row.id === product.id)) state.products.push(product); window.PosRuntime.setProducts(state.products); el('purchProductTemp').value = product.name; el('purchProductTemp').dataset.productId = product.id; el('purchCostTemp').value = Number(product.cost || 0).toFixed(2); }, newSupplier, editSupplier, saveSupplier, toggleSupplier, supplierStatement, viewPurchase: viewPurchaseById, openInvoicePayment, payInvoice, cancelPurchase: askCancel });
})();
