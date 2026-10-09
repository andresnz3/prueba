/* global connectedMode, localDB, DEFAULT_BUSINESS_ID, sysConfig, configStorageKey, cart, buyerType, paymentMethod, currentUser, cajaActual, MSG_SIN_CAJA, r2, isAdmin, showAlert, showConfirm, initApp, actualizarCatalogo, actualizarTablaInventario, renderDashboard, renderCajaView, generarVisualizacionTicket, mediosPagoVenta, resetearDescuentoVenta, actualizarCarrito */
'use strict';
/* global saleNumber */
(() => {
  if (connectedMode) return;
  const el = id => document.getElementById(id);
  let busy = false, loading = false, orders = [], selected = null, preview = null;
  const copy = value => JSON.parse(JSON.stringify(value));
  const fail = message => { throw new Error(message); };
  function flow() {
    const config = JSON.parse(localStorage.getItem(configStorageKey) || '{}');
    return config.salesFlow === 'CENTRALIZED' ? 'CENTRALIZED' : 'DIRECT';
  }
  function cartInput() {
    return { items: cart.map(item => ({ id: item.id, cantidad: item.cantidad })), buyerType, discountPercent: Number(el('descuentoPct').value || 0) * (document.querySelector('input[name="descApplies"][value="si"]').checked ? 1 : 0), detail: el('saleDetailInput').value.trim(), clientId: paymentMethod === 'credit' ? el('creditClientSelect').value || null : null, creditDays: Math.max(1, parseInt(el('creditDays').value) || 30), seller: currentUser?.displayName, suggestedMethod: paymentMethod };
  }
  const tables = () => [localDB.saleOrders, localDB.products, localDB.sales, localDB.clients, localDB.cajaSessions, localDB.inventory_movements, localDB.audit_logs, localDB.sync_queue, localDB.abonos];
  async function audit(action, detail) {
    await localDB.audit_logs.add({ business_id: DEFAULT_BUSINESS_ID, fechaTS: Date.now(), fecha: new Date().toLocaleString(), usuario: currentUser.displayName, modulo: action === 'NUEVA_VENTA' ? 'VENTAS' : 'CAJA', accion: action, detalle: detail });
  }
  async function quote(input) {
    if (!input.items.length) fail('El carrito está vacío. Agrega productos antes de continuar.');
    if (!['retail','wholesale'].includes(input.buyerType) || !Number.isFinite(input.discountPercent) || input.discountPercent < 0 || input.discountPercent > 100) fail('Tarifa o descuento inválido.');
    const seen = new Set(), items = [];
    for (const item of input.items) {
      if (seen.has(String(item.id)) || !Number.isFinite(item.cantidad) || item.cantidad <= 0) fail('Cantidad inválida.');
      seen.add(String(item.id));
      const p = await localDB.products.get(item.id);
      if (!p || p.business_id !== DEFAULT_BUSINESS_ID || p.deleted || p.active === false) fail('El producto ya no está disponible.');
      if ((p.stock || 0) < item.cantidad) fail('Stock insuficiente de ' + p.name + '. Disponible: ' + (p.stock || 0) + '.');
      const price = Number(input.buyerType === 'retail' ? p.retailPrice || p.retail || 0 : p.wholesalePrice || p.wholesale || 0);
      if (price < 0 || !Number.isFinite(price)) fail('Precio inválido.');
      items.push({ ...copy(p), cantidad: item.cantidad });
    }
    const rawSubtotal = items.reduce((sum, p) => r2(sum + r2((input.buyerType === 'retail' ? p.retailPrice || p.retail || 0 : p.wholesalePrice || p.wholesale || 0) * p.cantidad)), 0);
    const subtotal = r2(rawSubtotal);
    const discount = r2(rawSubtotal * input.discountPercent / 100);
    const total = r2(rawSubtotal - discount);
    return { items, subtotal, discount, total, token: JSON.stringify(items.map(p => [p.id,p.name,p.cantidad,p.retailPrice,p.wholesalePrice]).concat([[input.buyerType,input.discountPercent,total]])) };
  }
  async function record(input, options) {
    if (!currentUser) fail('Inicia sesión antes de cobrar.');
    if (options.orderId && !isAdmin('cajaView')) fail('No tiene permisos para cobrar órdenes.');
    if (cajaActual?.estado !== 'abierta') fail(MSG_SIN_CAJA);
    return localDB.transaction('rw', tables(), async () => {
      let order;
      if (options.orderId) {
        order = await localDB.saleOrders.get(options.orderId);
        if (!order || order.business_id !== DEFAULT_BUSINESS_ID || order.status !== 'PENDING') fail('La orden ya fue cobrada o cancelada.');
        input = order.input;
      }
      if (flow() !== (order ? 'CENTRALIZED' : 'DIRECT')) fail('El flujo de venta cambió. Revisa la configuración de Caja.');
      const sessions = await localDB.cajaSessions.where({ business_id: DEFAULT_BUSINESS_ID, estado: 'abierta' }).toArray();
      if (sessions.length !== 1) fail(MSG_SIN_CAJA);
      const session = sessions[0];
      const calc = await quote(input);
      if (options.expectedTotal !== undefined && calc.total !== r2(options.expectedTotal)) fail("El precio cambi?. Revisa el carrito antes de cobrar.");
      if (options.quoteToken && calc.token !== options.quoteToken) fail('El precio cambió. Cierra y vuelve a revisar la orden antes de cobrar.');
      const method = options.paymentMethod;
      if (!['cash','card','transfer','credit'].includes(method)) fail('Selecciona un método de pago.');
      if (method === 'cash' && (!Number.isFinite(Number(options.received)) || Number(options.received) < calc.total)) fail('Ingresa efectivo suficiente, con hasta dos decimales.');
      let client = null, dueTS = null;
      if (method === 'credit') {
        client = input.clientId ? (await localDB.clients.toArray()).find(c => String(c.id) === String(input.clientId)) : null;
        if (!client || client.business_id !== DEFAULT_BUSINESS_ID || client.active === false) fail('Selecciona un cliente activo para vender a crédito.');
        const clientSales = (await localDB.sales.toArray()).filter(s => s.business_id === DEFAULT_BUSINESS_ID && String(s.clienteId) === String(client.id) && s.metodo === 'Crédito' && !s.anulada);
        const payments = (await localDB.abonos.toArray()).filter(p => p.business_id === DEFAULT_BUSINESS_ID && p.tipo === 'cliente' && !p.anulado);
        const debt = r2(Number(client.deudaSinFactura || 0) + clientSales.reduce((sum,s) => sum + Math.max(0, r2(s.total - payments.filter(p => String(p.facturaId) === String(s.id)).reduce((v,p) => v + p.monto,0))),0));
        if (r2(debt + calc.total) > Number(client.creditLimit || 0)) fail('El cliente supera el límite de crédito disponible');
        client.debt = r2(debt + calc.total);
        const date = new Date(); date.setDate(date.getDate() + input.creditDays); dueTS = date.getTime();
      }
      const previous = (await localDB.sales.toArray()).filter(s => s.business_id === DEFAULT_BUSINESS_ID);
      const numero = Math.max(0, ...previous.map(s => Number(s.numero) || 0)) + 1;
      const id = Date.now() + Math.random(), now = Date.now();
      const sale = { id, business_id: DEFAULT_BUSINESS_ID, numero, fecha: new Date(now).toLocaleString(), fechaTS: now, vendedor: input.seller || currentUser.displayName, cajero: currentUser.displayName, detalle: input.detail || '-', metodo: method === 'credit' ? 'Crédito' : 'Contado', medioPago: method, cliente: client?.name || '-', clienteId: client?.id || null, cajaSessionId: session.id, estadoCaja: method === 'cash' ? 'confirmado' : method === 'credit' ? 'no_aplica' : 'pendiente', vencimiento: dueTS ? new Date(dueTS).toLocaleDateString() : null, vencimientoTS: dueTS, subtotal: calc.subtotal, descuentoPct: input.discountPercent, descuentoMonto: calc.discount, total: calc.total, tarifa: input.buyerType === 'retail' ? 'Menudeo' : 'Mayoreo', items: calc.items, plazo: dueTS ? input.creditDays + ' días' : '-', anulada: false, ordenId: order?.id || null };
      await localDB.sales.add(sale);
      if (client) { await localDB.clients.put(client); await localDB.sync_queue.add({ action: 'UPDATE', table_name: 'clients', data: JSON.stringify(client), status: 'pending' }); }
      for (const item of calc.items) {
        const product = await localDB.products.get(item.id);
        product.stock = product.stock - item.cantidad;
        await localDB.products.put(product);
        await localDB.sync_queue.add({ action: 'UPDATE', table_name: 'products', data: JSON.stringify(product), status: 'pending' });
        const movement = { business_id: DEFAULT_BUSINESS_ID, producto_id: item.id, tipo: 'VENTA', cantidad: -item.cantidad, costo_unitario: product.cost || 0, stock_nuevo: product.stock, fecha: sale.fecha, fechaTS: now, motivo: 'Venta #' + numero, usuario: currentUser.displayName };
        movement.id = await localDB.inventory_movements.add(movement);
        await localDB.sync_queue.add({ action: 'INSERT', table_name: 'inventory_movements', data: JSON.stringify(movement), status: 'pending' });
      }
      if (method !== 'credit' && calc.total > 0) {
        session.movimientos.push({ id: crypto.randomUUID(), tipo: 'venta', saleId: id, medioPago: method, monto: calc.total, concepto: 'Venta #' + numero, usuario: currentUser.displayName, fecha: sale.fecha, fechaTS: now, estado: sale.estadoCaja, anulado: false });
        await localDB.cajaSessions.put(session);
      }
      if (order) { order.status = 'COMPLETED'; order.saleId = id; order.completedAt = now; order.cashier = currentUser.displayName; await localDB.saleOrders.put(order); }
      await audit('NUEVA_VENTA', 'Vendió:\n' + calc.items.map(item => item.name + ' x ' + item.cantidad).join('\n') + '\nFactura: #' + numero + '\nTotal: ' + sysConfig.currency + calc.total.toFixed(2) + '\nVendedor: ' + sale.vendedor + '; cajero: ' + sale.cajero + '; ' + method);
      // Local queue retains its existing role; connected mode never runs this module.
      await localDB.sync_queue.add({ action: 'INSERT', table_name: 'sales', data: JSON.stringify(sale), status: 'pending' });
      return sale;
    });
  }
  async function refresh() {
    loading = true; el('connectedSalesFlow').disabled = true; el('saveConnectedSalesFlow').disabled = true;
    try { await initApp(); actualizarCatalogo(); actualizarTablaInventario(); renderDashboard(); await loadOrders(); }
    finally { loading = false; renderCajaView(); }
  }
  async function loadOrders() { orders = await localDB.saleOrders.where('business_id').equals(DEFAULT_BUSINESS_ID).toArray(); }
  async function nextOrderDisplayNumber() {
    const existing = await localDB.saleOrders.where('business_id').equals(DEFAULT_BUSINESS_ID).toArray();
    const highest = existing.reduce((value, order) => Math.max(value, Number(order.displayNumber) || 0), existing.length);
    return highest + 1;
  }
  async function orderDisplayNumber(order) {
    if (Number.isInteger(Number(order.displayNumber)) && Number(order.displayNumber) > 0) return Number(order.displayNumber);
    const all = await localDB.saleOrders.where('business_id').equals(DEFAULT_BUSINESS_ID).toArray();
    const used = new Set(all.map(item => Number(item.displayNumber)).filter(value => Number.isInteger(value) && value > 0));
    const legacy = all.filter(item => !used.has(Number(item.displayNumber))).sort((a, b) => Number(a.createdAt) - Number(b.createdAt) || String(a.id).localeCompare(String(b.id)));
    let candidate = 1;
    for (const item of legacy) {
      while (used.has(candidate)) candidate += 1;
      if (String(item.id) === String(order.id)) return candidate;
      used.add(candidate);
      candidate += 1;
    }
    return '';
  }
  async function prepare() {
    if (busy) return;
    busy = true;
    try {
      const openSessions = await localDB.cajaSessions.where({ business_id: DEFAULT_BUSINESS_ID, estado: 'abierta' }).toArray();
      if (openSessions.length !== 1) fail(MSG_SIN_CAJA);
      const input = cartInput();
      await localDB.transaction('rw', tables(), async () => {
        if (flow() !== 'CENTRALIZED') fail('El flujo de venta cambió.');
        const sessions = await localDB.cajaSessions.where({ business_id: DEFAULT_BUSINESS_ID, estado: 'abierta' }).toArray();
        if (sessions.length !== 1) fail(MSG_SIN_CAJA);
        const calc = await quote(input);
        const order = { id: crypto.randomUUID(), displayNumber: await nextOrderDisplayNumber(), business_id: DEFAULT_BUSINESS_ID, cajaSessionId: sessions[0].id, status: 'PENDING', createdAt: Date.now(), input, estimatedTotal: calc.total };
        await localDB.saleOrders.add(order); await audit('PREPARAR_ORDEN', 'Orden ' + order.id + '; sin factura ni movimiento de dinero.');
      });
      cart.splice(0); resetearDescuentoVenta(); actualizarCarrito(); await loadOrders(); render();
      showAlert('Orden enviada a Caja. No se generó factura ni se descontó inventario. La próxima factura sigue siendo #' + String(saleNumber).padStart(6, '0') + '.');
    } catch (error) { showAlert(error.message); }
    finally { busy = false; render(); }
  }
  async function cancelOrder(id) {
    if (!isAdmin('cajaView') || busy) return;
    showConfirm('¿Cancelar esta orden pendiente? No se modificará el inventario.', async () => {
      busy = true;
      try {
        await localDB.transaction('rw', tables(), async () => {
          const order = await localDB.saleOrders.get(id);
          if (!order || order.business_id !== DEFAULT_BUSINESS_ID || order.status !== 'PENDING') fail('La orden ya fue cobrada o cancelada.');
          order.status = 'CANCELLED'; order.cancelledAt = Date.now(); order.cancelledBy = currentUser.displayName;
          await localDB.saleOrders.put(order); await audit('CANCELAR_ORDEN', 'Orden ' + id);
        });
        await loadOrders(); render();
        showAlert('Orden cancelada. No se generó factura ni movimiento de caja. La próxima factura sigue siendo #' + String(saleNumber).padStart(6, '0') + '.');
      } catch (error) { showAlert(error.message); }
      finally { busy = false; render(); }
    });
  }
  async function startCharge(id) {
    if (busy || !isAdmin('cajaView')) return;
    try {
      if (cajaActual?.estado !== 'abierta') fail(MSG_SIN_CAJA);
      selected = await localDB.saleOrders.get(id);
      if (!selected || selected.business_id !== DEFAULT_BUSINESS_ID || selected.status !== 'PENDING') fail('La orden ya fue cobrada o cancelada.');
      preview = await quote(selected.input);
      el('localOrderTitle').textContent = 'Cobrar orden #' + await orderDisplayNumber(selected);
      el('localOrderSummary').textContent = 'Subtotal ' + sysConfig.currency + preview.subtotal.toFixed(2) + ' · Descuento ' + sysConfig.currency + preview.discount.toFixed(2);
      el('localOrderTotal').textContent = sysConfig.currency + preview.total.toFixed(2);
      el('localOrderPriceNotice').textContent = preview.total !== selected.estimatedTotal
        ? 'El precio cambió. Estimado: ' + sysConfig.currency + Number(selected.estimatedTotal).toFixed(2) + '. Confirma el total vigente para cobrar.'
        : 'Precio vigente comprobado. Total estimado al preparar: ' + sysConfig.currency + Number(selected.estimatedTotal).toFixed(2) + '. Al cobrar se generará la factura, se descontará el stock y se registrará el pago.';
      el('localOrderItems').replaceChildren();
      for (const item of preview.items) {
        const row = document.createElement('div'), description = document.createElement('span'), subtotal = document.createElement('span'), label = document.createElement('small'), amount = document.createElement('strong');
        const unitPrice = Number(selected.input.buyerType === 'retail' ? item.retailPrice || item.retail || 0 : item.wholesalePrice || item.wholesale || 0);
        row.className = 'checkout-item'; row.setAttribute('role', 'listitem');
        description.className = 'checkout-item-description'; description.textContent = item.name + ' × ' + Number(item.cantidad);
        subtotal.className = 'checkout-item-subtotal'; label.textContent = 'Subtotal'; amount.textContent = sysConfig.currency + r2(unitPrice * Number(item.cantidad)).toFixed(2);
        subtotal.append(label, amount); row.append(description, subtotal); el('localOrderItems').append(row);
      }
      el('localOrderMethod').value = selected.input.suggestedMethod || 'cash';
      el('localOrderMethod').querySelector('option[value="credit"]').disabled = !selected.input.clientId;
      el('localOrderReceived').value = ''; window.PosValidation.clear(el('localOrderForm')); paymentFields();
      el('localOrderCheckoutModal').classList.remove('hidden');
      (el('localOrderMethod').value === 'cash' ? el('localOrderReceived') : el('localOrderConfirmBtn')).focus();
    } catch (error) { showAlert(error.message); }
  }
  function updateCashChangePreview() {
    const previewBox = el('localOrderCashChangePreview'), input = el('localOrderReceived');
    if (!previewBox || !input || el('localOrderMethod').value !== 'cash' || !input.value || !Number.isFinite(Number(input.value)) || Number(input.value) < Number(preview?.total)) { previewBox?.classList.add('hidden'); return; }
    el('localOrderCashChangeAmount').textContent = sysConfig.currency + r2(Math.max(0, Number(input.value) - Number(preview.total))).toFixed(2);
    previewBox.classList.remove('hidden');
  }
  function paymentFields() {
    const method = el('localOrderMethod').value;
    const labels = { cash: 'Efectivo', card: 'Tarjeta', transfer: 'Transferencia', credit: 'Crédito' };
    el('localOrderCashGroup').classList.toggle('hidden', method !== 'cash');
    el('localOrderPaymentMethod').textContent = labels[method] || 'Efectivo';
    updateCashChangePreview();
  }
  async function charge(event) {
    event.preventDefault(); if (busy || !selected || !preview) return;
    const method = el('localOrderMethod').value, raw = el('localOrderReceived').value;
    if (method === 'cash' && (!/^\d+(?:\.\d{1,2})?$/.test(raw) || Number(raw) < preview.total)) { window.PosValidation.field('localOrderReceived', 'Ingresa efectivo suficiente, con hasta dos decimales'); return; }
    busy = true; el('localOrderConfirmBtn').disabled = true;
    try {
      const sale = await record(selected.input, { orderId: selected.id, quoteToken: preview.token, paymentMethod: method, received: method === 'cash' ? Number(raw) : null });
      el('localOrderCheckoutModal').classList.add('hidden'); selected = preview = null;
      await refresh(); generarVisualizacionTicket(sale, method === 'cash' ? Number(raw) : sale.total, method === 'cash' ? r2(Number(raw) - sale.total) : 0, false);
    } catch (error) { showAlert(error.message); }
    finally { busy = false; el('localOrderConfirmBtn').disabled = false; render(); }
  }
  async function confirmSale(id) {
    if (busy || !isAdmin('cajaView')) return;
    busy = true;
    try {
      await localDB.transaction('rw', tables(), async () => {
        const sale = (await localDB.sales.toArray()).find(s => String(s.id) === String(id));
        if (!sale || sale.business_id !== DEFAULT_BUSINESS_ID || sale.anulada || sale.estadoCaja !== 'pendiente') fail('El pago ya no está pendiente.');
        sale.estadoCaja = 'confirmado'; sale.usuarioConfirmacionCaja = currentUser.displayName; sale.fechaConfirmacionCaja = new Date().toLocaleString();
        await localDB.sales.put(sale);
        const sessions = await localDB.cajaSessions.where('business_id').equals(DEFAULT_BUSINESS_ID).toArray();
        for (const session of sessions) {
          let changed = false;
          for (const movement of session.movimientos) if (String(movement.saleId) === String(sale.id) && !movement.anulado && movement.estado === 'pendiente') { movement.estado = 'confirmado'; movement.usuarioConfirmacion = currentUser.displayName; movement.fechaConfirmacion = sale.fechaConfirmacionCaja; changed = true; }
          if (changed) await localDB.cajaSessions.put(session);
        }
        await audit('CONFIRMAR_VENTA', 'Factura #' + sale.numero + '; ' + sale.medioPago + '; no altera el efectivo físico.');
      });
      await refresh();
    } catch (error) { showAlert(error.message); }
    finally { busy = false; render(); }
  }
  function render() {
    el('connectedSalesFlowSetting').classList.remove('hidden'); el('connectedSalesFlow').value = flow();
    el('connectedSalesFlow').disabled = loading || busy || !isAdmin('cajaView');
    el('saveConnectedSalesFlow').disabled = loading || busy || !isAdmin('cajaView');
    el('processSaleBtn').textContent = flow() === 'CENTRALIZED' ? 'Enviar a Caja' : 'Procesar / Cobrar Venta';
    el('connectedSalesFlowMessage').textContent = flow() === 'CENTRALIZED' ? 'Caja centralizada local: prepara órdenes sin factura ni dinero; Caja confirma y cobra.' : 'Venta directa local: el vendedor cobra desde Punto de Venta.';
    const body = el('cajaOperacionesBody'), historicalBody = el('cajaPendientesHistoricosBody'), historicalSection = el('cajaPendientesHistoricosSection');
    const belongsToCurrent = order => cajaActual && (order.cajaSessionId !== undefined && order.cajaSessionId !== null ? String(order.cajaSessionId) === String(cajaActual.id) : Number(order.createdAt) >= Number(cajaActual.fechaAperturaTS));
    const hasOpenSession = Boolean(cajaActual);
    const currentOrders = orders.filter(o => o.status === 'PENDING' && (hasOpenSession ? belongsToCurrent(o) : true)).sort((a,b) => b.createdAt-a.createdAt);
    const historicalOrders = hasOpenSession ? orders.filter(o => o.status === 'PENDING' && !belongsToCurrent(o)).sort((a,b) => b.createdAt-a.createdAt) : [];
    body.querySelectorAll('tr[data-local-order]').forEach(row => row.remove());
    historicalBody?.querySelectorAll('tr[data-local-order]').forEach(row => row.remove());
    if (currentOrders.length) body.querySelectorAll('td[colspan]').forEach(cell => cell.closest('tr').remove());
    if (historicalBody) historicalBody.innerHTML = historicalOrders.length ? '' : '<tr><td colspan="7" class="text-center">Sin pendientes de sesiones anteriores.</td></tr>';
    historicalSection?.classList.toggle('hidden', historicalOrders.length === 0);
    for (const order of currentOrders) {
      const row = document.createElement('tr'); row.dataset.localOrder = order.id; row.dataset.priority = '0';
      for (const value of [new Date(order.createdAt).toLocaleString(), 'Orden pendiente · sin factura', order.input.seller, mediosPagoVenta[order.input.suggestedMethod], sysConfig.currency + order.estimatedTotal.toFixed(2), 'Pendiente de cobro']) { const td = document.createElement('td'); td.textContent = value; row.append(td); }
      const td = document.createElement('td');
      for (const [label,action] of [['Cobrar',startCharge],['Cancelar',cancelOrder]]) { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn-sm ' + (label === 'Cobrar' ? 'btn-success' : 'btn-secondary'); b.textContent = label; b.disabled = !isAdmin('cajaView'); b.dataset.orderId = order.id; b.addEventListener('click',() => action(order.id)); td.append(b); }
      row.append(td); body.prepend(row);
    }
    for (const order of historicalOrders) {
      const row = document.createElement('tr'); row.dataset.localOrder = order.id; row.dataset.priority = '0';
      for (const value of [new Date(order.createdAt).toLocaleString(), 'Orden de sesi�n anterior � sin factura', order.input.seller, mediosPagoVenta[order.input.suggestedMethod], sysConfig.currency + order.estimatedTotal.toFixed(2), 'Pendiente de resoluci�n']) { const td = document.createElement('td'); td.textContent = value; row.append(td); }
      const td = document.createElement('td'); const detail = document.createElement('button'); detail.type = 'button'; detail.className = 'btn btn-sm btn-secondary'; detail.textContent = 'Detalle'; detail.addEventListener('click', () => showAlert('Orden #' + order.id + ' de una sesi�n anterior. El cobro se registrar� en la sesi�n actual de Caja.')); td.append(detail); const charge = document.createElement('button'); charge.type = 'button'; charge.className = 'btn btn-sm btn-success'; charge.textContent = 'Cobrar'; charge.disabled = !isAdmin('cajaView'); charge.addEventListener('click', () => startCharge(order.id)); td.append(charge); const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn btn-sm btn-secondary'; cancel.textContent = 'Cancelar'; cancel.disabled = !isAdmin('cajaView'); cancel.addEventListener('click', () => cancelOrder(order.id)); td.append(cancel); row.append(td); historicalBody?.append(row);
    }
  }
  el('saveConnectedSalesFlow').addEventListener('click', async () => {
    if (busy || !isAdmin('cajaView')) return;
    const requested = el('connectedSalesFlow').value; busy = true;
    try {
      await localDB.transaction('rw', tables(), async () => {
        const sessions = await localDB.cajaSessions.where({ business_id: DEFAULT_BUSINESS_ID, estado: 'abierta' }).count();
        const pending = await localDB.saleOrders.where({ business_id: DEFAULT_BUSINESS_ID, status: 'PENDING' }).count();
        if (requested !== flow() && (sessions || pending)) fail('Cierra Caja y resuelve las órdenes pendientes antes de cambiar el flujo.');
        if (!['DIRECT','CENTRALIZED'].includes(requested)) fail('Selecciona un flujo válido.');
        const config = { ...sysConfig, ...JSON.parse(localStorage.getItem(configStorageKey) || '{}') };
        config.salesFlow = requested; localStorage.setItem(configStorageKey,JSON.stringify(config)); sysConfig.salesFlow = requested;
      });
      await loadOrders(); renderCajaView();
    } catch (error) { showAlert(error.message); }
    finally { busy = false; render(); }
  });
  el('localOrderForm').addEventListener('submit',charge); el('localOrderMethod').addEventListener('change',paymentFields); el('localOrderReceived').addEventListener('input',updateCashChangePreview);
  window.addEventListener('storage', event => { if (event.key === configStorageKey) renderCajaView(); });
  window.PosLocalFlow = Object.freeze({ load: refresh, salesFlow: flow, cartInput, record, prepare, confirmSale, render, isCentralized: () => flow() === 'CENTRALIZED' });
  document.addEventListener('DOMContentLoaded', async () => { await localDB.open(); await loadOrders(); renderCajaView(); });
})();
