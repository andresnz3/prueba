"use strict";
/*
 * General-admin review of customer-provided JSON migration packages.
 * Reads only the selected package and does not access local POS storage.
 * The local POS remains untouched.
 */
(() => {
  const el = id => document.getElementById(id);
  const r2 = value => Math.round((Number(value) || 0) * 100) / 100;
  const text = value => String(value ?? '').trim();
  const norm = value => text(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ');
  const money = value => r2(value).toLocaleString('es-NI', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  let canAccess = () => false;
  let businesses = [];
  let localIdentity = null;
  let localScope = null;
  let report = null;    // conteos y advertencias calculados
  let loading = false;
  let packageReadToken = 0;
  let packageValue = null;
  let packageFileSha256 = null;
  let previewCreditRequest = null;
  let migrateCreditRequest = null;
  let creditPreview = null;
  let creditPreviewToken = 0;
  let creditBusy = false;
  let creditTrigger = null;
  let migrationBusy = false;
  let migrationTrigger = null;
  let migrateBasicRequest = null;
  let previewInventoryRequest = null;
  let migrateInventoryRequest = null;
  let inventoryPreviewToken = 0;
  let inventoryPreview = null;
  let inventoryBusy = false;
  let inventoryTrigger = null;
  let previewSalesRequest = null;
  let migrateSalesRequest = null;
  let salesPreviewToken = 0;
  let salesPreview = null;
  let salesBusy = false;
  let salesTrigger = null;
  let previewPurchasesRequest = null;
  let migratePurchasesRequest = null;
  let previewArchiveRequest = null;
  let archiveMigrationRequest = null;
  let archiveStatusRequest = null;
  let projectMigrationOperationsRequest = null;
  let reviewIdentityRecordRequest = null;
  let createMigrationTargetRequest = null;
  let inspectExistingMigrationTargetRequest = null;
  let prepareExistingMigrationTargetRequest = null;
  let existingTargetInspection = null;
  let existingTargetBusy = false;
  let existingTargetRequestToken = 0;
  let archivePreview = null;
  let archivePreviewToken = 0;
  let archiveBusy = false;
  let identityReviewBusyKey = '';
  let purchasesPreviewToken = 0;
  let purchasesPreview = null;
  let purchasesBusy = false;
  let purchasesTrigger = null;
  const completedTargets = new Set();
  const completedInventoryTargets = new Set();
  const completedSalesTargets = new Set();
  const completedPurchasesTargets = new Set();
  // Simulación solo visual: vive en memoria y se descarta al salir o actualizar.
  let sim = { added: [], map: {}, general: false };
  const INVALID_PACKAGE_MESSAGE = 'Este archivo no parece ser un paquete de migración válido.';
  const VALID_PACKAGE_MESSAGE = 'Paquete válido. Listo para revisión.';

  function node(tag, className, content) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (content !== undefined) item.textContent = content;
    return item;
  }

  function renderLocalIdentity(identity, scope = null) {
    const businessId = text(identity?.id);
    const ambiguous = scope?.idSource === 'ambiguous' || Number(scope?.idsFound || 0) > 1;
    const legacy = Number(scope?.legacyRecords || 0);
    const excluded = Number(scope?.excludedRecords || 0);
    el('migrationLocalBusinessName').textContent = text(identity?.name) || 'No disponible';
    el('migrationLocalBusinessId').textContent = businessId || (ambiguous ? 'Varios identificadores en el archivo' : 'No declarado en el archivo');
    el('migrationSourceCountTitle').textContent = 'Datos declarados en el archivo JSON cargado';
    const warnings = [];
    if (!businessId) warnings.push('El paquete no contiene un identificador estable de origen.');
    if (ambiguous) warnings.push('El paquete declara más de un negocio.');
    if (legacy) warnings.push('Incluye ' + legacy.toLocaleString('es-NI') + ' registros sin identidad verificable.');
    if (excluded) warnings.push('Excluye ' + excluded.toLocaleString('es-NI') + ' registros de otros negocios.');
    const note = el('migrationSourceNote');
    note.classList.toggle('is-legacy', warnings.length > 0);
    note.textContent = warnings.length ? warnings.join(' ') : 'Esta vista resume solo el paquete JSON seleccionado; no accede a los datos locales del navegador.';
  }

  function packageIdentityReview(value) {
    const stored = value?.source?.scope?.identityReview;
    if (isRecord(stored) && isRecord(stored.counts) && isRecord(stored.byModule)) return stored;
    const scope = value?.source?.scope || {};
    const sourceId = text(value?.business?.localBusinessId || value?.business?.local_business_id || scope.localBusinessId).toLowerCase();
    const stores = {
      products: ['products', 'Productos'], clients: ['clients', 'Clientes'], suppliers: ['suppliers', 'Proveedores'],
      sales: ['sales', 'Ventas'], purchases: ['purchases', 'Compras'], cashSessions: ['cashSessions', 'Caja'],
      inventoryMovements: ['inventoryMovements', 'Inventario'], abonos: ['abonos', 'Abonos'], expenses: ['expenses', 'Gastos'],
      auditLogs: ['auditLogs', 'Auditoría'], saleOrders: ['saleOrders', 'Órdenes pendientes'], syncQueue: ['syncQueue', 'Operaciones pendientes']
    };
    const byModule = {};
    const counts = { confirmed: 0, legacy: 0, missingId: 0, sharedId: 0, inferred: 0, otherBusiness: 0, duplicateIds: 0, referenceIssues: 0 };
    const ids = Object.fromEntries(Object.keys(stores).map(name => [name, new Map()]));
    for (const [name, [field]] of Object.entries(stores)) for (const row of (Array.isArray(value?.data?.[field]) ? value.data[field] : [])) {
      if (row?.id === undefined || row?.id === null || String(row.id).trim() === '') continue;
      const key = String(row.id);
      ids[name].set(key, [...(ids[name].get(key) || []), row]);
    }
    const referenceIssues = [];
    for (const [key, [field, label]] of Object.entries(stores)) {
      const rows = Array.isArray(value?.data?.[field]) ? value.data[field] : [];
      const module = byModule[key] = { label, confirmed: 0, legacy: 0, missingId: 0, sharedId: 0, otherBusiness: 0, duplicateIds: 0, referenceIssues: 0, legacyReferences: [], otherBusinessReferences: [], duplicateReferences: [], referenceDetails: [] };
      const seen = new Map();
      rows.forEach((row, index) => {
        const id = text(row?.business_id ?? row?.businessId ?? row?.localBusinessId).toLowerCase();
        const rowRef = text(row?.id ?? row?.numero ?? row?.factura) || `fila ${index + 1}`;
        if (!id || id === '00000000-0000-0000-0000-000000000000') {
          module.legacy++; counts.legacy++;
          if (!id) { module.missingId++; counts.missingId++; } else { module.sharedId++; counts.sharedId++; }
          module.legacyReferences.push({ id: rowRef, identity: id ? 'shared' : 'missing' });
        } else if (sourceId && id === sourceId && scope.idSource === 'config') { module.confirmed++; counts.confirmed++; }
        else if (sourceId && id === sourceId) { module.legacy++; counts.legacy++; counts.inferred++; module.legacyReferences.push({ id: rowRef, identity: 'inferred' }); }
        else { module.otherBusiness++; counts.otherBusiness++; module.otherBusinessReferences.push({ id: rowRef, businessId: id }); }
        const localId = row?.id === undefined || row?.id === null ? '' : String(row.id);
        if (localId) {
          const duplicate = seen.get(localId) || 0; seen.set(localId, duplicate + 1);
          if (duplicate) { module.duplicateIds++; counts.duplicateIds++; module.duplicateReferences.push({ id: localId, duplicate: duplicate + 1 }); }
        }
      });
    }
    const addReference = (moduleName, row, fieldName, targetName, rawValue) => {
      if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') return;
      const targetRows = ids[targetName]?.get(String(rawValue)) || [];
      let issue = '';
      if (!targetRows.length) issue = 'MISSING_REFERENCE';
      else {
        const sourceId = text(row?.business_id ?? row?.businessId ?? row?.localBusinessId).toLowerCase();
        const targetIds = new Set(targetRows.map(item => text(item?.business_id ?? item?.businessId ?? item?.localBusinessId).toLowerCase()).filter(id => id && id !== '00000000-0000-0000-0000-000000000000'));
        if (sourceId && sourceId !== '00000000-0000-0000-0000-000000000000' && targetIds.size && !targetIds.has(sourceId)) issue = 'CROSS_BUSINESS_REFERENCE';
      }
      if (!issue) return;
      const record = text(row?.id ?? row?.numero ?? row?.factura) || 'fila sin identificador';
      const item = { module: moduleName, record, field: fieldName, target: stores[targetName][1], value: String(rawValue), issue };
      referenceIssues.push(item);
      const module = byModule[moduleName];
      module.referenceIssues++;
      if (module.referenceDetails.length < 2000) module.referenceDetails.push(item);
    };
    const checkItems = (moduleName, row) => (Array.isArray(row?.items) ? row.items : []).forEach((item, index) => addReference(moduleName, row, `items[${index}].productId`, 'products', item?.productId ?? item?.productoId ?? item?.producto_id ?? item?.id));
    for (const row of value?.data?.sales || []) { addReference('sales', row, 'clienteId', 'clients', row?.clienteId ?? row?.clientId); checkItems('sales', row); }
    for (const row of value?.data?.purchases || []) { addReference('purchases', row, 'proveedorId', 'suppliers', row?.proveedorId ?? row?.supplierId); checkItems('purchases', row); }
    for (const row of value?.data?.inventoryMovements || []) addReference('inventoryMovements', row, 'producto_id', 'products', row?.producto_id ?? row?.productoId ?? row?.productId);
    for (const row of value?.data?.abonos || []) {
      const supplier = norm(row?.tipo) === 'proveedor';
      addReference('abonos', row, 'referenciaId', supplier ? 'suppliers' : 'clients', row?.referenciaId ?? row?.supplierId ?? row?.clientId);
      addReference('abonos', row, 'facturaId', supplier ? 'purchases' : 'sales', row?.facturaId ?? row?.invoiceId);
      addReference('abonos', row, 'cajaSessionId', 'cashSessions', row?.cajaSessionId ?? row?.cashSessionId);
    }
    for (const row of value?.data?.expenses || []) addReference('expenses', row, 'sessionId', 'cashSessions', row?.sessionId ?? row?.cajaSessionId);
    for (const row of value?.data?.saleOrders || []) { addReference('saleOrders', row, 'cajaSessionId', 'cashSessions', row?.cajaSessionId ?? row?.cashSessionId); checkItems('saleOrders', row); }
    for (const row of value?.data?.cashSessions || []) for (const [index, movement] of (row?.movimientos || []).entries()) {
      addReference('cashSessions', row, `movimientos[${index}].saleId`, 'sales', movement?.saleId);
      addReference('cashSessions', row, `movimientos[${index}].purchaseId`, 'purchases', movement?.purchaseId);
    }
    counts.referenceIssues = referenceIssues.length;
    const knownLegacy = Number(scope.legacyRecords || 0);
    if (counts.legacy < knownLegacy) counts.legacy = knownLegacy;
    return { identityStatus: scope.idSource === 'config' ? 'PERSISTENT' : scope.idSource === 'inferred' ? 'INFERRED' : 'MISSING', counts, byModule, referenceIssues: referenceIssues.slice(0, 2000), referenceIssuesTruncated: referenceIssues.length > 2000, otherBusinessRows: counts.otherBusiness };
  }

  function renderPackageIdentityReview(review) {
    const container = el('migrationIdentityReview');
    if (!container) return;
    container.replaceChildren();
    const counts = review.counts || {};
    const sharedIdCount = Number(counts.sharedId || 0);
    const otherLegacyCount = Math.max(0, Number(counts.legacy || 0) - sharedIdCount);
    const summary = node('p', '', packageCountLabel(counts.confirmed, 'registro', 'registros') + ' con identidad estable; ' +
      packageCountLabel(sharedIdCount, 'registro con el identificador antiguo compartido', 'registros con el identificador antiguo compartido') + '; ' +
      packageCountLabel(otherLegacyCount, 'registro sin identidad confirmada', 'registros sin identidad confirmada') + '; ' +
      packageCountLabel(counts.otherBusiness, 'registro asociado a otra identidad', 'registros asociados a otra identidad') + '; ' +
      packageCountLabel(counts.duplicateIds, 'referencia repetida', 'referencias repetidas') + '; ' +
      packageCountLabel(counts.referenceIssues, 'relación no verificable', 'relaciones no verificables') + '.');
    container.append(summary);
    if (sharedIdCount) {
      container.append(node('p', 'migration-identity-batch-note', 'La confirmación administrativa cubre en conjunto los registros con el identificador compartido para este archivo. No hace falta revisarlos uno por uno; los registros duplicados, las relaciones rotas y las identidades diferentes requieren revisión aparte.'));
    }
    const modules = Object.entries(review.byModule || {}).filter(([, item]) =>
      Math.max(0, Number(item.legacy || 0) - Number(item.sharedId || 0)) ||
      item.otherBusiness || item.duplicateIds || item.referenceIssues
    );
    for (const [, item] of modules) {
      const itemSharedIdCount = Number(item.sharedId || (item.legacyReferences || []).filter(row => row.identity === 'shared').length);
      const itemOtherLegacyCount = Math.max(0, Number(item.legacy || 0) - itemSharedIdCount);
      const details = node('details');
      details.append(node('summary', '', item.label + ': ' + packageCountLabel(itemSharedIdCount, 'registro con identificador compartido', 'registros con identificador compartido') + ', ' +
        packageCountLabel(itemOtherLegacyCount, 'registro sin identidad confirmada', 'registros sin identidad confirmada') + ', ' +
        packageCountLabel(item.otherBusiness, 'registro de otra identidad', 'registros de otra identidad') + ', ' +
        packageCountLabel(item.duplicateIds, 'referencia repetida', 'referencias repetidas') + ', ' +
        packageCountLabel(item.referenceIssues, 'relación no verificable', 'relaciones no verificables')));
      const list = node('ul');
      for (const row of item.legacyReferences || []) {
        if (row.identity === 'shared') continue;
        list.append(node('li', '', 'Referencia ' + row.id + ' · ' + (row.identity === 'inferred' ? 'ID hallado en registros, no guardado en configuración' : 'sin ID de negocio')));
      }
      for (const row of item.otherBusinessReferences || []) list.append(node('li', '', `Referencia ${row.id} · otra identidad: ${row.businessId}`));
      for (const row of item.duplicateReferences || []) list.append(node('li', '', `Referencia repetida ${row.id} · aparición ${row.duplicate}`));
      for (const issue of item.referenceDetails || []) list.append(node('li', '', `Registro ${issue.record}: ${issue.field} → ${issue.target}, referencia ${issue.value} (${issue.issue === 'CROSS_BUSINESS_REFERENCE' ? 'otra identidad' : 'no encontrada'}).`));
      details.append(list); container.append(details);
    }
    for (const issue of review.referenceIssues || []) container.append(node('p', '', `${issue.module}: referencia ${issue.record}, campo ${issue.field} → ${issue.target} ${issue.value} (${issue.issue === 'CROSS_BUSINESS_REFERENCE' ? 'otra identidad' : 'no encontrada'}).`));
    if (review.referenceIssuesTruncated) container.append(node('p', '', 'La lista supera el límite de detalle; el conteo incluye todas las relaciones.'));
    if (review.otherBusinessRows) container.append(node('p', '', 'Los registros asociados a otra identidad no se incluyen en los datos del paquete. Deben revisarse por separado.'));
    container.classList.toggle('hidden', Number(counts.legacy || 0) + Number(counts.sharedId || 0) + Number(counts.otherBusiness || 0) + Number(counts.duplicateIds || 0) + Number(counts.referenceIssues || 0) === 0);
  }

  function renderOriginCounts(counts) {
    el('migrationOriginCounts').replaceChildren(
      card('Productos', counts.products),
      card('Clientes', counts.clients),
      card('Ventas', counts.sales)
    );
  }

  function hasItems(row) { return Array.isArray(row.items) && row.items.length > 0; }

  function receivables(sales, clients, abonos) {
    const payments = abonos.filter(item => (item.tipo === 'cliente' || item.tipo === 'factura') && !item.anulado);
    const credit = sales.filter(sale => sale.metodo === 'Crédito' && !sale.anulada);
    const byClient = new Map();
    for (const sale of credit) {
      const client = clients.find(item => String(item.id) === String(sale.clienteId)) || clients.find(item => !sale.clienteId && item.name === sale.cliente);
      const key = client ? String(client.id) : 'sin-cliente:' + String(sale.id);
      if (!byClient.has(key)) byClient.set(key, { sales: [], client });
      byClient.get(key).sales.push(sale);
    }
    let invoices = 0, total = 0;
    for (const { sales: list, client } of byClient.values()) {
      list.sort((a, b) => (a.fechaTS || a.id) - (b.fechaTS || b.id));
      const paid = {};
      list.forEach(sale => { paid[String(sale.id)] = 0; });
      const own = payments.filter(item => client ? String(item.referenciaId) === String(client.id) : list.some(sale => String(item.facturaId) === String(sale.id)));
      own.filter(item => item.facturaId).forEach(item => { const id = String(item.facturaId); if (paid[id] !== undefined) paid[id] = r2(paid[id] + (Number(item.monto) || 0)); });
      let rest = r2(own.filter(item => !item.facturaId).reduce((sum, item) => sum + (Number(item.monto) || 0), 0));
      for (const sale of list) {
        if (rest <= 0) break;
        const pending = r2(Math.max(0, (Number(sale.total) || 0) - paid[String(sale.id)]));
        const applied = Math.min(pending, rest);
        paid[String(sale.id)] = r2(paid[String(sale.id)] + applied); rest = r2(rest - applied);
      }
      for (const sale of list) {
        const balance = r2(Math.max(0, (Number(sale.total) || 0) - paid[String(sale.id)]));
        if (balance > 0) { invoices++; total = r2(total + balance); }
      }
    }
    return { invoices, total };
  }

  function payables(purchases, abonos) {
    let invoices = 0, total = 0;
    for (const purchase of purchases.filter(item => item.tipo === 'credito' && !item.anulada)) {
      const paid = abonos.filter(item => item.tipo === 'proveedor' && !item.anulado && String(item.facturaId) === String(purchase.id)).reduce((sum, item) => sum + (Number(item.monto) || 0), 0);
      const balance = r2(Math.max(0, (Number(purchase.total) || 0) - paid));
      if (balance > 0) { invoices++; total = r2(total + balance); }
    }
    return { invoices, total };
  }

  function categoryGroups(products) {
    const groups = new Map();
    for (const product of products) {
      const name = text(product.category);
      if (!name) continue;
      const key = norm(name);
      if (!groups.has(key)) groups.set(key, { names: new Map(), count: 0 });
      const group = groups.get(key);
      group.names.set(name, (group.names.get(name) || 0) + 1); group.count++;
    }
    return groups;
  }

  function buildReport(tables) {
    const products = tables.products.filter(item => !item.deleted);
    const clients = tables.clients, suppliers = tables.suppliers;
    const sales = tables.sales, purchases = tables.purchases, abonos = tables.abonos;
    const codes = new Map();
    let withoutCode = 0;
    for (const product of products) {
      const code = norm(product.barcode);
      if (!code) { withoutCode++; continue; }
      codes.set(code, (codes.get(code) || 0) + 1);
    }
    const duplicated = [...codes.values()].filter(count => count > 1);
    const cxc = receivables(sales, clients, abonos), cxp = payables(purchases, abonos);
    return {
      counts: {
        products: products.length, clients: clients.length, suppliers: suppliers.length, sales: sales.length, purchases: purchases.length,
        cash: tables.cajaSessions.length, movements: tables.inventory_movements.length, cxc: cxc.invoices, cxp: cxp.invoices
      },
      cxc, cxp,
      warnings: {
        withoutCode, duplicatedCodes: duplicated.length, duplicatedProducts: duplicated.reduce((sum, count) => sum + count, 0),
        withoutCategory: products.filter(item => !text(item.category)).length,
        clientsNoName: clients.filter(item => !text(item.name)).length,
        suppliersNoName: suppliers.filter(item => !text(item.name)).length,
        salesNoDetail: sales.filter(item => !hasItems(item)).length,
        purchasesNoDetail: purchases.filter(item => !hasItems(item)).length
      },
      products
    };
  }

  function effectiveName(raw) {
    let name = text(raw);
    if (!name) return sim.general ? 'General' : '';
    for (let step = 0; step < 20 && sim.map[name] !== undefined && sim.map[name] !== name; step++) name = sim.map[name];
    return name;
  }

  function simulatedCategories() {
    const rows = new Map();
    for (const product of report.products) {
      const name = effectiveName(product.category);
      if (!name) continue;
      const row = rows.get(name) || { name, count: 0, origins: new Set() };
      row.count++; if (text(product.category) && text(product.category) !== name) row.origins.add(text(product.category));
      rows.set(name, row);
    }
    for (const name of sim.added) if (!rows.has(name)) rows.set(name, { name, count: 0, origins: new Set() });
    return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }

  function simNotice(message) { const box = el('migrationSimNotice'); box.textContent = message; box.classList.toggle('hidden', !message); }

  function fillSelect(select, names, placeholder) {
    const previous = select.value;
    select.replaceChildren(new Option(placeholder, ''), ...names.map(name => new Option(name, name)));
    select.value = names.includes(previous) ? previous : '';
  }

  function renderCategories() {
    const rows = simulatedCategories();
    const names = rows.map(row => row.name);
    const body = el('migrationCategoriesBody'); body.replaceChildren();
    if (!rows.length) { const tr = node('tr'); const td = node('td', '', 'No hay categorías en los productos locales.'); td.colSpan = 3; tr.append(td); body.append(tr); }
    for (const row of rows) {
      const tr = node('tr');
      tr.append(node('td', '', row.name), node('td', '', String(row.count)), node('td', '', row.origins.size ? 'Proviene de: ' + [...row.origins].join(', ') : (sim.added.includes(row.name) ? 'Categoría nueva simulada' : (row.name === 'General' && sim.general ? 'Productos sin categoría (simulado)' : 'Original'))));
      body.append(tr);
    }
    fillSelect(el('migrationRenameFrom'), names, 'Categoría a renombrar');
    fillSelect(el('migrationMergeFrom'), names, 'Fusionar esta categoría');
    fillSelect(el('migrationMergeTo'), names, 'dentro de esta');
    const groups = [...categoryGroups(report.products).values()].filter(group => group.names.size > 1);
    const dupBox = el('migrationDuplicates'); dupBox.replaceChildren();
    const pending = groups.filter(group => new Set([...group.names.keys()].map(effectiveName)).size > 1);
    if (!pending.length) dupBox.append(node('p', 'system-admin-help', 'No se detectaron categorías duplicadas por mayúsculas, acentos o espacios.'));
    for (const group of pending) {
      const ordered = [...group.names.entries()].sort((a, b) => b[1] - a[1]);
      const target = ordered[0][0];
      const button = node('button', 'btn btn-secondary btn-sm', 'Fusionar en «' + target + '»');
      button.type = 'button';
      button.addEventListener('click', () => { for (const [name] of ordered) if (name !== target) sim.map[name] = target; simNotice('Simulado: ' + ordered.map(item => '«' + item[0] + '»').join(', ') + ' se fusionarían en «' + target + '». No se guardó nada.'); renderCategories(); });
      const line = node('div', 'migration-dup-row'); line.append(node('span', '', 'Duplicadas: ' + ordered.map(item => item[0] + ' (' + item[1] + ')').join(' / ')), button); dupBox.append(line);
    }
    const noCategory = report.products.filter(item => !text(item.category));
    el('migrationNoCategory').textContent = sim.general ? 'Productos sin categoría: 0 (simulado: ' + noCategory.length + ' pasarían a «General»).' : 'Productos sin categoría: ' + noCategory.length + '.';
    el('migrationAssignGeneralBtn').disabled = sim.general || !noCategory.length;
  }

  function card(label, value, extra) {
    const item = node('article'); item.append(node('span', '', label), node('strong', '', String(value)));
    if (extra) item.append(node('small', '', extra));
    return item;
  }

  function renderReport() {
    const type = el('migrationType').value;
    const full = type === 'full';
    const c = report.counts;
    renderOriginCounts(c);
    const counts = el('migrationCounts'); counts.replaceChildren(
      card('Proveedores', c.suppliers),
      card('Movimientos de inventario', c.movements, full ? '' : 'Solo se migran en la completa'),
      card('Compras', c.purchases, full ? '' : 'Solo se migran en la completa'),
      card('Sesiones de caja', c.cash, full ? '' : 'Solo se migran en la completa'),
      card('Cuentas por cobrar', c.cxc, 'Saldo C$ ' + money(report.cxc.total)), card('Cuentas por pagar', c.cxp, 'Saldo C$ ' + money(report.cxp.total)));
    const w = report.warnings;
    const items = [
      ['Productos sin código', w.withoutCode], ['Productos con código duplicado', w.duplicatedProducts, w.duplicatedCodes + ' código(s) repetido(s)'],
      ['Productos sin categoría', w.withoutCategory], ['Clientes sin nombre', w.clientsNoName], ['Proveedores sin nombre', w.suppliersNoName],
      ['Ventas sin detalle', w.salesNoDetail], ['Compras sin detalle', w.purchasesNoDetail],
      ['Saldos pendientes por cobrar', report.cxc.invoices, 'C$ ' + money(report.cxc.total)], ['Saldos pendientes por pagar', report.cxp.invoices, 'C$ ' + money(report.cxp.total)]
    ];
    const list = el('migrationWarnings'); list.replaceChildren();
    for (const [label, count, extra] of items) {
      const li = node('li', count > 0 ? 'migration-warn' : 'migration-ok');
      li.append(node('span', '', label), node('strong', '', count > 0 ? String(count) + (extra ? ' · ' + extra : '') : 'Sin problemas'));
      list.append(li);
    }
    el('migrationScope').textContent = full
      ? 'Migración completa: productos, inventario, clientes, proveedores, categorías, ventas, compras, caja, cuentas por cobrar, cuentas por pagar y kardex/historial.'
      : 'Migración básica: productos, inventario, clientes, proveedores y categorías.';
    renderCategories();
  }

  function destination() { return businesses.find(item => String(item.id) === el('migrationBusiness').value); }

  function isMigrationTarget(target) { return target?.status === 'INACTIVE' && target?.migrationState === 'PENDING'; }

  function renderBusinessOptions(selected = el('migrationBusiness').value) {
    const select = el('migrationBusiness');
    const targets = businesses.filter(isMigrationTarget);
    select.replaceChildren(new Option('Selecciona un destino bloqueado', ''), ...targets.map(item => {
      const suffix = ' · pendiente de importación (bloqueado)';
      return new Option(item.name + ' (#' + item.id + ')' + suffix, item.id);
    }));
    select.value = targets.some(item => String(item.id) === String(selected)) ? String(selected) : '';
  }

  function renderExistingBusinessOptions(selected = el('migrationExistingBusiness').value) {
    const select = el('migrationExistingBusiness');
    const available = businesses.filter(item => String(item.id) !== '1' && item.migrationState === 'NOT_REQUIRED' && ['ACTIVE', 'INACTIVE'].includes(item.status));
    select.replaceChildren(new Option('Selecciona un negocio existente', ''), ...available.map(item =>
      new Option(item.name + ' (#' + item.id + ')' + (item.status === 'ACTIVE' ? ' · activo' : ' · inactivo'), String(item.id))
    ));
    select.value = available.some(item => String(item.id) === String(selected)) ? String(selected) : '';
    el('migrationExistingInspectBtn').disabled = !inspectExistingMigrationTargetRequest || !select.value || existingTargetBusy;
  }

  function clearExistingTargetReview(clearStatus = true) {
    existingTargetRequestToken++;
    existingTargetInspection = null;
    el('migrationExistingReview').classList.add('hidden');
    el('migrationExistingReviewTitle').textContent = '';
    el('migrationExistingPreserved').textContent = '';
    el('migrationExistingBlockers').replaceChildren();
    el('migrationExistingWarnings').replaceChildren();
    el('migrationExistingConfirm').checked = false;
    el('migrationExistingConfirm').disabled = true;
    el('migrationExistingPrepareBtn').disabled = true;
    if (clearStatus) el('migrationExistingStatus').textContent = '';
    renderExistingBusinessOptions(el('migrationExistingBusiness').value);
  }

  function renderExistingTargetMessages(list, messages) {
    list.replaceChildren(...messages.map(message => node('li', '', message)));
    list.classList.toggle('hidden', messages.length === 0);
  }

  function updateExistingPrepareButton() {
    const confirmed = el('migrationExistingConfirm').checked;
    el('migrationExistingPrepareBtn').disabled = existingTargetBusy || !prepareExistingMigrationTargetRequest || !existingTargetInspection?.eligible || !confirmed;
    el('migrationExistingInspectBtn').disabled = existingTargetBusy || !inspectExistingMigrationTargetRequest || !el('migrationExistingBusiness').value;
    el('migrationExistingBusiness').disabled = existingTargetBusy;
  }

  function preservedSummary(value) {
    const preserved = value?.preserved || {};
    const parts = [];
    if (preserved.users) parts.push(`${preserved.users} usuario(s)`);
    if (preserved.settings) parts.push('la configuración');
    if (preserved.businessPhone || preserved.businessAddress) parts.push('los datos de contacto');
    if (preserved.auditLogs) parts.push('el historial de auditoría');
    if (preserved.subscriptions) parts.push('los datos del plan y sus pagos');
    const retained = parts.length ? ' Se conservarán ' + parts.join(', ') + ' sin cambios.' : ' No se encontraron usuarios ni ajustes previos que deban conservarse.';
    const accessChanges = value?.accessChanges || {};
    const sessions = Number(accessChanges.activeSessions || 0);
    const sessionsToRevoke = Number(accessChanges.sessionsToRevoke || 0);
    const authorizations = Number(accessChanges.authorizationsToRemove || 0);
    const access = sessionsToRevoke || authorizations
      ? ` Se revocarán ${sessionsToRevoke} sesión(es) (${sessions} activa(s)) y se invalidarán ${authorizations} permisos de acceso.`
      : ' El acceso quedará bloqueado durante la preparación.';
    return 'Esta revisión es de solo lectura.' + retained + access;
  }

  async function inspectExistingMigrationTarget() {
    const businessId = el('migrationExistingBusiness').value;
    const status = el('migrationExistingStatus');
    if (!canAccess() || !inspectExistingMigrationTargetRequest || !businessId || existingTargetBusy) return;
    const token = ++existingTargetRequestToken;
    existingTargetInspection = null;
    existingTargetBusy = true;
    el('migrationExistingReview').classList.add('hidden');
    status.textContent = 'Revisando si el negocio puede usarse como destino…';
    updateExistingPrepareButton();
    try {
      const result = await inspectExistingMigrationTargetRequest(businessId);
      if (token !== existingTargetRequestToken || el('migrationExistingBusiness').value !== businessId) return;
      existingTargetInspection = result;
      el('migrationExistingReview').classList.remove('hidden');
      el('migrationExistingReviewTitle').textContent = result.eligible ? 'El negocio puede prepararse como destino.' : 'Este negocio no puede usarse como destino todavía.';
      el('migrationExistingPreserved').textContent = preservedSummary(result);
      renderExistingTargetMessages(el('migrationExistingBlockers'), result.blockers);
      renderExistingTargetMessages(el('migrationExistingWarnings'), result.warnings);
      el('migrationExistingConfirm').checked = false;
      el('migrationExistingConfirm').disabled = !result.eligible;
      status.textContent = result.eligible ? 'La revisión no cambió los datos ni el estado del negocio.' : 'No se modificó ningún dato. Resuelve los elementos señalados antes de intentarlo de nuevo.';
    } catch (failure) {
      if (token === existingTargetRequestToken) status.textContent = failure?.message || 'No se pudo revisar el negocio. No se hicieron cambios.';
    } finally {
      if (token === existingTargetRequestToken) {
        existingTargetBusy = false;
        updateExistingPrepareButton();
      }
    }
  }

  async function prepareExistingMigrationTarget() {
    const businessId = el('migrationExistingBusiness').value;
    const status = el('migrationExistingStatus');
    if (!canAccess() || !prepareExistingMigrationTargetRequest || !existingTargetInspection?.eligible || !el('migrationExistingConfirm').checked || existingTargetBusy) return;
    existingTargetBusy = true;
    updateExistingPrepareButton();
    status.textContent = 'Reservando el negocio y bloqueando su acceso comercial…';
    try {
      const result = await prepareExistingMigrationTargetRequest(businessId, true);
      if (String(result?.business?.id) !== businessId || result.business.status !== 'INACTIVE' || result.business.migrationState !== 'PENDING') throw new Error('La respuesta no confirmó el negocio seleccionado. No continúes con la importación.');
      businesses = [...businesses.filter(item => String(item.id) !== businessId), result.business];
      renderBusinessOptions(businessId);
      renderExistingBusinessOptions('');
      el('migrationExistingReviewTitle').textContent = 'Negocio reservado para la migración.';
      el('migrationExistingPreserved').textContent = preservedSummary(result) + ' El acceso comercial está bloqueado hasta completar y conciliar la migración.';
      el('migrationExistingConfirm').checked = false;
      el('migrationExistingConfirm').disabled = true;
      existingTargetInspection = null;
      status.textContent = 'El negocio quedó bloqueado como destino. La importación y conciliación todavía están pendientes.';
      void updateArchivePreview();
      renderBasicMigrationButton();
      renderCreditMigrationButton();
      void updateInventoryPreview();
      void updateSalesPreview();
      void updatePurchasesPreview();
      void updateCreditPreview();
    } catch (failure) {
      status.textContent = failure?.message || 'No se pudo preparar el negocio. No se importó ni se sobrescribió información.';
    } finally {
      existingTargetBusy = false;
      updateExistingPrepareButton();
    }
  }

  async function createMigrationTarget() {
    const input = el('migrationTargetName'), button = el('migrationTargetCreateBtn'), status = el('migrationTargetStatus');
    const name = text(input.value);
    const planCode = el('migrationTargetPlan').value;
    if (!canAccess() || !createMigrationTargetRequest || button.disabled) return;
    if (!['CONECTADO_BASICO', 'CONECTADO_ESTANDAR', 'CONECTADO_PREMIUM'].includes(planCode)) { status.textContent = 'Selecciona el plan conectado del negocio.'; el('migrationTargetPlan').focus(); return; }
    if (!name || name.length > 160) { status.textContent = 'Escribe un nombre válido para el negocio.'; input.focus(); return; }
    button.disabled = true;
    status.textContent = 'Creando el negocio bloqueado para la importación…';
    try {
      const created = await createMigrationTargetRequest(name, planCode);
      businesses = [...businesses.filter(item => String(item.id) !== String(created.id)), created];
      input.value = '';
      el('migrationTargetPlan').value = '';
      renderBusinessOptions(created.id);
      status.textContent = 'Negocio creado. Permanecerá bloqueado hasta completar y conciliar la migración.';
      void updateArchivePreview();
      renderBasicMigrationButton();
      renderCreditMigrationButton();
      void updateInventoryPreview();
      void updateSalesPreview();
      void updatePurchasesPreview();
      void updateCreditPreview();
    } catch (failure) {
      status.textContent = failure?.message || 'No se pudo crear el destino. No se importó información.';
    } finally { button.disabled = false; }
  }

  function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

  function packageCount(value) {
    const count = Number(value);
    return Number.isFinite(count) && count >= 0 ? count.toLocaleString('es-NI') : '0';
  }

  function packageCountLabel(value, singular, plural) {
    return `${packageCount(value)} ${Number(value) === 1 ? singular : plural}`;
  }

  function packageDate(value) {
    const date = new Date(value);
    return value && Number.isFinite(date.getTime()) ? date.toLocaleString('es-NI') : 'No disponible';
  }

  function renderPackageWarnings(warnings) {
    const list = el('migrationPackageWarnings');
    list.replaceChildren();
    let warningCount = 0;
    for (const warning of warnings) {
      if (!isRecord(warning)) {
        warningCount++;
        list.append(node('li', 'migration-warn', String(warning)));
        continue;
      }
      const count = Number(warning.count);
      const hasCount = Number.isFinite(count) && count >= 0;
      const hasProblems = !hasCount || count > 0;
      const row = node('li', hasProblems ? 'migration-warn' : 'migration-ok');
      const heading = node('span');
      const label = text(warning.label || warning.code) || 'Advertencia';
      heading.textContent = label + (hasProblems ? ' · ' + (hasCount ? packageCount(count) : 'Revisar') : ' · Sin problemas');
      row.append(heading);
      if (hasProblems) {
        warningCount++;
        if (text(warning.detail)) row.append(node('small', '', text(warning.detail)));
      }
      list.append(row);
    }
    const summary = el('migrationPackageWarningSummary');
    summary.classList.toggle('has-warnings', warningCount > 0);
    summary.classList.toggle('no-warnings', warningCount === 0);
    summary.textContent = warningCount
      ? 'Paquete válido. Se encontraron ' + warningCount.toLocaleString('es-NI') + ' advertencia' + (warningCount === 1 ? '' : 's') + ' para revisar.'
      : 'Paquete válido. No se encontraron advertencias.';
  }

  function showPackage(value) {
    const summary = value.summary;
    const dataPackage = value.data;
    const packageScope = value.source?.scope || {};
    localScope = packageScope;
    localIdentity = {
      name: text(value.business?.name),
      id: text(value.business?.localBusinessId || value.business?.local_business_id || packageScope.localBusinessId),
      idSource: packageScope.idSource,
      idsFound: packageScope.idsFound
    };
    renderLocalIdentity(localIdentity, localScope);
    const counts = [
      ['Productos', summary.products], ['Clientes', summary.clients], ['Proveedores', summary.suppliers],
      ['Ventas', summary.sales], ['Compras', summary.purchases], ['Caja', summary.cashSessions],
      ['Inventario', summary.inventoryMovements], ['Abonos', summary.abonos],
      ['Gastos', summary.expenses], ['Auditoría', summary.auditLogs], ['Órdenes pendientes', summary.saleOrders], ['Cola local', summary.syncQueue],
      ['Categorías', Array.isArray(dataPackage.categories) ? dataPackage.categories.length : 0]
    ];
    el('migrationPackageBusiness').textContent = text(value.business.name) || 'No disponible';
    el('migrationPackageDate').textContent = packageDate(value.exportedAt);
    el('migrationPackageCounts').replaceChildren(...counts.map(([label, count]) => card(label, packageCount(count))));
    renderPackageWarnings(Array.isArray(value.warnings) ? value.warnings : []);
    renderPackageIdentityReview(packageIdentityReview(value));
    el('migrationPackageReview').classList.remove('hidden');
    packageValue = value;
    creditPreview = null;
    el('migrationCreditResult').classList.add('hidden');
    const products = value.data.products.filter(item => isRecord(item) && item.deleted !== true);
    const categories = new Set(products.map(item => norm(item.category ?? item.categoria) || norm('General')));
    el('migrationBasicProducts').textContent = packageCount(products.length);
    el('migrationBasicClients').textContent = packageCount(value.data.clients.length);
    el('migrationBasicSuppliers').textContent = packageCount(value.data.suppliers.length);
    el('migrationBasicCategories').textContent = packageCount(categories.size);
    el('migrationBasicSummary').classList.toggle('hidden', !migrateBasicRequest);
    el('migrationBasicResult').classList.add('hidden');
    el('migrationBasicStatus').textContent = '';
    renderBasicMigrationButton();
    el('migrationInventoryStatus').textContent = '';
    el('migrationInventoryResult').classList.add('hidden');
    void updateInventoryPreview();
    el('migrationSalesStatus').textContent = '';
    el('migrationSalesResult').classList.add('hidden');
    void updateSalesPreview();
    el('migrationPurchasesStatus').textContent = '';
    el('migrationPurchasesResult').classList.add('hidden');
    void updatePurchasesPreview();
    void updateCreditPreview();
    void updateArchivePreview();
  }

  function renderArchiveStageNotes(startBlockers = [], reconciliationNotes = []) {
    const startList = el('migrationArchiveBlockers');
    const notesList = el('migrationArchiveReconciliationList');
    if (!startList || !notesList) return;
    startList.replaceChildren(...startBlockers.map(message => {
      const item = document.createElement('li');
      item.className = 'migration-error';
      item.textContent = message;
      return item;
    }));
    notesList.replaceChildren(...reconciliationNotes.map(message => {
      const item = document.createElement('li');
      item.className = 'migration-info';
      item.textContent = message;
      return item;
    }));
    el('migrationArchiveStartGate')?.classList.toggle('hidden', startBlockers.length === 0);
    el('migrationArchiveReconciliationNotes')?.classList.toggle('hidden', reconciliationNotes.length === 0);
  }

  function updateArchiveApplyButton() {
    const target = destination();
    const confirm = el('migrationArchiveConfirm');
    const targetMatchesPreview = Boolean(archivePreview && target && String(target.id) === String(archivePreview.targetBusinessId));
    const callbacksReady = Boolean(previewArchiveRequest && archiveMigrationRequest && projectMigrationOperationsRequest);
    const checks = [
      { label: 'Sesión de administrador general', ready: Boolean(canAccess()), missing: 'Inicia sesión en el panel de administración general.' },
      { label: 'Archivo JSON cargado', ready: Boolean(packageValue), missing: 'Selecciona el archivo JSON del negocio.' },
      { label: 'Destino preparado', ready: isMigrationTarget(target), missing: 'Selecciona un destino preparado, inactivo y pendiente de migración.' },
      { label: 'Archivo validado para ese destino', ready: targetMatchesPreview, missing: target ? 'Espera a que termine la validación del archivo para este destino.' : 'Selecciona un destino para validar el archivo.' },
      { label: 'Sin bloqueos previos a la importación', ready: archivePreview?.eligibleToArchive === true, missing: 'Resuelve el bloqueo indicado en “No se puede iniciar todavía”.' },
      { label: 'Confirmación de procedencia', ready: confirm?.checked === true, missing: 'Marca la confirmación de procedencia del archivo.' },
      { label: 'Importación y conciliación disponibles', ready: callbacksReady, missing: 'La validación o el servicio de importación todavía no está disponible.' },
      { label: 'Sin otra importación en curso', ready: !archiveBusy, missing: 'Espera a que termine la importación en curso.' }
    ];
    const readiness = el('migrationArchiveReadiness');
    if (readiness) {
      const heading = node('strong', '', checks.every(check => check.ready) ? 'Todo listo para iniciar «Migrar datos».' : 'Para habilitar «Migrar datos», completa estos pasos:');
      const list = document.createElement('ul');
      for (const check of checks) {
        const item = node('li', check.ready ? 'migration-ok' : 'migration-warn');
        item.dataset.state = check.ready ? 'ready' : 'missing';
        item.append(node('span', '', check.label), node('strong', '', check.ready ? 'Listo' : check.missing));
        list.append(item);
      }
      readiness.replaceChildren(heading, list);
      readiness.classList.toggle('hidden', !packageValue || !canAccess());
    }
    const ready = checks.every(check => check.ready);
    el('migrationArchiveApplyBtn').disabled = !ready;
    return { ready, checks };
  }

  function updateArchiveStageMessages(result) {
    const startBlockers = Array.isArray(result?.startBlockers)
      ? result.startBlockers
      : (result?.eligibleToArchive === false ? (result?.blockers || []) : []);
    const reconciliationNotes = Array.isArray(result?.reconciliationNotes)
      ? result.reconciliationNotes
      : (result?.blockers || []).filter(message => !startBlockers.includes(message));
    renderArchiveStageNotes(startBlockers, reconciliationNotes);
  }

  function setFullMigrationStage(stage, state) {
    const item = el('migrationFullStages')?.querySelector(`[data-stage="${stage}"]`);
    if (item) item.dataset.state = state;
  }

  function resetFullMigrationStages() {
    for (const stage of ['archive', 'projection', 'reconciliation']) setFullMigrationStage(stage, 'waiting');
    el('migrationFullStages')?.classList.add('hidden');
    el('migrationFullDifferences')?.classList.add('hidden');
    el('migrationFullDifferenceList')?.replaceChildren();
  }

  function renderFullMigrationOutcome(result) {
    const reconciliation = result?.reconciliation;
    const differences = Array.isArray(reconciliation?.differences) ? reconciliation.differences : [];
    const blockers = Array.isArray(reconciliation?.blockers) ? reconciliation.blockers : [];
    const missingLabels = {
      expenses: 'gastos', auditLogs: 'auditoría', saleOrders: 'órdenes pendientes',
      syncQueue: 'operaciones pendientes guardadas en el POS local'
    };
    const missingStores = (archivePreview?.missingStores || []).map(store => missingLabels[store] || store);
    const pendingMessages = blockers.filter(message => !/^El archivo versi[oó]n 1 no incluye /.test(String(message)));
    if (archivePreview?.packageVersion === 1 && missingStores.length) {
      pendingMessages.unshift('El archivo no contiene ' + missingStores.join(', ') + '. No se consideran vacíos; se conservaron y procesaron los datos disponibles, y el negocio seguirá bloqueado hasta verificar esta información.');
    }
    const moduleNames = {
      sales: 'Ventas', purchases: 'Compras', customerPayments: 'Abonos de clientes', supplierPayments: 'Pagos a proveedores',
      cashSessions: 'Caja', cashMovements: 'Movimientos de caja', expenses: 'Gastos', inventoryMovements: 'Inventario',
      orders: 'Órdenes pendientes', auditLogs: 'Auditoría', products: 'Productos', clients: 'Clientes', suppliers: 'Proveedores'
    };
    const byModule = new Map();
    for (const difference of differences) {
      const key = String(difference?.module || 'other');
      if (!byModule.has(key)) byModule.set(key, { count: 0, examples: [] });
      const group = byModule.get(key);
      group.count++;
      if (group.examples.length >= 2) continue;
      const field = difference?.field && difference.field !== 'recordStatus' ? String(difference.field) : '';
      const values = difference?.expected !== undefined || difference?.found !== undefined
        ? ' (esperado: ' + String(difference.expected ?? '—') + '; encontrado: ' + String(difference.found ?? '—') + ')'
        : '';
      const reason = String(difference?.reason || 'Hay datos que no coinciden con el archivo original.');
      const example = field ? field + values + '. ' + reason : reason;
      if (!group.examples.includes(example)) group.examples.push(example);
    }
    for (const [key, group] of byModule) {
      const module = moduleNames[key] || key;
      pendingMessages.push(module + ': ' + packageCountLabel(group.count, 'diferencia', 'diferencias') + (group.examples.length ? '. Ejemplo: ' + group.examples.join(' / ') : '.'));
    }
    const uniqueMessages = [...new Set(pendingMessages.filter(Boolean))];
    const isComplete = reconciliation?.complete === true && reconciliation?.fullMigrationComplete === true && reconciliation?.stageMatched === true && reconciliation?.unresolved === false && differences.length === 0 && blockers.length === 0 && result?.businessStatus === 'INACTIVE';
    if (!isComplete && uniqueMessages.length === 0) uniqueMessages.push('El servidor no confirmó que todas las etapas y verificaciones estén completas. El negocio permanece bloqueado.');
    const stageProjection = reconciliation?.operational && !reconciliation?.unresolved && differences.length === 0 ? 'complete' : 'pending';
    setFullMigrationStage('projection', isComplete ? 'complete' : stageProjection);
    setFullMigrationStage('reconciliation', isComplete ? 'complete' : 'pending');
    const list = el('migrationFullDifferenceList');
    list.replaceChildren(...uniqueMessages.map(message => {
      const item = document.createElement('li');
      item.textContent = message;
      return item;
    }));
    el('migrationFullDifferences').classList.toggle('hidden', isComplete || uniqueMessages.length === 0);
    if (isComplete) {
      const totals = reconciliation.operational || {};
      const imported = ['sales', 'purchases', 'supplierPayments', 'cashSessions', 'cashMovements', 'expenses', 'inventoryMovements', 'orders']
        .filter(key => totals[key] !== undefined)
        .map(key => (moduleNames[key] || key) + ': ' + packageCount(totals[key].imported ?? totals[key].count ?? totals[key]))
        .join(', ');
      el('migrationArchiveStatus').textContent = 'Migración completada. ' + (imported ? 'Registros disponibles en el POS: ' + imported + '. ' : '') + 'El negocio quedó inactivo y listo para activarlo desde Administración general.';
      el('migrationArchiveStatus').dataset.state = 'valid';
      if (archivePreview) archivePreview.eligibleToArchive = false;
      el('migrationArchiveConfirm').disabled = true;
      return;
    }
    const differenceCount = differences.length;
    el('migrationArchiveStatus').textContent = 'Migración pendiente de revisión. Hay ' + packageCountLabel(differenceCount, 'diferencia', 'diferencias') + ' en ' + packageCount(byModule.size) + ' módulos y ' + packageCount(uniqueMessages.length) + ' bloqueos o datos pendientes. El negocio continúa inactivo.';
    el('migrationArchiveStatus').dataset.state = 'invalid';
  }

  function renderArchiveIdentityDetails() {
    const container = el('migrationArchiveIdentityDetails');
    if (!container) return;
    container.replaceChildren();
    const review = archivePreview?.identityReview;
    if (!review) { container.classList.add('hidden'); return; }
    const counts = review.counts || {};
    const confirmation = review.batchConfirmation || archivePreview.legacyIdentityConfirmation || null;
    const confirmationMatches = Boolean(confirmation?.confirmed === true && confirmation.packageSha256 === archivePreview.packageSha256 && String(confirmation.targetBusinessId) === String(archivePreview.targetBusinessId));
    const records = (review.records || []).filter(record => !record.bulkIdentityEligible);
    if (!records.length) {
      container.classList.add('hidden');
      return;
    }
    const identityOnlyRecords = Number(counts.sharedId || 0);
    const summary = records.length.toLocaleString('es-NI') + ' registros tienen alertas adicionales que requieren revisi\u00f3n individual.' +
      (identityOnlyRecords && confirmationMatches ? ' La identidad compartida del paquete ya fue autorizada; esa confirmaci\u00f3n no resuelve estas otras alertas.' : '');
    container.append(node('p', '', summary));
    const groups = new Map();
    for (const record of records) {
      if (!groups.has(record.entity)) groups.set(record.entity, []);
      groups.get(record.entity).push(record);
    }
    const labels = { products: 'Productos', clients: 'Clientes', suppliers: 'Proveedores', sales: 'Ventas', purchases: 'Compras', cashSessions: 'Caja', inventoryMovements: 'Inventario', abonos: 'Abonos', expenses: 'Gastos', auditLogs: 'Auditor\u00eda', saleOrders: '\u00d3rdenes pendientes', syncQueue: 'Operaciones pendientes' };
    const target = destination();
    const batchId = archivePreview.priorBatch?.id;
    for (const [entity, items] of groups) {
      const details = node('details');
      details.append(node('summary', '', (labels[entity] || entity) + ': ' + items.length.toLocaleString('es-NI') + ' registros con alertas'));
      const list = node('div', 'migration-identity-record-list');
      for (const record of items) {
        const item = node('article', 'migration-identity-record');
        const title = node('strong', '', (labels[entity] || entity) + ' · referencia ' + record.reference);
        const context = Object.entries(record.context || {}).map(([key, value]) => key + ': ' + value).join(' · ');
        const note = context ? node('small', '', context) : null;
        const identity = node('small', '', record.identity === 'OTHER_BUSINESS' ? 'Asociado a otra identidad; bloqueado.' : record.identityReason === 'SHARED_ID' ? 'Usa el identificador antiguo compartido y también tiene otra alerta.' : record.identity === 'LEGACY' ? 'Su procedencia todavía requiere revisión.' : 'Requiere revisar duplicados o relaciones.');
        item.append(title);
        if (note) item.append(note);
        item.append(identity);
        const packageIdentityResolved = confirmationMatches && record.identityReason === 'SHARED_ID';
        const decision = record.reviewDecision;
        if (packageIdentityResolved) {
          item.append(node('span', 'migration-identity-record-status', 'La procedencia del archivo fue confirmada; esta otra alerta mantiene el registro pendiente.'));
        } else if (decision) {
          const state = decision.decision === 'EXCLUDE'
            ? 'Excluido de la futura importaci\u00f3n; la decisi\u00f3n qued\u00f3 registrada.'
            : decision.recordStatus === 'PENDING'
              ? 'La pertenencia fue revisada; otras inconsistencias siguen pendientes.'
              : 'Incluido en el archivo hist\u00f3rico; la importaci\u00f3n operativa y conciliaci\u00f3n siguen pendientes.';
          item.append(node('span', 'migration-identity-record-status', state));
        } else if (batchId && record.identity !== 'OTHER_BUSINESS' && reviewIdentityRecordRequest) {
          const attestation = document.createElement('input');
          attestation.type = 'checkbox';
          const attestationLabel = node('label', 'migration-identity-attestation');
          attestationLabel.append(attestation, document.createTextNode('Confirmo que comprob\u00e9 esta referencia y que el registro pertenece al negocio de origen.'));
          const actions = node('div');
          for (const [choice, label] of [['INCLUDE', 'Confirmar pertenencia'], ['EXCLUDE', 'Excluir registro']]) {
            const button = node('button', 'btn ' + (choice === 'INCLUDE' ? 'btn-primary' : 'btn-secondary'), label);
            button.type = 'button';
            button.disabled = Boolean(identityReviewBusyKey);
            button.addEventListener('click', async () => {
              if (choice === 'INCLUDE' && !attestation.checked) { attestation.setCustomValidity('Confirma que comprobaste la pertenencia.'); attestation.reportValidity(); return; }
              attestation.setCustomValidity('');
              record.reviewError = '';
              identityReviewBusyKey = entity + ':' + record.key;
              button.disabled = true;
              try {
                const result = await reviewIdentityRecordRequest(String(target.id), String(batchId), entity, record.key, choice, choice === 'INCLUDE' && attestation.checked);
                record.reviewDecision = { decision: choice, recordStatus: result.recordStatus };
                renderArchiveIdentityDetails();
              } catch (failure) {
                record.reviewError = failure?.message || 'No se pudo guardar la decisi\u00f3n.';
              } finally {
                identityReviewBusyKey = '';
                renderArchiveIdentityDetails();
              }
            });
            actions.append(button);
          }
          item.append(attestationLabel, actions);
        } else if (!batchId) item.append(node('small', '', 'Primero guarda el paquete; estas alertas no se importan hasta resolverlas.'));
        if (record.reviewError) item.append(node('small', 'migration-identity-record-status', record.reviewError));
        list.append(item);
      }
      details.append(list); container.append(details);
    }
    if (review.recordsTruncated) container.append(node('p', '', 'La lista muestra una parte de los registros; los restantes siguen pendientes.'));
    if (review.referenceIssuesTruncated) container.append(node('p', '', 'Hay m\u00e1s relaciones no verificables de las que se muestran; siguen bloqueadas.'));
    container.classList.remove('hidden');
  }

  async function refreshArchiveIdentityDecisions(targetBusinessId, batchId) {
    if (!archiveStatusRequest || !archivePreview?.identityReview) return;
    try {
      const result = await archiveStatusRequest(String(targetBusinessId), String(batchId));
      const entries = result?.batch?.manifest?.identityReviewDecisions;
      if (!Array.isArray(entries)) return;
      const decisions = new Map(entries.map(item => [`${item.entity}:${item.sourceRecordKey}`, item]));
      for (const record of archivePreview.identityReview.records || []) {
        const decision = decisions.get(`${record.entity}:${record.key}`);
        if (decision) record.reviewDecision = { decision: decision.decision, recordStatus: decision.recordStatus };
      }
      renderArchiveIdentityDetails();
    } catch { /* La copia sigue intacta; el administrador puede volver a consultar el estado. */ }
  }

  async function updateArchivePreview() {
    const card = el('migrationArchiveCard');
    if (!card) return;
    const token = ++archivePreviewToken;
    archivePreview = null;
    el('migrationArchiveConfirm').checked = false;
    el('migrationArchiveConfirm').disabled = true;
    el('migrationLegacyIdentityConfirmationGroup')?.classList.add('hidden');
    el('migrationArchiveReview').classList.add('hidden');
    el('migrationArchiveBlockers').replaceChildren();
    el('migrationArchiveIdentityDetails')?.classList.add('hidden');
    el('migrationArchiveIdentityDetails')?.replaceChildren();
    resetFullMigrationStages();
    const target = destination();
    card.classList.toggle('hidden', !packageValue || !canAccess());
    el('migrationArchiveStatus').textContent = '';
    el('migrationArchiveStatus').dataset.state = '';
    updateArchiveApplyButton();
    if (!packageValue || !canAccess() || !isMigrationTarget(target) || !previewArchiveRequest) return;
    el('migrationArchiveStatus').textContent = 'Comprobando el contenido del archivo para este negocio…';
    try {
      const result = await previewArchiveRequest(String(target.id), packageValue, packageFileSha256);
      if (token !== archivePreviewToken || !canAccess() || String(destination()?.id) !== String(target.id)) return;
      archivePreview = result;
      const sharedCount = Number(result.identityReview?.counts?.sharedId || 0);
      const confirmableCount = Number(result.bulkIdentityEligibleRecords || 0);
      el('migrationLegacyIdentityConfirmationGroup')?.classList.toggle('hidden', !result.legacyIdentityConfirmationRequired);
      if (el('migrationLegacyIdentityNotice')) {
        el('migrationLegacyIdentityNotice').textContent = 'Encontramos ' + packageCountLabel(sharedCount, 'registro con el identificador antiguo compartido', 'registros con el identificador antiguo compartido') + '. Tu confirmación cubre solo la procedencia de este archivo; ' + packageCountLabel(confirmableCount, 'registro puede incluirse', 'registros pueden incluirse') + ' con ella. Los duplicados, relaciones rotas y datos ausentes seguirán bloqueados.';
      }
      const confirmLabel = el('migrationArchiveConfirmLabel');
      if (confirmLabel) confirmLabel.textContent = 'Confirmo que este archivo pertenece al negocio seleccionado y autorizo su migración';
      el('migrationArchiveSummary').textContent = 'Se comprobarían ' + packageCount(result.recordsExpected) + ' registros del negocio «' + target.name + '».' + (result.priorBatch ? ' Ya hay un intento previo (' + result.priorBatch.status + '); el sistema lo reanudará sin duplicar información.' : '');
      updateArchiveStageMessages(result);
      el('migrationArchiveReview').classList.remove('hidden');
      el('migrationArchiveConfirm').disabled = !result.eligibleToArchive;
      el('migrationFullStages')?.classList.remove('hidden');
      renderArchiveIdentityDetails();
      if (result.priorBatch?.id) void refreshArchiveIdentityDecisions(target.id, result.priorBatch.id);
      const otherBusiness = Number(result.identityReview?.counts?.otherBusiness || 0);
      el('migrationArchiveStatus').textContent = !result.eligibleToArchive
        ? (otherBusiness ? 'El archivo incluye registros asociados a otra identidad y no se guardar\u00e1 en este destino.' : 'No se guardar\u00e1 informaci\u00f3n hasta resolver la diferencia entre el origen y el destino.')
        : result.reconciliationNotes?.length
          ? 'Puedes iniciar la importación. Los datos disponibles se procesarán; las diferencias y módulos que faltan se comprobarán durante la conciliación.'
          : 'Validación lista. Confirma que el archivo pertenece al negocio seleccionado para iniciar la importación y conciliación.';
      updateArchiveApplyButton();
    } catch (failure) {
      if (token !== archivePreviewToken) return;
      el('migrationArchiveStatus').textContent = failure?.message || 'No se pudo validar el paquete. No se guardó información.';
      updateArchiveApplyButton();
    }
  }

  async function migrateFullPackage() {
    if (archiveBusy || !archivePreview || !packageValue || !archiveMigrationRequest || !projectMigrationOperationsRequest || !el('migrationArchiveConfirm').checked) return;
    const target = destination();
    if (!isMigrationTarget(target) || String(target.id) !== String(archivePreview.targetBusinessId)) return;
    archiveBusy = true;
    el('migrationBusiness').disabled = true;
    updateArchiveApplyButton();
    el('migrationArchiveStatus').dataset.state = '';
    el('migrationFullStages').classList.remove('hidden');
    el('migrationFullDifferences').classList.add('hidden');
    el('migrationFullDifferenceList').replaceChildren();
    setFullMigrationStage('archive', 'running');
    setFullMigrationStage('projection', 'waiting');
    setFullMigrationStage('reconciliation', 'waiting');
    el('migrationArchiveStatus').textContent = 'Comprobando nuevamente el archivo antes de importarlo…';
    try {
      const fresh = await previewArchiveRequest(String(target.id), packageValue, packageFileSha256);
      if (fresh.packageSha256 !== archivePreview.packageSha256 || fresh.fileSha256 !== packageFileSha256 || String(fresh.targetBusinessId) !== String(target.id)) throw new Error('El archivo o el negocio seleccionado cambiaron desde la revisión. Vuelve a revisar el paquete.');
      if (!fresh.eligibleToArchive) throw new Error(fresh.blockers?.[0] || 'El archivo no puede importarse en este negocio.');
      el('migrationArchiveStatus').textContent = 'Guardando el archivo original y la confirmación de este negocio…';
      const result = await archiveMigrationRequest(String(target.id), packageValue, true, packageFileSha256);
      if (String(destination()?.id) !== String(target.id) || result.packageSha256 !== fresh.packageSha256 || result.fileSha256 !== packageFileSha256) throw new Error('La respuesta no coincide con el archivo y negocio seleccionados. El negocio permanece bloqueado.');
      archivePreview = { ...fresh, priorBatch: { id: result.batchId, status: result.status }, legacyIdentityConfirmation: result.identityConfirmation, blockers: result.blockers };
      if (archivePreview.identityReview) archivePreview.identityReview.batchConfirmation = result.identityConfirmation;
      updateArchiveStageMessages(result);
      setFullMigrationStage('archive', 'complete');
      setFullMigrationStage('projection', 'running');
      setFullMigrationStage('reconciliation', 'running');
      const identityConfirmationMessage = result.identityConfirmationApplied
        ? ' Se confirmó la procedencia del archivo completo para este destino (' + packageCount(result.identityConfirmationApplied) + ' registros antiguos).'
        : '';
      el('migrationArchiveStatus').textContent = 'Archivo protegido.' + identityConfirmationMessage + ' Importando ahora los datos disponibles en los módulos del POS y conciliando sus relaciones…';
      const migrationResult = await projectMigrationOperationsRequest(String(target.id), String(result.batchId));
      if (String(destination()?.id) !== String(target.id) || migrationResult.batchId !== result.batchId || migrationResult.businessId !== String(target.id)) throw new Error('La respuesta de importación no coincide con el negocio seleccionado. El negocio permanece bloqueado.');
      renderFullMigrationOutcome(migrationResult);
      renderArchiveIdentityDetails();
      await refreshArchiveIdentityDecisions(target.id, result.batchId);
    } catch (failure) {
      setFullMigrationStage('archive', archivePreview?.priorBatch?.id ? 'complete' : 'error');
      setFullMigrationStage('projection', 'error');
      setFullMigrationStage('reconciliation', 'pending');
      el('migrationFullDifferences').classList.remove('hidden');
      const item = document.createElement('li');
      item.textContent = failure?.message || 'No se pudo completar la importación. El archivo local sigue disponible para reintentar.';
      el('migrationFullDifferenceList').replaceChildren(item);
      el('migrationArchiveStatus').textContent = 'Migración pendiente. No se confirmó una conciliación completa y el negocio permanece inactivo.';
      el('migrationArchiveStatus').dataset.state = 'invalid';
    } finally {
      archiveBusy = false;
      el('migrationBusiness').disabled = false;
      el('migrationArchiveConfirm').checked = false;
      updateArchiveApplyButton();
    }
  }

  function creditRows(id, rows) {
    el(id).replaceChildren(...rows.map(values => {
      const tr = document.createElement('tr');
      values.forEach(value => { const td = document.createElement('td'); td.textContent = value ?? '—'; tr.append(td); });
      return tr;
    }));
  }
  function renderCreditIssues(issues, payments, missingSchema, date) {
    const list = el('migrationCreditIssues');
    const pendingIssues = issues.filter(issue => issue.code === 'LOCAL_PENDING_APPLIED');
    const visibleIssues = issues.filter(issue => issue.code !== 'LOCAL_PENDING_APPLIED' && !(missingSchema && issue.code === 'MIGRATION_CREDIT_SCHEMA_REQUIRED'));
    const rows = [];
    if (pendingIssues.length) {
      const paymentRows = payments.filter(payment => payment.originalStatus === 'pendiente' && !payment.cancelled && payment.appliesToDebt);
      const item = document.createElement('li');
      item.className = 'migration-info';
      item.dataset.blocking = 'false';
      const summary = document.createElement('p');
      summary.textContent = 'Información: ' + pendingIssues.length.toLocaleString('es-NI') + ' abonos históricos pendientes en caja local ya están aplicados a la deuda.';
      item.append(summary);
      const details = document.createElement('details');
      details.className = 'migration-credit-issue-details';
      const detailsSummary = document.createElement('summary');
      detailsSummary.textContent = 'Ver detalle de los ' + pendingIssues.length.toLocaleString('es-NI') + ' abonos';
      details.append(detailsSummary);
      const detailList = document.createElement('ul');
      const detailRows = paymentRows.length
        ? paymentRows.map(payment => 'ID original ' + payment.sourcePaymentId + ' · Fecha ' + date(payment.date) + ' · Estado original: ' + (payment.originalStatus || 'No disponible') + ' · Aplicado a la deuda')
        : pendingIssues.map(issue => issue.message);
      detailList.replaceChildren(...detailRows.map(message => {
        const row = document.createElement('li');
        row.textContent = message;
        return row;
      }));
      details.append(detailList);
      item.append(details);
      rows.push(item);
    }
    rows.push(...visibleIssues.map(issue => {
      const item = document.createElement('li');
      const warning = !issue.blocking && ['VOID_PAYMENT', 'UNALLOCATED_GENERAL_PAYMENT'].includes(issue.code);
      item.className = issue.blocking ? 'migration-error' : warning ? 'migration-warn' : 'migration-info';
      item.dataset.blocking = String(issue.blocking);
      item.textContent = (issue.blocking ? 'Bloqueo: ' : warning ? 'Advertencia: ' : 'Información: ') + issue.message;
      return item;
    }));
    list.replaceChildren(...rows);
  }
  async function updateCreditPreview() {
    const token = ++creditPreviewToken, target = destination(), requestToken = packageReadToken;
    const section = el('migrationCreditSummary');
    section.classList.add('hidden');
    creditPreview = null;
    renderCreditMigrationButton();
    if (!canAccess() || !packageValue || !target || target.status !== 'ACTIVE' || !previewCreditRequest) return;
    section.classList.remove('hidden');
    section.setAttribute('aria-busy', 'true');
    el('migrationCreditRefreshBtn').disabled = true;
    const status = el('migrationCreditStatus');
    status.dataset.state = '';
    status.textContent = 'Conciliando créditos y revisando el destino…';
    el('migrationCreditTotals').textContent = '';
    el('migrationCreditIssues').replaceChildren();
    ['migrationCreditInvoices', 'migrationCreditPayments', 'migrationCreditClients'].forEach(id => el(id).replaceChildren());
    try {
      const result = await previewCreditRequest(String(target.id), packageValue);
      if (token !== creditPreviewToken || requestToken !== packageReadToken || !canAccess() || destination()?.id !== target.id) return;
      if (result.previewOnly !== true || typeof result.canImport !== 'boolean' || typeof result.eligible !== 'boolean') throw new Error('Respuesta de conciliación inválida.');
      creditPreview = result;
      const labels = { PAID: 'Pagada', OPEN: 'Pendiente', OVERDUE: 'Vencida', CANCELLED: 'Anulada', INVALID: 'Datos inválidos' };
      const date = value => value ? new Date(value).toLocaleString('es-NI', { timeZone: 'America/Managua' }) : '—';
      creditRows('migrationCreditInvoices', result.invoices.map(row => [row.clientName, row.invoiceNumber, row.sourceSaleId, date(row.date) + ' / ' + date(row.dueAt), 'C$' + row.total, 'C$' + row.paid, 'C$' + row.balance, labels[row.status] || row.status]));
      creditRows('migrationCreditPayments', result.payments.map(row => [row.sourcePaymentId + ' / ' + row.clientName, row.allocations.map(part => 'Factura ' + part.invoiceNumber + ': C$' + part.amount).join('; ') || (row.general ? 'General sin distribución' : row.sourceSaleId), date(row.date), 'C$' + row.amount, row.paymentMethod, row.originalStatus, row.cancelled ? 'Anulado; no descuenta' : row.appliesToDebt ? 'Aplicado históricamente' : 'Requiere revisión']));
      creditRows('migrationCreditClients', result.clients.map(row => [row.clientName, row.declaredDebt, row.openingDebt, row.invoiceBalance, row.calculatedDebt, row.difference]));
      const totals = result.totals;
      el('migrationCreditTotals').textContent = totals.invoices + ' facturas · ' + totals.payments + ' abonos · Total C$' + totals.total + ' · Aplicado C$' + totals.paid + ' · Saldo C$' + totals.balance + (result.importable ? ' · Ya importadas: ' + result.importable.invoicesAlreadyImported + ' facturas / ' + result.importable.paymentGroupsAlreadyImported + ' abonos' : '');
      const missingSchema = result.gates?.schema === false || result.issues.some(issue => issue.code === 'MIGRATION_CREDIT_SCHEMA_REQUIRED');
      renderCreditIssues(result.issues, result.payments, missingSchema, date);
      status.dataset.state = missingSchema ? 'blocked' : result.financiallyConsistent ? 'valid' : 'invalid';
      status.textContent = missingSchema
        ? 'Bloqueo real del destino: falta SQL 010 de créditos históricos. La conciliación permanece en solo lectura y la importación sigue deshabilitada.'
        : !result.financiallyConsistent
        ? 'Conciliación bloqueada: hay inconsistencias financieras o falta resolver una correspondencia.'
        : result.eligible && result.canImport
          ? 'Conciliación sin diferencias financieras. La importación está disponible.'
          : 'Conciliación sin diferencias financieras. La importación de esta etapa no está habilitada.';
      renderCreditMigrationButton();
    } catch (failure) {
      if (token !== creditPreviewToken || requestToken !== packageReadToken || !canAccess()) return;
      creditPreview = null;
      status.dataset.state = 'invalid';
      status.textContent = failure?.message || 'No se pudo conciliar. La importación permanece bloqueada.';
      renderCreditMigrationButton();
    } finally {
      if (token === creditPreviewToken) { section.setAttribute('aria-busy', 'false'); el('migrationCreditRefreshBtn').disabled = false; }
    }
  }

  function renderCreditMigrationButton() {
    const button = el('migrationCreditImportBtn');
    if (!button) return;
    const target = destination();
    const ready = Boolean(canAccess() && packageValue && target?.status === 'ACTIVE' && creditPreview?.eligible && creditPreview?.canImport && creditPreview?.financiallyConsistent);
    button.disabled = !ready || creditBusy || migrationBusy || inventoryBusy || salesBusy || purchasesBusy;
    button.textContent = creditPreview?.importable?.invoicesAlreadyImported > 0 || creditPreview?.importable?.paymentGroupsAlreadyImported > 0
      ? 'Revisar importación idempotente'
      : 'Importar créditos y abonos históricos';
    el('migrationCreditImportNote').textContent = ready
      ? 'La importación es transaccional e idempotente. No creará movimientos de caja ni de inventario.'
      : 'Se requiere una conciliación financiera completa y correspondencias válidas para habilitar la importación.';
  }

  function renderCreditMigrationResult(result) {
    el('migrationCreditCreatedInvoices').textContent = packageCount(result.created.invoices);
    el('migrationCreditSkippedInvoices').textContent = packageCount(result.skipped.invoices);
    el('migrationCreditCreatedPayments').textContent = packageCount(result.created.payments);
    el('migrationCreditSkippedPayments').textContent = packageCount(result.skipped.payments);
    el('migrationCreditFinalBalance').textContent = 'C$' + result.financial.balance;
    el('migrationCreditResultWarnings').replaceChildren(...(result.warnings.length
      ? result.warnings.map(warning => node('li', 'migration-warn', warning))
      : [node('li', 'migration-ok', 'La importación terminó sin advertencias.')]));
    el('migrationCreditResult').classList.remove('hidden');
    el('migrationCreditStatus').textContent = 'Importación transaccional de créditos y abonos completada.';
    el('migrationCreditStatus').dataset.state = 'valid';
  }

  function closeCreditMigrationConfirmation() {
    if (creditBusy) return;
    el('migrationCreditConfirmModal').classList.add('hidden');
    if (creditTrigger?.isConnected) creditTrigger.focus();
  }

  function syncCreditOriginConfirmation() {
    const required = Boolean(creditPreview?.sourceOriginConflict?.required);
    el('migrationCreditConfirmBtn').disabled = creditBusy || (required && !el('migrationCreditOriginConfirm').checked);
  }

  function openCreditMigrationConfirmation() {
    const target = destination();
    if (!canAccess() || !packageValue || !target || target.status !== 'ACTIVE' || creditBusy || migrationBusy || inventoryBusy || salesBusy || purchasesBusy || !creditPreview?.eligible || !creditPreview?.canImport || !migrateCreditRequest) return;
    creditTrigger = el('migrationCreditImportBtn');
    el('migrationCreditConfirmSource').textContent = text(packageValue.business.name) || 'No disponible';
    el('migrationCreditConfirmTarget').textContent = target.name + ' (#' + target.id + ')';
    el('migrationCreditConfirmInvoices').textContent = packageCount(creditPreview.invoices.length);
    el('migrationCreditConfirmPayments').textContent = packageCount(creditPreview.payments.length);
    el('migrationCreditConfirmBalance').textContent = 'C$' + creditPreview.totals.balance;
    el('migrationCreditOriginWarning').classList.toggle('hidden', !creditPreview.sourceOriginConflict?.required);
    el('migrationCreditOriginConfirm').checked = false;
    el('migrationCreditConfirmError').classList.add('hidden');
    el('migrationCreditConfirmError').textContent = '';
    el('migrationCreditConfirmModal').classList.remove('hidden');
    syncCreditOriginConfirmation();
    el('migrationCreditConfirmTitle').focus();
  }

  async function confirmCreditMigration() {
    const target = destination();
    if (creditBusy || migrationBusy || inventoryBusy || salesBusy || purchasesBusy || !canAccess() || !packageValue || !target || target.status !== 'ACTIVE' || !creditPreview?.eligible || !creditPreview?.canImport || !migrateCreditRequest) return;
    const requestToken = packageReadToken;
    const modal = el('migrationCreditConfirmModal');
    const errorBox = el('migrationCreditConfirmError');
    creditBusy = true;
    modal.querySelector('.modal-card').setAttribute('aria-busy', 'true');
    el('migrationCreditCancelBtn').disabled = true;
    el('migrationCreditConfirmBtn').disabled = true;
    el('migrationCreditStatus').dataset.state = '';
    el('migrationCreditStatus').textContent = 'Importando facturas y abonos históricos en una transacción…';
    renderBasicMigrationButton(); renderInventoryMigrationButton(); renderSalesMigrationButton(); renderPurchasesMigrationButton(); renderCreditMigrationButton();
    errorBox.classList.add('hidden');
    let completed = false;
    try {
      const result = await migrateCreditRequest(String(target.id), packageValue, el('migrationCreditOriginConfirm').checked);
      if (!canAccess() || requestToken !== packageReadToken) return;
      renderCreditMigrationResult(result);
      modal.classList.add('hidden');
      completed = true;
    } catch (failure) {
      if (!canAccess() || requestToken !== packageReadToken) return;
      const message = failure?.message || 'No se pudo completar la migración de créditos.';
      el('migrationCreditStatus').dataset.state = 'invalid';
      el('migrationCreditStatus').textContent = message;
      errorBox.textContent = message;
      errorBox.classList.remove('hidden');
    } finally {
      creditBusy = false;
      modal.querySelector('.modal-card').setAttribute('aria-busy', 'false');
      el('migrationCreditCancelBtn').disabled = false;
      syncCreditOriginConfirmation();
      renderBasicMigrationButton(); renderInventoryMigrationButton(); renderSalesMigrationButton(); renderPurchasesMigrationButton(); renderCreditMigrationButton();
      if (modal.classList.contains('hidden') && creditTrigger?.isConnected) creditTrigger.focus();
      if (completed) await updateCreditPreview();
    }
  }

  function renderBasicMigrationButton() {
    const target = destination();
    const targetId = target ? String(target.id) : '';
    const button = el('migrationBasicStartBtn');
    button.disabled = !canAccess() || !packageValue || !target || target.status !== 'ACTIVE' || migrationBusy || inventoryBusy || salesBusy || purchasesBusy || creditBusy || completedTargets.has(targetId);
    button.textContent = completedTargets.has(targetId) ? 'Migración completada para este destino' : 'Migrar datos básicos';
  }

  function renderInventoryMigrationButton() {
    const button = el('migrationInventoryStartBtn');
    const target = destination();
    const targetId = target ? String(target.id) : '';
    const visible = Boolean(canAccess() && packageValue && target && target.status === 'ACTIVE' && inventoryPreview?.eligible);
    el('migrationInventorySummary').classList.toggle('hidden', !visible);
    button.disabled = !visible || migrationBusy || inventoryBusy || salesBusy || purchasesBusy || creditBusy || completedInventoryTargets.has(targetId);
    button.textContent = completedInventoryTargets.has(targetId) ? 'Inventario inicial completado para este destino' : 'Migrar inventario inicial';
  }

  function renderInventoryMigrationResult(result) {
    el('migrationInventoryCreated').textContent = packageCount(result.created.inventoryMovements);
    el('migrationInventorySkipped').textContent = packageCount(result.skipped.inventoryMovements);
    const warnings = el('migrationInventoryWarnings');
    warnings.replaceChildren(...(result.warnings.length
      ? result.warnings.map(warning => node('li', '', warning))
      : [node('li', '', 'No hubo advertencias adicionales.')]));
    el('migrationInventoryResult').classList.remove('hidden');
    el('migrationInventoryStatus').textContent = 'Migración de inventario completada.';
    el('migrationInventoryStatus').dataset.state = 'valid';
  }

  async function updateInventoryPreview() {
    const token = ++inventoryPreviewToken;
    const requestToken = packageReadToken;
    const target = destination();
    inventoryPreview = null;
    el('migrationInventorySummary').classList.add('hidden');
    const gateStatus = el('migrationInventoryGateStatus');
    gateStatus.classList.add('hidden');
    gateStatus.dataset.state = '';

    if (!canAccess() || !packageValue || !target || target.status !== 'ACTIVE' || migrationBusy || inventoryBusy || purchasesBusy || creditBusy || !previewInventoryRequest) return;
    const status = el('migrationInventoryStatus');
    status.dataset.state = '';
    status.textContent = 'Verificando migración básica y productos del destino…';
    gateStatus.textContent = 'Verificando si la migración básica está lista…';
    gateStatus.classList.remove('hidden');
    try {
      const preview = await previewInventoryRequest(String(target.id), packageValue);
      if (token !== inventoryPreviewToken || requestToken !== packageReadToken || !canAccess() || target.id !== destination()?.id) return;
      if (!preview.eligible) {
        status.textContent = '';
        gateStatus.textContent = preview.warnings.join(' ');
        renderInventoryMigrationButton();
        return;
      }
      gateStatus.classList.add('hidden');
      inventoryPreview = preview;
      el('migrationInventoryWithStock').textContent = packageCount(preview.products.productsWithStock);
      el('migrationInventoryWithoutStock').textContent = packageCount(preview.products.productsWithoutStock);
      el('migrationInventoryToSkip').textContent = packageCount(preview.products.productsToSkip);
      el('migrationInventoryResult').classList.add('hidden');
      status.textContent = preview.warnings.join(' ');
      renderInventoryMigrationButton();
    } catch (failure) {
      if (token !== inventoryPreviewToken || requestToken !== packageReadToken || !canAccess()) return;
      gateStatus.dataset.state = 'invalid';
      gateStatus.textContent = failure?.message || 'No se pudo revisar el inventario destino.';
      gateStatus.classList.remove('hidden');
      renderInventoryMigrationButton();
    }
  }

  function closeInventoryMigrationConfirmation() {
    const modal = el('migrationInventoryConfirmModal');
    if (inventoryBusy) return;
    modal.classList.add('hidden');
    if (inventoryTrigger?.isConnected) inventoryTrigger.focus();
  }

  function openInventoryMigrationConfirmation() {
    const target = destination();
    if (!canAccess() || !packageValue || !target || target.status !== 'ACTIVE' || migrationBusy || inventoryBusy || purchasesBusy || creditBusy || !inventoryPreview?.eligible) return;
    inventoryTrigger = el('migrationInventoryStartBtn');
    el('migrationInventoryConfirmSource').textContent = text(packageValue.business.name) || 'No disponible';
    el('migrationInventoryConfirmTarget').textContent = target.name + ' (#' + target.id + ')';
    el('migrationInventoryConfirmWithStock').textContent = packageCount(inventoryPreview.products.productsWithStock);
    el('migrationInventoryConfirmWithoutStock').textContent = packageCount(inventoryPreview.products.productsWithoutStock);
    el('migrationInventoryConfirmToSkip').textContent = packageCount(inventoryPreview.products.productsToSkip);
    const warnings = el('migrationInventoryConfirmWarnings');
    warnings.replaceChildren(...(inventoryPreview.warnings.length
      ? inventoryPreview.warnings.map(warning => node('li', 'migration-warn', warning))
      : [node('li', 'migration-ok', 'No se detectaron productos que deban omitirse.') ]));
    el('migrationInventoryConfirmError').classList.add('hidden');
    el('migrationInventoryConfirmError').textContent = '';
    el('migrationInventoryConfirmModal').classList.remove('hidden');
    el('migrationInventoryConfirmTitle').focus();
  }

  async function confirmInventoryMigration() {
    const target = destination();
    if (migrationBusy || inventoryBusy || purchasesBusy || creditBusy || !canAccess() || !packageValue || !target || target.status !== 'ACTIVE' || !inventoryPreview?.eligible || !migrateInventoryRequest) return;
    const requestToken = packageReadToken;
    inventoryBusy = true;
    const modal = el('migrationInventoryConfirmModal');
    const errorBox = el('migrationInventoryConfirmError');
    const status = el('migrationInventoryStatus');
    el('migrationInventoryStartBtn').disabled = true;
    el('migrationInventoryConfirmBtn').disabled = true;
    el('migrationInventoryCancelBtn').disabled = true;
    modal.querySelector('.modal-card').setAttribute('aria-busy', 'true');
    status.dataset.state = '';
    status.textContent = 'Creando movimientos iniciales de inventario…';
    errorBox.classList.add('hidden');
    try {
      const result = await migrateInventoryRequest(String(target.id), packageValue);
      if (!canAccess() || requestToken !== packageReadToken) return;
      completedInventoryTargets.add(String(target.id));
      renderInventoryMigrationResult(result);
      modal.classList.add('hidden');
    } catch (failure) {
      if (!canAccess() || requestToken !== packageReadToken) return;
      status.dataset.state = 'invalid';
      status.textContent = failure?.message || 'No se pudo completar la migración de inventario.';
      errorBox.textContent = status.textContent;
      errorBox.classList.remove('hidden');
    } finally {
      inventoryBusy = false;
      modal.querySelector('.modal-card').setAttribute('aria-busy', 'false');
      el('migrationInventoryCancelBtn').disabled = false;
      el('migrationInventoryConfirmBtn').disabled = false;
      renderBasicMigrationButton();
      renderInventoryMigrationButton();
      renderSalesMigrationButton();
      renderPurchasesMigrationButton();
      if (modal.classList.contains('hidden') && inventoryTrigger?.isConnected) inventoryTrigger.focus();
      if (completedInventoryTargets.has(String(target.id))) {
        await updateInventoryPreview();
        await updateSalesPreview();
        await updatePurchasesPreview();
      }
    }
  }

  function renderSalesMigrationButton() {
    const button = el('migrationSalesStartBtn');
    const target = destination();
    const targetId = target ? String(target.id) : '';
    const visible = Boolean(canAccess() && packageValue && target && target.status === 'ACTIVE' && salesPreview?.eligible);
    el('migrationSalesSummary').classList.toggle('hidden', !visible);
    button.disabled = !visible || migrationBusy || inventoryBusy || salesBusy || purchasesBusy || creditBusy || completedSalesTargets.has(targetId);
    button.textContent = completedSalesTargets.has(targetId) ? 'Ventas históricas completadas para este destino' : 'Migrar ventas históricas';
  }

  function salesWarningGroups(warnings) {
    const omitted = [];
    const other = [];
    for (const warning of warnings) {
      const value = String(warning);
      if (/^Venta\s+.+:\s+/i.test(value) && /(?:se omitirá|omitida|omitirá completa|se omitió)/i.test(value)) omitted.push(value);
      else other.push(value);
    }
    return { omitted, other };
  }

  function salesWarningClass(warning) {
    if (/(?:error|inválid|no se pudo|falló|bloquead|rechaz)/i.test(warning)) return 'migration-error';
    if (/(?:información|sin advertencias|no se detectaron|revisión completada)/i.test(warning)) return 'migration-info';
    return 'migration-warn';
  }

  function omittedSalesLabel(count, label) {
    return count + ' ' + label + (count === 1 ? '' : 's') + ' omitida' + (count === 1 ? '' : 's');
  }

  function renderSalesWarningPanel({ warnings, panelId, summaryId, detailsId, detailsSummaryId, omittedListId, otherListId, omittedCount, label }) {
    const panel = el(panelId);
    if (!panel) return;
    const warningList = Array.isArray(warnings) ? warnings : [];
    const groups = salesWarningGroups(warningList);
    const count = Number.isSafeInteger(Number(omittedCount)) && Number(omittedCount) > 0 ? Number(omittedCount) : groups.omitted.length;
    panel.classList.toggle('hidden', warningList.length === 0 && count === 0);
    const summary = el(summaryId);
    summary.textContent = groups.omitted.length
      ? omittedSalesLabel(count, label) + '; ' + groups.omitted.length + ' detalle' + (groups.omitted.length === 1 ? '' : 's') + ' disponible' + (groups.omitted.length === 1 ? '' : 's') + '.'
      : count > 0 ? omittedSalesLabel(count, label) + '; el servicio no devolvió el detalle por factura.'
        : (warningList.length ? warningList.length + ' aviso' + (warningList.length === 1 ? '' : 's') + ' para revisar.' : '');
    summary.dataset.state = groups.omitted.length || groups.other.length ? 'warning' : 'info';
    const details = el(detailsId);
    details.classList.toggle('hidden', groups.omitted.length === 0 && count === 0);
    const detailsSummary = el(detailsSummaryId);
    detailsSummary.textContent = omittedSalesLabel(count, label) + ' · ver número y motivo';
    const omittedList = el(omittedListId);
    omittedList.replaceChildren(...(groups.omitted.length
      ? groups.omitted.map(warning => node('li', 'migration-warn', warning))
      : count > 0 ? [node('li', 'migration-error', 'El servicio informó ventas omitidas, pero no devolvió sus motivos por factura.')]
        : []));
    const otherList = el(otherListId);
    otherList.replaceChildren(...groups.other.map(warning => node('li', salesWarningClass(warning), warning)));
    otherList.classList.toggle('hidden', groups.other.length === 0);
  }

  function renderSalesMigrationResult(result) {
    const imported = Number(result.created?.sales || 0);
    const omitted = Number(result.skipped?.sales || 0);
    const warnings = Array.isArray(result.warnings) ? result.warnings : [];
    el('migrationSalesSummary').classList.remove('hidden');
    const resultSection = el('migrationSalesResult');
    resultSection.classList.toggle('has-omissions', omitted > 0 || warnings.length > 0);
    el('migrationSalesCreated').textContent = packageCount(imported);
    el('migrationSalesSkipped').textContent = packageCount(omitted);
    el('migrationSalesResultDetected').textContent = packageCount(imported + omitted);
    renderSalesWarningPanel({ warnings, panelId: 'migrationSalesResult', summaryId: 'migrationSalesResultWarningSummary', detailsId: 'migrationSalesSkippedDetails', detailsSummaryId: 'migrationSalesSkippedDetailsSummary', omittedListId: 'migrationSalesWarnings', otherListId: 'migrationSalesOtherWarnings', omittedCount: omitted, label: 'venta' });
    resultSection.classList.remove('hidden');
    el('migrationSalesStatus').textContent = 'Migración de ventas históricas completada.';
    el('migrationSalesStatus').dataset.state = 'valid';
  }

  async function updateSalesPreview() {
    const token = ++salesPreviewToken;
    const requestToken = packageReadToken;
    const target = destination();
    salesPreview = null;
    el('migrationSalesSummary').classList.add('hidden');
    renderSalesMigrationButton();
    const gateStatus = el('migrationSalesGateStatus');
    gateStatus.classList.add('hidden');
    gateStatus.dataset.state = '';
    el('migrationSalesGateTitle').textContent = 'Bloqueo de migración';
    el('migrationSalesGateWarnings').replaceChildren();
    el('migrationSalesPreviewWarningPanel').classList.add('hidden');
    if (!canAccess() || !packageValue || !target || target.status !== 'ACTIVE' || migrationBusy || inventoryBusy || salesBusy || purchasesBusy || creditBusy || !previewSalesRequest) return;
    const status = el('migrationSalesStatus');
    status.dataset.state = '';
    status.textContent = 'Verificando migración básica, inventario inicial y ventas…';
    el('migrationSalesGateTitle').textContent = 'Verificando las fases previas y los productos/clientes de destino…';
    el('migrationSalesGateWarnings').replaceChildren();
    gateStatus.classList.remove('hidden');
    try {
      const preview = await previewSalesRequest(String(target.id), packageValue);
      if (token !== salesPreviewToken || requestToken !== packageReadToken || !canAccess() || String(target.id) !== String(destination()?.id)) return;
      if (!preview.eligible) {
        status.textContent = '';
        gateStatus.dataset.state = 'blocked';
        el('migrationSalesGateTitle').textContent = 'Bloqueo: ventas históricas no disponibles';
        el('migrationSalesGateWarnings').replaceChildren(...(preview.warnings.length
          ? preview.warnings.map(warning => node('li', 'migration-error', warning))
          : [node('li', 'migration-error', 'El servidor bloqueó la vista previa sin detallar la causa.') ]));
        gateStatus.classList.remove('hidden');
        renderSalesMigrationButton();
        return;
      }
      gateStatus.classList.add('hidden');
      salesPreview = preview;
      el('migrationSalesDetected').textContent = packageCount(preview.sales.detected);
      el('migrationSalesCanMigrate').textContent = packageCount(preview.sales.couldMigrate);
      el('migrationSalesToSkip').textContent = packageCount(preview.sales.toSkip);
      status.dataset.state = 'info';
      status.textContent = 'Revisión lista: ' + packageCount(preview.sales.detected) + ' detectadas, ' + packageCount(preview.sales.couldMigrate) + ' preparadas y ' + packageCount(preview.sales.toSkip) + ' omitidas.';
      renderSalesWarningPanel({ warnings: preview.warnings, panelId: 'migrationSalesPreviewWarningPanel', summaryId: 'migrationSalesPreviewWarningSummary', detailsId: 'migrationSalesPreviewSkippedDetails', detailsSummaryId: 'migrationSalesPreviewSkippedSummary', omittedListId: 'migrationSalesPreviewSkippedWarnings', otherListId: 'migrationSalesPreviewOtherWarnings', omittedCount: preview.sales.toSkip, label: 'venta' });
      renderSalesMigrationButton();
    } catch (failure) {
      if (token !== salesPreviewToken || requestToken !== packageReadToken || !canAccess()) return;
      gateStatus.dataset.state = 'invalid';
      el('migrationSalesGateTitle').textContent = 'No se pudo revisar la migración';
      el('migrationSalesGateWarnings').replaceChildren(node('li', 'migration-error', failure?.message || 'No se pudieron revisar las ventas del paquete.'));
      gateStatus.classList.remove('hidden');
      renderSalesMigrationButton();
    }
  }

  function closeSalesMigrationConfirmation() {
    const modal = el('migrationSalesConfirmModal');
    if (salesBusy) return;
    modal.classList.add('hidden');
    if (salesTrigger?.isConnected) salesTrigger.focus();
  }

  function salesOriginConfirmationRequired() {
    return salesPreview?.sourceOriginConflict?.required === true;
  }

  function syncSalesOriginConfirmation() {
    const checkbox = el('migrationSalesOriginConfirm');
    const confirmButton = el('migrationSalesConfirmBtn');
    if (!checkbox || !confirmButton) return;
    confirmButton.disabled = salesBusy || (salesOriginConfirmationRequired() && !checkbox.checked);
  }

  function openSalesMigrationConfirmation() {
    const target = destination();
    if (!canAccess() || !packageValue || !target || target.status !== 'ACTIVE' || migrationBusy || inventoryBusy || salesBusy || purchasesBusy || creditBusy || !salesPreview?.eligible) return;
    salesTrigger = el('migrationSalesStartBtn');
    el('migrationSalesConfirmSource').textContent = text(packageValue.business.name) || 'No disponible';
    el('migrationSalesConfirmTarget').textContent = target.name + ' (#' + target.id + ')';
    el('migrationSalesConfirmDetected').textContent = packageCount(salesPreview.sales.detected);
    el('migrationSalesConfirmCanMigrate').textContent = packageCount(salesPreview.sales.couldMigrate);
    el('migrationSalesConfirmToSkip').textContent = packageCount(salesPreview.sales.toSkip);
    const originWarning = el('migrationSalesOriginWarning');
    const originMessage = el('migrationSalesOriginMessage');
    const originConfirm = el('migrationSalesOriginConfirm');
    const conflict = salesPreview.sourceOriginConflict;
    originConfirm.checked = false;
    originWarning.classList.toggle('hidden', !conflict?.required);
    if (conflict?.required) {
      const existing = conflict.existingSources.map(source => (source.sourceBusinessName || 'Origen sin identificar') + ' (clave ' + source.sourceBusinessKey.slice(0, 8) + ', ' + source.saleCount + ' ventas)').join(', ');
      originMessage.textContent = 'Este destino ya contiene ' + existing + '. El paquete entrante pertenece a ' + conflict.incomingSourceBusinessName + ' (clave ' + conflict.incomingSourceBusinessKey.slice(0, 8) + '). Las facturas locales podrían repetirse; se conservarán separadas por sus referencias de migración. Confirma la nueva fuente antes de continuar.';
    } else originMessage.textContent = '';
    syncSalesOriginConfirmation();
    renderSalesWarningPanel({ warnings: salesPreview.warnings, panelId: 'migrationSalesConfirmWarningPanel', summaryId: 'migrationSalesConfirmWarningSummary', detailsId: 'migrationSalesConfirmSkippedDetails', detailsSummaryId: 'migrationSalesConfirmSkippedSummary', omittedListId: 'migrationSalesConfirmSkippedWarnings', otherListId: 'migrationSalesConfirmOtherWarnings', omittedCount: salesPreview.sales.toSkip, label: 'venta' });
    if (!salesPreview.warnings.length) el('migrationSalesConfirmWarningSummary').textContent = 'No se detectaron advertencias adicionales.';
    el('migrationSalesConfirmError').classList.add('hidden');
    el('migrationSalesConfirmError').textContent = '';
    el('migrationSalesConfirmModal').classList.remove('hidden');
    el('migrationSalesConfirmTitle').focus();
  }

  async function confirmSalesMigration() {
    const target = destination();
    if (migrationBusy || inventoryBusy || salesBusy || purchasesBusy || creditBusy || !canAccess() || !packageValue || !target || target.status !== 'ACTIVE' || !salesPreview?.eligible || !migrateSalesRequest) return;
    if (salesOriginConfirmationRequired() && !el('migrationSalesOriginConfirm').checked) return;
    const requestToken = packageReadToken;
    salesBusy = true;
    const modal = el('migrationSalesConfirmModal');
    const errorBox = el('migrationSalesConfirmError');
    const status = el('migrationSalesStatus');
    el('migrationSalesStartBtn').disabled = true;
    el('migrationSalesConfirmBtn').disabled = true;
    el('migrationSalesCancelBtn').disabled = true;
    modal.querySelector('.modal-card').setAttribute('aria-busy', 'true');
    status.dataset.state = '';
    status.textContent = 'Registrando ventas históricas…';
    errorBox.classList.add('hidden');
    let completed = false;
    let completedResult = null;
    try {
      const result = await migrateSalesRequest(String(target.id), packageValue, salesOriginConfirmationRequired() && el('migrationSalesOriginConfirm').checked);
      completedResult = result;
      if (!canAccess() || requestToken !== packageReadToken) return;
      completedSalesTargets.add(String(target.id));
      renderSalesMigrationResult(result);
      modal.classList.add('hidden');
      completed = true;
    } catch (failure) {
      if (!canAccess() || requestToken !== packageReadToken) return;
      status.dataset.state = 'invalid';
      status.textContent = failure?.message || 'No se pudo completar la migración de ventas.';
      errorBox.textContent = status.textContent;
      errorBox.classList.remove('hidden');
    } finally {
      salesBusy = false;
      modal.querySelector('.modal-card').setAttribute('aria-busy', 'false');
      el('migrationSalesCancelBtn').disabled = false;
      syncSalesOriginConfirmation();
      renderBasicMigrationButton();
      renderInventoryMigrationButton();
      renderSalesMigrationButton();
      renderPurchasesMigrationButton();
      if (modal.classList.contains('hidden') && salesTrigger?.isConnected) salesTrigger.focus();
      if (completed) {
        await updateSalesPreview();
        renderSalesMigrationResult(completedResult);
      }
    }
  }

  function renderPurchasesMigrationButton() {
    const button = el('migrationPurchasesStartBtn');
    const target = destination();
    const targetId = target ? String(target.id) : '';
    const visible = Boolean(canAccess() && packageValue && target && target.status === 'ACTIVE' && purchasesPreview);
    el('migrationPurchasesSummary').classList.toggle('hidden', !visible);
    button.disabled = !visible || !purchasesPreview?.eligible || migrationBusy || inventoryBusy || salesBusy || purchasesBusy || creditBusy || completedPurchasesTargets.has(targetId);
    button.textContent = completedPurchasesTargets.has(targetId) ? 'Compras históricas completadas para este destino' : 'Migrar compras históricas';
  }

  function renderPurchasesMigrationResult(result) {
    el('migrationPurchasesCreated').textContent = packageCount(result.created.purchases);
    el('migrationPurchasesSkipped').textContent = packageCount(result.skipped.purchases);
    const warnings = el('migrationPurchasesResultWarnings');
    warnings.replaceChildren(...(result.warnings.length
      ? result.warnings.map(warning => node('li', '', warning))
      : [node('li', '', 'No hubo advertencias adicionales.')]));
    el('migrationPurchasesResult').classList.remove('hidden');
    el('migrationPurchasesStatus').textContent = 'Migración de compras históricas completada.';
    el('migrationPurchasesStatus').dataset.state = 'valid';
  }

  async function updatePurchasesPreview() {
    const token = ++purchasesPreviewToken;
    const requestToken = packageReadToken;
    const target = destination();
    purchasesPreview = null;
    el('migrationPurchasesSummary').classList.add('hidden');
    renderPurchasesMigrationButton();
    const gateStatus = el('migrationPurchasesGateStatus');
    gateStatus.classList.add('hidden');
    gateStatus.textContent = '';
    if (!canAccess() || !packageValue || !target || target.status !== 'ACTIVE' || migrationBusy || inventoryBusy || salesBusy || purchasesBusy || creditBusy || !previewPurchasesRequest) return;
    const status = el('migrationPurchasesStatus');
    status.dataset.state = '';
    status.textContent = 'Verificando proveedor, productos y saldos operativos…';
    gateStatus.textContent = 'Verificando la migración básica, el esquema histórico y las relaciones del destino…';
    gateStatus.classList.remove('hidden');
    try {
      const preview = await previewPurchasesRequest(String(target.id), packageValue);
      if (token !== purchasesPreviewToken || requestToken !== packageReadToken || !canAccess() || String(target.id) !== String(destination()?.id)) return;
      purchasesPreview = preview;
      el('migrationPurchasesDetected').textContent = packageCount(preview.purchases.detected);
      el('migrationPurchasesCanMigrate').textContent = packageCount(preview.purchases.couldMigrate);
      el('migrationPurchasesToSkip').textContent = packageCount(preview.purchases.toSkip);
      const diagnosticLabels = [
        ['suppliersUnmatched', 'proveedores sin correspondencia'], ['suppliersAmbiguous', 'proveedores ambiguos'],
        ['productsUnmatched', 'productos sin correspondencia'], ['productsAmbiguous', 'productos ambiguos'],
        ['duplicateInvoices', 'facturas duplicadas'], ['missingCosts', 'costos faltantes'],
        ['inconsistentTotals', 'totales inconsistentes'], ['unsupportedStatuses', 'estados no compatibles']
      ];
      const diagnostics = diagnosticLabels.filter(([key]) => preview.diagnostics[key] > 0)
        .map(([key, label]) => packageCount(preview.diagnostics[key]) + ' ' + label);
      el('migrationPurchasesDiagnostics').textContent = diagnostics.length ? diagnostics.join(' · ') : 'Sin costos, relaciones, estados ni totales inconsistentes.';
      const warnings = el('migrationPurchasesWarnings');
      warnings.replaceChildren(...(preview.warnings.length
        ? preview.warnings.map(warning => node('li', 'migration-warn', warning))
        : [node('li', 'migration-ok', 'No se detectaron compras que deban omitirse.')]));
      if (!preview.eligible) {
        status.textContent = '';
        gateStatus.textContent = preview.warnings.join(' ');
        renderPurchasesMigrationButton();
        return;
      }
      gateStatus.classList.add('hidden');
      status.textContent = preview.warnings.join(' ');
      renderPurchasesMigrationButton();
    } catch (failure) {
      if (token !== purchasesPreviewToken || requestToken !== packageReadToken || !canAccess()) return;
      gateStatus.dataset.state = 'invalid';
      gateStatus.textContent = failure?.message || 'No se pudieron revisar las compras del paquete.';
      gateStatus.classList.remove('hidden');
      renderPurchasesMigrationButton();
    }
  }

  function closePurchasesMigrationConfirmation() {
    const modal = el('migrationPurchasesConfirmModal');
    if (purchasesBusy) return;
    modal.classList.add('hidden');
    if (purchasesTrigger?.isConnected) purchasesTrigger.focus();
  }

  function openPurchasesMigrationConfirmation() {
    const target = destination();
    if (!canAccess() || !packageValue || !target || target.status !== 'ACTIVE' || migrationBusy || inventoryBusy || salesBusy || purchasesBusy || creditBusy || !purchasesPreview?.eligible) return;
    purchasesTrigger = el('migrationPurchasesStartBtn');
    el('migrationPurchasesConfirmSource').textContent = text(packageValue.business.name) || 'No disponible';
    el('migrationPurchasesConfirmTarget').textContent = target.name + ' (#' + target.id + ')';
    el('migrationPurchasesConfirmDetected').textContent = packageCount(purchasesPreview.purchases.detected);
    el('migrationPurchasesConfirmCanMigrate').textContent = packageCount(purchasesPreview.purchases.couldMigrate);
    el('migrationPurchasesConfirmToSkip').textContent = packageCount(purchasesPreview.purchases.toSkip);
    const warnings = el('migrationPurchasesConfirmWarnings');
    warnings.replaceChildren(...(purchasesPreview.warnings.length
      ? purchasesPreview.warnings.map(warning => node('li', 'migration-warn', warning))
      : [node('li', 'migration-ok', 'No se detectaron compras que deban omitirse.')]));
    el('migrationPurchasesConfirmError').classList.add('hidden');
    el('migrationPurchasesConfirmError').textContent = '';
    el('migrationPurchasesConfirmModal').classList.remove('hidden');
    el('migrationPurchasesConfirmTitle').focus();
  }

  async function confirmPurchasesMigration() {
    const target = destination();
    if (migrationBusy || inventoryBusy || salesBusy || purchasesBusy || creditBusy || !canAccess() || !packageValue || !target || target.status !== 'ACTIVE' || !purchasesPreview?.eligible || !migratePurchasesRequest) return;
    const requestToken = packageReadToken;
    purchasesBusy = true;
    const modal = el('migrationPurchasesConfirmModal');
    const errorBox = el('migrationPurchasesConfirmError');
    const status = el('migrationPurchasesStatus');
    el('migrationPurchasesStartBtn').disabled = true;
    el('migrationPurchasesConfirmBtn').disabled = true;
    el('migrationPurchasesCancelBtn').disabled = true;
    modal.querySelector('.modal-card').setAttribute('aria-busy', 'true');
    status.dataset.state = '';
    status.textContent = 'Registrando compras históricas…';
    errorBox.classList.add('hidden');
    let completed = false;
    try {
      const result = await migratePurchasesRequest(String(target.id), packageValue);
      if (!canAccess() || requestToken !== packageReadToken) return;
      completedPurchasesTargets.add(String(target.id));
      renderPurchasesMigrationResult(result);
      modal.classList.add('hidden');
      completed = true;
    } catch (failure) {
      if (!canAccess() || requestToken !== packageReadToken) return;
      status.dataset.state = 'invalid';
      status.textContent = failure?.message || 'No se pudo completar la migración de compras.';
      errorBox.textContent = status.textContent;
      errorBox.classList.remove('hidden');
    } finally {
      purchasesBusy = false;
      modal.querySelector('.modal-card').setAttribute('aria-busy', 'false');
      el('migrationPurchasesCancelBtn').disabled = false;
      el('migrationPurchasesConfirmBtn').disabled = false;
      renderBasicMigrationButton();
      renderInventoryMigrationButton();
      renderSalesMigrationButton();
      renderPurchasesMigrationButton();
      if (modal.classList.contains('hidden') && purchasesTrigger?.isConnected) purchasesTrigger.focus();
      if (completed) await updatePurchasesPreview();
    }
  }

  function closeBasicMigrationConfirmation() {
    const modal = el('migrationBasicConfirmModal');
    if (migrationBusy) return;
    modal.classList.add('hidden');
    if (migrationTrigger?.isConnected) migrationTrigger.focus();
  }

  function openBasicMigrationConfirmation() {
    const target = destination();
    if (!canAccess() || !packageValue || !target || target.status !== 'ACTIVE' || migrationBusy || inventoryBusy || purchasesBusy || creditBusy || completedTargets.has(String(target.id))) return;
    migrationTrigger = el('migrationBasicStartBtn');
    el('migrationConfirmSource').textContent = text(packageValue.business.name) || 'No disponible';
    el('migrationConfirmTarget').textContent = target.name + ' (#' + target.id + ')';
    el('migrationConfirmProducts').textContent = el('migrationBasicProducts').textContent;
    el('migrationConfirmClients').textContent = el('migrationBasicClients').textContent;
    el('migrationConfirmSuppliers').textContent = el('migrationBasicSuppliers').textContent;
    const systemBusiness = String(target.id) === '1';
    el('migrationSystemBusinessConfirmWrap').classList.toggle('hidden', !systemBusiness);
    el('migrationSystemBusinessConfirm').checked = false;
    el('migrationBasicConfirmError').classList.add('hidden');
    el('migrationBasicConfirmError').textContent = '';
    el('migrationBasicConfirmBtn').disabled = systemBusiness;
    el('migrationBasicConfirmModal').classList.remove('hidden');
    el('migrationBasicConfirmTitle').focus();
  }

  function renderBasicMigrationResult(result) {
    for (const kind of ['products', 'clients', 'suppliers']) {
      const label = kind[0].toUpperCase() + kind.slice(1);
      el('migrationResult' + label + 'Created').textContent = packageCount(result.created[kind]);
      el('migrationResult' + label + 'Skipped').textContent = packageCount(result.skipped[kind]);
    }
    const warnings = el('migrationBasicWarnings');
    warnings.replaceChildren(...(result.warnings.length
      ? result.warnings.map(warning => node('li', '', warning))
      : [node('li', '', 'No hubo advertencias adicionales.')]));
    el('migrationBasicResult').classList.remove('hidden');
    el('migrationBasicStatus').textContent = 'Migración básica completada.';
    el('migrationBasicStatus').dataset.state = 'valid';
  }

  async function confirmBasicMigration() {
    const target = destination();
    const confirmSystemBusiness = String(target?.id) === '1' && el('migrationSystemBusinessConfirm').checked;
    if (migrationBusy || inventoryBusy || purchasesBusy || creditBusy || !canAccess() || !packageValue || !target || target.status !== 'ACTIVE' || !migrateBasicRequest || (String(target.id) === '1' && !confirmSystemBusiness)) return;
    const requestToken = packageReadToken;
    migrationBusy = true;
    el('migrationBasicStartBtn').disabled = true;
    el('migrationBasicConfirmBtn').disabled = true;
    el('migrationBasicCancelBtn').disabled = true;
    const status = el('migrationBasicStatus');
    status.dataset.state = '';
    status.textContent = 'Migrando productos, clientes y proveedores…';
    el('migrationBasicConfirmError').classList.add('hidden');
    try {
      const result = await migrateBasicRequest(String(target.id), packageValue, confirmSystemBusiness);
      if (!canAccess() || requestToken !== packageReadToken) return;
      completedTargets.add(String(target.id));
      renderBasicMigrationResult(result);
      el('migrationBasicConfirmModal').classList.add('hidden');
    } catch (failure) {
      if (!canAccess() || requestToken !== packageReadToken) return;
      status.dataset.state = 'invalid';
      status.textContent = failure?.message || 'No se pudo completar la migración básica.';
      const errorBox = el('migrationBasicConfirmError');
      errorBox.textContent = status.textContent;
      errorBox.classList.remove('hidden');
    } finally {
      migrationBusy = false;
      el('migrationBasicCancelBtn').disabled = false;
      renderBasicMigrationButton();
      if (el('migrationBasicConfirmModal').classList.contains('hidden') && migrationTrigger?.isConnected) migrationTrigger.focus();
      if (completedTargets.has(String(target.id))) {
        await updateInventoryPreview();
        await updateSalesPreview();
        await updatePurchasesPreview();
      }
    }
  }

  async function readPackage(file) {
    if (!canAccess() || migrationBusy || inventoryBusy || salesBusy || purchasesBusy || creditBusy || archiveBusy || !el('migrationBasicConfirmModal').classList.contains('hidden') || !el('migrationInventoryConfirmModal').classList.contains('hidden') || !el('migrationSalesConfirmModal').classList.contains('hidden') || !el('migrationPurchasesConfirmModal').classList.contains('hidden') || !el('migrationCreditConfirmModal').classList.contains('hidden')) return;
    const token = ++packageReadToken;
    packageValue = null;
    packageFileSha256 = null;
    archivePreviewToken++;
    archivePreview = null;
    el('migrationArchiveCard').classList.add('hidden');
    el('migrationArchiveReview').classList.add('hidden');
    el('migrationArchiveConfirm').checked = false;
    el('migrationArchiveConfirm').disabled = true;
    el('migrationLegacyIdentityConfirmationGroup')?.classList.add('hidden');
    el('migrationArchiveIdentityDetails')?.replaceChildren();
    el('migrationArchiveIdentityDetails')?.classList.add('hidden');
    el('migrationArchiveStatus').textContent = '';
    el('migrationArchiveStatus').dataset.state = '';
    resetFullMigrationStages();
    creditPreview = null;
    el('migrationCreditResult').classList.add('hidden');
    renderCreditMigrationButton();
    creditPreviewToken++;
    el('migrationCreditSummary')?.classList.add('hidden');
    completedTargets.clear();
    el('migrationBasicSummary').classList.add('hidden');
    el('migrationBasicResult').classList.add('hidden');
    el('migrationBasicStatus').textContent = '';
    inventoryPreviewToken++;
    inventoryPreview = null;
    completedInventoryTargets.clear();
    el('migrationInventorySummary').classList.add('hidden');
    el('migrationInventoryResult').classList.add('hidden');
    el('migrationInventoryStatus').textContent = '';
    el('migrationInventoryGateStatus').classList.add('hidden');
    el('migrationInventoryGateStatus').textContent = '';
    salesPreviewToken++;
    salesPreview = null;
    completedSalesTargets.clear();
    el('migrationSalesSummary').classList.add('hidden');
    el('migrationSalesResult').classList.add('hidden');
    el('migrationSalesStatus').textContent = '';
    el('migrationSalesGateStatus').classList.add('hidden');
    el('migrationSalesGateStatus').dataset.state = '';
    el('migrationSalesGateTitle').textContent = 'Bloqueo de migración';
    el('migrationSalesGateWarnings').replaceChildren();
    purchasesPreviewToken++;
    purchasesPreview = null;
    completedPurchasesTargets.clear();
    el('migrationPurchasesSummary').classList.add('hidden');
    el('migrationPurchasesResult').classList.add('hidden');
    el('migrationPurchasesStatus').textContent = '';
    el('migrationPurchasesGateStatus').classList.add('hidden');
    el('migrationPurchasesGateStatus').textContent = '';
    el('migrationPurchasesConfirmModal').classList.add('hidden');
    renderBasicMigrationButton();
    renderSalesMigrationButton();
    renderPurchasesMigrationButton();
    renderCreditMigrationButton();
    el('migrationPackageReview').classList.add('hidden');
    el('migrationPackageStatus').textContent = '';
    let value;
    try {
      if (!file || !/\.json$/i.test(file.name) || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 32 * 1024 * 1024 || !window.crypto?.subtle) throw new Error('Invalid package file');
      const bytes = await file.arrayBuffer();
      packageFileSha256 = Array.from(new Uint8Array(await window.crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
      const rawText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      value = JSON.parse(rawText.replace(/^\uFEFF/, ''));
    } catch {
      if (token !== packageReadToken) return;
      packageValue = null;
      packageFileSha256 = null;
      creditPreview = null;
      el('migrationCreditResult').classList.add('hidden');
      renderCreditMigrationButton();
      creditPreviewToken++;
      el('migrationCreditSummary')?.classList.add('hidden');
      el('migrationBasicSummary').classList.add('hidden');
      renderBasicMigrationButton();
      renderPurchasesMigrationButton();
      el('migrationPackageStatus').dataset.state = 'invalid';
      el('migrationPackageStatus').textContent = INVALID_PACKAGE_MESSAGE;
      return;
    }
    if (token !== packageReadToken) return;
    if (!isRecord(value) || value.type !== 'pos_local_migration_package' || ![1, 2].includes(value.version) ||
        !isRecord(value.data) || !Array.isArray(value.data.products) || !Array.isArray(value.data.clients) ||
        !Array.isArray(value.data.suppliers) || !Array.isArray(value.data.purchases) || !isRecord(value.summary) || !isRecord(value.business)) {
      packageValue = null;
      creditPreview = null;
      el('migrationCreditResult').classList.add('hidden');
      renderCreditMigrationButton();
      creditPreviewToken++;
      el('migrationCreditSummary')?.classList.add('hidden');
      el('migrationBasicSummary').classList.add('hidden');
      renderBasicMigrationButton();
      renderPurchasesMigrationButton();
      el('migrationPackageStatus').dataset.state = 'invalid';
      el('migrationPackageStatus').textContent = INVALID_PACKAGE_MESSAGE;
      return;
    }
    showPackage(value);
    el('migrationPackageStatus').dataset.state = 'valid';
    el('migrationPackageStatus').textContent = VALID_PACKAGE_MESSAGE;
  }

  function setupPackageReader() {
    const input = el('migrationPackageFile');
    const dropzone = el('migrationPackageDropzone');
    input.addEventListener('change', () => {
      const [file] = input.files || [];
      if (file) readPackage(file);
      input.value = '';
    });
    el('migrationBusiness').addEventListener('change', () => {
      el('migrationBasicResult').classList.add('hidden');
      el('migrationCreditResult').classList.add('hidden');
      el('migrationBasicStatus').textContent = '';
      renderBasicMigrationButton();
      void updateInventoryPreview();
      void updateSalesPreview();
      void updatePurchasesPreview();
      void updateCreditPreview();
      void updateArchivePreview();
    });
    el('migrationBasicStartBtn').addEventListener('click', openBasicMigrationConfirmation);
    el('migrationBasicCancelBtn').addEventListener('click', closeBasicMigrationConfirmation);
    el('migrationBasicConfirmBtn').addEventListener('click', confirmBasicMigration);
    el('migrationSystemBusinessConfirm').addEventListener('change', event => {
      el('migrationBasicConfirmBtn').disabled = !event.currentTarget.checked || migrationBusy;
    });
    el('migrationBasicConfirmModal').addEventListener('click', event => {
      if (event.target.classList.contains('modal-overlay')) closeBasicMigrationConfirmation();
    });
    el('migrationInventoryStartBtn').addEventListener('click', openInventoryMigrationConfirmation);
    el('migrationInventoryCancelBtn').addEventListener('click', closeInventoryMigrationConfirmation);
    el('migrationInventoryConfirmBtn').addEventListener('click', confirmInventoryMigration);
    el('migrationInventoryConfirmModal').addEventListener('click', event => {
      if (event.target.classList.contains('modal-overlay')) closeInventoryMigrationConfirmation();
    });
    el('migrationSalesStartBtn').addEventListener('click', openSalesMigrationConfirmation);
    el('migrationSalesCancelBtn').addEventListener('click', closeSalesMigrationConfirmation);
    el('migrationSalesConfirmBtn').addEventListener('click', confirmSalesMigration);
    el('migrationSalesOriginConfirm').addEventListener('change', syncSalesOriginConfirmation);
    el('migrationSalesConfirmModal').addEventListener('click', event => {
      if (event.target.classList.contains('modal-overlay')) closeSalesMigrationConfirmation();
    });
    el('migrationPurchasesStartBtn').addEventListener('click', openPurchasesMigrationConfirmation);
    el('migrationPurchasesCancelBtn').addEventListener('click', closePurchasesMigrationConfirmation);
    el('migrationPurchasesConfirmBtn').addEventListener('click', confirmPurchasesMigration);
    el('migrationPurchasesConfirmModal').addEventListener('click', event => {
      if (event.target.classList.contains('modal-overlay')) closePurchasesMigrationConfirmation();
    });
    el('migrationCreditImportBtn').addEventListener('click', openCreditMigrationConfirmation);
    el('migrationCreditCancelBtn').addEventListener('click', closeCreditMigrationConfirmation);
    el('migrationCreditConfirmBtn').addEventListener('click', confirmCreditMigration);
    el('migrationCreditOriginConfirm').addEventListener('change', syncCreditOriginConfirmation);
    el('migrationCreditConfirmModal').addEventListener('click', event => {
      if (event.target.classList.contains('modal-overlay')) closeCreditMigrationConfirmation();
    });
    el('migrationArchiveConfirm').addEventListener('change', updateArchiveApplyButton);
    el('migrationArchiveApplyBtn').addEventListener('click', migrateFullPackage);
    el('migrationExistingBusiness').addEventListener('change', () => clearExistingTargetReview());
    el('migrationExistingInspectBtn').addEventListener('click', inspectExistingMigrationTarget);
    el('migrationExistingConfirm').addEventListener('change', updateExistingPrepareButton);
    el('migrationExistingPrepareBtn').addEventListener('click', prepareExistingMigrationTarget);
    el('migrationTargetCreateBtn').addEventListener('click', createMigrationTarget);
    el('migrationTargetName').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); createMigrationTarget(); } });
    document.addEventListener('keydown', event => {
      const modal = el('migrationCreditConfirmModal');
      if (modal.classList.contains('hidden')) return;
      if (event.key === 'Escape') { closeCreditMigrationConfirmation(); return; }
      if (event.key === 'Tab') {
        const controls = [...modal.querySelectorAll('button:not(:disabled), input:not(:disabled)')].filter(control => control.getClientRects().length);
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    });
    document.addEventListener('keydown', event => {
      const modal = el('migrationPurchasesConfirmModal');
      if (modal.classList.contains('hidden')) return;
      if (event.key === 'Escape') { closePurchasesMigrationConfirmation(); return; }
      if (event.key === 'Tab') {
        const controls = [...modal.querySelectorAll('button:not(:disabled), input:not(:disabled)')].filter(control => control.getClientRects().length);
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    });
    document.addEventListener('keydown', event => {
      const modal = el('migrationBasicConfirmModal');
      if (modal.classList.contains('hidden')) return;
      if (event.key === 'Escape') { closeBasicMigrationConfirmation(); return; }
      if (event.key === 'Tab') {
        const controls = [...modal.querySelectorAll('button:not(:disabled), input:not(:disabled)')].filter(control => control.getClientRects().length);
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    });
    document.addEventListener('keydown', event => {
      const modal = el('migrationInventoryConfirmModal');
      if (modal.classList.contains('hidden')) return;
      if (event.key === 'Escape') { closeInventoryMigrationConfirmation(); return; }
      if (event.key === 'Tab') {
        const controls = [...modal.querySelectorAll('button:not(:disabled), input:not(:disabled)')].filter(control => control.getClientRects().length);
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    });
    document.addEventListener('keydown', event => {
      const modal = el('migrationSalesConfirmModal');
      if (modal.classList.contains('hidden')) return;
      if (event.key === 'Escape') { closeSalesMigrationConfirmation(); return; }
      if (event.key === 'Tab') {
        const controls = [...modal.querySelectorAll('button:not(:disabled)')].filter(control => control.getClientRects().length);
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    });
    dropzone.addEventListener('dragover', event => {
      event.preventDefault();
      dropzone.classList.add('is-dragging');
    });
    dropzone.addEventListener('dragleave', event => {
      if (!dropzone.contains(event.relatedTarget)) dropzone.classList.remove('is-dragging');
    });
    dropzone.addEventListener('drop', event => {
      event.preventDefault();
      dropzone.classList.remove('is-dragging');
      const [file] = event.dataTransfer?.files || [];
      readPackage(file);
    });
  }

  async function refresh() {
    if (!canAccess() || loading) return;
    const status = el('migrationStatus');
    status.classList.remove('hidden');
    if (!packageValue) {
      report = null;
      el('migrationResult').classList.add('hidden');
      status.textContent = 'Carga el archivo JSON que recibiste para revisar su contenido.';
      return;
    }
    loading = true;
    el('migrationRefreshBtn').disabled = true;
    status.textContent = 'Calculando el resumen del archivo JSON?';
    try {
      const field = name => Array.isArray(packageValue.data[name]) ? packageValue.data[name] : [];
      const tables = {
        products: field('products'), clients: field('clients'), suppliers: field('suppliers'),
        sales: field('sales'), purchases: field('purchases'), cajaSessions: field('cashSessions'),
        inventory_movements: field('inventoryMovements'), abonos: field('abonos')
      };
      report = buildReport(tables);
      const business = packageValue.business || {};
      const scope = packageValue.source?.scope || {};
      localIdentity = {
        name: text(business.name),
        id: text(business.localBusinessId || business.local_business_id || scope.localBusinessId),
        idSource: scope.idSource,
        idsFound: scope.idsFound
      };
      localScope = scope;
      renderLocalIdentity(localIdentity, localScope);
      sim = { added: [], map: {}, general: false };
      simNotice('');
      el('migrationResult').classList.remove('hidden');
      status.textContent = 'Resumen calculado exclusivamente desde el paquete JSON. No se consulto el POS local ni se enviaron datos al servidor.';
      renderReport();
    } catch (failure) {
      status.textContent = failure?.message || 'No se pudo resumir el paquete JSON.';
    } finally {
      loading = false;
      el('migrationRefreshBtn').disabled = false;
    }
  }

  function show(options) {
    canAccess = options.canAccess; businesses = options.businesses || [];
    createMigrationTargetRequest = options.createMigrationTarget;
    inspectExistingMigrationTargetRequest = options.inspectExistingMigrationTarget;
    prepareExistingMigrationTargetRequest = options.prepareExistingMigrationTarget;
    existingTargetBusy = false;
    existingTargetInspection = null;
    clearExistingTargetReview();
    renderExistingBusinessOptions();
    migrateBasicRequest = options.migrateBasic;
    previewInventoryRequest = options.previewInventory;
    migrateInventoryRequest = options.migrateInventory;
    previewCreditRequest = options.previewCredit;
    migrateCreditRequest = options.migrateCredit;
    previewSalesRequest = options.previewSales;
    migrateSalesRequest = options.migrateSales;
    previewPurchasesRequest = options.previewPurchases;
    migratePurchasesRequest = options.migratePurchases;
    previewArchiveRequest = options.previewArchive;
    archiveMigrationRequest = options.archiveFull;
    archiveStatusRequest = options.archiveStatus;
    projectMigrationOperationsRequest = options.projectMigrationOperations;
    reviewIdentityRecordRequest = options.reviewIdentityRecord;
    if (!canAccess()) return;
    const select = el('migrationBusiness'), previous = String(options.targetBusinessId || select.value);
    renderBusinessOptions(previous);
    el('migrationTargetCreateBtn').disabled = !createMigrationTargetRequest;
    el('migrationExistingInspectBtn').disabled = !inspectExistingMigrationTargetRequest || !el('migrationExistingBusiness').value;
    const destinationHelp = select.parentElement?.nextElementSibling;
    if (destinationHelp) destinationHelp.textContent = 'El negocio permanecerá bloqueado hasta que el sistema importe y concilie toda la información.';
    renderBasicMigrationButton();
    renderCreditMigrationButton();
    void updateInventoryPreview();
    void updateSalesPreview();
    void updatePurchasesPreview();
    void updateCreditPreview();
    void updateArchivePreview();
  }

  function reset() {
    previewCreditRequest = null;
    report = null; localIdentity = null; localScope = null; sim = { added: [], map: {}, general: false };
    packageReadToken++;
    archivePreviewToken++;
    inventoryPreviewToken++;
    salesPreviewToken++;
    purchasesPreviewToken++;
    packageValue = null;
    creditPreviewToken++;
    el('migrationCreditSummary')?.classList.add('hidden');
    migrationBusy = false; inventoryBusy = false; salesBusy = false; purchasesBusy = false; creditBusy = false; archiveBusy = false; identityReviewBusyKey = ''; existingTargetBusy = false; existingTargetRequestToken++; existingTargetInspection = null; createMigrationTargetRequest = null; inspectExistingMigrationTargetRequest = null; prepareExistingMigrationTargetRequest = null; migrateBasicRequest = null; previewInventoryRequest = null; migrateInventoryRequest = null; previewSalesRequest = null; migrateSalesRequest = null; previewPurchasesRequest = null; migratePurchasesRequest = null; migrateCreditRequest = null; previewArchiveRequest = null; archiveMigrationRequest = null; archiveStatusRequest = null; projectMigrationOperationsRequest = null; reviewIdentityRecordRequest = null; archivePreview = null; creditPreview = null; inventoryPreview = null; salesPreview = null; purchasesPreview = null; completedTargets.clear(); completedInventoryTargets.clear(); completedSalesTargets.clear(); completedPurchasesTargets.clear();
    el('migrationResult')?.classList.add('hidden');
    el('migrationOriginCounts')?.replaceChildren(card('Productos', '—'), card('Clientes', '—'), card('Ventas', '—'));
    el('migrationSourceNote')?.classList.remove('is-legacy');
    el('migrationPackageFile').value = '';
    el('migrationArchiveCard')?.classList.add('hidden');
    if (el('migrationTargetStatus')) el('migrationTargetStatus').textContent = '';
    if (el('migrationExistingStatus')) el('migrationExistingStatus').textContent = '';
    if (el('migrationExistingBusiness')) el('migrationExistingBusiness').value = '';
    if (el('migrationExistingReview')) el('migrationExistingReview').classList.add('hidden');
    if (el('migrationExistingConfirm')) { el('migrationExistingConfirm').checked = false; el('migrationExistingConfirm').disabled = true; }
    if (el('migrationExistingPrepareBtn')) el('migrationExistingPrepareBtn').disabled = true;
    el('migrationArchiveReview')?.classList.add('hidden');
    if (el('migrationArchiveConfirm')) { el('migrationArchiveConfirm').checked = false; el('migrationArchiveConfirm').disabled = true; }
    el('migrationLegacyIdentityConfirmationGroup')?.classList.add('hidden');
    el('migrationArchiveIdentityDetails')?.replaceChildren();
    el('migrationArchiveIdentityDetails')?.classList.add('hidden');
    if (el('migrationArchiveStatus')) el('migrationArchiveStatus').textContent = '';
    resetFullMigrationStages();
    el('migrationPackageReview').classList.add('hidden');
    el('migrationBasicSummary').classList.add('hidden');
    el('migrationBasicResult').classList.add('hidden');
    el('migrationBasicStatus').textContent = '';
    el('migrationBasicConfirmModal').classList.add('hidden');
    el('migrationInventorySummary')?.classList.add('hidden');
    el('migrationInventoryResult')?.classList.add('hidden');
    el('migrationInventoryStatus').textContent = '';
    el('migrationInventoryGateStatus')?.classList.add('hidden');
    el('migrationInventoryGateStatus').textContent = '';
    el('migrationInventoryConfirmModal').classList.add('hidden');
    el('migrationSalesSummary')?.classList.add('hidden');
    el('migrationSalesResult')?.classList.add('hidden');
    el('migrationSalesStatus').textContent = '';
    el('migrationSalesGateStatus')?.classList.add('hidden');
    el('migrationSalesGateStatus').dataset.state = '';
    el('migrationSalesGateTitle').textContent = 'Bloqueo de migración';
    el('migrationSalesGateWarnings').replaceChildren();
    el('migrationSalesConfirmModal').classList.add('hidden');
    el('migrationSalesOriginWarning')?.classList.add('hidden');
    if (el('migrationSalesOriginConfirm')) el('migrationSalesOriginConfirm').checked = false;
    el('migrationPurchasesSummary')?.classList.add('hidden');
    el('migrationPurchasesResult')?.classList.add('hidden');
    el('migrationPurchasesStatus').textContent = '';
    el('migrationPurchasesGateStatus')?.classList.add('hidden');
    el('migrationPurchasesGateStatus').textContent = '';
    el('migrationPurchasesConfirmModal').classList.add('hidden');
    el('migrationCreditConfirmModal').classList.add('hidden');
    el('migrationCreditResult').classList.add('hidden');
    el('migrationPackageStatus').dataset.state = '';
    el('migrationPackageStatus').textContent = 'Aún no se ha seleccionado un paquete.';
    el('migrationIdentityReview')?.classList.add('hidden');
    el('migrationIdentityReview')?.replaceChildren();
  }

  function init() {
    if (!el('migrationRefreshBtn')) return;
    setupPackageReader();
    el('migrationCreditRefreshBtn').addEventListener('click', updateCreditPreview);
    el('migrationRefreshBtn').addEventListener('click', refresh);
    el('migrationType').addEventListener('change', () => { if (report && canAccess()) renderReport(); });
    el('migrationBusiness').addEventListener('change', () => { void updateInventoryPreview(); if (report && canAccess()) { const status = el('migrationStatus'); status.textContent = 'Se validará el paquete para el negocio seleccionado antes de iniciar la migración.'; status.classList.remove('hidden'); } });
    el('migrationAddForm').addEventListener('submit', event => {
      event.preventDefault(); if (!report || !canAccess()) return;
      const input = el('migrationAddName'), name = text(input.value);
      if (!name) { simNotice('Escribe el nombre de la categoría a simular.'); return; }
      if (simulatedCategories().some(row => norm(row.name) === norm(name))) { simNotice('Esa categoría ya existe en la simulación.'); return; }
      sim.added.push(name); input.value = ''; simNotice('Simulado: se agregaría la categoría «' + name + '». No se guardó nada.'); renderCategories();
    });
    el('migrationRenameForm').addEventListener('submit', event => {
      event.preventDefault(); if (!report || !canAccess()) return;
      const from = el('migrationRenameFrom').value, input = el('migrationRenameTo'), to = text(input.value);
      if (!from || !to) { simNotice('Elige la categoría y escribe el nuevo nombre.'); return; }
      if (norm(from) === norm(to)) { simNotice('El nuevo nombre es igual al actual.'); return; }
      if (simulatedCategories().some(row => norm(row.name) === norm(to))) { simNotice('Ya existe una categoría con ese nombre; usa fusionar.'); return; }
      sim.map[from] = to; sim.added = sim.added.map(name => name === from ? to : name); input.value = '';
      simNotice('Simulado: «' + from + '» se renombraría a «' + to + '». No se guardó nada.'); renderCategories();
    });
    el('migrationMergeForm').addEventListener('submit', event => {
      event.preventDefault(); if (!report || !canAccess()) return;
      const from = el('migrationMergeFrom').value, to = el('migrationMergeTo').value;
      if (!from || !to || from === to) { simNotice('Elige dos categorías distintas para fusionar.'); return; }
      sim.map[from] = to; sim.added = sim.added.filter(name => name !== from);
      simNotice('Simulado: «' + from + '» se fusionaría en «' + to + '». No se guardó nada.'); renderCategories();
    });
    el('migrationAssignGeneralBtn').addEventListener('click', () => {
      if (!report || !canAccess()) return;
      sim.general = true; simNotice('Simulado: los productos sin categoría pasarían a «General». No se guardó nada.'); renderCategories();
    });
    el('migrationResetSimBtn').addEventListener('click', () => { if (!report) return; sim = { added: [], map: {}, general: false }; simNotice('Simulación descartada.'); renderCategories(); });
  }

  window.PosMigrationPreview = Object.freeze({ show, reset });
  init();
})();
