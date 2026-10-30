/* global Dexie */
"use strict";
(() => {
  const DB_NAME = 'POS_OfflineDB';
  const CONFIG_KEY = 'posSystemConfig';
  const LEGACY_BUSINESS_ID = '00000000-0000-0000-0000-000000000000';
  const STORE_NAMES = ['products', 'clients', 'suppliers', 'sales', 'purchases', 'cajaSessions', 'inventory_movements', 'abonos', 'gastos', 'audit_logs', 'saleOrders', 'sync_queue'];
  const STORE_LABELS = { products: 'Productos', clients: 'Clientes', suppliers: 'Proveedores', sales: 'Ventas', purchases: 'Compras', cajaSessions: 'Caja', inventory_movements: 'Inventario', abonos: 'Abonos', gastos: 'Gastos', audit_logs: 'Auditoría', saleOrders: 'Órdenes pendientes', sync_queue: 'Operaciones locales pendientes' };
  const FIELD_LABELS = { business_id: 'negocio de origen', clienteId: 'cliente relacionado', clientId: 'cliente relacionado', proveedorId: 'proveedor relacionado', supplierId: 'proveedor relacionado', productoId: 'producto relacionado', productId: 'producto relacionado', facturaId: 'factura relacionada', saleId: 'venta relacionada', compraId: 'compra relacionada', purchaseId: 'compra relacionada', cajaSessionId: 'sesión de Caja relacionada', cashSessionId: 'sesión de Caja relacionada', referenciaId: 'registro relacionado' };
  const normalizeFieldName = key => key.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const SAFE_RELATION_KEYS = new Set([
    'id', 'clienteId', 'proveedorId', 'productoId', 'productId', 'facturaId', 'compraId', 'ventaId',
    'cajaSessionId', 'cashSessionId', 'referenciaId', 'business_id'
  ].map(normalizeFieldName));
  const SENSITIVE_KEYS = new Set([
    'password', 'passwordhash', 'pass', 'credential', 'credentials', 'token', 'accesstoken', 'refreshtoken', 'sessiontoken',
    'secret', 'apikey', 'privatekey', 'signingkey', 'encryptionkey', 'licensecode', 'licenseid', 'licensekey', 'licensepermit', 'licensestatus', 'installationid', 'installationsignature', 'username', 'userid', 'useragent', 'authsession',
    'authsessionid', 'jwt', 'salt', 'sessiontoken'
  ]);
  const WARNING_LABELS = [
    ['PRODUCTS_WITHOUT_CODE', 'Productos sin código'],
    ['DUPLICATED_PRODUCTS', 'Productos duplicados por código'],
    ['PRODUCTS_WITHOUT_CATEGORY', 'Productos sin categoría'],
    ['CLIENTS_WITHOUT_NAME', 'Clientes sin nombre'],
    ['SUPPLIERS_WITHOUT_NAME', 'Proveedores sin nombre'],
    ['SALES_WITHOUT_DETAIL', 'Ventas sin detalle'],
    ['PURCHASES_WITHOUT_DETAIL', 'Compras sin detalle']
  ];
  const el = id => document.getElementById(id);
  const text = value => String(value ?? '').trim();
  const fieldLabel = value => FIELD_LABELS[value] || 'referencia relacionada';
  const norm = value => text(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ');
  const countText = value => Number(value || 0).toLocaleString('es-NI');
  let packageData = null;
  let busy = false;

  function readLocalConfig() {
    let config = {};
    try {
      const parsed = JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed;
    } catch { /* Se utilizarán valores locales predeterminados. */ }
    const configuredId = text(config.localBusinessId || config.local_business_id || config.businessId || config.business_id).toLowerCase();
    return {
      business: {
        ...scrub(config),
        name: text(config.name) || 'POS DISTRIBUIDORA',
        currency: text(config.currency) || 'C$',
        ruc: text(config.ruc),
        address: text(config.address),
        phone: text(config.phone),
        localBusinessId: configuredId && configuredId !== LEGACY_BUSINESS_ID ? configuredId : '',
        header: text(config.header),
        footer: text(config.footer),
        tax: Number.isFinite(Number(config.tax)) ? Number(config.tax) : 0,
        minStock: Number.isFinite(Number(config.minStock)) ? Number(config.minStock) : 5,
        salesFlow: text(config.salesFlow) || 'DIRECT'
      },
      configuredId: configuredId && configuredId !== LEGACY_BUSINESS_ID ? configuredId : ''
    };
  }

  function businessIdOf(row) {
    return text(row?.business_id ?? row?.businessId ?? row?.localBusinessId).toLowerCase();
  }

  function safeReference(value, fallback) {
    if (typeof value === 'string' || typeof value === 'number') {
      const candidate = String(value).trim();
      const hasControlChars = Array.from(candidate).some(character => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      });
      if (candidate && candidate.length <= 120 && !hasControlChars) return candidate;
    }
    return fallback;
  }

  function rowReference(row, index) {
    return safeReference(row?.id ?? row?.numero ?? row?.factura ?? row?.displayNumber, `fila ${index + 1}`);
  }

  function referenceIssuesOf(tables) {
    const ids = Object.fromEntries(STORE_NAMES.map(name => [name, new Map()]));
    for (const name of STORE_NAMES) for (const row of tables[name]) {
      if (row?.id === undefined || row?.id === null || String(row.id).trim() === '') continue;
      const key = String(row.id);
      ids[name].set(key, [...(ids[name].get(key) || []), row]);
    }
    const issues = [];
    const add = (source, row, index, field, target, value) => {
      if (value === undefined || value === null || String(value).trim() === '') return;
      const matches = ids[target]?.get(String(value)) || [];
      if (!matches.length) {
        issues.push({ module: source, record: rowReference(row, index), field, target: STORE_LABELS[target], value: safeReference(value, '[referencia]'), issue: 'MISSING_REFERENCE' });
        return;
      }
      const sourceBusiness = businessIdOf(row), targetBusinesses = new Set(matches.map(businessIdOf).filter(id => id && id !== LEGACY_BUSINESS_ID));
      if (sourceBusiness && sourceBusiness !== LEGACY_BUSINESS_ID && targetBusinesses.size && !targetBusinesses.has(sourceBusiness)) {
        issues.push({ module: source, record: rowReference(row, index), field, target: STORE_LABELS[target], value: safeReference(value, '[referencia]'), issue: 'CROSS_BUSINESS_REFERENCE' });
      }
    };
    const eachItem = (module, row, index, target) => (Array.isArray(row?.items) ? row.items : []).forEach((item, itemIndex) => {
      add(module, row, index, `items[${itemIndex}].productId`, target, item?.productId ?? item?.productoId ?? item?.producto_id ?? item?.id);
    });
    tables.sales.forEach((row, index) => { add('sales', row, index, 'clienteId', 'clients', row?.clienteId ?? row?.clientId); eachItem('sales', row, index, 'products'); });
    tables.purchases.forEach((row, index) => { add('purchases', row, index, 'proveedorId', 'suppliers', row?.proveedorId ?? row?.supplierId); eachItem('purchases', row, index, 'products'); });
    tables.inventory_movements.forEach((row, index) => add('inventory_movements', row, index, 'producto_id', 'products', row?.producto_id ?? row?.productoId ?? row?.productId));
    tables.abonos.forEach((row, index) => {
      const supplierPayment = norm(row?.tipo) === 'proveedor';
      add('abonos', row, index, 'referenciaId', supplierPayment ? 'suppliers' : 'clients', row?.referenciaId ?? row?.supplierId ?? row?.clientId);
      add('abonos', row, index, 'facturaId', supplierPayment ? 'purchases' : 'sales', row?.facturaId ?? row?.invoiceId);
      add('abonos', row, index, 'cajaSessionId', 'cajaSessions', row?.cajaSessionId ?? row?.cashSessionId);
    });
    tables.gastos.forEach((row, index) => add('gastos', row, index, 'sessionId', 'cajaSessions', row?.sessionId ?? row?.cajaSessionId));
    tables.saleOrders.forEach((row, index) => { add('saleOrders', row, index, 'cajaSessionId', 'cajaSessions', row?.cajaSessionId ?? row?.cashSessionId); eachItem('saleOrders', row, index, 'products'); });
    tables.cajaSessions.forEach((row, index) => (Array.isArray(row?.movimientos) ? row.movimientos : []).forEach((movement, movementIndex) => {
      add('cajaSessions', row, index, `movimientos[${movementIndex}].saleId`, 'sales', movement?.saleId);
      add('cajaSessions', row, index, `movimientos[${movementIndex}].purchaseId`, 'purchases', movement?.purchaseId);
    }));
    return issues;
  }

  function buildIdentityReview(tables, businessId, idSource, foreignRows) {
    const byModule = {};
    let confirmedRecords = 0, sharedIdRecords = 0, missingIdRecords = 0, inferredRecords = 0, foreignRecords = 0, duplicateIds = 0;
    for (const name of STORE_NAMES) {
      const rows = tables[name], seen = new Map();
      const module = byModule[name] = { label: STORE_LABELS[name], confirmed: 0, legacy: 0, missingId: 0, sharedId: 0, otherBusiness: 0, duplicateIds: 0, legacyReferences: [], otherBusinessReferences: [], duplicateReferences: [] };
      rows.forEach((row, index) => {
        const rowId = businessIdOf(row);
        if (!rowId) { module.legacy++; module.missingId++; missingIdRecords++; }
        else if (rowId === LEGACY_BUSINESS_ID) { module.legacy++; module.sharedId++; sharedIdRecords++; }
        else if (businessId && rowId === businessId && idSource === 'config') { module.confirmed++; confirmedRecords++; }
        else if (businessId && rowId === businessId) { module.legacy++; inferredRecords++; }
        else { module.otherBusiness++; foreignRecords++; }

        const reference = rowReference(row, index);
        if (!rowId || rowId === LEGACY_BUSINESS_ID || rowId === businessId && idSource !== 'config') {
          if (module.legacyReferences.length < 2000) module.legacyReferences.push({ id: reference, identity: rowId === LEGACY_BUSINESS_ID ? 'shared' : rowId ? 'inferred' : 'missing' });
        } else if (rowId !== businessId && module.otherBusinessReferences.length < 2000) {
          module.otherBusinessReferences.push({ id: reference, businessId: safeReference(rowId, '[identificador]') });
        }

        const rowIdKey = row?.id === undefined || row?.id === null ? '' : String(row.id);
        if (rowIdKey) {
          const count = seen.get(rowIdKey) || 0;
          seen.set(rowIdKey, count + 1);
          if (count) {
            module.duplicateIds++; duplicateIds++;
            if (module.duplicateReferences.length < 2000) module.duplicateReferences.push({ id: safeReference(rowIdKey, '[referencia]'), duplicate: count + 1 });
          }
        }
      });
      if (module.legacyReferences.length === 2000) module.legacyReferencesTruncated = true;
      if (module.otherBusinessReferences.length === 2000) module.otherBusinessReferencesTruncated = true;
      if (module.duplicateReferences.length === 2000) module.duplicateReferencesTruncated = true;
    }
    const referenceIssues = referenceIssuesOf(tables);
    return {
      identityStatus: idSource === 'config' ? 'PERSISTENT' : idSource === 'inferred' ? 'INFERRED' : 'MISSING',
      counts: { confirmed: confirmedRecords, legacy: sharedIdRecords + missingIdRecords + inferredRecords, missingId: missingIdRecords, sharedId: sharedIdRecords, inferred: inferredRecords, otherBusiness: foreignRecords, duplicateIds, referenceIssues: referenceIssues.length },
      byModule, referenceIssues: referenceIssues.slice(0, 2000), referenceIssuesTruncated: referenceIssues.length > 2000,
      otherBusinessRows: Object.values(foreignRows).reduce((sum, rows) => sum + rows.length, 0)
    };
  }

  async function readOnlySnapshot(identity) {
    if (!(await Dexie.exists(DB_NAME))) throw window.PosMessages.expected('No se encontró información anterior de este POS en este dispositivo.');
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME);
      request.onupgradeneeded = () => request.transaction.abort();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('No se pudo abrir la base local.'));
    });
    try {
      const names = new Set(Array.from(db.objectStoreNames));
      const tables = Object.fromEntries(STORE_NAMES.map(name => [name, []]));
      const available = STORE_NAMES.filter(name => names.has(name));
      if (available.length) {
        await new Promise((resolve, reject) => {
          const transaction = db.transaction(available, 'readonly');
          transaction.oncomplete = resolve;
          transaction.onabort = () => reject(transaction.error || new Error('La lectura local fue cancelada.'));
          transaction.onerror = () => reject(transaction.error || new Error('No se pudieron leer los datos locales.'));
          for (const name of available) {
            const request = transaction.objectStore(name).getAll();
            request.onsuccess = () => { tables[name] = request.result; };
          }
        });
      }

      const ids = new Set(STORE_NAMES.flatMap(name => tables[name]).map(businessIdOf).filter(id => id && id !== LEGACY_BUSINESS_ID));
      let businessId = identity.configuredId;
      let idSource = businessId ? 'config' : 'none';
      if (!businessId && ids.size === 1) { businessId = [...ids][0]; idSource = 'inferred'; }
      else if (!businessId && ids.size > 1) idSource = 'ambiguous';

      const scopedTables = Object.fromEntries(STORE_NAMES.map(name => [name, []]));
      const foreignRows = Object.fromEntries(STORE_NAMES.map(name => [name, []]));
      let legacyRecords = 0, excludedRecords = 0;
      for (const name of STORE_NAMES) for (const row of tables[name]) {
        const rowId = businessIdOf(row);
        if (!rowId || rowId === LEGACY_BUSINESS_ID) { scopedTables[name].push(row); legacyRecords++; }
        else if (businessId && rowId === businessId) scopedTables[name].push(row);
        else { excludedRecords++; foreignRows[name].push(row); }
      }
      const identityReview = buildIdentityReview(tables, businessId, idSource, foreignRows);
      return {
        tables: scopedTables, businessId, idSource, idsFound: ids.size, legacyRecords, excludedRecords,
        identityReview, unconfirmedRecords: identityReview.counts.inferred,
        missingStores: STORE_NAMES.filter(name => !names.has(name))
      };
    } finally {
      db.close();
    }
  }

  function scrub(value) {
    if (Array.isArray(value)) return value.map(scrub);
    if (value instanceof Date) return value.toISOString();
    if (!value || typeof value !== 'object') return value;
    const clean = {};
    for (const [key, nested] of Object.entries(value)) {
      const normalizedKey = normalizeFieldName(key);
      const credentialLike = /(password|passwd|token|secret|credential|license(code|id|key|permit|status)|installation(id|signature)|username|userid|useragent|privatekey|signingkey|encryptionkey)/.test(normalizedKey);
      const authKeyLike = /^(auth|login|private|public|signing|encryption)key(?:id|value)?$/.test(normalizedKey);
      const accountId = /^(user|usuario|vendedor|cajero|cashier|seller)(id|_id)$/.test(normalizedKey);
      if (SAFE_RELATION_KEYS.has(normalizedKey) || (!SENSITIVE_KEYS.has(normalizedKey) && !credentialLike && !authKeyLike && !accountId)) {
        if (typeof nested === 'string' && ['data', 'payload', 'detalle', 'details'].includes(normalizedKey)) {
          const trimmed = nested.trim();
          if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
            try { clean[key] = JSON.stringify(scrub(JSON.parse(trimmed))); continue; } catch { /* preserve non-JSON business text */ }
          }
        }
        clean[key] = scrub(nested);
      }
    }
    return clean;
  }

  function summarize(tables) {
    const products = tables.products;
    const codes = new Map();
    for (const product of products) {
      const code = norm(product.barcode ?? product.codigo ?? product.code);
      if (code) codes.set(code, (codes.get(code) || 0) + 1);
    }
    const duplicateProducts = [...codes.values()].filter(amount => amount > 1).reduce((sum, amount) => sum + amount, 0);
    const summary = {
      products: products.length,
      clients: tables.clients.length,
      suppliers: tables.suppliers.length,
      sales: tables.sales.length,
      purchases: tables.purchases.length,
      cashSessions: tables.cajaSessions.length,
      inventoryMovements: tables.inventory_movements.length,
      abonos: tables.abonos.length,
      expenses: tables.gastos.length,
      auditLogs: tables.audit_logs.length,
      saleOrders: tables.saleOrders.length,
      syncQueue: tables.sync_queue.length
    };
    const warningCounts = {
      PRODUCTS_WITHOUT_CODE: products.filter(item => !norm(item.barcode ?? item.codigo ?? item.code)).length,
      DUPLICATED_PRODUCTS: duplicateProducts,
      PRODUCTS_WITHOUT_CATEGORY: products.filter(item => !text(item.category ?? item.categoria)).length,
      CLIENTS_WITHOUT_NAME: tables.clients.filter(item => !text(item.name ?? item.nombre)).length,
      SUPPLIERS_WITHOUT_NAME: tables.suppliers.filter(item => !text(item.name ?? item.nombre)).length,
      SALES_WITHOUT_DETAIL: tables.sales.filter(item => !Array.isArray(item.items) || item.items.length === 0).length,
      PURCHASES_WITHOUT_DETAIL: tables.purchases.filter(item => !Array.isArray(item.items) || item.items.length === 0).length
    };
    return { summary, warningCounts, products };
  }

  function categoriesOf(products) {
    const names = new Map();
    for (const product of products) {
      const category = text(product.category ?? product.categoria);
      if (category && !names.has(norm(category))) names.set(norm(category), category);
    }
    return [...names.values()].sort((a, b) => a.localeCompare(b, 'es'));
  }

  function makeWarnings(warningCounts, snapshot) {
    const warnings = WARNING_LABELS.map(([code, label]) => ({ code, label, count: warningCounts[code] }));
    if (snapshot.missingStores.length) warnings.push({
      code: 'LOCAL_STORES_NOT_PRESENT', label: 'Tiendas locales no encontradas', count: snapshot.missingStores.length,
      detail: 'No encontramos información de estos módulos: ' + snapshot.missingStores.map(name => STORE_LABELS[name] || 'otro módulo').join(', ') + '. Abre el negocio en este POS y vuelve a generar el archivo.'
    });
    if (snapshot.tables.sync_queue.length) warnings.push({
      code: 'LOCAL_QUEUE_REQUIRES_REVIEW', label: 'Operaciones locales pendientes de revisión', count: snapshot.tables.sync_queue.length,
      detail: 'La cola se conserva como referencia y nunca se ejecuta automáticamente para evitar duplicar ventas, pagos o movimientos.'
    });
    const pendingOrders = snapshot.tables.saleOrders.filter(item => item.status === 'PENDING').length;
    if (pendingOrders) warnings.push({
      code: 'PENDING_ORDERS_PRESERVED', label: 'Órdenes pendientes preservadas', count: pendingOrders,
      detail: 'Las órdenes se conservarán como pendientes; no se convertirán en ventas ni se cobrarán automáticamente.'
    });
    if (!snapshot.businessId) warnings.push({
      code: 'LOCAL_BUSINESS_ID_MISSING', label: 'No se pudo confirmar un ID local exclusivo',
      count: snapshot.identityReview.counts.legacy,
      detail: 'El paquete conserva los registros antiguos, pero no se usará el nombre del negocio para afirmar que todos pertenecen a la misma empresa.'
    });
    if (snapshot.idSource === 'inferred') warnings.push({
      code: 'LOCAL_BUSINESS_ID_INFERRED', label: 'Identidad encontrada en los registros, por confirmar',
      count: snapshot.identityReview.counts.inferred,
      detail: 'El identificador no estaba guardado en la configuración de la instalación. Estos registros no se consideran confirmados.'
    });
    if (snapshot.identityReview.counts.legacy) warnings.push({
      code: 'LEGACY_RECORDS_INCLUDED', label: 'Registros antiguos por confirmar',
      count: snapshot.identityReview.counts.legacy,
      detail: 'No se modificaron ni reasignaron. Su pertenencia debe revisarse con las referencias de cada módulo antes de incluirlos en una migración operativa.'
    });
    if (snapshot.excludedRecords) warnings.push({
      code: 'OTHER_BUSINESS_RECORDS_EXCLUDED', label: 'Registros asociados a otra identidad excluidos',
      count: snapshot.excludedRecords,
      detail: 'Se muestran sus referencias para que se exporten o revisen por separado. No se mezclarán en este paquete.'
    });
    if (snapshot.identityReview.counts.duplicateIds) warnings.push({
      code: 'DUPLICATE_LOCAL_REFERENCES', label: 'Referencias locales repetidas', count: snapshot.identityReview.counts.duplicateIds,
      detail: 'Los registros repetidos se conservan en el archivo, pero sus relaciones deben revisarse antes de importarlos.'
    });
    if (snapshot.identityReview.counts.referenceIssues) warnings.push({
      code: 'INCONSISTENT_LOCAL_REFERENCES', label: 'Relaciones que requieren revisión', count: snapshot.identityReview.counts.referenceIssues,
      detail: 'Hay referencias a registros no encontrados o asociados a otra identidad. No se corregirán automáticamente.'
    });
    return warnings;
  }

  function renderIdentityReview(review) {
    const container = el('migrationExportIdentityReview');
    if (!container) return;
    container.replaceChildren();
    const counts = review.counts;
    const summary = document.createElement('p');
    summary.textContent = `${countText(counts.confirmed)} registros con identidad estable; ${countText(counts.legacy)} antiguos por revisar; ${countText(counts.otherBusiness)} asociados a otra identidad; ${countText(counts.duplicateIds)} referencias repetidas; ${countText(counts.referenceIssues)} relaciones por revisar.`;
    container.append(summary);
    const modules = Object.entries(review.byModule).filter(([, value]) => value.legacy || value.otherBusiness || value.duplicateIds || value.referenceIssues);
    for (const [, value] of modules) {
      const details = document.createElement('details');
      const heading = document.createElement('summary');
      heading.textContent = `${value.label}: ${countText(value.legacy)} antiguos, ${countText(value.otherBusiness)} de otra identidad, ${countText(value.duplicateIds)} repetidos`;
      details.append(heading);
      const list = document.createElement('ul');
      for (const row of value.legacyReferences) {
        const item = document.createElement('li');
        item.textContent = `Referencia ${row.id} · ${row.identity === 'shared' ? 'identificador antiguo compartido' : row.identity === 'inferred' ? 'identificador encontrado en los datos, no guardado en los ajustes' : 'sin identificación del negocio'}`;
        list.append(item);
      }
      for (const row of value.otherBusinessReferences) {
        const item = document.createElement('li'); item.textContent = `Referencia ${row.id} · asociada a otro negocio`; list.append(item);
      }
      for (const row of value.duplicateReferences) {
        const item = document.createElement('li'); item.textContent = `Referencia repetida ${row.id} · aparición ${row.duplicate}`; list.append(item);
      }
      details.append(list);
      container.append(details);
    }
    for (const issue of review.referenceIssues) {
      const item = document.createElement('p');
      item.textContent = `${STORE_LABELS[issue.module] || 'Información'}: referencia ${issue.record}, ${fieldLabel(issue.field)} ${issue.issue === 'CROSS_BUSINESS_REFERENCE' ? 'asociada a otro negocio' : 'no encontrada'}.`;
      container.append(item);
    }
    if (review.referenceIssuesTruncated) {
      const note = document.createElement('p'); note.textContent = 'La lista de relaciones supera el límite de detalle; los conteos incluyen todas.'; container.append(note);
    }
    if (review.otherBusinessRows) {
      const note = document.createElement('p'); note.textContent = 'Los registros asociados a otra identidad se excluyeron del contenido operativo del paquete y solo se muestran aquí mediante sus referencias.'; container.append(note);
    }
    container.classList.toggle('hidden', counts.legacy + counts.otherBusiness + counts.duplicateIds + counts.referenceIssues === 0);
  }

  function renderCounts(summary) {
    const labels = [
      ['Productos', summary.products], ['Clientes', summary.clients], ['Proveedores', summary.suppliers], ['Ventas', summary.sales],
      ['Compras', summary.purchases], ['Caja', summary.cashSessions], ['Inventario', summary.inventoryMovements], ['Abonos', summary.abonos],
      ['Gastos', summary.expenses], ['Auditoría', summary.auditLogs], ['Órdenes', summary.saleOrders], ['Cola pendiente', summary.syncQueue]
    ];
    const list = el('migrationExportCounts');
    list.replaceChildren(...labels.map(([label, count]) => {
      const card = document.createElement('article');
      const title = document.createElement('span'); title.textContent = label;
      const value = document.createElement('strong'); value.textContent = countText(count);
      card.append(title, value);
      return card;
    }));
  }

  function renderWarnings(warnings) {
    const list = el('migrationExportWarnings');
    list.replaceChildren(...warnings.map(warning => {
      const row = document.createElement('li');
      row.className = warning.count > 0 || warning.detail ? 'migration-export-warning' : 'migration-export-ok';
      const heading = document.createElement('div');
      const label = document.createElement('strong'); label.textContent = warning.label;
      const count = document.createElement('span'); count.textContent = warning.count > 0 ? countText(warning.count) : (warning.detail ? 'Revisar' : 'Sin problemas');
      heading.append(label, count); row.append(heading);
      if (warning.detail) { const detail = document.createElement('small'); detail.textContent = warning.detail; row.append(detail); }
      return row;
    }));
  }

  function businessFilePart(name) {
    return norm(name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'negocio';
  }

  function localDate() {
    const date = new Date();
    const pad = value => String(value).padStart(2, '0');
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  }

  function fileName(businessName) {
    return 'paquete-migracion-' + businessFilePart(businessName) + '-' + localDate() + '.json';
  }

  function download() {
    if (!packageData || new URLSearchParams(location.search).get('mode') === 'connected') return;
    const file = new Blob([JSON.stringify(packageData.value, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = packageData.fileName;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    el('migrationExportStatus').textContent = 'Paquete descargado. Envíalo manualmente al administrador autorizado.';
  }

  async function generate() {
    if (busy || new URLSearchParams(location.search).get('mode') === 'connected') return;
    busy = true;
    packageData = null;
    el('migrationExportGenerateBtn').disabled = true;
    el('migrationExportDownloadBtn').disabled = true;
    el('migrationExportReview').classList.add('hidden');
    const status = el('migrationExportStatus');
    status.textContent = 'Revisando la información guardada anteriormente en este POS…';
    try {
      const identity = readLocalConfig();
      const snapshot = await readOnlySnapshot(identity);
      const report = summarize(snapshot.tables);
      const warnings = makeWarnings(report.warningCounts, snapshot);
      const exportProducts = snapshot.tables.products;
      const cleanTables = Object.fromEntries(STORE_NAMES.map(name => [name, snapshot.tables[name].map(scrub)]));
      cleanTables.products = exportProducts.map(scrub);
      const categoryList = categoriesOf(exportProducts);
      const exportedAt = new Date().toISOString();
      const name = fileName(identity.business.name);
      const value = {
        type: 'pos_local_migration_package',
        version: 2,
        exportedAt,
        source: {
          mode: 'local', database: DB_NAME,
          scope: { localBusinessId: snapshot.businessId || null, idSource: snapshot.idSource, idsFound: snapshot.idsFound, legacyRecords: snapshot.legacyRecords, unconfirmedRecords: snapshot.unconfirmedRecords, excludedRecords: snapshot.excludedRecords, identityReview: snapshot.identityReview, missingStores: snapshot.missingStores }
        },
        business: { name: identity.business.name, currency: identity.business.currency, ...(snapshot.businessId ? { localBusinessId: snapshot.businessId } : {}) },
        summary: report.summary,
        warnings,
        data: {
          products: cleanTables.products,
          clients: cleanTables.clients,
          suppliers: cleanTables.suppliers,
          sales: cleanTables.sales,
          purchases: cleanTables.purchases,
          cashSessions: cleanTables.cajaSessions,
          inventoryMovements: cleanTables.inventory_movements,
          abonos: cleanTables.abonos,
          expenses: cleanTables.gastos,
          auditLogs: cleanTables.audit_logs,
          saleOrders: cleanTables.saleOrders,
          syncQueue: cleanTables.sync_queue,
          configuration: scrub(identity.business),
          categories: categoryList
        }
      };
      packageData = { value, fileName: name };
      renderCounts(report.summary);
      renderWarnings(warnings);
      renderIdentityReview(snapshot.identityReview);
      const idNote = snapshot.businessId
        ? (snapshot.idSource === 'inferred' ? 'Encontramos una identificación común en los registros, pero no estaba guardada en los ajustes; todavía requiere confirmación.' : 'Se usó la identificación guardada para esta instalación.')
        : 'No encontramos una identificación propia para esta instalación. El archivo conserva los registros antiguos y no usa el nombre del negocio para atribuirlos automáticamente.';
      el('migrationExportScope').textContent = idNote + (snapshot.excludedRecords ? ' Se excluyeron ' + countText(snapshot.excludedRecords) + ' registros identificados como pertenecientes a otro negocio.' : '') + ' La revisión no modificó ningún registro.';
      el('migrationExportFilename').textContent = 'Nombre del archivo: ' + name;
      el('migrationExportReview').classList.remove('hidden');
      el('migrationExportDownloadBtn').disabled = false;
      status.textContent = 'Resumen listo. Revisa los conteos y advertencias antes de descargar.';
    } catch (failure) {
      status.textContent = window.PosMessages.fromError(failure, 'No se pudo revisar la información anterior. No se modificaron los datos; inténtalo de nuevo.');
    } finally {
      busy = false;
      el('migrationExportGenerateBtn').disabled = false;
    }
  }

  function init() {
    if (new URLSearchParams(location.search).get('mode') === 'connected') return;
    const generateButton = el('migrationExportGenerateBtn');
    const downloadButton = el('migrationExportDownloadBtn');
    if (!generateButton || !downloadButton) return;
    generateButton.addEventListener('click', generate);
    downloadButton.addEventListener('click', download);
  }

  async function prepareRecoveryCopy() {
    await generate();
    if (!packageData) throw new Error('LOCAL_EXPORT_UNAVAILABLE');
    return packageData.value.summary;
  }

  function downloadRecoveryCopy() {
    if (!packageData) throw new Error('LOCAL_EXPORT_UNAVAILABLE');
    download();
    return packageData.value.summary;
  }

  window.PosLocalMigrationExport = Object.freeze({ prepareRecoveryCopy, downloadRecoveryCopy });

  init();
})();
