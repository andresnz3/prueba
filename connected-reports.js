/* global connectedMode */
'use strict';
(() => {
  if (!connectedMode) return;
  const el = id => document.getElementById(id);
  const money = value => 'C$' + Number(value || 0).toFixed(2);
  const purchaseReference = row => (row.purchaseNumber || row.invoiceNumber || '—') + (row.supplierInvoiceNumber ? ' · Factura proveedor ' + row.supplierInvoiceNumber : '');
  const normalizeDate = value => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    if (!match) return null;
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (date.getFullYear() !== Number(match[1]) || date.getMonth() !== Number(match[2]) - 1 || date.getDate() !== Number(match[3])) return null;
    return date;
  };
  const startOfDay = value => {
    const date = normalizeDate(value);
    return date ? date.toISOString() : null;
  };
  const startAfterDay = value => {
    const date = normalizeDate(value);
    if (!date) return null;
    date.setDate(date.getDate() + 1);
    return date.toISOString();
  };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const dateStamp = value => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };
  const dateTime = value => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('es-NI');
  };
  const paymentLabel = value => ({ CASH: 'Efectivo', CARD: 'Tarjeta', TRANSFER: 'Transferencia', CREDIT: 'Crédito', OTHER: 'Otro' })[value] || value || '—';
  const movementLabel = value => ({ SALE: 'Venta', CUSTOMER_PAYMENT: 'Abono de cliente', REVERSAL: 'Devolución', MANUAL_ENTRY: 'Entrada manual', MANUAL_EXIT: 'Salida manual', EXPENSE: 'Gasto', SUPPLIER_PAYMENT: 'Pago a proveedor' })[value] || value || 'Movimiento';
  const statusLabel = value => ({ COMPLETED: 'Completada', CANCELLED: 'Anulada', CONFIRMED: 'Confirmado', PENDING: 'Pendiente', VOID: 'Anulado', POSTED: 'Registrado' })[value] || value || '—';
  const setText = (id, value) => { const node = el(id); if (node) node.textContent = value; };
  let report = null, requestId = 0;

  function placeholder(bodyId, columns, message) {
    const body = el(bodyId);
    if (body) body.innerHTML = `<tr class="connected-report-placeholder"><td class="text-center" colspan="${columns}">${esc(message)}</td></tr>`;
  }
  function setRows(bodyId, columns, rows, renderRow, emptyText) {
    const body = el(bodyId);
    if (!body) return;
    if (!rows.length) { placeholder(bodyId, columns, emptyText); window.PosTables?.setDataTableExportEnabled(body, false); return; }
    body.innerHTML = rows.map(renderRow).join('');
    window.PosTables?.setDataTableExportEnabled(body, true);
  }
  function rowDate(value) { return esc(dateStamp(value)); }
  function renderPending() {
    report = null;
    for (const id of ['repComprasPending', 'repGastosPending', 'repCxPPending']) el(id)?.classList.remove('hidden');
    setRows('repVentasMetodoBody', 3, [], () => '', 'Sin ventas para el período seleccionado.');
    setRows('repTopProductosBody', 3, [], () => '', 'Sin productos vendidos en el período seleccionado.');
    setRows('repVendedoresBody', 7, [], () => '', 'Sin ventas para el período seleccionado.');
    setRows('repVentasHistorialBody', 6, [], () => '', 'Sin ventas para el período seleccionado.');
    setRows('repCajaMetodosBody', 3, [], () => '', 'Sin ventas para el período seleccionado.');
    setRows('repCajaMovimientosBody', 6, [], () => '', 'Sin movimientos para el período seleccionado.');
    setRows('repCajaBody', 6, [], () => '', 'Sin cierres de caja en el período seleccionado.');
    setRows('repInventarioBody', 5, [], () => '', 'Sin productos disponibles.');
    setRows('repCxCBody', 4, [], () => '', 'Sin cuentas por cobrar.');
    setRows('repCxCPagosBody', 6, [], () => '', 'Sin abonos para el período seleccionado.');
    setRows('repComprasBody', 5, [], () => '', 'Sin compras para el período seleccionado.');
    setRows('repSupplierPaymentsBody', 6, [], () => '', 'Sin pagos a proveedores en el período seleccionado.');
    setRows('repKardexBody', 8, [], () => '', 'Sin movimientos de inventario para el período seleccionado.');
    setRows('repGastosCategoriaBody', 3, [], () => '', 'Reporte de gastos disponible cuando el módulo conectado esté implementado.');
    setRows('repGastosHistoryBody', 8, [], () => '', 'Sin gastos para el período seleccionado.');
    setRows('repCxPBody', 2, [], () => '', '');
    setRows('repConnectedCxPBody', 8, [], () => '', 'No hay cuentas por pagar pendientes.');
  }
  function labelRange(from, until) {
    if (!from && !until) return 'Mostrando todos los datos conectados.';
    return `Mostrando datos conectados ${from ? 'desde ' + from : 'desde el inicio'} hasta ${until || 'hoy'}.`;
  }
  function range() {
    const fromValue = el('reporteDesdeInput')?.value || '';
    const untilValue = el('reporteHastaInput')?.value || '';
    const fromDate = fromValue ? normalizeDate(fromValue) : null;
    const untilDate = untilValue ? normalizeDate(untilValue) : null;
    if ((fromValue && !fromDate) || (untilValue && !untilDate)) throw new Error('Ingresa fechas válidas para el período.');
    if (fromDate && untilDate && fromDate > untilDate) throw new Error('La fecha Desde no puede ser posterior a Hasta.');
    return { from: fromValue ? startOfDay(fromValue) : null, until: untilValue ? startAfterDay(untilValue) : null, fromValue, untilValue };
  }
  function render(data) {
    if (!data) { renderPending(); return; }
    report = data;
    el('connectedReportScope')?.classList.remove('hidden');
    el('repGastosPending')?.classList.add('hidden');
    for (const node of document.querySelectorAll('#reportesView .connected-report-only')) node.classList.remove('hidden');
    const labels = { repCompras: 'Compras del período', repCxP: 'Cuentas por Pagar · saldo actual' };
    for (const [id, label] of Object.entries(labels)) {
      const card = el(id)?.closest('.summary-card');
      if (!card) continue;
      const heading = card.querySelector('span'); if (heading) heading.textContent = label;
      if (id === 'repCompras') setText(id, money(data.purchases.total));
      else setText(id, money(data.payables.balance));
    }
    const debtCard = el('repCxC')?.closest('.summary-card')?.querySelector('span');
    if (debtCard) debtCard.textContent = 'Cuentas por Cobrar · saldo actual';
    setText('connectedInventorySummary', `${data.inventory.activeProducts} productos activos · ${Number(data.inventory.stockUnits).toFixed(3)} unidades · ${data.inventory.lowStock} con stock bajo · ${data.inventory.outOfStock} agotados · valor al costo ${money(data.inventory.stockCostValue)}.`);
    setText('connectedReceivablesSummary', `${data.receivables.indebtedClients} clientes con saldo · vencido ${money(data.receivables.overdue)}.`);
    setText('repVentas', money(data.sales.total));
    setText('repCostoVendido', money(data.sales.cost));
    setText('repGananciaBruta', money(data.sales.grossProfit));
    setText('repCxC', money(data.receivables.balance));
    setText('repCompras', money(data.purchases.total)); setText('repGastos', money(data.expenses.total)); setText('repUtilidad', money(data.sales.netProfit)); setText('repCxP', money(data.payables.balance));
    const netLabel = el('repUtilidad')?.closest('.summary-card')?.querySelector('span');
    if (netLabel) netLabel.textContent = 'Utilidad neta';
    setRows('repVentasMetodoBody', 3, data.sales.paymentMethods, row => `<tr><td>${esc(paymentLabel(row.method))}</td><td>${row.count}</td><td>${money(row.total)}</td></tr>`, 'Sin ventas para el período seleccionado.');
    setRows('repTopProductosBody', 3, data.sales.topProducts, row => `<tr><td>${esc(row.name)}</td><td>${Number(row.quantity).toFixed(3)}</td><td>${money(row.total)}</td></tr>`, 'Sin productos vendidos en el período seleccionado.');
    setRows('repVendedoresBody', 7, data.sales.sellers, row => `<tr><td><strong>${esc(row.seller)}</strong></td><td>${row.count}</td><td>${money(row.cash)}</td><td>${money(row.card)}</td><td>${money(row.transfer)}</td><td>${money(row.credit)}</td><td>${money(row.total)}</td></tr>`, 'Sin ventas para el período seleccionado.');
    setRows('repVentasHistorialBody', 6, data.sales.history, row => `<tr data-table-date="${rowDate(row.createdAt)}"><td>${esc(dateTime(row.createdAt))}</td><td>${esc(row.invoiceNumber)}</td><td>${esc(row.seller)}</td><td>${esc(paymentLabel(row.paymentMethod))}</td><td>${money(row.total)}</td><td>${esc(statusLabel(row.status))}</td></tr>`, 'Sin ventas para el período seleccionado.');
    const historyNote = data.sales.historyLimited ? `Hay ${data.sales.historyCount} facturas en el período. El historial muestra las 1,000 más recientes; las sumas excluyen anulaciones.` : `El historial incluye ${data.sales.historyCount} facturas del período; las sumas excluyen anulaciones.`;
    setText('repVentasHistoryNote', historyNote);
    setRows('repCajaMetodosBody', 3, data.sales.paymentMethods, row => `<tr><td>${esc(paymentLabel(row.method))}</td><td>${row.count}</td><td>${money(row.total)}</td></tr>`, 'Sin ventas para el período seleccionado.');
    setRows('repCajaMovimientosBody', 6, data.cash.movements, row => `<tr data-table-date="${rowDate(row.createdAt)}"><td>${esc(dateTime(row.createdAt))}</td><td>${esc(movementLabel(row.type))}${row.supplierName ? `<br><small>${esc(row.supplierName)}${row.purchaseNumber || row.invoiceNumber ? ' · ' + esc(row.purchaseNumber || row.invoiceNumber) : ''}${row.supplierInvoiceNumber ? ' · Factura proveedor ' + esc(row.supplierInvoiceNumber) : ''}</small>` : ''}</td><td>${row.direction === 'IN' ? 'Entrada' : 'Salida'}</td><td>${esc(paymentLabel(row.paymentMethod))}</td><td>${esc(statusLabel(row.status))}</td><td>${money(row.amount)}</td></tr>`, 'Sin movimientos para el período seleccionado.');
    setRows('repCajaBody', 6, data.cash.closures, row => `<tr data-table-date="${rowDate(row.closedAt)}"><td>${esc(dateTime(row.openedAt))}</td><td>${esc(dateTime(row.closedAt))}</td><td>${esc(row.closedBy)}</td><td>${money(row.expectedAmount)}</td><td>${money(row.countedAmount)}</td><td>${money(row.difference)}</td></tr>`, 'Sin cierres de caja en el período seleccionado.');
    setRows('repInventarioBody', 5, data.inventory.products, row => `<tr><td>${esc(row.name)}</td><td>${Number(row.stock).toFixed(3)}</td><td>${money(row.cost)}</td><td>${money(row.value)}</td><td>${esc(row.status)}</td></tr>`, 'Sin productos disponibles.');
    setRows('repCxCBody', 4, data.receivables.clients, row => `<tr><td><strong>${esc(row.clientName)}</strong></td><td>${money(row.creditLimit)}</td><td>${money(row.balance)}</td><td>${esc(row.status)}</td></tr>`, 'Sin cuentas por cobrar.');
    setRows('repCxCPagosBody', 6, data.receivables.payments, row => `<tr data-table-date="${rowDate(row.createdAt)}"><td>${esc(dateTime(row.createdAt))}</td><td>${esc(row.clientName)}</td><td>${esc(row.invoiceNumber || '—')}</td><td>${esc(paymentLabel(row.paymentMethod))}</td><td>${esc(statusLabel(row.status))}</td><td>${money(row.amount)}</td></tr>`, 'Sin abonos para el período seleccionado.');
    setRows('repComprasBody', 5, data.purchases.history, row => `<tr data-table-date="${rowDate(row.createdAt)}"><td>${esc(dateTime(row.createdAt))}</td><td>${esc(purchaseReference(row))}</td><td>${esc(row.supplierName)}</td><td>${esc(row.purchaseType === 'CREDIT' ? 'Crédito' : 'Contado')}${row.status === 'CANCELLED' ? ' · Anulada' : ''}</td><td>${money(row.total)}</td></tr>`, 'Sin compras para el período seleccionado.');
    setRows('repSupplierPaymentsBody', 6, data.suppliers.payments, row => `<tr data-table-date="${rowDate(row.createdAt)}"><td>${esc(dateTime(row.createdAt))}</td><td>${esc(row.supplierName)}</td><td>${esc(purchaseReference(row))}</td><td>${esc(paymentLabel(row.paymentMethod))}</td><td>${esc(statusLabel(row.status))}</td><td>${money(row.amount)}</td></tr>`, 'Sin pagos a proveedores en el período seleccionado.');
    setRows('repKardexBody', 8, data.inventory.movements, row => `<tr data-table-date="${rowDate(row.createdAt)}"><td>${esc(dateTime(row.createdAt))}</td><td>${esc(row.type)}</td><td>${esc(row.productName)}</td><td>${Number(row.quantity).toFixed(3)}</td><td>${row.stockAfter === null ? '—' : Number(row.stockAfter).toFixed(3)}</td><td>${row.unitCost === null ? '—' : money(row.unitCost)}</td><td>${esc(row.userName)}</td><td>${esc(row.reason)}</td></tr>`, 'Sin movimientos de inventario para el período seleccionado.');
    setRows('repGastosCategoriaBody', 3, data.expenses.byCategory, row => `<tr><td>${esc(row.category)}</td><td>${row.count}</td><td>${money(row.total)}</td></tr>`, 'Sin gastos para el período seleccionado.');
    setRows('repGastosHistoryBody', 8, data.expenses.history, row => `<tr data-table-date="${rowDate(row.createdAt)}"><td>${esc(dateTime(row.createdAt))}</td><td>${esc(row.category)}</td><td>${esc(row.description)}</td><td>${esc(row.receiptReference || '—')}</td><td>${esc(paymentLabel(row.paymentMethod))}</td><td>${esc(statusLabel(row.status))}</td><td>${money(row.amount)}</td><td>${esc(row.userName)}</td></tr>`, 'Sin gastos para el período seleccionado.');
    setText('connectedReportPayablesSummary', `${data.payables.invoices.length} facturas · saldo actual ${money(data.payables.balance)} · pagos por confirmar ${money(data.payables.pendingPayments)}.`);
    setRows('repConnectedCxPBody', 8, data.payables.invoices, row => `<tr><td>${esc(purchaseReference(row))}</td><td>${esc(row.supplierName)}</td><td data-table-date="${rowDate(row.createdAt)}">${esc(dateTime(row.createdAt))}</td><td>${esc(row.dueAt ? new Date(row.dueAt).toLocaleDateString('es-NI') : '—')}</td><td>${money(row.total)}</td><td>${money(row.paid)}</td><td>${money(row.balance)}</td><td>${esc(statusLabel(row.status))}</td></tr>`, 'No hay cuentas por pagar pendientes.');
    const details = [];
    if (data.sales.historyLimited) details.push('El detalle de ventas muestra las 1,000 filas más recientes; el total del período considera todos los registros.');
    if (data.expenses.historyLimited) details.push('El detalle de gastos muestra los 1,000 registros más recientes; los totales consideran todo el período.');
    if (data.purchases.historyLimited) details.push('El detalle de compras muestra hasta 1,000 facturas; el total considera el período completo.');
    if (data.cash.movements.length === 1000) details.push('El reporte de caja muestra hasta 1,000 movimientos.');
    if (data.cash.closures.length === 1000) details.push('El reporte de cierres muestra hasta 1,000 cajas cerradas.');
    const status = el('connectedReportStatus');
    if (status) { status.textContent = details.join(' '); status.classList.toggle('hidden', !details.length); }
    window.PosTables?.refreshDataTable(el('repVentasHistorialBody'));
    window.PosTables?.refreshDataTable(el('repGastosHistoryBody'));
    window.PosTables?.refreshDataTable(el('repComprasBody'));
    window.PosTables?.refreshDataTable(el('repSupplierPaymentsBody'));
    window.PosTables?.refreshDataTable(el('repKardexBody'));
    window.PosTables?.refreshDataTable(el('repConnectedCxPBody'));
    window.PosTables?.refreshDataTable(el('repCajaMovimientosBody'));
    window.PosTables?.refreshDataTable(el('repCajaBody'));
  }
  async function load() {
    const current = ++requestId, status = el('connectedReportStatus');
    try {
      report = null;
      renderPending();
      const selected = range();
      const rangeLabel = el('reporteRangoLabel');
      if (rangeLabel) rangeLabel.textContent = labelRange(selected.fromValue, selected.untilValue);
      if (status) { status.textContent = 'Cargando reportes conectados…'; status.classList.remove('hidden'); }
      const data = await window.PosConnected.inventoryOperation(client => client.connectedReport(selected.from, selected.until));
      if (current !== requestId) return false;
      render(data);
      return true;
    } catch (failure) {
      if (current !== requestId) return false;
      if (status) { status.textContent = failure.message || 'No se pudieron cargar los reportes conectados.'; status.classList.remove('hidden'); }
      if (failure.code === 'INVALID_SESSION') window.PosConnected.handleError(failure);
      return false;
    }
  }
  function exportExcel() {
    if (!report) { window.showAlert?.('Espera a que termine de cargar el reporte conectado para exportar.'); return false; }
    const rows = report;
    const sheets = [
      { name: 'Resumen', rows: [['Indicador', 'Valor'], ['Ventas', Number(rows.sales.total)], ['Costo vendido', Number(rows.sales.cost)], ['Utilidad bruta', Number(rows.sales.grossProfit)], ['Gastos', Number(rows.expenses.total)], ['Utilidad neta', Number(rows.sales.netProfit)], ['Compras del período', Number(rows.purchases.total)], ['Cuentas por pagar actuales', Number(rows.payables.balance)], ['Cuentas por cobrar', Number(rows.receivables.balance)], ['Entradas de caja', Number(rows.cash.periodIn)], ['Salidas de caja', Number(rows.cash.periodOut)], ['Inventario a costo', Number(rows.inventory.stockCostValue)]] },
      { name: 'Ventas', rows: [['Fecha', 'Factura', 'Vendedor', 'Medio', 'Total', 'Estado'], ...rows.sales.history.map(row => [dateTime(row.createdAt), row.invoiceNumber, row.seller, paymentLabel(row.paymentMethod), Number(row.total), statusLabel(row.status)])] },
      { name: 'Compras', rows: [['Fecha', 'N° compra interno', 'Factura proveedor', 'Proveedor', 'Condición', 'Estado', 'Total'], ...rows.purchases.history.map(row => [dateTime(row.createdAt), row.purchaseNumber || row.invoiceNumber, row.supplierInvoiceNumber || '', row.supplierName, row.purchaseType === 'CREDIT' ? 'Crédito' : 'Contado', statusLabel(row.status), Number(row.total)])] },
      { name: 'Cuentas por pagar', rows: [['N° compra interno', 'Factura proveedor', 'Proveedor', 'Vencimiento', 'Total', 'Abonado', 'Saldo', 'Estado'], ...rows.payables.invoices.map(row => [row.purchaseNumber || row.invoiceNumber, row.supplierInvoiceNumber || '', row.supplierName, row.dueAt ? new Date(row.dueAt).toLocaleDateString('es-NI') : '—', Number(row.total), Number(row.paid), Number(row.balance), statusLabel(row.status)])] },
      { name: 'Pagos proveedores', rows: [['Fecha', 'Proveedor', 'N° compra interno', 'Factura proveedor', 'Medio', 'Estado', 'Monto'], ...rows.suppliers.payments.map(row => [dateTime(row.createdAt), row.supplierName, row.purchaseNumber || row.invoiceNumber || '—', row.supplierInvoiceNumber || '', paymentLabel(row.paymentMethod), statusLabel(row.status), Number(row.amount)])] },
      { name: 'Gastos', rows: [['Fecha', 'Categoría', 'Descripción', 'Comprobante', 'Medio', 'Estado', 'Monto', 'Registrado por'], ...rows.expenses.history.map(row => [dateTime(row.createdAt), row.category, row.description, row.receiptReference || '—', paymentLabel(row.paymentMethod), statusLabel(row.status), Number(row.amount), row.userName])] },
      { name: 'Gastos por categoría', rows: [['Categoría', 'Cantidad', 'Total'], ...rows.expenses.byCategory.map(row => [row.category, Number(row.count), Number(row.total)])] },
      { name: 'CxC', rows: [['Cliente', 'Límite', 'Saldo', 'Estado'], ...rows.receivables.clients.map(row => [row.clientName, Number(row.creditLimit), Number(row.balance), row.status])] },
      { name: 'Abonos CxC', rows: [['Fecha', 'Cliente', 'Factura', 'Medio', 'Estado', 'Monto'], ...rows.receivables.payments.map(row => [dateTime(row.createdAt), row.clientName, row.invoiceNumber || '—', paymentLabel(row.paymentMethod), statusLabel(row.status), Number(row.amount)])] },
      { name: 'Caja', rows: [['Fecha', 'Tipo', 'Dirección', 'Medio', 'Estado', 'Monto'], ...rows.cash.movements.map(row => [dateTime(row.createdAt), movementLabel(row.type) + (row.supplierName ? ' · ' + row.supplierName + (row.purchaseNumber || row.invoiceNumber ? ' · ' + (row.purchaseNumber || row.invoiceNumber) : '') + (row.supplierInvoiceNumber ? ' · Factura proveedor ' + row.supplierInvoiceNumber : '') : ''), row.direction === 'IN' ? 'Entrada' : 'Salida', paymentLabel(row.paymentMethod), statusLabel(row.status), Number(row.amount)])] },
      { name: 'Inventario', rows: [['Producto', 'Stock', 'Costo', 'Valor', 'Estado'], ...rows.inventory.products.map(row => [row.name, Number(row.stock), Number(row.cost), Number(row.value), row.status])] },
      { name: 'Kardex', rows: [['Fecha', 'Movimiento', 'Producto', 'Cantidad', 'Stock después', 'Costo unitario', 'Usuario', 'Motivo'], ...rows.inventory.movements.map(row => [dateTime(row.createdAt), row.type, row.productName, Number(row.quantity), row.stockAfter === null ? '' : Number(row.stockAfter), row.unitCost === null ? '' : Number(row.unitCost), row.userName, row.reason])] }
    ];
    if (!window.PosTables?.exportWorkbookToXlsx(sheets, { fileName: 'reportes_conectados' })) { window.showAlert?.('No se pudo preparar el archivo de Excel.'); return false; }
    return true;
  }
  document.addEventListener('connected:report-data-changed', () => {
    report = null;
    if (!el('reportesView')?.classList.contains('hidden')) load();
  });
  window.PosReports = Object.freeze({ load, render: () => render(report), exportExcel });
})();
