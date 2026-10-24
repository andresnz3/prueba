'use strict';
(() => {
  const views = Object.freeze({
    inventoryView: 'inventory', purchasesView: 'purchases', payablesView: 'payables',
    clientsView: 'clients', historyView: 'history', cajaView: 'cash',
    gastosView: 'expenses', reportesView: 'reports', configView: 'settings'
  });
  const labels = Object.freeze({
    products: 'Producto', clients: 'Cliente', suppliers: 'Proveedor', sales: 'Venta', purchases: 'Compra',
    cashSessions: 'Turno de caja', inventoryMovements: 'Movimiento de inventario', abonos: 'Abono',
    expenses: 'Gasto', auditLogs: 'Registro de auditoría', saleOrders: 'Orden pendiente',
    configuration: 'Configuración comercial', categories: 'Categorías'
  });
  const fields = Object.freeze({
    products: [['Nombre', ['name', 'nombre']], ['Código de barras', ['barcode', 'codigo', 'codigoBarras']], ['Categoría', ['category', 'categoria']], ['Existencias originales', ['stock', 'existencias']], ['Costo', ['cost', 'costo']], ['Precio al detalle', ['retailPrice', 'precio', 'precioVenta']], ['Precio al por mayor', ['wholesalePrice', 'precioMayorista']], ['Margen al detalle', ['marginRetail', 'margenRetail']], ['Margen al por mayor', ['marginWholesale', 'margenWholesale']]],
    clients: [['Nombre', ['name', 'nombre']], ['Teléfono', ['phone', 'telefono']], ['Identificación', ['ruc', 'cedula']], ['Límite de crédito', ['creditLimit', 'limiteCredito']], ['Saldo de origen', ['openingBalance', 'debt', 'deuda']]],
    suppliers: [['Nombre', ['name', 'nombre']], ['Contacto', ['contact', 'contacto']], ['Teléfono', ['phone', 'telefono']], ['Identificación', ['ruc']], ['Dirección', ['address', 'direccion']]],
    sales: [['Factura original', ['invoiceNumber', 'factura', 'invoice', 'numeroFactura']], ['Cliente', ['client', 'cliente', 'clientName']], ['Fecha original', ['fechaTS', 'createdAt', 'date', 'fecha']], ['Total', ['total']], ['Descuento', ['discount', 'descuento']], ['Impuesto', ['tax', 'impuesto']], ['Método de pago', ['paymentMethod', 'metodoPago', 'medioPago']], ['Estado original', ['status', 'estado']], ['Anulación', ['cancelReason', 'motivoAnulacion', 'cancelledAt']]],
    purchases: [['Factura original', ['invoiceNumber', 'invoice', 'factura', 'numeroFactura']], ['Proveedor', ['supplierName', 'proveedor', 'supplier']], ['Fecha original', ['fechaTS', 'createdAt', 'date', 'fecha']], ['Vencimiento', ['dueDate', 'dueAt', 'vencimiento']], ['Total', ['total']], ['Descuento', ['discount', 'descuento']], ['Estado original', ['status', 'estado']], ['Anulación', ['cancelReason', 'motivoAnulacion', 'cancelledAt']]],
    inventoryMovements: [['Producto', ['productName', 'producto', 'name']], ['Tipo', ['type', 'tipo']], ['Fecha original', ['fechaTS', 'createdAt', 'date']], ['Cantidad', ['quantity', 'cantidad']], ['Existencia anterior', ['stock_anterior', 'stockBefore']], ['Existencia final de origen', ['stock_nuevo', 'stockAfter']], ['Costo', ['cost', 'costo']], ['Motivo', ['reason', 'motivo']]],
    cashSessions: [['Estado original', ['status', 'estado']], ['Apertura', ['openedAt', 'fechaApertura']], ['Cierre', ['closedAt', 'fechaCierre']], ['Efectivo inicial', ['openingAmount', 'montoInicial']], ['Abierta por', ['openedBy', 'usuarioApertura']], ['Cerrada por', ['closedBy', 'usuarioCierre']]],
    abonos: [['Fecha original', ['fechaTS', 'createdAt', 'date']], ['Monto', ['amount', 'monto']], ['Método de pago', ['paymentMethod', 'metodoPago']], ['Factura de origen', ['invoiceNumber', 'facturaId']], ['Tipo', ['tipo']], ['Estado original', ['status', 'estado']], ['Anulación', ['cancelReason', 'motivoAnulacion']]],
    expenses: [['Fecha original', ['fechaTS', 'createdAt', 'date']], ['Categoría', ['category', 'categoria']], ['Descripción', ['description', 'concepto', 'descripcion']], ['Monto', ['amount', 'monto']], ['Método de pago', ['paymentMethod', 'metodoPago']], ['Estado original', ['status', 'estado']], ['Anulación', ['cancelReason', 'motivoAnulacion']]],
    saleOrders: [['Fecha original', ['createdAt', 'fechaTS', 'date']], ['Estado original', ['status', 'estado']], ['Total estimado', ['estimatedTotal', 'total']], ['Nota', ['notes', 'nota']]],
    auditLogs: [['Fecha original', ['createdAt', 'fechaTS', 'date']], ['Acción', ['action', 'accion']], ['Módulo', ['entity', 'modulo']], ['Descripción', ['details', 'descripcion']]],
    configuration: [['Nombre comercial', ['businessName', 'name']], ['Razón social', ['legalName']], ['RUC', ['ruc']], ['Teléfono', ['phone']], ['Dirección', ['address']], ['Moneda', ['currency']], ['Encabezado del comprobante', ['ticketHeader', 'header']], ['Pie del comprobante', ['ticketFooter', 'footer']]],
    categories: [['Categorías originales', ['categories']]]
  });
  const monetaryFields = new Set(['total', 'discount', 'descuento', 'tax', 'impuesto', 'cost', 'costo', 'retailPrice', 'precio', 'wholesalePrice', 'precioMayorista', 'creditLimit', 'limiteCredito', 'openingBalance', 'debt', 'deuda', 'amount', 'monto', 'openingAmount', 'montoInicial', 'estimatedTotal']);
  const sections = new Map();
  const text = value => String(value ?? '').trim();

  function formatDate(value) {
    const date = typeof value === 'number' || /^\d{10,}$/.test(String(value)) ? new Date(Number(value)) : new Date(value);
    return Number.isNaN(date.getTime()) ? text(value) : new Intl.DateTimeFormat('es-NI', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }

  function displayValue(key, value) {
    if (value === null || value === undefined || value === '') return '';
    if (/^(fechaTS|createdAt|date|fecha|openedAt|closedAt|dueDate|dueAt|cancelledAt)$/i.test(key)) return formatDate(value);
    if (monetaryFields.has(key) && /^-?\d+(?:\.\d+)?$/.test(String(value))) return 'C$' + Number(value).toFixed(2);
    if (typeof value === 'boolean') return value ? 'Sí' : 'No';
    if (Array.isArray(value)) return value.length + ' registro(s)';
    if (typeof value === 'object') {
      const entries = Object.entries(value).slice(0, 6).map(([name, amount]) => name + ': ' + (monetaryFields.has(name) && /^-?\d+(?:\.\d+)?$/.test(String(amount)) ? 'C$' + Number(amount).toFixed(2) : text(amount)));
      return entries.join(' · ');
    }
    return text(value);
  }

  function createSection(view, module) {
    const host = document.querySelector('#' + view + ' .history-container');
    if (!host) return;
    const section = document.createElement('section');
    section.className = 'connected-migration-history hidden';
    section.setAttribute('aria-labelledby', 'migrationHistoryTitle-' + module);
    section.dataset.module = module;
    const heading = document.createElement('h2');
    heading.id = 'migrationHistoryTitle-' + module;
    heading.innerHTML = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 2.64-6.36L3 8"></path><path d="M3 3v5h5"></path><path d="M12 7v5l3 2"></path></svg> Historial del negocio local';
    const intro = document.createElement('p');
    intro.className = 'connected-report-note';
    intro.textContent = 'Consulta aquí los datos originales conservados. Se muestran como referencia histórica y no cambian existencias, caja, saldos ni reportes actuales.';
    const status = document.createElement('p');
    status.className = 'connected-migration-history-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const content = document.createElement('div');
    content.className = 'connected-migration-history-content';
    const loadButton = document.createElement('button');
    loadButton.type = 'button';
    loadButton.className = 'btn btn-secondary';
    loadButton.textContent = 'Consultar historial conservado';
    const moreButton = document.createElement('button');
    moreButton.type = 'button';
    moreButton.className = 'btn btn-secondary hidden';
    moreButton.textContent = 'Cargar más registros';
    let offset = 0, total = 0, pending = false, loaded = false;

    function renderRecord(record) {
      const article = document.createElement('article');
      article.className = 'connected-migration-history-record';
      const title = document.createElement('strong');
      title.textContent = (labels[record.entityType] || 'Registro') + ' · ' + record.sourceBusinessName;
      const state = document.createElement('span');
      state.className = 'connected-migration-history-state';
      state.textContent = ({ ARCHIVED: 'Conservado para revisión', PENDING: 'Pendiente de revisión', PROJECTED: 'Enlazado a un registro', EXCLUDED: 'Excluido con revisión' })[record.recordStatus] || 'Pendiente de revisión';
      const top = document.createElement('div');
      top.className = 'connected-migration-history-record-heading';
      top.append(title, state);
      article.append(top);
      const list = document.createElement('dl');
      list.className = 'connected-migration-history-fields';
      const payload = record.payload || {};
      const choices = fields[record.entityType] || [];
      for (const [label, keys] of choices) {
        const key = keys.find(candidate => Object.hasOwn(payload, candidate));
        if (!key) continue;
        const value = displayValue(key, payload[key]);
        if (!value) continue;
        const dt = document.createElement('dt'); dt.textContent = label;
        const dd = document.createElement('dd'); dd.textContent = value;
        list.append(dt, dd);
      }
      if (record.hasImage) {
        const dt = document.createElement('dt'); dt.textContent = 'Imagen de origen';
        const dd = document.createElement('dd'); dd.textContent = 'Incluida en el archivo; todavía no está publicada en el almacenamiento de imágenes del negocio.';
        list.append(dt, dd);
      }
      if (record.entityType === 'cashSessions' && Array.isArray(payload.movimientos)) {
        const dt = document.createElement('dt'); dt.textContent = 'Movimientos originales';
        const dd = document.createElement('dd'); dd.textContent = payload.movimientos.length + ' movimiento(s) conservado(s); no se suman a la caja actual.';
        list.append(dt, dd);
      }
      if (Array.isArray(payload.items)) {
        const dt = document.createElement('dt'); dt.textContent = 'Detalles originales';
        const dd = document.createElement('dd');
        const lines = payload.items.slice(0, 5).map(item => [item.name || item.productName || item.producto, item.quantity || item.cantidad].filter(Boolean).join(' · ')).filter(Boolean);
        dd.textContent = payload.items.length + ' línea(s)' + (lines.length ? ': ' + lines.join('; ') : '');
        list.append(dt, dd);
      }
      if (list.childElementCount) article.append(list);
      if (record.pendingReason) {
        const note = document.createElement('p'); note.className = 'connected-migration-history-pending'; note.textContent = record.pendingReason; article.append(note);
      }
      return article;
    }

    async function loadPage(reset) {
      if (pending || !window.PosConnected) return;
      pending = true; loadButton.disabled = true; moreButton.disabled = true;
      status.textContent = 'Consultando el historial…';
      if (reset) { offset = 0; content.replaceChildren(); }
      try {
        const result = await window.PosConnected.migrationHistory(module, offset, 50);
        if (!result.available) {
          status.textContent = 'El archivo histórico todavía no está disponible en esta instalación.';
          content.replaceChildren();
          loaded = true;
          return;
        }
        total = result.total;
        offset = result.offset + result.records.length;
        content.append(...result.records.map(renderRecord));
        const integrity = result.reconciliation.archiveIntegrity === 'MATCH' ? 'La copia coincide con el conteo declarado en el archivo.' : result.reconciliation.archiveIntegrity === 'DIFFERENT' ? 'La copia presenta diferencias frente al conteo declarado en el archivo.' : 'No hay un archivo conservado para este negocio.';
        const unresolved = result.reconciliation.unresolvedRecords || 0;
        status.textContent = (total ? total + ' registro(s) históricos disponibles. ' : 'No hay registros históricos de este tipo. ') + integrity + ' La comparación con los registros operativos está pendiente; la migración no puede declararse completa.' + (unresolved ? ' ' + unresolved + ' registro(s) aún no tienen enlace operativo.' : '');
        if (result.reconciliation.differences.length) {
          const differences = document.createElement('ul');
          differences.className = 'connected-migration-history-differences';
          for (const difference of result.reconciliation.differences.slice(0, 5)) {
            const item = document.createElement('li');
            const expected = difference.expected === null ? 'por conciliar' : String(difference.expected);
            item.textContent = [difference.origin, difference.entity, 'esperado: ' + expected, 'encontrado: ' + String(difference.found), difference.reason].filter(Boolean).join(' · ');
            differences.append(item);
          }
          if (!content.querySelector('.connected-migration-history-differences')) content.prepend(differences);
        }
        if (!loaded && !total) {
          const empty = document.createElement('p'); empty.textContent = 'No se encontraron registros archivados para este módulo.'; content.append(empty);
        }
        loaded = true;
        moreButton.classList.toggle('hidden', offset >= total);
      } catch {
        status.textContent = 'No se pudo consultar el historial. Intenta nuevamente.';
      } finally {
        pending = false; loadButton.disabled = false; moreButton.disabled = false;
        loadButton.textContent = loaded ? 'Actualizar historial' : 'Consultar historial conservado';
      }
    }

    loadButton.addEventListener('click', () => loadPage(true));
    moreButton.addEventListener('click', () => loadPage(false));
    section.append(heading, intro, loadButton, status, content, moreButton);
    host.append(section);
    sections.set(view, section);
  }

  for (const [view, module] of Object.entries(views)) createSection(view, module);
  window.PosMigrationHistory = Object.freeze({
    activate(view) { for (const [key, section] of sections) section.classList.toggle('hidden', key !== view); }
  });
})();
