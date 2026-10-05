/* global connectedMode, showAlert, generarVisualizacionTicket, renderCajaViewBase */
'use strict';
(() => {
  if (!connectedMode) return;
  const el = id => document.getElementById(id);
  let busy = false, quote = null, quoteInput = null, activeScope = null, currentCash = null, salesFlow = 'DIRECT', activeOrderId = null, pendingOrderDetails = new Map();
  const state = () => window.PosRuntime.salesInput();
  const scope = () => { const s = state(); return 'posOperation_' + encodeURIComponent(window.POS_API_BASE_URL) + '_' + s.businessId + '_' + s.userId; };
  function pending() {
    const value = localStorage.getItem(scope());
    if (!value) return null;
    try { const result = JSON.parse(value); if (/^[a-f0-9-]{36}$/.test(result.key) && ['SALE', 'CANCEL', 'OPEN_CASH', 'CLOSE_CASH', 'PREPARE_ORDER', 'ORDER_CHARGE', 'ORDER_CANCEL', 'PAYMENT_CONFIRM'].includes(result.kind)) return result; } catch { /* Invalid marker stays blocked until checked. */ }
    throw new Error('No se pudo leer la referencia de la operación pendiente.');
  }
  function notice(text = '') { el('saleOperationMessage').textContent = text; el('saleOperationMessage').classList.toggle('hidden', !text); el('recoverSaleBtn').classList.toggle('hidden', !text); }
  function showPending() { if (pending()) notice('Hay una operación cuyo resultado debe comprobarse antes de volver a cobrar. Requiere conexión.'); else notice(); }
  function api(action) { return window.PosConnected.inventoryOperation(action); }
  async function pages(method) {
    return api(async (client, business) => {
      const list = []; let maxId = null;
      for (let offset = 0; ; offset += 100) {
        const values = await client[method](offset, maxId);
        if (!maxId && values.length) maxId = values[0].id;
        if (values.some(value => value.businessId !== business)) throw new window.PosApiError('INVALID_RESPONSE');
        list.push(...values); if (values.length < 100) return list;
      }
    });
  }
  function mappedSale(sale) {
    return { id: sale.id, businessId: sale.businessId, numero: sale.invoiceNumber, vendedor: sale.seller, fecha: new Date(sale.createdAt).toLocaleString(), fechaTS: Date.parse(sale.createdAt), detalle: sale.detail || '-', metodo: 'Contado', medioPago: sale.paymentMethod.toLowerCase(), cliente: '-', clienteId: null, tarifa: sale.priceType === 'RETAIL' ? 'Menudeo' : 'Mayoreo', subtotal: Number(sale.subtotal), descuentoPct: Number(sale.discountPercent), descuentoMonto: Number(sale.discount), total: Number(sale.total), anulada: sale.status === 'CANCELLED', motivoAnulacion: sale.cancelReason, conectado: true, estadoCaja: sale.cashStatus === 'PENDING' ? 'pendiente' : sale.cashStatus === 'CONFIRMED' ? 'confirmado' : 'no_aplica', cajaSessionId: sale.cashSessionId, items: sale.items.map(item => ({ id: item.productId, name: item.name, barcode: item.barcode, cantidad: Number(item.quantity), connectedSubtotal: Number(item.subtotal), retailPrice: Number(item.unitPrice), wholesalePrice: Number(item.unitPrice) })) };
  }
  async function completed(result, recovered = false) {
    if (result.kind === 'CONFIRM_PAYMENT' && result.sale) {
      window.PosRuntime.publishSale(mappedSale(result.sale)); activeOrderId = null; quote = quoteInput = null;
      showAlert((result.movement.paymentMethod === 'CARD' ? 'Tarjeta' : 'Transferencia') + ' confirmado por ' + (result.movement.confirmedBy || result.sale.cashier) + ' el ' + new Date(result.movement.confirmedAt).toLocaleString() + '. No suma al efectivo físico esperado.');
    } else if (result.sale) {
      const sale = mappedSale(result.sale);
      window.PosRuntime.publishSale(sale);
      if (result.kind === 'SALE') {
        window.PosRuntime.clearCart(); el('connectedCheckoutModal').classList.add('hidden'); quote = quoteInput = null; activeOrderId = null;
        generarVisualizacionTicket(sale, Number(result.sale.cashReceived || result.sale.total), Number(result.sale.changeAmount || 0), recovered);
      } else { el('anularVentaModal').classList.add('hidden'); showAlert(result.sale.paymentMethod === 'CASH' ? 'Venta anulada en MySQL. Stock y efectivo revertidos.' : 'Venta anulada en MySQL. Stock repuesto. La devolución por tarjeta o transferencia debe realizarse por el mismo medio fuera del POS.'); }
      try { await window.PosInventory.load('salesView'); } catch (error) { if (error.code === 'INVALID_SESSION') window.PosConnected.handleError(error); else showAlert('La operación está confirmada. No se pudo actualizar el catálogo; vuelve a Ventas para consultarlo.'); }
    }
    if (result.kind === 'ABANDONED') showAlert('La operación no estaba registrada y quedó descartada en el servidor. Una solicitud tardía con esa referencia será rechazada. Puedes preparar el cobro nuevamente.');
    if (result.order && !result.sale) {
      activeOrderId = null; quote = quoteInput = null; el('connectedCheckoutModal').classList.add('hidden');
      if (result.kind === 'ORDER') { window.PosRuntime.clearCart(); showAlert('Pedido #' + result.order.id + ' enviado a Caja. No se generó factura ni se descontó inventario.'); }
      else if (result.kind === 'CANCEL_ORDER') showAlert('Pedido #' + result.order.id + ' cancelado. No se generó factura ni movimiento de caja.');
    }
    if (result.cash) el('cierreCajaModal').classList.add('hidden');
    if (window.PosConnected.canManageModule('cajaView')) await load('cajaView');
    if (result.cash) showAlert(result.kind === 'OPEN_CASH' ? 'Caja abierta en MySQL.' : 'Caja cerrada en MySQL.');
  }
  const uncertain = error => error.status >= 500 || ['NETWORK_ERROR', 'INVALID_RESPONSE', 'STALE_REQUEST', 'INVALID_SESSION'].includes(error.code);
  async function perform(kind, data, action) {
    if (busy) return;
    if (pending()) { showPending(); showAlert('Comprueba la operación pendiente antes de iniciar otra.'); return; }
    busy = true; const marker = { key: crypto.randomUUID(), kind }; const storage = scope();
    data.operationKey = marker.key;
    try { localStorage.setItem(storage, JSON.stringify(marker)); } catch { busy = false; showAlert('No se pudo guardar la referencia del cobro. Habilita el almacenamiento del navegador antes de cobrar. No se envió la operación.'); return; }
    showPending();
    try {
      const result = await api(client => action(client, data));
      localStorage.removeItem(storage); notice(); await completed(result);
    } catch (error) {
      if (!uncertain(error)) localStorage.removeItem(storage);
      if (error.code === 'STALE_REQUEST') return;
      if (uncertain(error)) {
        for (const id of ['connectedCheckoutModal','anularVentaModal','cierreCajaModal']) el(id).classList.add('hidden');
        notice('Resultado desconocido. Comprueba esta operación antes de intentar cobrar nuevamente; podría estar confirmada.');
      }
      if (error.code === 'INVALID_SESSION') window.PosConnected.handleError(error);
      else {
        if (['CASH_INVALID', 'CASH_INSUFFICIENT'].includes(error.code)) window.PosValidation.field('connectedCashReceived', error.message);
        showAlert(error.message + (uncertain(error) ? ' Comprueba el estado de la operación antes de cobrar nuevamente.' : ''));
      }
      showPending();
    } finally { busy = false; }
  }
  async function recover() {
    if (busy) return;
    const marker = pending(); if (!marker) { notice(); return; }
    busy = true; const storage = scope();
    try {
      // Locking resolver commits a tombstone if absent, rejecting any delayed request.
      const result = await api(client => client.resolveOperation(marker.key));
      localStorage.removeItem(storage); notice(); await completed(result, true);
    } catch (error) { window.PosConnected.handleError(error); showPending(); }
    finally { busy = false; }
  }
  function cartData() {
    const input = state();
    return { items: input.items, priceType: input.priceType, discountPercent: input.discountPercent, paymentMethod: input.paymentMethod };
  }
  async function checkout() {
    if (busy) return;
    if (pending()) { showPending(); showAlert('Comprueba la operación pendiente antes de cobrar nuevamente.'); return; }
    if (!state().items.length) { showAlert('El carrito está vacío. Agrega productos antes de cobrar.'); el('barcodeInput').focus(); return; }
    if (state().paymentMethod === 'CREDIT') { showAlert('Las ventas a crédito están pendientes de integrar clientes y cuentas por cobrar.'); return; }
    if (document.querySelector('input[name="descApplies"][value="si"]').checked && !window.PosValidation.validate(el('descuentoBox'), true)) return;
    if (salesFlow === 'CENTRALIZED') {
      const input = state();
      await perform('PREPARE_ORDER', { items: input.items, priceType: input.priceType, discountPercent: input.discountPercent, detail: input.detail }, (client, data) => client.prepareOrder(data));
      return;
    }
    activeOrderId = null;
    busy = true;
    try {
      quoteInput = cartData(); quote = await api(client => client.quoteSale(quoteInput));
      el('connectedCheckoutTotal').textContent = 'C$' + quote.total;
      el('connectedCheckoutDetail').textContent = (quote.paymentMethod === 'CASH' ? 'Efectivo' : quote.paymentMethod === 'CARD' ? 'Tarjeta' : 'Transferencia') + ' · Subtotal C$' + quote.subtotal + ' · Descuento C$' + quote.discount;
      el('connectedCheckoutItems').replaceChildren();
      for (const item of quote.items) { const row = document.createElement('p'); row.textContent = item.name + ' × ' + Number(item.quantity) + ' — C$' + item.total; el('connectedCheckoutItems').append(row); }
      el('connectedOrderMethodGroup').classList.add('hidden'); el('connectedPriceChangeMessage').classList.add('hidden');
      el('connectedCashGroup').classList.toggle('hidden', quote.paymentMethod !== 'CASH');
      el('connectedCashReceived').value = ''; window.PosValidation.clear(el('connectedCheckoutModal'));
      if (quote.paymentMethod !== 'CASH') {
        const data = { ...quoteInput, quoteToken: quote.quoteToken, cashReceived: null, detail: state().detail };
        busy = false;
        await perform('SALE', data, (client, input) => client.createSale(input));
        return;
      }
      el('connectedCheckoutTitle').textContent = 'Cobrar venta en efectivo';
      el('confirmConnectedSaleBtn').textContent = 'Confirmar venta';
      el('connectedCheckoutModal').classList.remove('hidden');
      el('connectedCashReceived').focus();
    } catch (error) { showAlert(error.message); if (error.code === 'INVALID_SESSION') window.PosConnected.handleError(error); }
    finally { busy = false; }
  }
  async function confirm() {
    if (activeOrderId) {
      if (!quote || busy) return;
      const method = quote.paymentMethod, received = method === 'CASH' ? el('connectedCashReceived').value : null;
      if (method === 'CASH' && (!/^\d+(?:\.\d{1,2})?$/.test(received) || Number(received) < Number(quote.total))) { window.PosValidation.field('connectedCashReceived', 'Ingresa efectivo suficiente, con hasta dos decimales'); return; }
      const id = activeOrderId;
      await perform('ORDER_CHARGE', { quoteToken: quote.quoteToken, paymentMethod: method, cashReceived: received }, (client, input) => client.chargeOrder(id, input));
      return;
    }
    if (!quote || !quoteInput || busy) return;
    const data = { ...quoteInput, quoteToken: quote.quoteToken, cashReceived: quote.paymentMethod === 'CASH' ? el('connectedCashReceived').value : null, detail: state().detail };
    if (quote.paymentMethod === 'CASH' && (!/^\d+(?:\.\d{1,2})?$/.test(data.cashReceived) || Number(data.cashReceived) < Number(quote.total))) { window.PosValidation.field('connectedCashReceived', 'Ingresa efectivo suficiente, con hasta dos decimales'); return; }
    await perform('SALE', data, (client, input) => client.createSale(input));
  }
  async function cancel() {
    const id = el('anularVentaId').value, reason = el('anularVentaMotivo').value.trim();
    if (!id) { showAlert('Selecciona una venta del historial para anular.'); return; }
    if (!reason) { window.PosValidation.field('anularVentaMotivo', 'Ingresa el motivo de anulación'); return; }
    await perform('CANCEL', { reason }, (client, input) => client.cancelSale(id, input));
  }
  function renderCheckoutMode() {
    const button = el('processSaleBtn');
    if (button) button.textContent = salesFlow === 'CENTRALIZED' ? 'Enviar a Caja' : 'Procesar / Cobrar Venta';
  }
  async function startOrderCharge(id) {
    if (busy || pending()) { showPending(); showAlert('Comprueba la operación pendiente antes de continuar.'); return; }
    activeOrderId = String(id); quoteInput = null; el('connectedOrderPaymentMethod').value = 'CASH';
    await refreshOrderQuote();
  }
  async function refreshOrderQuote() {
    if (!activeOrderId || busy) return;
    busy = true; el("confirmConnectedSaleBtn").disabled = true;
    let refreshed = false;
    try {
      quote = await api(client => client.quoteOrder(activeOrderId, el('connectedOrderPaymentMethod').value));
      el('connectedCheckoutTitle').textContent = 'Cobrar pedido #' + activeOrderId;
      el('connectedCheckoutItems').replaceChildren();
      for (const item of quote.items) { const row = document.createElement('p'); row.textContent = item.name + ' × ' + Number(item.quantity) + ' — C$' + item.total; el('connectedCheckoutItems').append(row); }
      el('connectedCheckoutTotal').textContent = 'C$' + quote.total;
      const method = quote.paymentMethod === 'CASH' ? 'Efectivo' : quote.paymentMethod === 'CARD' ? 'Tarjeta' : 'Transferencia';
      el('connectedCheckoutDetail').textContent = method + ' · Subtotal C$' + quote.subtotal + ' · Descuento C$' + quote.discount;
      const difference = Number(quote.priceDelta), priceMessage = el('connectedPriceChangeMessage');
      priceMessage.textContent = quote.priceChanged ? 'El precio cambió desde que se preparó el pedido: estimado C$' + quote.estimatedTotal + '; precio vigente C$' + quote.total + ' (' + (difference > 0 ? '+' : '') + 'C$' + quote.priceDelta + '). Confirma este precio vigente para continuar.' : 'Precio vigente comprobado. Total estimado al preparar: C$' + quote.estimatedTotal + '.';
      priceMessage.classList.remove('hidden');
      el('connectedOrderMethodGroup').classList.remove('hidden');
      el('connectedCashGroup').classList.toggle('hidden', quote.paymentMethod !== 'CASH');
      el('connectedCashReceived').value = ''; window.PosValidation.clear(el('connectedCheckoutModal'));
      el('confirmConnectedSaleBtn').textContent = quote.priceChanged ? 'Confirmar precio y cobrar' : 'Confirmar y cobrar pedido';
      el('connectedCheckoutModal').classList.remove('hidden');
      refreshed = true;
    } catch (error) { showAlert(error.message); if (error.code === 'INVALID_SESSION') window.PosConnected.handleError(error); }
    finally {
      busy = false; el('confirmConnectedSaleBtn').disabled = false;
      if (refreshed) (quote.paymentMethod === 'CASH' ? el('connectedCashReceived') : el('confirmConnectedSaleBtn')).focus();
    }
  }
  async function confirmPayment(id) {
    await perform('PAYMENT_CONFIRM', {}, (client, input) => client.confirmPayment(id, input));
  }
  async function cancelOrder(id) {
    await perform('ORDER_CANCEL', {}, (client, input) => client.cancelOrder(id, input));
  }
  const money = value => 'C$' + Number(value || 0).toFixed(2);
  function fillEmpty(body, columns, message) {
    const row = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = columns; cell.className = 'text-center'; cell.textContent = message; row.append(cell); body.replaceChildren(row);
  }
  function renderCentral(overview) {
    if (!overview || overview.businessId !== state().businessId) throw new window.PosApiError('INVALID_RESPONSE');
    salesFlow = overview.salesFlow; renderCheckoutMode();
    el('cajaCentralBox').classList.remove('hidden');
    const scopeLabel = overview.currentCashSessionId ? 'sesión actual' : 'historial general';
    el('cajaOperacionesTitulo').textContent = 'Operaciones para revisión (' + scopeLabel + ')';
    el('cajaMovimientosTitulo').textContent = 'Movimientos de efectivo (' + scopeLabel + ')';
    const visibleOperationTitle = [...document.querySelectorAll('#cajaCentralBox h3')].find(element => element !== el('cajaOperacionesTitulo') && element.textContent.trim().startsWith('Operaciones'));
    if (visibleOperationTitle) visibleOperationTitle.textContent = 'Operaciones para revisión (' + scopeLabel + ')';
    const displayScopeLabel = overview.currentCashSessionId ? 'sesi\u00f3n actual' : 'historial general';
    el('cajaOperacionesTitulo').textContent = 'Operaciones para revisi\u00f3n (' + displayScopeLabel + ')';
    el('cajaMovimientosTitulo').textContent = 'Movimientos de efectivo (' + displayScopeLabel + ')';
    if (visibleOperationTitle) visibleOperationTitle.textContent = 'Operaciones para revisi\u00f3n (' + displayScopeLabel + ')';
    el('cajaCentralVentas').textContent = money(overview.salesByUser.reduce((sum, item) => sum + Number(item.total), 0));
    el('cajaCentralCobros').textContent = money(overview.customerCollections);
    el('cajaCentralEsperado').textContent = money(overview.expectedAmount);
    el('cajaCentralDiferencia').textContent = money(overview.lastDifference);
    el('connectedSalesFlowSetting').classList.toggle('hidden', state().role !== 'ADMIN');
    el('connectedSalesFlow').value = salesFlow;
    const users = el('cajaVentasUsuarioBody');
    if (!overview.salesByUser.length) fillEmpty(users, 8, 'Sin ventas registradas.');
    else {
      users.replaceChildren();
      for (const item of overview.salesByUser) {
        const row = document.createElement('tr');
        for (const value of [item.userName, item.saleCount, money(item.cash), money(item.card), money(item.transfer), money(item.credit), money(item.collections), money(item.total)]) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }
        users.append(row);
      }
    }
    pendingOrderDetails = new Map([...overview.pendingOrders, ...(overview.pendingHistoricalOrders || [])].map(order => [order.id, order]));
    const paymentRows = payments => payments.map(payment => ({ kind: 'payment', id: payment.id, date: payment.createdAt, reference: 'Factura #' + payment.invoiceNumber, user: payment.seller, method: payment.paymentMethod === 'CARD' ? 'Tarjeta pendiente' : 'Transferencia pendiente', amount: payment.amount }));
    const orderRows = orders => orders.map(order => ({ kind: 'order', id: order.id, date: order.createdAt, reference: 'Pedido #' + order.id, user: order.seller, method: 'Por cobrar', amount: order.estimatedTotal }));
    const saleRows = sales => (sales || []).map(sale => ({ kind: 'sale', id: sale.id, date: sale.createdAt, reference: 'Factura #' + sale.invoiceNumber, user: sale.seller, method: sale.paymentMethod === 'CARD' ? 'Tarjeta' : sale.paymentMethod === 'TRANSFER' ? 'Transferencia' : 'Efectivo', amount: sale.amount }));
    const renderOperationRows = (body, payments, orders, historical = false, additionalRows = []) => {
      if (!body) return;
      const rows = [...additionalRows, ...paymentRows(payments), ...orderRows(orders)].sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
      if (!rows.length) { fillEmpty(body, 7, historical ? 'Sin pendientes de sesiones anteriores.' : 'No hay pagos pendientes ni pedidos por cobrar.'); return; }
      body.replaceChildren();
      for (const item of rows) {
        const row = document.createElement('tr');
        for (const value of [new Date(item.date).toLocaleString(), item.reference, item.user, item.method, money(item.amount), item.kind === 'payment' ? 'Pendiente de confirmación' : (historical ? 'Pendiente histórico · sin factura' : 'Pedido pendiente · sin factura ni descuento de inventario')]) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }
        if (item.kind === 'sale') row.cells[5].textContent = 'Venta registrada';
        const actions = document.createElement('td');
        const addAction = (label, action, danger = false) => { const button = document.createElement('button'); button.type = 'button'; button.className = danger ? 'btn btn-sm btn-danger' : 'btn btn-sm btn-success'; button.textContent = label; button.dataset.action = action; button.dataset.id = item.id; actions.append(button); };
        if (item.kind === 'payment') addAction('Confirmar recibido', 'confirm-payment');
        else if (item.kind === 'order') { addAction('Detalle', 'order-detail'); addAction('Cobrar', 'charge-order'); addAction('Cancelar', 'cancel-order', true); }
        row.append(actions); body.append(row);
      }
    };
    const hasOpenSession = Boolean(overview.currentCashSessionId);
    renderOperationRows(el('cajaOperacionesBody'), overview.pendingPayments, overview.pendingOrders, false, saleRows(overview.operationSales));
    const historicalPayments = hasOpenSession ? (overview.pendingHistoricalPayments || []) : [], historicalOrders = hasOpenSession ? (overview.pendingHistoricalOrders || []) : [];
    renderOperationRows(el('cajaPendientesHistoricosBody'), historicalPayments, historicalOrders, true);
    el('cajaPendientesHistoricosSection')?.classList.toggle('hidden', !hasOpenSession || (historicalPayments.length === 0 && historicalOrders.length === 0));
    const movementsBody = el('cajaMovimientosBody');
    if (!overview.movements.length) fillEmpty(movementsBody, 7, 'Sin movimientos registrados.');
    else {
      movementsBody.replaceChildren();
      for (const movement of overview.movements) {
        const method = movement.paymentMethod === 'CARD' ? 'Tarjeta' : movement.paymentMethod === 'TRANSFER' ? 'Transferencia' : movement.paymentMethod === 'CASH' ? 'Efectivo' : '';
        let status = movement.status === 'VOID' ? 'Anulado' : movement.status === 'PENDING' ? (method ? method + ' pendiente de confirmación' : 'Pendiente') : (method ? method + ' confirmado' : 'Confirmado');
        if (movement.status === 'CONFIRMED' && method && method !== 'Efectivo' && movement.confirmedBy) status += ' · ' + movement.confirmedBy + ' · ' + new Date(movement.confirmedAt).toLocaleString();
        const row = document.createElement('tr');
        for (const value of [new Date(movement.createdAt).toLocaleString(), method || (movement.type === 'REVERSAL' ? 'Reversión' : movement.type), movement.description || '', money(movement.amount), movement.userName, status]) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }
        const actionCell = document.createElement('td');
        if (movement.status === 'PENDING' && ['CARD', 'TRANSFER'].includes(movement.paymentMethod)) { const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-sm btn-success'; button.textContent = 'Confirmar recibido'; button.dataset.action = 'confirm-payment'; button.dataset.id = movement.id; actionCell.append(button); }
        row.append(actionCell); movementsBody.append(row);
      }
    }
  }
  function mappedCash(value) {
    return { connectedCloseData: { ...value, openedAt: new Date(value.openedAt).toLocaleString(), closedAt: value.closedAt ? new Date(value.closedAt).toLocaleString() : new Date().toLocaleString(), closedBy: value.closedBy || value.closingBy }, id: value.id, businessId: value.businessId, estado: value.status === 'OPEN' ? 'abierta' : 'cerrada', efectivoInicial: Number(value.openingAmount), efectivoEsperado: Number(value.expectedAmount), efectivoReal: Number(value.countedAmount), diferencia: Number(value.difference), usuarioApertura: value.openedBy, usuarioCierre: value.closedBy, fechaApertura: new Date(value.openedAt).toLocaleString(), fechaAperturaTS: Date.parse(value.openedAt), fechaCierre: value.closedAt ? new Date(value.closedAt).toLocaleString() : null, fechaCierreTS: value.closedAt ? Date.parse(value.closedAt) : null, movimientos: (value.movements || []).map(m => ({ id: m.id, tipo: m.direction === 'IN' ? 'entrada' : 'salida', medioPago: m.payment_method, monto: Number(m.amount), concepto: m.description, usuario: m.user_name, fecha: new Date(m.created_at).toLocaleString(), fechaTS: Date.parse(m.created_at), estado: m.status === 'PENDING' ? 'pendiente' : m.status === 'CONFIRMED' ? 'confirmado' : 'void' })), connectedSales: (value.movements || []).filter(m => m.type === 'SALE' && m.status === 'CONFIRMED').reduce((sum, m) => sum + Number(m.amount), 0), connectedExpected: Number(value.expectedAmount) };
  }
  function renderCash(overview) { renderCajaViewBase(); if (overview) renderCentral(overview); }
  async function load(view) {
    if (activeScope !== scope()) { activeScope = scope(); quote = quoteInput = null; }
    showPending();
    if (view === 'salesView' || view === 'cajaView') {
      const settings = await api(client => client.salesFlow()); salesFlow = settings.salesFlow; renderCheckoutMode();
    }
    if (view === 'historyView') window.PosRuntime.setSales((await pages('sales')).map(mappedSale).reverse());
    if (view === 'cajaView') {
      const sessions = await pages('cashSessions');
      currentCash = sessions.find(value => value.status === 'OPEN') || null;
      window.PosRuntime.setCash(sessions.map(mappedCash)); renderCash(await api(client => client.cashOverview()));
    }
  }
  async function openCash() {
    const value = el('cajaEfectivoInicialInput').value;
    if (!/^\d+(?:\.\d{1,2})?$/.test(value)) { window.PosValidation.field('cajaEfectivoInicialInput', 'Ingresa el efectivo inicial, cero o mayor, con hasta dos decimales'); return; }
    await perform('OPEN_CASH', { openingAmount: value }, (client, input) => client.openCash(input));
  }
  async function closeDialog() {
    try { currentCash = await api(client => client.currentCash(true)); if (!currentCash) throw new window.PosApiError('CASH_CLOSED', 409); window.PosCashSummary.open(mappedCash(currentCash).connectedCloseData); }
    catch (error) { showAlert(error.message); }
  }
  async function closeCash() {
    const value = el('cajaEfectivoRealInput').value;
    if (!/^\d+(?:\.\d{1,2})?$/.test(value)) { window.PosValidation.field('cajaEfectivoRealInput', 'Ingresa el efectivo contado, cero o mayor, con hasta dos decimales'); return; }
    if (!currentCash) return;
    await perform('CLOSE_CASH', { countedAmount: value }, (client, input) => client.closeCash(currentCash.id, input));
  }
  for (const id of ['registrarEntradaBtn', 'registrarSalidaBtn']) { el(id).disabled = true; el(id).title = 'Movimientos manuales pendientes de integración'; }
  document.querySelector('input[name="paymentMethod"][value="credit"]').disabled = true;
  el('descuentoPct').step = '0.0001';
  el('confCurrency').disabled = true; el('confCurrency').title = 'Moneda conectada C$. Configuración monetaria por negocio pendiente.';
  for (const id of ['summaryCreditSales', 'summaryTotalExpenses']) el(id).closest('.summary-card').classList.add('hidden');
  el('historyView').querySelector('h1').textContent = 'Historial de ventas MySQL';
  const auditTable = el('auditTableBody').closest('.history-table-container'); auditTable.previousElementSibling.classList.add('hidden'); auditTable.classList.add('hidden');
  el('currentSaleNumber').textContent = 'Al confirmar';
  el('confirmConnectedSaleBtn').addEventListener('click', confirm); el('recoverSaleBtn').addEventListener('click', recover);
  el('connectedOrderPaymentMethod').addEventListener('change', refreshOrderQuote);
  el('connectedCheckoutModal').querySelector('.close-modal-btn').addEventListener('click', () => { activeOrderId = null; quote = quoteInput = null; });
  const handleOperationAction = event => {
    const button = event.target.closest('button[data-action]'); if (!button) return;
    const id = button.dataset.id, action = button.dataset.action;
    if (action === 'confirm-payment') confirmPayment(id);
    if (action === 'charge-order') startOrderCharge(id);
    if (action === 'cancel-order') cancelOrder(id);
    if (action === 'order-detail') {
      const order = pendingOrderDetails.get(id); if (!order) return;
      const detail = order.items.map(item => item.name + ' × ' + Number(item.quantity) + ' · C$' + item.estimatedSubtotal).join('\n');
      showAlert('Pedido #' + order.id + ' · ' + order.seller + '\n' + detail + '\nEstimado al preparar: C$' + order.estimatedTotal + '. Precio y stock se volverán a validar al cobrar.');
    }
  };
  for (const id of ['cajaOperacionesBody', 'cajaPendientesHistoricosBody']) el(id)?.addEventListener('click', handleOperationAction);
  el('cajaMovimientosBody').addEventListener('click', event => { const button = event.target.closest('button[data-action="confirm-payment"]'); if (button) confirmPayment(button.dataset.id); });
  el('saveConnectedSalesFlow').addEventListener('click', async () => {
    const button = el('saveConnectedSalesFlow'); button.disabled = true;
    try {
      const value = await api(client => client.setSalesFlow(el('connectedSalesFlow').value));
      salesFlow = value.salesFlow; renderCheckoutMode(); el('connectedSalesFlowMessage').textContent = salesFlow === 'DIRECT' ? 'Venta directa activa. Cada vendedor cobra desde Venta.' : 'Cobro centralizado activo. Los vendedores preparan pedidos; un usuario con permiso de Caja confirma y factura.';
      await load('cajaView');
    } catch (error) { showAlert(error.message); if (error.code === 'INVALID_SESSION') window.PosConnected.handleError(error); }
    finally { button.disabled = false; }
  });
  window.addEventListener('storage', event => { if (event.key === activeScope) showPending(); });
  window.PosSales = Object.freeze({ checkout, confirm, cancel, openCash, closeCash, closeDialog, load, renderCash });
})();
