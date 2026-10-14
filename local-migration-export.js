/* global Dexie */
"use strict";
(() => {
  const DB_NAME = 'POS_OfflineDB';
  const CONFIG_KEY = 'posSystemConfig';
  const LEGACY_BUSINESS_ID = '00000000-0000-0000-0000-000000000000';
  const STORE_NAMES = ['products', 'clients', 'suppliers', 'sales', 'purchases', 'cajaSessions', 'inventory_movements', 'abonos'];
  const normalizeFieldName = key => key.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const SAFE_RELATION_KEYS = new Set([
    'id', 'clienteId', 'proveedorId', 'productoId', 'productId', 'facturaId', 'compraId', 'ventaId',
    'cajaSessionId', 'cashSessionId', 'referenciaId', 'business_id'
  ].map(normalizeFieldName));
  const SENSITIVE_FIELD_PATTERN = /(usuario|user|operador|vendedor|cajero|cashier|confirmacion|confirmation|password|token|session|clave|auth)/;
  const SENSITIVE_KEYS = new Set([
    'password', 'passwordhash', 'pass', 'credential', 'credentials', 'token', 'accesstoken', 'refreshtoken', 'sessiontoken',
    'secret', 'apikey', 'key', 'keyid', 'privatekey', 'publickey', 'signingkey', 'encryptionkey', 'username', 'user', 'userid', 'useragent', 'usuario',
    'vendedor', 'cajero', 'seller', 'cashier', 'openedby', 'closedby', 'confirmedby', 'cancelledby', 'createdby', 'updatedby',
    'usuariocreacion', 'usuarioapertura', 'usuariocierre', 'usuarioconfirmacion', 'usuarioanulacion', 'session', 'sessions',
    'sessionid', 'authsession', 'authsessionid', 'jwt', 'salt', 'hash'
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
        name: text(config.name) || 'POS DISTRIBUIDORA',
        currency: text(config.currency) || 'C$',
        ruc: text(config.ruc),
        address: text(config.address),
        phone: text(config.phone),
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

  async function readOnlySnapshot(identity) {
    if (!(await Dexie.exists(DB_NAME))) throw new Error('No se encontró la base local POS_OfflineDB en este navegador.');
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
      let legacyRecords = 0, excludedRecords = 0;
      for (const name of STORE_NAMES) for (const row of tables[name]) {
        const rowId = businessIdOf(row);
        if (!rowId || rowId === LEGACY_BUSINESS_ID) { scopedTables[name].push(row); legacyRecords++; }
        else if (businessId && rowId === businessId) scopedTables[name].push(row);
        else excludedRecords++;
      }
      return { tables: scopedTables, businessId, idSource, idsFound: ids.size, legacyRecords, excludedRecords };
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
      const credentialLike = /(password|passwd|token|secret|credential|username|userid|useragent)/.test(normalizedKey);
      const authKeyLike = /^(auth|login|private|public|signing|encryption)key(?:id|value)?$/.test(normalizedKey);
      if (SAFE_RELATION_KEYS.has(normalizedKey) || (!SENSITIVE_KEYS.has(normalizedKey) && !credentialLike && !authKeyLike && !SENSITIVE_FIELD_PATTERN.test(normalizedKey))) clean[key] = scrub(nested);
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
      abonos: tables.abonos.length
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
    if (!snapshot.businessId) {
      warnings.push({
        code: 'LOCAL_BUSINESS_ID_MISSING',
        label: 'No se pudo confirmar un ID local exclusivo',
        count: snapshot.legacyRecords,
        detail: 'Se incluyen los registros heredados o con el ID fijo compartido para conservarlos; podrían abarcar datos guardados con nombres anteriores.'
      });
    } else if (snapshot.legacyRecords) {
      warnings.push({
        code: 'LEGACY_RECORDS_INCLUDED',
        label: 'Registros heredados incluidos',
        count: snapshot.legacyRecords,
        detail: 'Los registros sin ID local o con el ID fijo anterior se incluyen para no excluir datos existentes.'
      });
    }
    if (snapshot.excludedRecords) warnings.push({
      code: 'OTHER_BUSINESS_RECORDS_EXCLUDED',
      label: 'Registros con otros business_id excluidos',
      count: snapshot.excludedRecords,
      detail: 'Estos registros no coinciden con el ID local seleccionado para este paquete.'
    });
    return warnings;
  }

  function renderCounts(summary) {
    const labels = [
      ['Productos', summary.products], ['Clientes', summary.clients], ['Proveedores', summary.suppliers], ['Ventas', summary.sales],
      ['Compras', summary.purchases], ['Caja', summary.cashSessions], ['Inventario', summary.inventoryMovements], ['Abonos', summary.abonos]
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
    status.textContent = 'Leyendo POS_OfflineDB en modo solo lectura…';
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
        version: 1,
        exportedAt,
        source: { mode: 'local', database: DB_NAME },
        business: { name: identity.business.name, currency: identity.business.currency },
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
          configuration: identity.business,
          categories: categoryList
        }
      };
      packageData = { value, fileName: name };
      renderCounts(report.summary);
      renderWarnings(warnings);
      const idNote = snapshot.businessId
        ? (snapshot.idSource === 'inferred' ? 'Se usó el único business_id encontrado en los registros.' : 'Se usó el ID local guardado en la configuración.')
        : 'No hay ID local por negocio; el paquete incluye el grupo heredado de POS_OfflineDB y podría contener datos guardados con nombres anteriores.';
      el('migrationExportScope').textContent = idNote + (snapshot.excludedRecords ? ' Se excluyeron ' + countText(snapshot.excludedRecords) + ' registros con otros business_id.' : '') + ' La lectura no modificó ningún registro.';
      el('migrationExportFilename').textContent = 'Nombre del archivo: ' + name;
      el('migrationExportReview').classList.remove('hidden');
      el('migrationExportDownloadBtn').disabled = false;
      status.textContent = 'Resumen listo. Revisa los conteos y advertencias antes de descargar.';
    } catch (failure) {
      status.textContent = 'No se pudo generar el resumen: ' + (failure?.message || 'error desconocido') + '.';
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

  init();
})();
