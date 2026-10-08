/* global connectedMode */
'use strict';
(() => {
  if (!connectedMode) return;
  const el = id => document.getElementById(id);
  const money = value => 'C$' + Number(value || 0).toFixed(2);
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
  const statusLabel = value => ({ COMPLETED: 'Completada', CANCELLED: 'Anulada', CONFIRMED: 'Confirmado', PENDING: 'Pendiente', VOID: 'Anulado' })[value] || value || '—';
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
    setRows('repComprasBody', 5, [], () => '', 'Reporte disponible cuando compras conectadas esté implementado.');
    setRows('repGastosCategoriaBody', 3, [], () => '', 'Reporte de gastos disponible cuando el módulo conectado esté implementado.');
    setRows('repCxPBody', 2, [], () => '', 'Reporte disponible cuando compras conectadas esté implementado.');
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
    for (const id of ['repComprasPending', 'repGastosPending', 'repCxPPending']) el(id)?.classList.remove('hidden');
    for (const node of document.querySelectorAll('#reportesView .connected-report-only')) node.classList.remove('hidden');
    const labels = { repCompras: 'Compras pendientes', repGastos: 'Gastos pendientes', repUtilidad: 'Utilidad neta pendiente', repCxP: 'Cuentas por Pagar pendientes' };
    for (const [id, label] of Object.entries(labels)) {
      const card = el(id)?.closest('.summary-card');
      if (!card) continue;
      const heading = card.querySelector('span'); if (heading) heading.textContent = label;
      setText(id, 'Pendiente');
    }
    const debtCard = el('repCxC')?.closest('.summary-card')?.querySelector('span');
    if (debtCard) debtCard.textContent = 'Cuentas por Cobrar · saldo actual';
    setText('connectedInventorySummary', `${data.inventory.activeProducts} productos activos · ${Number(data.inventory.stockUnits).toFixed(3)} unidades · ${data.inventory.lowStock} con stock bajo · ${data.inventory.outOfStock} agotados · valor al costo ${money(data.inventory.stockCostValue)}.`);
    setText('connectedReceivablesSummary', `${data.receivables.indebtedClients} clientes con saldo · vencido ${money(data.receivables.overdue)}.`);
    setText('repVentas', money(data.sales.total));
    setText('repCxC', money(data.receivables.balance));
    setText('repCompras', 'Pendiente'); setText('repGastos', 'Pendiente'); setText('repUtilidad', 'Pendiente'); setText('repCxP', 'Pendiente');
    setRows('repVentasMetodoBody', 3, data.sales.paymentMethods, row => `<tr><td>${esc(paymentLabel(row.method))}</td><td>${row.count}</td><td>${money(row.total)}</td></tr>`, 'Sin ventas para el período seleccionado.');
    setRows('repTopProductosBody', 3, data.sales.topProducts, row => `<tr><td>${esc(row.name)}</td><td>${Number(row.quantity).toFixed(3)}</td><td>${money(row.total)}</td></tr>`, 'Sin productos vendidos en el período seleccionado.');
    setRows('repVendedoresBody', 7, data.sales.sellers, row => `<tr><td><strong>${esc(row.seller)}</strong></td><td>${row.count}</td><td>${money(row.cash)}</td><td>${money(row.card)}</td><td>${money(row.transfer)}</td><td>${money(row.credit)}</td><td>${money(row.total)}</td></tr>`, 'Sin ventas para el período seleccionado.');
    setRows('repVentasHistorialBody', 6, data.sales.history, row => `<tr data-table-date="${rowDate(row.createdAt)}"><td>${esc(dateTime(row.createdAt))}</td><td>${esc(row.invoiceNumber)}</td><td>${esc(row.seller)}</td><td>${esc(paymentLabel(row.paymentMethod))}</td><td>${money(row.total)}</td><td>${esc(statusLabel(row.status))}</td></tr>`, 'Sin ventas para el período seleccionado.');
    const historyNote = data.sales.historyLimited ? `Hay ${data.sales.historyCount} facturas en el período. El historial muestra las 1,000 más recientes; las sumas excluyen anulaciones.` : `El historial incluye ${data.sales.historyCount} facturas del período; las sumas excluyen anulaciones.`;
    setText('repVentasHistoryNote', historyNote);
    setRows('repCajaMetodosBody', 3, data.sales.paymentMethods, row => `<tr><td>${esc(paymentLabel(row.method))}</td><td>${row.count}</td><td>${money(row.total)}</td></tr>`, 'Sin ventas para el período seleccionado.');
    setRows('repCajaMovimientosBody', 6, data.cash.movements, row => `<tr data-table-date="${rowDate(row.createdAt)}"><td>${esc(dateTime(row.createdAt))}</td><td>${esc(movementLabel(row.type))}</td><td>${row.direction === 'IN' ? 'Entrada' : 'Salida'}</td><td>${esc(paymentLabel(row.paymentMethod))}</td><td>${esc(statusLabel(row.status))}</td><td>${money(row.amount)}</td></tr>`, 'Sin movimientos para el período seleccionado.');
    setRows('repCajaBody', 6, data.cash.closures, row => `<tr data-table-date="${rowDate(row.closedAt)}"><td>${esc(dateTime(row.openedAt))}</td><td>${esc(dateTime(row.closedAt))}</td><td>${esc(row.closedBy)}</td><td>${money(row.expectedAmount)}</td><td>${money(row.countedAmount)}</td><td>${money(row.difference)}</td></tr>`, 'Sin cierres de caja en el período seleccionado.');
    setRows('repInventarioBody', 5, data.inventory.products, row => `<tr><td>${esc(row.name)}</td><td>${Number(row.stock).toFixed(3)}</td><td>${money(row.cost)}</td><td>${money(row.value)}</td><td>${esc(row.status)}</td></tr>`, 'Sin productos disponibles.');
    setRows('repCxCBody', 4, data.receivables.clients, row => `<tr><td><strong>${esc(row.clientName)}</strong></td><td>${money(row.creditLimit)}</td><td>${money(row.balance)}</td><td>${esc(row.status)}</td></tr>`, 'Sin cuentas por cobrar.');
    setRows('repCxCPagosBody', 6, data.receivables.payments, row => `<tr data-table-date="${rowDate(row.createdAt)}"><td>${esc(dateTime(row.createdAt))}</td><td>${esc(row.clientName)}</td><td>${esc(row.invoiceNumber || '—')}</td><td>${esc(paymentLabel(row.paymentMethod))}</td><td>${esc(statusLabel(row.status))}</td><td>${money(row.amount)}</td></tr>`, 'Sin abonos para el período seleccionado.');
    setRows('repComprasBody', 5, [], () => '', 'Reporte disponible cuando compras conectadas esté implementado.');
    setRows('repGastosCategoriaBody', 3, [], () => '', 'Reporte de gastos disponible cuando el módulo conectado esté implementado.');
    setRows('repCxPBody', 2, [], () => '', 'Reporte disponible cuando compras conectadas esté implementado.');
    const details = [];
    if (data.sales.historyLimited) details.push('El detalle de ventas muestra las 1,000 filas más recientes; el total del período considera todos los registros.');
    if (data.cash.movements.length === 1000) details.push('El reporte de caja muestra hasta 1,000 movimientos.');
    if (data.cash.closures.length === 1000) details.push('El reporte de cierres muestra hasta 1,000 cajas cerradas.');
    const status = el('connectedReportStatus');
    if (status) { status.textContent = details.join(' '); status.classList.toggle('hidden', !details.length); }
    window.PosTables?.refreshDataTable(el('repVentasHistorialBody'));
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
  window.PosReports = Object.freeze({ load, render: () => render(report) });
})();
