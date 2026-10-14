/* global Dexie */
"use strict";
/*
 * Revisión del paquete y previsualización opcional del navegador local.
 * La lectura de Dexie usa transacciones readonly; solo la confirmación de la
 * fase básica envía productos, clientes y proveedores al backend conectado.
 * Nunca escribe en Dexie ni guarda la simulación de categorías.
 */
(() => {
  const LOCAL_DB_NAME = 'POS_OfflineDB';
  const LOCAL_CONFIG_KEY = 'posSystemConfig';
  const LEGACY_BUSINESS_ID = '00000000-0000-0000-0000-000000000000';
  const BASIC_STORES = ['products', 'clients', 'suppliers', 'inventory_movements'];
  const FULL_STORES = ['sales', 'purchases', 'cajaSessions', 'abonos'];
  const el = id => document.getElementById(id);
  const r2 = value => Math.round((Number(value) || 0) * 100) / 100;
  const text = value => String(value ?? '').trim();
  const norm = value => text(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ');
  const money = value => r2(value).toLocaleString('es-NI', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const SAFE_MESSAGE = 'La migración completa permanece deshabilitada; esta fase solo permite importar datos básicos.';

  let canAccess = () => false;
  let businesses = [];
  let localIdentity = null;
  let localScope = null;
  let data = null;      // copia en memoria de los datos locales (solo lectura)
  let report = null;    // conteos y advertencias calculados
  let loading = false;
  let packageReadToken = 0;
  let packageValue = null;
  let migrationBusy = false;
  let migrationTrigger = null;
  let migrateBasicRequest = null;
  let previewInventoryRequest = null;
  let migrateInventoryRequest = null;
  let inventoryPreviewToken = 0;
  let inventoryPreview = null;
  let inventoryBusy = false;
  let inventoryTrigger = null;
  const completedTargets = new Set();
  const completedInventoryTargets = new Set();
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

  function readLocalIdentity() {
    let config = {};
    try { config = JSON.parse(localStorage.getItem(LOCAL_CONFIG_KEY) || '{}') || {}; } catch { /* config local no legible */ }
    const configuredId = text(config.localBusinessId || config.local_business_id || config.businessId || config.business_id).toLowerCase();
    return {
      name: text(config.name) || 'POS DISTRIBUIDORA',
      configuredId: configuredId && configuredId !== LEGACY_BUSINESS_ID ? configuredId : ''
    };
  }

  function businessIdOf(row) {
    return text(row?.business_id ?? row?.businessId ?? row?.localBusinessId).toLowerCase();
  }

  function renderLocalIdentity(identity, scope = null) {
    el('migrationLocalBusinessName').textContent = identity.name;
    const businessId = identity.id || identity.configuredId;
    el('migrationLocalBusinessId').textContent = businessId
      ? businessId + (identity.idSource === 'inferred' ? ' (detectado en los registros)' : '')
      : identity.idSource === 'ambiguous'
        ? 'No configurado; hay varios business_id'
        : 'No configurado (identificador legado compartido)';

    const note = el('migrationSourceNote');
    note.classList.toggle('is-legacy', !businessId || identity.idSource === 'ambiguous');
    if (businessId && !scope) el('migrationSourceCountTitle').textContent = 'Datos detectados para el ID local';
    else if (businessId && !scope.legacyRecords) el('migrationSourceCountTitle').textContent = 'Datos detectados solo de este negocio local';
    else if (businessId) el('migrationSourceCountTitle').textContent = 'Datos detectados para el ID local y registros heredados';
    else el('migrationSourceCountTitle').textContent = 'Datos detectados en la base local compartida';
    if (businessId) {
      const legacy = scope?.legacyRecords || 0;
      const excluded = scope?.excludedRecords || 0;
      const source = identity.idSource === 'inferred'
        ? 'No hay localBusinessId en la configuración; se detectó un único business_id en los registros y se usa para filtrar.'
        : 'Los datos se filtran por el identificador local configurado.';
      note.textContent = source + (legacy ? ' Se incluyen ' + legacy.toLocaleString('es-NI') + ' registros heredados sin ID o con el ID fijo anterior para conservarlos.' : '') + (excluded ? ' Se excluyen ' + excluded.toLocaleString('es-NI') + ' registros con otro business_id.' : '') + ' Esta vista solo lee datos; no los convierte ni los migra.';
    } else {
      const excluded = scope?.excludedRecords || 0;
      note.textContent = 'No existe un identificador local por negocio. El modo local asigna a los registros nuevos un business_id fijo compartido; los registros heredados se muestran para no omitirlos, pero no se puede garantizar que pertenezcan exclusivamente al nombre mostrado.' + (excluded ? ' Se excluyen ' + excluded.toLocaleString('es-NI') + ' registros que tienen otros business_id.' : '') + ' Esta vista solo lee datos; no los convierte ni los migra.';
    }
  }

  function renderOriginCounts(counts) {
    el('migrationOriginCounts').replaceChildren(
      card('Productos', counts.products),
      card('Clientes', counts.clients),
      card('Ventas', counts.sales)
    );
  }

  async function readLocalData(identity) {
    if (!(await Dexie.exists(LOCAL_DB_NAME))) return { missing: true, tables: {} };
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(LOCAL_DB_NAME);
      request.onupgradeneeded = event => {
        if (event.oldVersion === 0) request.transaction.abort();
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('No se pudo abrir la base local.'));
    });
    try {
      const storeNames = new Set(Array.from(db.objectStoreNames));
      const names = [...BASIC_STORES, ...FULL_STORES];
      const tables = Object.fromEntries(names.map(name => [name, []]));
      const available = names.filter(name => storeNames.has(name));
      if (available.length) {
        await new Promise((resolve, reject) => {
          const transaction = db.transaction(available, 'readonly');
          transaction.oncomplete = resolve;
          transaction.onabort = () => reject(transaction.error || new Error('La lectura de la base local fue cancelada.'));
          transaction.onerror = () => reject(transaction.error || new Error('No se pudieron leer las tablas locales.'));
          for (const name of available) {
            const request = transaction.objectStore(name).getAll();
            request.onsuccess = () => { tables[name] = request.result; };
          }
        });
      }
      const ids = new Set(names.flatMap(name => tables[name]).map(businessIdOf).filter(id => id && id !== LEGACY_BUSINESS_ID));
      let businessId = identity.configuredId;
      let idSource = businessId ? 'config' : 'none';
      if (!businessId && ids.size === 1) { businessId = [...ids][0]; idSource = 'inferred'; }
      else if (!businessId && ids.size > 1) idSource = 'ambiguous';

      const scopedTables = Object.fromEntries(names.map(name => [name, []]));
      let legacyRecords = 0, excludedRecords = 0;
      for (const name of names) for (const row of tables[name]) {
        const rowId = businessIdOf(row);
        if (!rowId || rowId === LEGACY_BUSINESS_ID) {
          scopedTables[name].push(row);
          legacyRecords++;
        } else if (businessId && rowId === businessId) scopedTables[name].push(row);
        else excludedRecords++;
      }
      return {
        missing: false,
        tables: scopedTables,
        identity: { ...identity, id: businessId, idSource, idsFound: ids.size },
        scope: { legacyRecords, excludedRecords }
      };
    } finally {
      db.close();
    }
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

  function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

  function packageCount(value) {
    const count = Number(value);
    return Number.isFinite(count) && count >= 0 ? count.toLocaleString('es-NI') : '0';
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
    const counts = [
      ['Productos', summary.products], ['Clientes', summary.clients], ['Proveedores', summary.suppliers],
      ['Ventas', summary.sales], ['Compras', summary.purchases], ['Caja', summary.cashSessions],
      ['Inventario', summary.inventoryMovements], ['Abonos', summary.abonos],
      ['Categorías', Array.isArray(dataPackage.categories) ? dataPackage.categories.length : 0]
    ];
    el('migrationPackageBusiness').textContent = text(value.business.name) || 'No disponible';
    el('migrationPackageDate').textContent = packageDate(value.exportedAt);
    el('migrationPackageCounts').replaceChildren(...counts.map(([label, count]) => card(label, packageCount(count))));
    renderPackageWarnings(Array.isArray(value.warnings) ? value.warnings : []);
    el('migrationPackageReview').classList.remove('hidden');
    packageValue = value;
    const products = value.data.products.filter(item => isRecord(item) && item.deleted !== true);
    const categories = new Set(products.map(item => norm(item.category ?? item.categoria) || norm('General')));
    el('migrationBasicProducts').textContent = packageCount(products.length);
    el('migrationBasicClients').textContent = packageCount(value.data.clients.length);
    el('migrationBasicSuppliers').textContent = packageCount(value.data.suppliers.length);
    el('migrationBasicCategories').textContent = packageCount(categories.size);
    el('migrationBasicSummary').classList.remove('hidden');
    el('migrationBasicResult').classList.add('hidden');
    el('migrationBasicStatus').textContent = '';
    renderBasicMigrationButton();
    el('migrationInventoryStatus').textContent = '';
    el('migrationInventoryResult').classList.add('hidden');
    void updateInventoryPreview();
  }

  function renderBasicMigrationButton() {
    const target = destination();
    const targetId = target ? String(target.id) : '';
    const button = el('migrationBasicStartBtn');
    button.disabled = !canAccess() || !packageValue || !target || target.status !== 'ACTIVE' || migrationBusy || inventoryBusy || completedTargets.has(targetId);
    button.textContent = completedTargets.has(targetId) ? 'Migración completada para este destino' : 'Migrar datos básicos';
  }

  function renderInventoryMigrationButton() {
    const button = el('migrationInventoryStartBtn');
    const target = destination();
    const targetId = target ? String(target.id) : '';
    const visible = Boolean(canAccess() && packageValue && target && target.status === 'ACTIVE' && inventoryPreview?.eligible);
    el('migrationInventorySummary').classList.toggle('hidden', !visible);
    button.disabled = !visible || migrationBusy || inventoryBusy || completedInventoryTargets.has(targetId);
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
    gateStatus.textContent = '';
    if (!canAccess() || !packageValue || !target || target.status !== 'ACTIVE' || migrationBusy || inventoryBusy || !previewInventoryRequest) return;
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
    if (!canAccess() || !packageValue || !target || target.status !== 'ACTIVE' || migrationBusy || inventoryBusy || !inventoryPreview?.eligible) return;
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
    if (migrationBusy || inventoryBusy || !canAccess() || !packageValue || !target || target.status !== 'ACTIVE' || !inventoryPreview?.eligible || !migrateInventoryRequest) return;
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
      if (modal.classList.contains('hidden') && inventoryTrigger?.isConnected) inventoryTrigger.focus();
      if (completedInventoryTargets.has(String(target.id))) await updateInventoryPreview();
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
    if (!canAccess() || !packageValue || !target || target.status !== 'ACTIVE' || migrationBusy || inventoryBusy || completedTargets.has(String(target.id))) return;
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
    if (migrationBusy || inventoryBusy || !canAccess() || !packageValue || !target || target.status !== 'ACTIVE' || !migrateBasicRequest || (String(target.id) === '1' && !confirmSystemBusiness)) return;
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
      if (completedTargets.has(String(target.id))) await updateInventoryPreview();
    }
  }

  async function readPackage(file) {
    if (!canAccess() || migrationBusy || inventoryBusy || !el('migrationBasicConfirmModal').classList.contains('hidden') || !el('migrationInventoryConfirmModal').classList.contains('hidden')) return;
    const token = ++packageReadToken;
    packageValue = null;
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
    renderBasicMigrationButton();
    el('migrationPackageReview').classList.add('hidden');
    el('migrationPackageStatus').textContent = '';
    let value;
    try {
      if (!file || !/\.json$/i.test(file.name)) throw new Error('Invalid package file');
      value = JSON.parse(await file.text());
    } catch {
      if (token !== packageReadToken) return;
      packageValue = null;
      el('migrationBasicSummary').classList.add('hidden');
      renderBasicMigrationButton();
      el('migrationPackageStatus').dataset.state = 'invalid';
      el('migrationPackageStatus').textContent = INVALID_PACKAGE_MESSAGE;
      return;
    }
    if (token !== packageReadToken) return;
    if (!isRecord(value) || value.type !== 'pos_local_migration_package' || value.version !== 1 ||
        !isRecord(value.data) || !Array.isArray(value.data.products) || !Array.isArray(value.data.clients) ||
        !Array.isArray(value.data.suppliers) || !isRecord(value.summary) || !isRecord(value.business)) {
      packageValue = null;
      el('migrationBasicSummary').classList.add('hidden');
      renderBasicMigrationButton();
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
      el('migrationBasicStatus').textContent = '';
      renderBasicMigrationButton();
      void updateInventoryPreview();
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

  function updateContinue() {
    const button = el('migrationContinueBtn');
    button.disabled = true;
    button.title = SAFE_MESSAGE;
    el('migrationContinueNote').textContent = SAFE_MESSAGE;
  }

  async function refresh() {
    if (!canAccess() || loading) return;
    loading = true; el('migrationRefreshBtn').disabled = true;
    const status = el('migrationStatus'); status.textContent = 'Leyendo datos locales (solo lectura)…'; status.classList.remove('hidden');
    try {
      localIdentity = readLocalIdentity();
      renderLocalIdentity(localIdentity);
      renderOriginCounts({ products: '…', clients: '…', sales: '…' });
      const result = await readLocalData(localIdentity);
      if (result.missing) { data = null; report = null; el('migrationResult').classList.add('hidden'); status.textContent = 'No se encontró una base local (' + LOCAL_DB_NAME + ') en este navegador.'; return; }
      localIdentity = result.identity;
      localScope = result.scope;
      renderLocalIdentity(localIdentity, localScope);
      data = result.tables; report = buildReport(data);
      sim = { added: [], map: {}, general: false }; simNotice('');
      el('migrationResult').classList.remove('hidden');
      const dest = destination();
      status.textContent = 'Previsualización actualizada' + (dest ? ' · destino: ' + dest.name + ' (#' + dest.id + ')' : '') + '. No se migró ni se modificó ningún dato.';
      renderReport();
    } catch (failure) {
      status.textContent = 'No se pudo leer la base local: ' + (failure && failure.message ? failure.message : 'error desconocido') + '.';
    } finally { loading = false; el('migrationRefreshBtn').disabled = false; }
  }

  function show(options) {
    canAccess = options.canAccess; businesses = options.businesses || [];
    migrateBasicRequest = options.migrateBasic;
    previewInventoryRequest = options.previewInventory;
    migrateInventoryRequest = options.migrateInventory;
    if (!canAccess()) return;
    localIdentity = readLocalIdentity();
    renderLocalIdentity(localIdentity, localScope);
    const select = el('migrationBusiness'), previous = select.value;
    select.replaceChildren(new Option('Selecciona un negocio conectado', ''), ...businesses.map(item => new Option(item.name + ' (#' + item.id + ')' + (item.status === 'ACTIVE' ? '' : ' · inactivo'), item.id)));
    select.value = businesses.some(item => String(item.id) === previous) ? previous : '';
    updateContinue();
    renderBasicMigrationButton();
    void updateInventoryPreview();
  }

  function reset() {
    data = null; report = null; localIdentity = null; localScope = null; sim = { added: [], map: {}, general: false };
    packageReadToken++;
    inventoryPreviewToken++;
    packageValue = null; migrationBusy = false; inventoryBusy = false; migrateBasicRequest = null; previewInventoryRequest = null; migrateInventoryRequest = null; inventoryPreview = null; completedTargets.clear(); completedInventoryTargets.clear();
    el('migrationResult')?.classList.add('hidden');
    el('migrationOriginCounts')?.replaceChildren(card('Productos', '—'), card('Clientes', '—'), card('Ventas', '—'));
    el('migrationSourceNote')?.classList.remove('is-legacy');
    el('migrationPackageFile').value = '';
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
    el('migrationPackageStatus').dataset.state = '';
    el('migrationPackageStatus').textContent = 'Aún no se ha seleccionado un paquete.';
  }

  function init() {
    if (!el('migrationRefreshBtn')) return;
    setupPackageReader();
    el('migrationRefreshBtn').addEventListener('click', refresh);
    el('migrationType').addEventListener('change', () => { if (report && canAccess()) renderReport(); });
    el('migrationBusiness').addEventListener('change', () => { void updateInventoryPreview(); if (report && canAccess()) { const status = el('migrationStatus'); status.textContent = 'Destino seleccionado solo para la lectura técnica; los datos básicos solo se envían al confirmar su migración.'; status.classList.remove('hidden'); } });
    el('migrationContinueBtn').addEventListener('click', event => { event.preventDefault(); el('migrationContinueNote').textContent = SAFE_MESSAGE; });
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
