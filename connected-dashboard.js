/* global connectedMode */
'use strict';
(() => {
  if (!connectedMode) return;
  const el = id => document.getElementById(id);
  const money = value => `C$${Number(value || 0).toFixed(2)}`;
  const purchaseReference = row => (row.purchaseNumber || row.invoiceNumber || '—') + (row.supplierInvoiceNumber ? ' · Factura proveedor ' + row.supplierInvoiceNumber : '');
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const dayKey = value => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };
  const dateTime = value => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('es-NI');
  };
  const paymentLabel = value => ({ CASH: 'Efectivo', CARD: 'Tarjeta', TRANSFER: 'Transferencia', CREDIT: 'Crédito', OTHER: 'Otro' })[value] || value || '—';
  const movementLabel = value => ({ SALE: 'Venta', CUSTOMER_PAYMENT: 'Abono de cliente', REVERSAL: 'Devolución', MANUAL_ENTRY: 'Entrada manual', MANUAL_EXIT: 'Salida manual', EXPENSE: 'Gasto', SUPPLIER_PAYMENT: 'Pago a proveedor' })[value] || value || 'Movimiento';
  const statusLabel = value => ({ COMPLETED: 'Completada', CANCELLED: 'Anulada', CONFIRMED: 'Confirmado', PENDING: 'Pendiente', VOID: 'Anulado', POSTED: 'Registrado', PARTIAL: 'Parcial', PAID: 'Pagada', OPEN: 'Pendiente', OVERDUE: 'Vencida', PENDING_CONFIRMATION: 'Por confirmar' })[value] || value || '—';
  let currentData = null, requestId = 0;

  function apiRange() {
    const range = window.PosDashboardPeriod?.range() || { from: '', until: '' };
    if (range.error) throw new Error(range.error);
    const start = value => {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
      return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
    };
    const from = start(range.from), until = start(range.until);
    if (until) until.setDate(until.getDate() + 1);
    return { from: from ? from.toISOString() : null, until: until ? until.toISOString() : null };
  }
  function setRows(id, columns, rows, emptyText) {
    const body = el(id);
    if (!body) return;
    body.innerHTML = rows.length ? rows.map(row => `<tr>${row}</tr>`).join('') : `<tr><td colspan="${columns}" class="text-center">${esc(emptyText)}</td></tr>`;
    window.PosTables?.setDataTableExportEnabled(body, rows.length > 0);
    window.PosTables?.refreshDataTable(body);
  }
  function setText(id, value) { const node = el(id); if (node) node.textContent = value; }
  function render(data) {
    currentData = data;
    const status = el('connectedDashboardStatus');
    if (status) status.textContent = 'El período filtra ventas, compras, gastos, abonos y movimientos de caja. El inventario y los saldos de CxC/CxP son actuales.';
    const saleCount = Number(data.sales.count || 0);
    setText('connectedDashSalesTotal', money(data.sales.total));
    setText('connectedDashSalesCount', String(saleCount));
    setText('connectedDashTicketAverage', money(saleCount ? Number(data.sales.total) / saleCount : 0));
    setText('connectedDashProfitSales', money(data.sales.total));
    setText('connectedDashSalesCost', money(data.sales.cost));
    setText('connectedDashGrossProfit', money(data.sales.grossProfit));
    setText('connectedDashExpenseTotal', money(data.expenses.total));
    setText('connectedDashExpenseCard', money(data.expenses.total));
    setText('connectedDashNetProfit', money(data.sales.netProfit));
    setText('connectedDashCashIn', money(data.cash.periodIn));
    setText('connectedDashCashOut', money(data.cash.periodOut));
    setText('connectedDashCashExpected', data.cash.currentExpected === null ? 'Sin caja abierta' : money(data.cash.currentExpected));
    setText('connectedDashUnitsSold', `${Number(data.sales.unitsSold || 0).toLocaleString('es-NI', { maximumFractionDigits: 3 })} uds.`);
    setText('connectedDashLowStock', String(data.inventory.lowStock || 0));
    setText('connectedDashActiveProducts', String(data.inventory.activeProducts));
    setText('connectedDashStockValue', money(data.inventory.stockCostValue));
    setText('connectedDashReceivableBalance', money(data.receivables.balance));
    setText('connectedDashReceivableOverdue', money(data.receivables.overdue));
    const postedPayments = data.receivables.payments.filter(payment => payment.status === 'POSTED');
    setText('dashGananciaVentas', money(data.sales.total));
    setText('dashGananciaCosto', money(data.sales.cost));
    setText('dashGananciaBruta', money(data.sales.grossProfit));
    setText('dashGananciaGastos', money(data.expenses.total));
    setText('dashGananciaEstimada', money(data.sales.netProfit));
    setText('dashVentasPeriodo', money(data.sales.total));
    setText('dashCantidadVentas', String(saleCount));
    setText('dashTicketPromedio', money(saleCount ? Number(data.sales.total) / saleCount : 0));
    setText('dashComprasPeriodo', money(data.purchases.total));
    setText('dashProdsVendidos', `${Number(data.sales.unitsSold || 0).toLocaleString('es-NI', { maximumFractionDigits: 3 })} uds.`);
    setText('dashBajoStock', String(data.inventory.lowStock || 0));
    setText('dashProductosActivos', String(data.inventory.activeProducts));
    setText('dashValorInventario', money(data.inventory.stockCostValue));
    setText('dashCxC', money(data.receivables.balance));
    setText('dashCxP', money(data.payables.balance));
    setText('dashGastos', money(data.expenses.total));
    setText('dashAbonosPeriodo', money(postedPayments.reduce((total, payment) => total + Number(payment.amount || 0), 0)));
    setText('dashEntradasEfectivo', money(data.cash.periodIn));
    setText('dashSalidasEfectivo', money(data.cash.periodOut));
    setText('dashEfectivoEsperado', data.cash.currentExpected === null ? 'Sin caja abierta' : money(data.cash.currentExpected));
    setText('connectedDashPaymentsTotal', money(postedPayments.reduce((total, payment) => total + Number(payment.amount || 0), 0)));
    setText('connectedDashPurchasesTotal', money(data.purchases.total));
    setText('connectedDashPayablesBalance', money(data.payables.balance));
    setText('connectedDashSupplierPaymentsPending', money(data.suppliers.payments.filter(payment => payment.status === 'PENDING').reduce((total, payment) => total + Number(payment.amount || 0), 0)));
    setRows('connectedDashMethodsBody', 3, data.sales.paymentMethods.map(row => `<td>${esc(paymentLabel(row.method))}</td><td>${Number(row.count)}</td><td>${money(row.total)}</td>`), 'Sin ventas en este período.');
    setRows('connectedDashSellersBody', 3, data.sales.sellers.map(row => `<td><strong>${esc(row.seller)}</strong></td><td>${Number(row.count)}</td><td>${money(row.total)}</td>`), 'Sin ventas en este período.');
    setRows('connectedDashProductsBody', 3, data.sales.topProducts.map(row => `<td>${esc(row.name)}</td><td>${Number(row.quantity).toLocaleString('es-NI', { maximumFractionDigits: 3 })}</td><td>${money(row.total)}</td>`), 'Sin productos vendidos en este período.');
    setRows('connectedDashHistoryBody', 6, data.sales.history.map(row => `<td data-sort-value="${esc(dayKey(row.createdAt))}" data-table-date="${esc(dayKey(row.createdAt))}">${esc(dateTime(row.createdAt))}</td><td>${esc(row.invoiceNumber)}</td><td>${esc(row.seller)}</td><td>${esc(paymentLabel(row.paymentMethod))}</td><td>${money(row.total)}</td><td>${esc(statusLabel(row.status))}</td>`), 'Sin ventas en este período.');
    setRows('connectedDashDebtorsBody', 3, data.receivables.clients.map(row => `<td><strong>${esc(row.clientName)}</strong></td><td>${money(row.balance)}</td><td>${esc(row.status)}</td>`), 'No hay clientes con deuda actual.');
    setRows('connectedDashPaymentsBody', 6, data.receivables.payments.map(row => `<td data-table-date="${esc(dayKey(row.createdAt))}">${esc(dateTime(row.createdAt))}</td><td>${esc(row.clientName)}</td><td>${esc(row.invoiceNumber || '—')}</td><td>${esc(paymentLabel(row.paymentMethod))}</td><td>${esc(statusLabel(row.status))}</td><td>${money(row.amount)}</td>`), 'Sin abonos en este período.');
    setRows('connectedDashExpensesBody', 7, data.expenses.history.map(row => `<td data-table-date="${esc(dayKey(row.createdAt))}">${esc(dateTime(row.createdAt))}</td><td>${esc(row.category)}</td><td>${esc(row.description)}</td><td>${esc(paymentLabel(row.paymentMethod))}</td><td>${esc(statusLabel(row.status))}</td><td>${money(row.amount)}</td><td>${esc(row.userName)}</td>`), 'Sin gastos en este período.');
    setRows('connectedDashPurchasesBody', 5, data.purchases.history.map(row => `<td data-table-date="${esc(dayKey(row.createdAt))}">${esc(dateTime(row.createdAt))}</td><td>${esc(purchaseReference(row))}</td><td>${esc(row.supplierName)}</td><td>${esc(row.purchaseType === 'CREDIT' ? 'Crédito' : 'Contado')}${row.status === 'CANCELLED' ? ' · Anulada' : ''}</td><td>${money(row.total)}</td>`), 'Sin compras en este período.');
    setRows('connectedDashPayablesBody', 7, data.payables.invoices.map(row => `<td>${esc(purchaseReference(row))}</td><td>${esc(row.supplierName)}</td><td>${esc(row.dueAt ? new Date(row.dueAt).toLocaleDateString('es-NI') : '—')}</td><td>${money(row.total)}</td><td>${money(row.paid)}</td><td>${money(row.balance)}</td><td>${esc(statusLabel(row.status))}</td>`), 'No hay facturas pendientes por pagar.');
    setRows('connectedDashSupplierPaymentsBody', 6, data.suppliers.payments.map(row => `<td data-table-date="${esc(dayKey(row.createdAt))}">${esc(dateTime(row.createdAt))}</td><td>${esc(row.supplierName)}</td><td>${esc(purchaseReference(row))}</td><td>${esc(paymentLabel(row.paymentMethod))}</td><td>${esc(statusLabel(row.status))}</td><td>${money(row.amount)}</td>`), 'Sin pagos a proveedores en este período.');
    setRows('connectedDashCashBody', 6, data.cash.movements.map(row => `<td data-table-date="${esc(dayKey(row.createdAt))}">${esc(dateTime(row.createdAt))}</td><td>${esc(movementLabel(row.type))}${row.supplierName ? `<br><small>${esc(row.supplierName)}${row.purchaseNumber || row.invoiceNumber ? ' · ' + esc(row.purchaseNumber || row.invoiceNumber) : ''}${row.supplierInvoiceNumber ? ' · Factura proveedor ' + esc(row.supplierInvoiceNumber) : ''}</small>` : ''}</td><td>${row.direction === 'IN' ? 'Entrada' : 'Salida'}</td><td>${esc(paymentLabel(row.paymentMethod))}</td><td>${esc(statusLabel(row.status))}</td><td>${money(row.amount)}</td>`), 'Sin movimientos en este período.');
    setRows('dashMetodosBody', 3, data.sales.paymentMethods.map(row => `<td>${esc(paymentLabel(row.method))}</td><td>${Number(row.count)}</td><td>${money(row.total)}</td>`), 'Sin ventas en este período.');
    setRows('dashVendedoresBody', 3, data.sales.sellers.map(row => `<td><strong>${esc(row.seller)}</strong></td><td>${Number(row.count)}</td><td>${money(row.total)}</td>`), 'Sin ventas en este período.');
    setRows('dashProductosBody', 3, data.sales.topProducts.map(row => `<td>${esc(row.name)}</td><td>${Number(row.quantity).toLocaleString('es-NI', { maximumFractionDigits: 3 })}</td><td>${money(row.total)}</td>`), 'Sin productos vendidos en este período.');
    const note = el('connectedDashboardStatus');
    if (note && data.sales.historyLimited) note.textContent += ` Se muestran las ${data.sales.history.length} ventas más recientes; los indicadores incluyen el período completo.`;
  }
  async function load() {
    const current = ++requestId, status = el('dashboardStatus');
    try {
      currentData = null;
      if (status) { status.textContent = 'Cargando dashboard…'; status.classList.remove('hidden'); }
      const range = apiRange();
      const data = await window.PosConnected.inventoryOperation(client => client.connectedReport(range.from, range.until));
      if (current !== requestId) return false;
      render(data);
      if (status) status.classList.add('hidden');
      return true;
    } catch (failure) {
      if (current !== requestId) return false;
      if (status) { status.textContent = failure.message || 'No se pudo cargar el Dashboard conectado.'; status.classList.remove('hidden'); }
      if (failure.code === 'INVALID_SESSION') window.PosConnected.handleError(failure);
      return false;
    }
  }
  function exportSheets() {
    if (!currentData) return null;
    const average = currentData.sales.count ? Number(currentData.sales.total) / Number(currentData.sales.count) : 0;
    const summary = [
      ['Indicador', 'Valor'],
      ['Ventas del período', money(currentData.sales.total)],
      ['Ventas realizadas', Number(currentData.sales.count)],
      ['Promedio por venta', money(average)],
      ['Costo vendido del período', money(currentData.sales.cost)],
      ['Ganancia bruta del período', money(currentData.sales.grossProfit)],
      ['Gastos del período', money(currentData.expenses.total)],
      ['Ganancia neta del período', money(currentData.sales.netProfit)],
      ['Compras del período', money(currentData.purchases.total)],
      ['Productos vendidos en el período', Number(currentData.sales.unitsSold || 0)],
      ['Productos con bajo stock', Number(currentData.inventory.lowStock || 0)],
      ['Deuda actual por pagar', money(currentData.payables.balance)],
      ['Pagos a proveedores pendientes de confirmar', money(currentData.payables.pendingPayments)],
      ['Entradas de efectivo confirmadas', money(currentData.cash.periodIn)],
      ['Salidas de efectivo confirmadas', money(currentData.cash.periodOut)],
      ['Efectivo esperado en caja abierta', currentData.cash.currentExpected === null ? 'Sin caja abierta' : money(currentData.cash.currentExpected)],
      ['Productos activos', Number(currentData.inventory.activeProducts)],
      ['Unidades en inventario', Number(currentData.inventory.stockUnits)],
      ['Valor de inventario a costo', money(currentData.inventory.stockCostValue)],
      ['Deuda actual por cobrar', money(currentData.receivables.balance)],
      ['Saldo vencido por cobrar', money(currentData.receivables.overdue)],
      ['Abonos registrados en el período', money(currentData.receivables.payments.filter(payment => payment.status === 'POSTED').reduce((total, payment) => total + Number(payment.amount || 0), 0))]
    ];
    return [
      { name: 'Resumen', rows: summary },
      { name: 'Ventas por medio', rows: [['Medio de pago', 'Ventas', 'Total'], ...currentData.sales.paymentMethods.map(row => [paymentLabel(row.method), Number(row.count), Number(row.total)])] },
      { name: 'Ventas por vendedor', rows: [['Vendedor', 'Ventas', 'Efectivo', 'Tarjeta', 'Transferencia', 'Crédito', 'Total'], ...currentData.sales.sellers.map(row => [row.seller, Number(row.count), Number(row.cash), Number(row.card), Number(row.transfer), Number(row.credit), Number(row.total)])] },
      { name: 'Productos más vendidos', rows: [['Producto', 'Unidades', 'Total vendido'], ...currentData.sales.topProducts.map(row => [row.name, Number(row.quantity), Number(row.total)])] },
      { name: 'Ventas del período', rows: [['Fecha', 'Factura', 'Vendedor', 'Medio de pago', 'Total', 'Estado'], ...currentData.sales.history.map(row => [dateTime(row.createdAt), row.invoiceNumber, row.seller, paymentLabel(row.paymentMethod), Number(row.total), statusLabel(row.status)])] },
      { name: 'Cuentas por cobrar', rows: [['Cliente', 'Deuda', 'Estado'], ...currentData.receivables.clients.map(row => [row.clientName, Number(row.balance), row.status])] },
      { name: 'Abonos del período', rows: [['Fecha', 'Cliente', 'Factura', 'Medio de pago', 'Estado', 'Monto'], ...currentData.receivables.payments.map(row => [dateTime(row.createdAt), row.clientName, row.invoiceNumber || '—', paymentLabel(row.paymentMethod), statusLabel(row.status), Number(row.amount)])] },
      { name: 'Compras del período', rows: [['Fecha', 'N° compra interno', 'Factura proveedor', 'Proveedor', 'Condición', 'Estado', 'Total'], ...currentData.purchases.history.map(row => [dateTime(row.createdAt), row.purchaseNumber || row.invoiceNumber, row.supplierInvoiceNumber || '', row.supplierName, row.purchaseType === 'CREDIT' ? 'Crédito' : 'Contado', statusLabel(row.status), Number(row.total)])] },
      { name: 'Cuentas por pagar', rows: [['N° compra interno', 'Factura proveedor', 'Proveedor', 'Vencimiento', 'Total', 'Abonado', 'Saldo', 'Estado'], ...currentData.payables.invoices.map(row => [row.purchaseNumber || row.invoiceNumber, row.supplierInvoiceNumber || '', row.supplierName, row.dueAt ? new Date(row.dueAt).toLocaleDateString('es-NI') : '—', Number(row.total), Number(row.paid), Number(row.balance), statusLabel(row.status)])] },
      { name: 'Pagos a proveedores', rows: [['Fecha', 'Proveedor', 'N° compra interno', 'Factura proveedor', 'Medio de pago', 'Estado', 'Monto'], ...currentData.suppliers.payments.map(row => [dateTime(row.createdAt), row.supplierName, row.purchaseNumber || row.invoiceNumber || '—', row.supplierInvoiceNumber || '', paymentLabel(row.paymentMethod), statusLabel(row.status), Number(row.amount)])] },
      { name: 'Gastos del período', rows: [['Fecha', 'Categoría', 'Descripción', 'Medio de pago', 'Estado', 'Monto', 'Registrado por'], ...currentData.expenses.history.map(row => [dateTime(row.createdAt), row.category, row.description, paymentLabel(row.paymentMethod), statusLabel(row.status), Number(row.amount), row.userName])] },
      { name: 'Movimientos de efectivo', rows: [['Fecha', 'Tipo', 'Dirección', 'Medio de pago', 'Estado', 'Monto'], ...currentData.cash.movements.map(row => [dateTime(row.createdAt), movementLabel(row.type) + (row.supplierName ? ' · ' + row.supplierName + (row.purchaseNumber || row.invoiceNumber ? ' · ' + (row.purchaseNumber || row.invoiceNumber) : '') + (row.supplierInvoiceNumber ? ' · Factura proveedor ' + row.supplierInvoiceNumber : '') : ''), row.direction === 'IN' ? 'Entrada' : 'Salida', paymentLabel(row.paymentMethod), statusLabel(row.status), Number(row.amount)])] },
      { name: 'Kardex', rows: [['Fecha', 'Movimiento', 'Producto', 'Cantidad', 'Stock después', 'Costo unitario', 'Usuario', 'Motivo'], ...currentData.inventory.movements.map(row => [dateTime(row.createdAt), row.type, row.productName, Number(row.quantity), row.stockAfter === null ? '' : Number(row.stockAfter), row.unitCost === null ? '' : Number(row.unitCost), row.userName, row.reason])] }
    ];
  }
  function exportExcel() {
    const sheets = exportSheets();
    if (!sheets) return false;
    return Boolean(window.PosTables?.exportWorkbookToXlsx(sheets, { fileName: 'dashboard' }));
  }
  const exportButton = document.querySelector('.dashboard-heading button');
  if (exportButton) exportButton.onclick = event => { event.preventDefault(); exportExcel(); };
  document.addEventListener('dashboard:period-changed', () => {
    if (!el('dashboardView')?.classList.contains('hidden')) load();
  });
  document.addEventListener('connected:report-data-changed', () => {
    currentData = null;
    if (!el('dashboardView')?.classList.contains('hidden')) load();
  });
  window.PosDashboard = Object.freeze({ load, exportSheets, exportExcel });
})();
