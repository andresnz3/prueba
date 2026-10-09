/* global connectedMode */
'use strict';
(() => {
  if (!connectedMode) return;
  const el = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const money = value => 'C$' + Number(value || 0).toFixed(2);
  const paymentLabel = value => ({ CASH: 'Efectivo', BANK: 'Banco', PENDING: 'Por pagar' })[value] || value || '—';
  const dateTime = value => { const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('es-NI'); };
  let offset = 0, count = 0, rows = [], summary = { today: '0.00', total: '0.00', count: 0 }, requestId = 0, busy = false;
  const filteredRows = () => {
    const range = window.PosPeriodFilters?.range('expenses') || { from: '', until: '' };
    return rows.filter(item => window.PosPeriodFilters?.matches(item.createdAt, range));
  };

  function status(message, error = false) {
    const node = el('connectedExpenseStatus');
    if (!node) return;
    node.textContent = message;
    node.classList.remove('hidden');
    node.classList.toggle('error', error);
  }

  function render() {
    const body = el('gastosTableBody');
    if (body) {
      const visibleRows = filteredRows();
      const pageRows = visibleRows;
      body.innerHTML = pageRows.length ? pageRows.map(item => {
        const voided = item.status === 'VOID';
        const stamp = new Date(item.createdAt);
        const day = Number.isNaN(stamp.getTime()) ? '' : stamp.toISOString().slice(0, 10);
        return `<tr data-table-date="${esc(day)}"${voided ? ' style="background-color:#fdf5f5;color:#888;"' : ''}><td>${esc(dateTime(item.createdAt))}</td><td><strong>${esc(item.category)}</strong></td><td>${esc(item.description)}${voided ? ` <span style="color:#d32f2f;font-weight:bold;font-size:11px;">ANULADO: ${esc(item.cancelReason || '')}</span>` : ''}</td><td>${esc(paymentLabel(item.paymentMethod))}<br><small style="color:#666;">Ref: ${esc(item.receiptReference || 'S/F')}</small></td><td style="color:#d32f2f;font-weight:bold;">${voided ? `<del>${money(item.amount)}</del>` : money(item.amount)}</td><td>${esc(item.userName)}</td><td>${voided ? '—' : `<button class="btn btn-sm btn-danger" onclick="window.eliminarGasto('${esc(item.id)}')">Anular</button>`}</td></tr>`;
      }).join('') : `<tr><td colspan="7" class="text-center">${rows.length ? 'No hay gastos en este período.' : 'Sin gastos registrados.'}</td></tr>`;
      window.PosTables?.refreshDataTable(body);
    }
    const visibleRows = filteredRows();
    count = visibleRows.length;
    const range = window.PosPeriodFilters?.range('expenses') || { from: '', until: '' };
    const periodTotal = rows.filter(item => item.status !== 'VOID' && window.PosPeriodFilters?.matches(item.createdAt, range)).reduce((sum, item) => sum + Number(item.amount || 0), 0);
    if (el('gastosResumenPeriodo')) el('gastosResumenPeriodo').textContent = money(periodTotal);
    if (el('gastosResumenHoy')) el('gastosResumenHoy').textContent = money(summary.today);
    if (el('gastosResumenTotal')) el('gastosResumenTotal').textContent = money(summary.total);
    const prev = el('gastosPrevPageBtn'), next = el('gastosNextPageBtn');
    if (prev) prev.disabled = offset === 0 || busy;
    if (next) next.disabled = offset + 100 >= count || busy;
    const pageLabel = el('gastosPageLabel');
    if (pageLabel) pageLabel.textContent = count ? `Mostrando ${offset + 1}–${Math.min(offset + 100, count)} de ${count} en el período` : 'Sin gastos en el período';
  }

  async function load(view = 'gastosView') {
    if (view !== 'gastosView') return true;
    const current = ++requestId;
    try {
      status('Cargando gastos…');
      const result = await window.PosConnected.inventoryOperation(async client => {
        const first = await client.expenses(0);
        const expenses = [...first.expenses];
        for (let pageOffset = 100; pageOffset < first.summary.count; pageOffset += 100) {
          const page = await client.expenses(pageOffset);
          expenses.push(...page.expenses);
        }
        return { expenses, summary: first.summary };
      });
      if (current !== requestId) return false;
      rows = result.expenses;
      summary = result.summary;
      offset = 0;
      render();
      status('Gastos actualizados. Los pagos en efectivo aparecen en Caja.');
      el('connectedExpenseStatus')?.classList.add('hidden');
      return true;
    } catch (failure) {
      if (current !== requestId) return false;
      status(failure.message || 'No se pudieron cargar los gastos conectados.', true);
      if (failure.code === 'INVALID_SESSION') window.PosConnected.handleError(failure);
      return false;
    }
  }

  async function create() {
    if (busy) return;
    const category = el('gastoCategoria').value;
    const method = el('gastoMetodo').value;
    const description = el('gastoDescripcion').value.trim();
    const receiptReference = el('gastoComprobante').value.trim();
    const amount = el('gastoMonto').value;
    if (!description) { status('Ingrese una descripción válida.', true); el('gastoDescripcion').focus(); return; }
    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) { status('Ingrese un monto mayor que cero.', true); el('gastoMonto').focus(); return; }
    const paymentMethod = ({ caja: 'CASH', banco: 'BANK', pendiente: 'PENDING' })[method];
    if (!paymentMethod) { status('Seleccione un método de pago válido.', true); return; }
    const button = el('formRegistrarGasto')?.querySelector('button[type="submit"]');
    busy = true; if (button) button.disabled = true; render();
    try {
      await window.PosConnected.inventoryOperation(client => client.createExpense({ operationKey: window.crypto.randomUUID(), category, description, receiptReference, amount, paymentMethod }));
      el('formRegistrarGasto').reset();
      status('Gasto registrado.');
      await load('gastosView');
      document.dispatchEvent(new Event('connected:report-data-changed'));
    } catch (failure) {
      status(failure.message || 'No se pudo registrar el gasto conectado.', true);
      if (failure.code === 'INVALID_SESSION') window.PosConnected.handleError(failure);
    } finally { busy = false; if (button) button.disabled = false; render(); }
  }

  function cancel(id) {
    const expense = rows.find(item => item.id === String(id));
    if (!expense || expense.status === 'VOID') return;
    window.showAnularRegistro('Anular Gasto', `${expense.category} — ${expense.description} — Monto: ${money(expense.amount)}.`, async reason => {
      try {
        await window.PosConnected.inventoryOperation(client => client.cancelExpense(expense.id, { operationKey: window.crypto.randomUUID(), reason }));
        status('Gasto anulado.');
        await load('gastosView');
        document.dispatchEvent(new Event('connected:report-data-changed'));
      } catch (failure) {
        status(failure.message || 'No se pudo anular el gasto conectado.', true);
        if (failure.code === 'INVALID_SESSION') window.PosConnected.handleError(failure);
      }
    });
  }

  function page(delta) { offset = Math.max(0, Math.min(Math.max(0, count - 1), offset + delta * 100)); render(); }
  function applyPeriod() { offset = 0; render(); }
  document.addEventListener('pos:period-changed', event => { if (event.detail?.id === 'expenses') applyPeriod(); });
  window.PosExpenses = Object.freeze({ load, render, create, cancel, page, applyPeriod });
})();
