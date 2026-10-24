'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { httpError } = require('../middleware/errors');

const SOURCE_STORES = Object.freeze({
  products: 'products', clients: 'clients', suppliers: 'suppliers', sales: 'sales', purchases: 'purchases',
  cashSessions: 'cashSessions', inventoryMovements: 'inventoryMovements', abonos: 'abonos',
  expenses: 'expenses', auditLogs: 'auditLogs', saleOrders: 'saleOrders', syncQueue: 'syncQueue'
});
const MAX_RECORDS_PER_TYPE = 50000;
const CHUNK_SIZE = 100;
const LEGACY_BUSINESS_ID = '00000000-0000-0000-0000-000000000000';
const normalizeName = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const hasControlChars = value => Array.from(String(value)).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const sensitiveKey = key => /(password|passwd|secret|credential|token|sessiontoken|privatekey|signingkey|encryptionkey|salt|passwordhash|username|useragent|userid|authsession|refresh|accesskey|apikey)/i.test(String(key).replace(/[^a-z0-9]/gi, ''));
const relationIdKey = key => /^(?:user|usuario|vendedor|cajero|cashier|seller)(?:id|_id)$/i.test(String(key));
const numericIdentifierKey = key => String(key) === 'id' || /(?:Id|ID|_id)$/.test(String(key));

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
const hash = value => createHash('sha256').update(value).digest('hex');

function scrub(value, omissions = { count: 0 }) {
  if (Array.isArray(value)) return value.map(item => scrub(item, omissions));
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try { return JSON.stringify(scrub(JSON.parse(trimmed), omissions)); } catch { return value; }
    }
    return value;
  }
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, nested] of Object.entries(value)) {
    if (sensitiveKey(key) || relationIdKey(key)) { omissions.count++; continue; }
    // MySQL JSON stores numeric identifiers as DOUBLE and can round local IDs
    // such as Date.now() + Math.random(). Keep their exact JSON spelling as text
    // so the archived payload and cross-module references survive a round trip.
    if (numericIdentifierKey(key) && typeof nested === 'number' && Number.isFinite(nested)) {
      result[key] = String(nested);
      continue;
    }
    result[key] = scrub(nested, omissions);
  }
  return result;
}

function sourceIdentity(value, legacyPackageFingerprint) {
  const business = value?.business || {};
  const candidateId = [business.localBusinessId, business.local_business_id, value?.source?.scope?.localBusinessId]
    .find(item => (typeof item === 'string' && item.trim()) || (typeof item === 'number' && Number.isSafeInteger(item))) || null;
  const candidateText = candidateId === null ? '' : String(candidateId).trim();
  const sourceId = candidateText && candidateText.length <= 112 && !hasControlChars(candidateText) && candidateText.toLowerCase() !== LEGACY_BUSINESS_ID ? candidateText : null;
  const name = String(business.name || '').trim();
  if (!name || name.length > 160 || hasControlChars(name)) throw httpError(400, 'MIGRATION_PACKAGE_INVALID');
  const key = sourceId
    ? hash('id:' + String(sourceId).trim().toLowerCase())
    : hash('legacy-package:' + String(legacyPackageFingerprint || '') + '\nname:' + normalizeName(name));
  return { sourceBusinessKey: key, sourceBusinessName: name, sourceBusinessId: sourceId === null ? null : String(sourceId).trim() };
}

function recordKey(row, index, seen) {
  const candidate = row && ['id', 'localId', 'sourceId', 'uuid', 'key'].map(key => row[key]).find(item => (typeof item === 'string' || typeof item === 'number') && String(item).trim());
  if (candidate !== undefined) {
    const id = String(candidate).trim();
    if (id.length > 112 || hasControlChars(id)) {
      return { key: 'row:' + hash(canonical(row)) + ':' + index, issue: 'El identificador local no cabe en la clave de origen permitida; requiere revisión.' };
    }
    const count = seen.get(id) || 0;
    seen.set(id, count + 1);
    return { key: count ? 'id:' + id + ':duplicate:' + count : 'id:' + id, issue: count ? 'El identificador local está repetido; se conservó cada fila y sus relaciones requieren revisión.' : null };
  }
  const fingerprint = hash(canonical(row));
  return { key: 'row:' + fingerprint + ':' + index, issue: 'La fila no contiene un identificador local estable; se conservó por posición y no se verificaron sus relaciones.' };
}

function firstSubsetMismatch(previous, current, path = '') {
  if (Array.isArray(previous)) {
    if (!Array.isArray(current)) return path || 'value';
    const unorderedMovements = /(?:^|\.)movimientos$/.test(path);
    if (!unorderedMovements && previous.length !== current.length) return path || 'length';
    if (previous.length > current.length) return path || 'length';
    if (!unorderedMovements) {
      for (let index = 0; index < previous.length; index++) {
        const mismatch = firstSubsetMismatch(previous[index], current[index], path + '[' + index + ']');
        if (mismatch) return mismatch;
      }
      return null;
    }
    const remaining = [...current];
    for (let index = 0; index < previous.length; index++) {
      const matches = [];
      for (let candidate = 0; candidate < remaining.length; candidate++) {
        if (!firstSubsetMismatch(previous[index], remaining[candidate], path + '[' + index + ']')) matches.push(candidate);
      }
      if (matches.length !== 1) return path + '[' + index + ']' + (matches.length ? '.ambiguous' : '.missing');
      remaining.splice(matches[0], 1);
    }
    return null;
  }
  if (previous && typeof previous === 'object') {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return path || 'value';
    for (const key of Object.keys(previous)) {
      if (!Object.hasOwn(current, key)) return path ? path + '.' + key : key;
      const mismatch = firstSubsetMismatch(previous[key], current[key], path ? path + '.' + key : key);
      if (mismatch) return mismatch;
    }
    return null;
  }
  return Object.is(previous, current) ? null : path || 'value';
}

function analyzePackageReferences(data) {
  const storeFields = { products: 'products', clients: 'clients', suppliers: 'suppliers', sales: 'sales', purchases: 'purchases', cashSessions: 'cashSessions', inventoryMovements: 'inventoryMovements', abonos: 'abonos', expenses: 'expenses', auditLogs: 'auditLogs', saleOrders: 'saleOrders', syncQueue: 'syncQueue' };
  const rows = Object.fromEntries(Object.entries(storeFields).map(([entity, field]) => [entity, Array.isArray(data[field]) ? data[field] : []]));
  const byId = Object.fromEntries(Object.keys(rows).map(entity => [entity, new Map()]));
  for (const [entity, values] of Object.entries(rows)) for (const row of values) {
    if (row?.id === undefined || row?.id === null || String(row.id).trim() === '') continue;
    const key = String(row.id);
    byId[entity].set(key, [...(byId[entity].get(key) || []), row]);
  }
  const issues = [];
  const add = (entity, row, index, field, target, value) => {
    if (value === undefined || value === null || String(value).trim() === '') return;
    const matches = byId[target]?.get(String(value)) || [];
    let issue = null;
    if (!matches.length) issue = 'MISSING_REFERENCE';
    else if (matches.length > 1) issue = 'AMBIGUOUS_REFERENCE';
    else {
      const sourceBusinessId = String(row?.business_id ?? row?.businessId ?? '').trim().toLowerCase();
      const targetBusinessIds = new Set(matches.map(item => String(item?.business_id ?? item?.businessId ?? '').trim().toLowerCase()).filter(id => id && id !== LEGACY_BUSINESS_ID));
      if (sourceBusinessId && sourceBusinessId !== LEGACY_BUSINESS_ID && targetBusinessIds.size && !targetBusinessIds.has(sourceBusinessId)) issue = 'CROSS_BUSINESS_REFERENCE';
    }
    if (issue) {
      const id = row?.id === undefined || row?.id === null ? `row-${index + 1}` : String(row.id);
      issues.push({ entity, recordId: id, field, target, reference: String(value), issue });
    }
  };
  const checkItems = (entity, row, index) => (Array.isArray(row?.items) ? row.items : []).forEach((item, itemIndex) =>
    add(entity, row, index, `items[${itemIndex}].productId`, 'products', item?.productId ?? item?.productoId ?? item?.producto_id ?? item?.id));
  rows.sales.forEach((row, index) => { add('sales', row, index, 'clienteId', 'clients', row?.clienteId ?? row?.clientId); checkItems('sales', row, index); });
  rows.purchases.forEach((row, index) => { add('purchases', row, index, 'proveedorId', 'suppliers', row?.proveedorId ?? row?.supplierId); checkItems('purchases', row, index); });
  rows.inventoryMovements.forEach((row, index) => add('inventoryMovements', row, index, 'producto_id', 'products', row?.producto_id ?? row?.productoId ?? row?.productId));
  rows.abonos.forEach((row, index) => {
    const supplierPayment = normalizeName(row?.tipo) === 'proveedor';
    add('abonos', row, index, 'referenciaId', supplierPayment ? 'suppliers' : 'clients', row?.referenciaId ?? row?.supplierId ?? row?.clientId);
    add('abonos', row, index, 'facturaId', supplierPayment ? 'purchases' : 'sales', row?.facturaId ?? row?.invoiceId);
    add('abonos', row, index, 'cajaSessionId', 'cashSessions', row?.cajaSessionId ?? row?.cashSessionId);
  });
  rows.expenses.forEach((row, index) => add('expenses', row, index, 'sessionId', 'cashSessions', row?.sessionId ?? row?.cajaSessionId));
  rows.saleOrders.forEach((row, index) => { add('saleOrders', row, index, 'cajaSessionId', 'cashSessions', row?.cajaSessionId ?? row?.cashSessionId); checkItems('saleOrders', row, index); });
  rows.cashSessions.forEach((row, index) => (Array.isArray(row?.movimientos) ? row.movimientos : []).forEach((movement, movementIndex) => {
    add('cashSessions', row, index, `movimientos[${movementIndex}].saleId`, 'sales', movement?.saleId);
    add('cashSessions', row, index, `movimientos[${movementIndex}].purchaseId`, 'purchases', movement?.purchaseId);
  }));
  return { rows, issues };
}

function buildArchivePlan(packageValue) {
  if (!packageValue || typeof packageValue !== 'object' || Array.isArray(packageValue) ||
      packageValue.type !== 'pos_local_migration_package' || ![1, 2].includes(packageValue.version) ||
      !packageValue.data || typeof packageValue.data !== 'object' || Array.isArray(packageValue.data)) {
    throw httpError(400, 'MIGRATION_PACKAGE_INVALID');
  }
  const originalFingerprint = hash(canonical(packageValue));
  const identity = sourceIdentity(packageValue, originalFingerprint);
  const omissions = { count: 0 };
  const datasets = [];
  const missingStores = [];
  const blockers = [];
  const securityBlockers = [];
  const counts = {};
  const analysis = analyzePackageReferences(packageValue.data);
  const identityByModule = {};
  const reviewRecords = [];
  const scope = packageValue.source?.scope || {};
  const concreteBusinessIds = new Set();
  for (const rows of Object.values(analysis.rows)) for (const row of rows) {
    const value = [row?.business_id, row?.businessId, row?.localBusinessId, row?.local_business_id].find(item => (typeof item === 'string' && item.trim()) || (typeof item === 'number' && Number.isSafeInteger(item)));
    const id = value === undefined ? '' : String(value).trim().toLowerCase();
    if (id && id !== LEGACY_BUSINESS_ID) concreteBusinessIds.add(id);
  }
  if (concreteBusinessIds.size > 1) securityBlockers.push('El archivo contiene identificadores locales distintos; separa los negocios antes de guardarlo.');

  for (const [entity, packageField] of Object.entries(SOURCE_STORES)) {
    const rows = packageValue.data[packageField];
    if (!Array.isArray(rows)) {
      missingStores.push(packageField);
      counts[entity] = 0;
      identityByModule[entity] = { total: 0, confirmed: 0, legacy: 0, missingId: 0, sharedId: 0, inferred: 0, otherBusiness: 0, duplicates: 0, inconsistentReferences: 0, references: [] };
      continue;
    }
    if (rows.length > MAX_RECORDS_PER_TYPE) throw httpError(400, 'MIGRATION_PACKAGE_INVALID');
    const seen = new Map();
    const localIdCounts = new Map();
    for (const row of rows) {
      const candidate = row && ['id', 'localId', 'sourceId', 'uuid', 'key'].map(key => row[key]).find(item => (typeof item === 'string' || typeof item === 'number') && String(item).trim());
      if (candidate !== undefined) {
        const localId = String(candidate).trim();
        localIdCounts.set(localId, (localIdCounts.get(localId) || 0) + 1);
      }
    }
    const duplicateLocalIds = new Set([...localIdCounts].filter(([, count]) => count > 1).map(([localId]) => localId));
    const moduleReview = identityByModule[entity] = { total: rows.length, confirmed: 0, legacy: 0, missingId: 0, sharedId: 0, inferred: 0, otherBusiness: 0, duplicates: 0, inconsistentReferences: 0, references: [] };
    const records = rows.map((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw httpError(400, 'MIGRATION_PACKAGE_INVALID');
      const clean = scrub(raw, omissions);
      const identityKey = recordKey(raw, index, seen);
      const rawBusinessId = [raw.business_id, raw.businessId, raw.localBusinessId, raw.local_business_id]
        .find(value => (typeof value === 'string' && value.trim()) || (typeof value === 'number' && Number.isSafeInteger(value)));
      const rowBusinessId = rawBusinessId === undefined ? '' : String(rawBusinessId).trim().toLowerCase();
      const idMatches = Boolean(identity.sourceBusinessId && rowBusinessId === identity.sourceBusinessId.toLowerCase());
      const inferred = idMatches && scope.idSource === 'inferred';
      const legacy = !rowBusinessId || rowBusinessId === LEGACY_BUSINESS_ID || inferred || (idMatches && scope.idSource !== 'config');
      const foreign = Boolean(rowBusinessId && rowBusinessId !== LEGACY_BUSINESS_ID && !idMatches);
      if (legacy) {
        moduleReview.legacy++;
        if (!rowBusinessId) moduleReview.missingId++;
        else if (rowBusinessId === LEGACY_BUSINESS_ID) moduleReview.sharedId++;
        else moduleReview.inferred++;
      } else if (foreign) {
        moduleReview.otherBusiness++;
        securityBlockers.push('Una fila de ' + entity + ' está asociada a otra identidad local; no se guardará junto a este negocio.');
      } else if (idMatches) moduleReview.confirmed++;
      const reference = identityKey.key;
      const localIdCandidate = raw && ['id', 'localId', 'sourceId', 'uuid', 'key'].map(key => raw[key]).find(item => (typeof item === 'string' || typeof item === 'number') && String(item).trim());
      const duplicate = Boolean((localIdCandidate !== undefined && duplicateLocalIds.has(String(localIdCandidate).trim())) || (identityKey.issue && identityKey.issue.includes('repetido')));
      const rowId = raw?.id === undefined || raw?.id === null ? `row-${index + 1}` : String(raw.id);
      const relatedIssues = analysis.issues.filter(issue => issue.entity === entity && issue.recordId === rowId);
      const reasons = [];
      if (duplicate) moduleReview.duplicates++;
      if (duplicate && !identityKey.issue) reasons.push('DUPLICATE_LOCAL_ID: The source identifier occurs more than once in this module.');
      if (identityKey.issue) reasons.push(identityKey.issue.includes('repetido') ? 'DUPLICATE_LOCAL_ID: ' + identityKey.issue : 'MISSING_LOCAL_ID: ' + identityKey.issue);
      if (legacy) reasons.push('IDENTITY_UNCONFIRMED: El ID de este registro no permite confirmar a qué negocio pertenece.');
      if (relatedIssues.length) {
        moduleReview.inconsistentReferences += relatedIssues.length;
        reasons.push('INCONSISTENT_REFERENCES: Hay referencias internas sin correspondencia verificable.');
      }
      const actorValue = ['usuario', 'userName', 'user_name', 'seller', 'vendedor', 'cashier', 'cajero', 'usuarioCreacion', 'usuarioApertura', 'usuarioCierre'].map(key => raw[key]).find(value => typeof value === 'string' && value.trim());
      if (entity === 'syncQueue') reasons.push('LOCAL_QUEUE_REQUIRES_REVIEW: La cola local no se ejecutará para evitar duplicados.');
      const imageValue = entity === 'products' ? raw.image : null;
      if (typeof imageValue === 'string' && imageValue.startsWith('data:')) {
        const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(imageValue);
        const byteLength = match ? Math.floor(match[2].length * 3 / 4) - (match[2].endsWith('==') ? 2 : match[2].endsWith('=') ? 1 : 0) : Infinity;
        if (!match || byteLength < 1 || byteLength > 8 * 1024 * 1024) reasons.push('IMAGE_REQUIRES_REVIEW: La imagen no cumple el formato o tamaño permitido; se conserva sin publicarla.');
      }
      const sharedLegacyId = rowBusinessId === LEGACY_BUSINESS_ID;
      const archiveOnlyEligible = entity === 'syncQueue' && packageValue.version >= 2 && !rowBusinessId &&
        Boolean(identity.sourceBusinessId) && scope.idSource === 'config' && !duplicate && !identityKey.issue && !relatedIssues.length;
      const nonIdentityPendingReasons = reasons.filter(reason => !reason.startsWith('IDENTITY_UNCONFIRMED:') &&
        !(entity === 'syncQueue' && reason.startsWith('LOCAL_QUEUE_REQUIRES_REVIEW:')));
      const bulkIdentityEligible = sharedLegacyId && nonIdentityPendingReasons.length === 0;
      const status = reasons.length ? 'PENDING' : 'ARCHIVED';
      const displayRef = [raw.id, raw.numero, raw.factura, raw.displayNumber].find(value => (typeof value === 'string' || typeof value === 'number') && String(value).trim()) ?? `fila ${index + 1}`;
      const context = {};
      for (const key of ['name', 'nombre', 'barcode', 'codigo', 'numero', 'factura', 'fecha', 'fechaTS', 'total', 'monto', 'categoria', 'tipo', 'estado', 'status', 'anulada']) {
        if (raw[key] !== undefined && (typeof raw[key] === 'string' || typeof raw[key] === 'number' || typeof raw[key] === 'boolean')) context[key] = String(raw[key]).slice(0, 100);
      }
      if ((legacy || foreign || duplicate || relatedIssues.length) && !archiveOnlyEligible) {
        if (moduleReview.references.length < 1000) moduleReview.references.push({ key: reference, reference: String(displayRef).slice(0, 120), identity: foreign ? 'OTHER_BUSINESS' : legacy ? (rowBusinessId === LEGACY_BUSINESS_ID ? 'SHARED_ID' : rowBusinessId ? 'INFERRED_ID' : 'MISSING_ID') : 'REQUIRES_REVIEW', duplicate, issues: relatedIssues.map(issue => ({ field: issue.field, target: issue.target, reference: issue.reference, issue: issue.issue })), context });
        reviewRecords.push({ entity, key: reference, reference: String(displayRef).slice(0, 120), identity: foreign ? 'OTHER_BUSINESS' : legacy ? 'LEGACY' : 'REQUIRES_REVIEW', identityReason: foreign ? 'OTHER_BUSINESS' : sharedLegacyId ? 'SHARED_ID' : !rowBusinessId ? 'MISSING_ID' : legacy ? 'INFERRED_ID' : 'DATA_INCONSISTENCY', bulkIdentityEligible, decisionStatus: 'PENDING', context });
      }
      return {
        entity, key: identityKey.key, fingerprint: hash(canonical(clean)), status, reason: reasons.length ? reasons.join(' ').slice(0, 500) : null,
        bulkIdentityEligible,
        archiveOnlyEligible,
        sharedLegacyIdentityRow: sharedLegacyId,
        originalReason: reasons.length ? reasons.join(' ').slice(0, 500) : null,
        nonIdentityPendingReason: nonIdentityPendingReasons.join(' ').slice(0, 500) || null,
        actor: actorValue ? Array.from(String(actorValue).trim()).slice(0, 180).join('') : null,
        payload: clean
      };
    });
    datasets.push(...records);
    counts[entity] = rows.length;
    if (moduleReview.references.length === 1000) moduleReview.referencesTruncated = true;
  }
  if (packageValue.version >= 2 && missingStores.length) blockers.push('El paquete 2 declara todas las tiendas locales; faltan: ' + missingStores.join(', ') + '.');
  if (packageValue.version === 1) blockers.push('El archivo versión 1 no incluye gastos, auditoría local, órdenes pendientes ni cola de sincronización. No se asumirán vacíos: se migrarán los datos disponibles y la migración quedará pendiente hasta verificar esos módulos.');
  if (missingStores.length && packageValue.version >= 2) blockers.push('Hay tiendas locales sin exportar.');
  const config = packageValue.data.configuration;
  if (config !== undefined) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw httpError(400, 'MIGRATION_PACKAGE_INVALID');
    const clean = scrub(config, omissions);
    datasets.push({ entity: 'configuration', key: 'configuration', fingerprint: hash(canonical(clean)), status: 'ARCHIVED', reason: null, actor: null, payload: clean });
    counts.configuration = 1;
  } else {
    missingStores.push('configuration'); counts.configuration = 0;
    blockers.push('No se incluyó la configuración comercial de origen.');
  }
  if (packageValue.data.categories !== undefined) {
    if (!Array.isArray(packageValue.data.categories) || packageValue.data.categories.some(value => typeof value !== 'string')) throw httpError(400, 'MIGRATION_PACKAGE_INVALID');
    const clean = scrub(packageValue.data.categories, omissions);
    datasets.push({ entity: 'categories', key: 'derived', fingerprint: hash(canonical(clean)), status: 'ARCHIVED', reason: null, actor: null, payload: clean });
    counts.categories = clean.length;
  }
  const identityTotals = Object.values(identityByModule).reduce((total, item) => {
    for (const key of ['confirmed', 'legacy', 'missingId', 'sharedId', 'inferred', 'otherBusiness', 'duplicates', 'inconsistentReferences']) total[key] += item[key] || 0;
    return total;
  }, { confirmed: 0, legacy: 0, missingId: 0, sharedId: 0, inferred: 0, otherBusiness: 0, duplicates: 0, inconsistentReferences: 0 });
  const archiveOnlyQueueRows = datasets.filter(item => item.entity === 'syncQueue' && item.archiveOnlyEligible).length;
  const legacyOutsideSharedId = Math.max(0, identityTotals.legacy - identityTotals.sharedId - archiveOnlyQueueRows);
  if (legacyOutsideSharedId) blockers.push('Hay ' + legacyOutsideSharedId + ' registros antiguos cuya pertenencia no se confirma con la autorización del identificador compartido. Se conservarán pendientes.');
  if (identityTotals.inferred) blockers.push('Hay registros con un identificador hallado en sus datos, pero no guardado como identidad persistente. Revisa su procedencia.');
  if (identityTotals.duplicates) blockers.push('Hay referencias locales repetidas que requieren revisión.');
  if (identityTotals.inconsistentReferences) blockers.push('Hay relaciones entre registros que no se pueden verificar.');
  const pendingRecords = datasets.filter(item => item.status === 'PENDING' && !item.bulkIdentityEligible && !item.archiveOnlyEligible).length;
  if (pendingRecords) blockers.push('Hay ' + pendingRecords + ' registros pendientes de revisión; se conservaron sin ejecutar ni alterar su estado original.');
  if (scope.idSource === 'ambiguous' || concreteBusinessIds.size > 1) blockers.push('El origen local declara más de un identificador; revisa y separa los negocios antes de migrar.');
  if (!identity.sourceBusinessId && !identityTotals.sharedId) blockers.push('El archivo no contiene una identidad persistente del origen. Se requiere evidencia del negocio y revisión de sus registros sin identificar.');
  if (Number(scope.excludedRecords) > 0) blockers.push('La exportación excluyó ' + Number(scope.excludedRecords) + ' registros asociados a otra identidad. Deben revisarse por separado.');
  if (Array.isArray(scope.missingStores) && scope.missingStores.length) blockers.push('La exportación no encontró las tiendas locales: ' + scope.missingStores.join(', ') + '.');
  if (omissions.count) blockers.push('Se retiraron ' + omissions.count + ' campos sensibles o identificadores de cuenta; no se copiaron contraseñas ni credenciales locales.');
  if (identityTotals.otherBusiness) securityBlockers.push('Hay registros asociados a otra identidad de negocio; no se guardarán junto al destino seleccionado.');
  if (concreteBusinessIds.size > 1) securityBlockers.push('El paquete contiene varios identificadores concretos de negocio; no se guardará.');
  if (Number(scope.excludedRecords) > 0) securityBlockers.push('El exportador excluyó registros de otra identidad; revisa el origen antes de guardar.');
  const scopedSourceId = typeof scope.localBusinessId === 'string' ? scope.localBusinessId.trim() : '';
  if (scopedSourceId && identity.sourceBusinessId && scopedSourceId.toLowerCase() !== identity.sourceBusinessId.toLowerCase()) securityBlockers.push('La identidad del paquete no coincide con el alcance declarado por la exportación.');
  if (legacyOutsideSharedId || scope.idSource === 'inferred') blockers.push('La pertenencia de algunos registros no está confirmada; permanecerán pendientes hasta que su procedencia pueda comprobarse.');
  if (analysis.issues.length) blockers.push('Se detectaron ' + analysis.issues.length + ' relaciones no verificables; revisa sus referencias.');
  const blockerDetails = blockers.map(message => ({
    code: message.includes('registros cuya pertenencia') ? 'LEGACY_IDENTITY'
      : message.includes('registros pendientes de revisi') ? 'PENDING_RECORDS'
        : message.includes('identidad persistente del origen') ? 'SOURCE_IDENTITY_MISSING'
          : message.includes('La pertenencia de algunos registros') ? 'LEGACY_SOURCE_IDENTITY'
              : message.includes('relaciones entre registros') || message.includes('relaciones no verificables') ? 'INCONSISTENT_REFERENCES'
                : message.includes('referencias locales repetidas') ? 'DUPLICATE_LOCAL_IDS' : 'PACKAGE_BLOCKER',
    message
  }));
  const manifest = {
    format: 'pos_local_migration_archive_v1', packageVersion: packageValue.version,
    sourceCounts: counts, recordsExpected: datasets.length, missingStores: [...new Set(missingStores)],
    sensitiveFieldsRemoved: omissions.count, blockers, blockerDetails, securityBlockers,
    identityReview: { counts: identityTotals, byModule: identityByModule, records: reviewRecords.slice(0, 1000), recordsTruncated: reviewRecords.length > 1000, referenceIssues: analysis.issues.slice(0, 1000), referenceIssuesTruncated: analysis.issues.length > 1000 },
    archiveOnlyEntities: archiveOnlyQueueRows ? { syncQueue: { records: archiveOnlyQueueRows, execution: 'NEVER', reason: 'Se conserva para auditoría; no se vuelve a ejecutar.' } } : {}
  };
  const packageSha256 = originalFingerprint;
  return { ...identity, sourceIdSource: scope.idSource || null, packageSha256, packageVersion: packageValue.version, records: datasets, manifest,
    legacyIdentityConfirmationRequired: identityTotals.sharedId > 0,
    bulkIdentityEligibleRecords: datasets.filter(item => item.bulkIdentityEligible).length };
}

function createSystemAdminMigrationArchive({ repo, requireSystemAdmin }) {
  async function assertSchema(db) {
    const rows = await repo.rows(db, "SELECT TABLE_NAME AS tableName,COLUMN_NAME AS columnName FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('migration_import_batches','migration_source_records','business_migration_controls')", []);
    const required = {
      migration_import_batches: ['id', 'business_id', 'source_business_key', 'source_business_name', 'package_sha256', 'package_version', 'status', 'current_stage', 'actor_business_id', 'actor_user_id', 'manifest', 'stage_results', 'created_at', 'updated_at', 'completed_at'],
      migration_source_records: ['business_id', 'batch_id', 'entity_type', 'source_record_key', 'source_fingerprint', 'record_status', 'target_table', 'target_record_id', 'source_actor', 'pending_reason', 'source_payload', 'created_at', 'updated_at'],
      business_migration_controls: ['business_id', 'state', 'source_business_key', 'batch_id', 'actor_business_id', 'actor_user_id', 'created_at', 'completed_at']
    };
    const actual = new Map();
    for (const row of rows) actual.set(row.tableName, [...(actual.get(row.tableName) || []), row.columnName]);
    if (Object.entries(required).some(([table, columns]) => !columns.every(column => actual.get(table)?.includes(column)))) throw httpError(503, 'MIGRATION_ARCHIVE_SCHEMA_REQUIRED');
  }

  async function assertTarget(db, businessId, lock = false) {
    const [business] = await repo.rows(db, 'SELECT b.id,b.name,b.status,c.state AS migrationState,c.source_business_key AS sourceBusinessKey,c.batch_id AS batchId FROM businesses b LEFT JOIN business_migration_controls c ON c.business_id=b.id WHERE b.id=?' + (lock ? ' FOR UPDATE' : ''), [businessId]);
    if (!business) throw httpError(404, 'BUSINESS_NOT_FOUND');
    if (business.status !== 'INACTIVE' || business.migrationState !== 'PENDING') throw httpError(409, 'MIGRATION_TARGET_REQUIRED');
    return business;
  }

  function jsonObject(value) {
    if (value && typeof value === 'object') return value;
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; }
    catch { return {}; }
  }

  async function inspectContinuation(db, business, plan, existingBatch = null) {
    if (existingBatch) {
      const priorManifest = jsonObject(existingBatch.manifest);
      return {
        continuation: priorManifest.continuation || null,
        conflicts: [],
        priorBatch: { id: existingBatch.id, status: existingBatch.status, packageVersion: Number(existingBatch.packageVersion), packageSha256: existingBatch.packageSha256 }
      };
    }
    if (!business.sourceBusinessKey || business.sourceBusinessKey === plan.sourceBusinessKey) {
      return { continuation: null, conflicts: [], priorBatch: null };
    }
    const conflicts = [];
    const addConflict = (entity, sourceRecordKey, field, reason) => {
      if (conflicts.length < 100) conflicts.push({ entity, sourceRecordKey, field, reason });
    };
    if (plan.packageVersion !== 2 || !plan.sourceBusinessId || plan.sourceIdSource !== 'config') {
      addConflict('package', null, 'sourceIdentity', 'La continuación requiere un paquete versión 2 con identidad local persistente.');
    }
    if (plan.manifest.securityBlockers.length || plan.manifest.missingStores.length || plan.manifest.identityReview.counts.otherBusiness ||
        plan.manifest.identityReview.counts.duplicates || plan.manifest.identityReview.counts.inconsistentReferences) {
      addConflict('package', null, 'integrity', 'El paquete nuevo contiene alertas de integridad que impiden continuar el lote anterior.');
    }
    if (!business.batchId) {
      addConflict('business', null, 'batchId', 'El destino ya está ligado a un origen anterior, pero no se encontró su lote.');
      return { continuation: null, conflicts, priorBatch: null };
    }
    const [previous] = await repo.rows(db,
      'SELECT id,source_business_key AS sourceBusinessKey,source_business_name AS sourceBusinessName,package_sha256 AS packageSha256,package_version AS packageVersion,status,manifest FROM migration_import_batches WHERE business_id=? AND id=?',
      [business.id, business.batchId]);
    if (!previous || previous.sourceBusinessKey !== business.sourceBusinessKey || Number(previous.packageVersion) !== 1) {
      addConflict('business', null, 'sourceBinding', 'El lote previo no es una importación versión 1 verificable para este destino.');
      return { continuation: null, conflicts, priorBatch: previous ? { id: previous.id, status: previous.status, packageVersion: Number(previous.packageVersion), packageSha256: previous.packageSha256 } : null };
    }
    const previousManifest = jsonObject(previous.manifest);
    const confirmation = previousManifest.identityReview?.batchConfirmation;
    if (confirmation?.confirmed !== true || confirmation.packageSha256 !== previous.packageSha256 ||
        String(confirmation.targetBusinessId) !== String(business.id) || !confirmation.adminIdentity?.userId || !confirmation.confirmedAt) {
      addConflict('business', null, 'priorAuthorization', 'No se encontró la confirmación administrativa válida del paquete anterior.');
    }
    if (normalizeName(previous.sourceBusinessName) !== normalizeName(plan.sourceBusinessName)) {
      addConflict('package', null, 'businessName', 'El nombre de origen difiere del lote anterior; no se pudo demostrar continuidad.');
    }

    const previousRows = await repo.rows(db,
      'SELECT entity_type AS entityType,source_record_key AS sourceRecordKey,record_status AS recordStatus,target_table AS targetTable,target_record_id AS targetRecordId,source_actor AS sourceActor,pending_reason AS pendingReason,source_payload AS payload FROM migration_source_records WHERE business_id=? AND batch_id=? ORDER BY entity_type,source_record_key',
      [business.id, previous.id]);
    const currentRows = new Map(plan.records.map(row => [row.entity + ':' + row.key, row]));
    for (const row of previousRows) {
      const key = row.entityType + ':' + row.sourceRecordKey;
      const current = currentRows.get(key);
      if (!current) {
        addConflict(row.entityType, row.sourceRecordKey, 'record', 'El paquete versión 2 no contiene un registro ya archivado en la versión 1.');
        continue;
      }
      const oldPayload = jsonObject(row.payload);
      const mismatch = firstSubsetMismatch(oldPayload, current.payload);
      if (mismatch) addConflict(row.entityType, row.sourceRecordKey, mismatch, 'El mismo identificador local contiene información diferente entre los paquetes.');
      if (row.sourceActor && current.actor && String(row.sourceActor) !== String(current.actor)) {
        addConflict(row.entityType, row.sourceRecordKey, 'sourceActor', 'El responsable histórico difiere entre los paquetes.');
      }
      if (row.recordStatus === 'PROJECTED' && (!row.targetTable || !row.targetRecordId)) {
        addConflict(row.entityType, row.sourceRecordKey, 'targetMapping', 'El registro marcado como trasladado no conserva su referencia operativa.');
      }
    }
    if (previousRows.length !== Number(previousManifest.recordsExpected || previousRows.length)) {
      addConflict('package', null, 'priorArchiveCount', 'El lote anterior no contiene todos los registros que declaró archivar.');
    }
    const referenceTables = new Map();
    const permittedTargetTables = new Set(['products', 'clients', 'suppliers', 'business_settings', 'sales', 'purchases', 'customer_payments', 'supplier_payments', 'cash_sessions', 'expenses', 'inventory_movements', 'migration_zero_inventory_events', 'sale_orders', 'audit_logs']);
    for (const row of previousRows.filter(item => item.recordStatus === 'PROJECTED' && item.targetTable !== 'products.category')) {
      if (!permittedTargetTables.has(row.targetTable) || !/^[1-9]\d{0,19}$/.test(String(row.targetRecordId || ''))) {
        addConflict(row.entityType, row.sourceRecordKey, 'targetMapping', 'La referencia operativa previa no es verificable.');
        continue;
      }
      referenceTables.set(row.targetTable, [...(referenceTables.get(row.targetTable) || []), String(row.targetRecordId)]);
    }
    for (const [table, ids] of referenceTables) {
      const uniqueIds = [...new Set(ids)];
      const found = await repo.rows(db, 'SELECT id FROM `' + table + '` WHERE business_id=? AND id IN (' + uniqueIds.map(() => '?').join(',') + ')', [business.id, ...uniqueIds]);
      const foundIds = new Set(found.map(row => String(row.id)));
      for (const row of previousRows) {
        if (row.recordStatus === 'PROJECTED' && row.targetTable === table && !foundIds.has(String(row.targetRecordId))) {
          addConflict(row.entityType, row.sourceRecordKey, 'targetMapping', 'El registro operativo del lote anterior ya no existe en el negocio seleccionado.');
        }
      }
    }
    const continuation = {
      mode: 'V1_TO_V2_CONTINUATION',
      priorBatchId: previous.id,
      priorPackageSha256: previous.packageSha256,
      priorFileSha256: previousManifest.packageHashes?.originalFileSha256 || null,
      priorPackageVersion: Number(previous.packageVersion),
      canonicalSourceBusinessKey: business.sourceBusinessKey,
      nextSourceBusinessKey: plan.sourceBusinessKey,
      stableLocalBusinessId: plan.sourceBusinessId,
      matchedPriorRecords: Math.max(0, previousRows.length - conflicts.filter(item => item.field === 'record').length),
      priorProjectedRecords: previousRows.filter(row => row.recordStatus === 'PROJECTED').length,
      priorUnresolvedProjectedRecords: previousRows.filter(row => row.recordStatus === 'PROJECTED' && row.pendingReason).length,
      priorPackageRecords: previousRows.length,
      conflicts
    };
    return {
      continuation,
      conflicts,
      priorBatch: { id: previous.id, status: previous.status, packageVersion: Number(previous.packageVersion), packageSha256: previous.packageSha256 },
      priorRows: previousRows
    };
  }

  function targetNameMatchesSource(business, plan) {
    return normalizeName(business.name) === normalizeName(plan.sourceBusinessName);
  }

  function validateTarget(businessId) {
    if (typeof businessId !== 'string' || !/^[1-9]\d{0,19}$/.test(businessId) || BigInt(businessId) > 18446744073709551615n) throw httpError(400, 'INVALID_INPUT');
  }

  function applyPackageIdentityConfirmation(plan, confirmed) {
    if (plan.legacyIdentityConfirmationRequired && confirmed !== true) throw httpError(409, 'MIGRATION_LEGACY_IDENTITY_CONFIRMATION_REQUIRED');
    if (!confirmed) return { identityResolvedRows: 0, recordsNowImportable: 0 };

    const sharedRows = new Set(plan.records.filter(record => record.sharedLegacyIdentityRow).map(record => `${record.entity}:${record.key}`));
    const archiveOnlyQueue = new Set(plan.records.filter(record => record.archiveOnlyEligible).map(record => `${record.entity}:${record.key}`));
    let recordsNowImportable = 0;
    let archiveOnlyRecords = 0;
    for (const record of plan.records) {
      const recordKey = `${record.entity}:${record.key}`;
      const isShared = sharedRows.has(recordKey);
      const isArchiveOnly = archiveOnlyQueue.has(recordKey);
      if (!isShared && !isArchiveOnly) continue;
      if (record.nonIdentityPendingReason) {
        record.status = 'PENDING';
        record.reason = record.nonIdentityPendingReason;
      } else {
        record.status = 'ARCHIVED';
        record.reason = null;
        if (isArchiveOnly) archiveOnlyRecords++;
        else recordsNowImportable++;
      }
    }
    for (const record of plan.manifest.identityReview.records) {
      if (record.identityReason === 'SHARED_ID') record.decisionStatus = record.bulkIdentityEligible ? 'AUTHORIZED_BY_PACKAGE' : 'IDENTITY_CONFIRMED_OTHER_ALERTS';
    }

    const unresolvedLegacy = Math.max(0, Number(plan.manifest.identityReview.counts.legacy || 0) - sharedRows.size - archiveOnlyQueue.size);
    const details = (plan.manifest.blockerDetails || []).filter(item => ![
      'LEGACY_IDENTITY', 'PENDING_RECORDS', 'SOURCE_IDENTITY_MISSING', 'LEGACY_SOURCE_IDENTITY'
    ].includes(item.code));
    if (unresolvedLegacy) details.push({ code: 'LEGACY_IDENTITY', message: `Quedan ${unresolvedLegacy} registros cuya pertenencia requiere una revisión adicional.` });
    const remainingPending = plan.records.filter(record => record.status === 'PENDING').length;
    if (remainingPending) details.push({ code: 'PENDING_RECORDS', message: `Hay ${remainingPending} registros con duplicados, relaciones u otros datos pendientes; no se importarán.` });
    plan.manifest.blockerDetails = details;
    plan.manifest.blockers = details.map(item => item.message);
    plan.manifest.identityReview.bulkConfirmedRecords = recordsNowImportable;
    plan.manifest.identityReview.identityConfirmedRecords = sharedRows.size;
    plan.manifest.identityReview.unresolvedLegacyRecords = unresolvedLegacy;
    plan.manifest.archiveOnlyEntities = archiveOnlyQueue.size ? {
      ...(plan.manifest.archiveOnlyEntities || {}),
      syncQueue: { records: archiveOnlyRecords, execution: 'NEVER', reason: 'Se conserva para auditoría; no se vuelve a ejecutar.' }
    } : (plan.manifest.archiveOnlyEntities || {});
    return { identityResolvedRows: sharedRows.size, recordsNowImportable, archiveOnlyRecords };
  }

  function setFileHash(plan, fileSha256) {
    if (fileSha256 !== null && fileSha256 !== undefined && (typeof fileSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(fileSha256))) throw httpError(400, 'INVALID_INPUT');
    plan.fileSha256 = fileSha256 || null;
    plan.manifest.packageHashes = { canonicalSha256: plan.packageSha256, originalFileSha256: plan.fileSha256 };
  }

  async function preview(auth, businessId, packageValue, fileSha256 = null) {
    requireSystemAdmin(auth);
    validateTarget(businessId);
    const plan = buildArchivePlan(packageValue);
    setFileHash(plan, fileSha256);
    await assertSchema(repo.pool);
    const business = await assertTarget(repo.pool, businessId);
    const [prior] = await repo.rows(repo.pool, 'SELECT id,package_sha256 AS packageSha256,package_version AS packageVersion,status,manifest FROM migration_import_batches WHERE business_id=? AND source_business_key=?', [businessId, plan.sourceBusinessKey]);
    if (prior && prior.packageSha256 !== plan.packageSha256) throw httpError(409, 'MIGRATION_PACKAGE_CHANGED');
    const continuationInfo = await inspectContinuation(repo.pool, business, plan, prior || null);
    const priorManifest = prior ? (typeof prior.manifest === 'string' ? JSON.parse(prior.manifest) : prior.manifest) : null;
    if (plan.fileSha256 && priorManifest?.packageHashes?.originalFileSha256 && plan.fileSha256 !== priorManifest.packageHashes.originalFileSha256) throw httpError(409, 'MIGRATION_PACKAGE_CHANGED');
    const priorIdentityConfirmation = priorManifest?.identityReview?.batchConfirmation || null;
    const continuationMessages = continuationInfo.conflicts.map(item => `${item.entity}${item.sourceRecordKey ? ' ' + item.sourceRecordKey : ''} · ${item.field}: ${item.reason}`);
    const startBlockers = [...plan.manifest.securityBlockers, ...continuationMessages,
      ...(String(business.id) === '1' ? ['El negocio principal del sistema no puede recibir paquetes locales.'] : [])];
    const reconciliationNotes = [
      ...plan.manifest.blockers,
      ...(continuationInfo.continuation ? ['Se continuará el lote versión 1 ' + continuationInfo.continuation.priorBatchId + ' con el paquete versión 2; ' + continuationInfo.continuation.matchedPriorRecords + ' registros anteriores tienen coincidencia por identificador y contenido.'] : []),
      ...(plan.manifest.archiveOnlyEntities?.syncQueue ? [plan.manifest.archiveOnlyEntities.syncQueue.records + ' elementos de la cola local se conservarán solo para auditoría y nunca se ejecutarán.'] : []),
      ...(!targetNameMatchesSource(business, plan) ? ['El nombre de origen difiere del destino; verifica que el archivo corresponda al negocio seleccionado.'] : [])
    ];
    return {
      ok: true, targetBusinessId: String(business.id), targetBusinessName: business.name,
      targetStatus: business.status, targetMigrationState: business.migrationState,
      sourceBusinessKey: plan.sourceBusinessKey, sourceBusinessName: plan.sourceBusinessName,
      packageSha256: plan.packageSha256, packageVersion: plan.packageVersion,
      fileSha256: plan.fileSha256,
      counts: plan.manifest.sourceCounts, recordsExpected: plan.manifest.recordsExpected,
      missingStores: plan.manifest.missingStores, sensitiveFieldsRemoved: plan.manifest.sensitiveFieldsRemoved,
      identityReview: plan.manifest.identityReview,
      continuation: continuationInfo.continuation,
      continuationConflicts: continuationInfo.conflicts,
      archiveOnlyEntities: plan.manifest.archiveOnlyEntities,
      legacyIdentityConfirmationRequired: plan.legacyIdentityConfirmationRequired,
      bulkIdentityEligibleRecords: plan.bulkIdentityEligibleRecords,
      legacyIdentityConfirmation: priorIdentityConfirmation,
      startBlockers,
      reconciliationNotes,
      blockers: [...startBlockers, ...reconciliationNotes],
      eligibleToArchive: startBlockers.length === 0,
      priorBatch: prior ? { id: prior.id, status: prior.status } : continuationInfo.priorBatch
    };
  }

  async function archive(auth, businessId, packageValue, confirmed, fileSha256 = null) {
    requireSystemAdmin(auth);
    validateTarget(businessId);
    if (confirmed !== true) throw httpError(409, 'MIGRATION_ARCHIVE_CONFIRMATION_REQUIRED');
    if (String(businessId) === '1') throw httpError(409, 'MIGRATION_SYSTEM_BUSINESS_CONFIRMATION_REQUIRED');
    const plan = buildArchivePlan(packageValue);
    setFileHash(plan, fileSha256);
    if (plan.manifest.securityBlockers.length) throw httpError(409, 'MIGRATION_SOURCE_SCOPE_REQUIRED');
    const identityAuthorization = applyPackageIdentityConfirmation(plan, confirmed);
    const bulkIdentityConfirmedRows = identityAuthorization.identityResolvedRows;
    plan.manifest.identityReview.sourceEvidence = {
      sourceName: plan.sourceBusinessName, targetName: null, operatorUserId: String(auth.user_id)
    };
    let batchId;
    let identityConfirmation = null;
    let identityConfirmationCreated = false;
    let continuationInfo = null;
    let continuationRecordMap = new Map();
    let effectiveSourceBusinessKey = plan.sourceBusinessKey;
    await repo.transaction(async db => {
      await assertSchema(db);
      const business = await assertTarget(db, businessId, true);
      const [existing] = await repo.rows(db, 'SELECT id,package_sha256 AS packageSha256,package_version AS packageVersion,status,manifest FROM migration_import_batches WHERE business_id=? AND source_business_key=? FOR UPDATE', [businessId, plan.sourceBusinessKey]);
      continuationInfo = await inspectContinuation(db, business, plan, existing || null);
      if (continuationInfo.conflicts.length) throw httpError(409, 'MIGRATION_CONTINUATION_CONFLICT');
      if (continuationInfo.continuation) {
        plan.manifest.continuation = continuationInfo.continuation;
        effectiveSourceBusinessKey = continuationInfo.continuation.canonicalSourceBusinessKey || plan.sourceBusinessKey;
        continuationRecordMap = new Map((continuationInfo.priorRows || []).map(row => [row.entityType + ':' + row.sourceRecordKey, row]));
        const excluded = (continuationInfo.priorRows || []).filter(row => row.recordStatus === 'EXCLUDED');
        if (excluded.length) {
          const message = 'El lote anterior contiene ' + excluded.length + ' registros excluidos; se conservaron excluidos y requieren resolución antes de completar.';
          plan.manifest.blockers = [...(plan.manifest.blockers || []), message];
          plan.manifest.blockerDetails = [...(plan.manifest.blockerDetails || []), { code: 'PRIOR_EXCLUSIONS', message }];
          plan.manifest.continuation.excludedPriorRecords = excluded.length;
        }
      }
       plan.manifest.identityReview.sourceEvidence.targetName = business.name;
       plan.manifest.identityReview.sourceEvidence.nameMatches = targetNameMatchesSource(business, plan);
      if (existing) {
        if (existing.packageSha256 !== plan.packageSha256) throw httpError(409, 'MIGRATION_PACKAGE_CHANGED');
        batchId = existing.id;
      }
      const existingManifest = existing ? (typeof existing.manifest === 'string' ? JSON.parse(existing.manifest) : existing.manifest) : null;
      if (plan.fileSha256 && existingManifest?.packageHashes?.originalFileSha256 && plan.fileSha256 !== existingManifest.packageHashes.originalFileSha256) throw httpError(409, 'MIGRATION_PACKAGE_CHANGED');
      const existingConfirmation = existingManifest?.identityReview?.batchConfirmation || null;
      if (existingConfirmation && (existingConfirmation.packageSha256 !== plan.packageSha256 || String(existingConfirmation.targetBusinessId) !== String(business.id))) throw httpError(409, 'MIGRATION_BATCH_CONFLICT');
      if (confirmed) {
        if (existingConfirmation) {
          const { evidenceReference: unusedEvidenceReference, ...storedConfirmation } = existingConfirmation;
          void unusedEvidenceReference;
          identityConfirmation = { ...storedConfirmation, confirmationText: 'Confirmo que este archivo pertenece al negocio seleccionado y autorizo su migración' };
        }
        else {
          const [timestamp] = await repo.rows(db, 'SELECT UTC_TIMESTAMP(3) AS confirmedAt', []);
          const confirmedAt = timestamp.confirmedAt instanceof Date ? timestamp.confirmedAt.toISOString() : new Date(timestamp.confirmedAt).toISOString();
          identityConfirmation = {
            version: 1,
            scope: plan.packageVersion >= 2 && identityAuthorization.archiveOnlyRecords ? 'PACKAGE_PROVENANCE_WITH_AUDIT_ONLY_QUEUE' : plan.legacyIdentityConfirmationRequired ? 'SHARED_LEGACY_BUSINESS_ID_ROWS_ONLY' : 'PACKAGE_PROVENANCE',
            confirmed: true,
            confirmationText: 'Confirmo que este archivo pertenece al negocio seleccionado y autorizo su migración',
            packageSha256: plan.packageSha256,
            fileSha256: plan.fileSha256,
            targetBusinessId: String(business.id),
            eligibleRecords: identityAuthorization.recordsNowImportable,
            identityResolvedRecords: bulkIdentityConfirmedRows,
            archiveOnlyRecords: identityAuthorization.archiveOnlyRecords,
            sharedIdentityRecords: Number(plan.manifest.identityReview.counts.sharedId || 0),
            adminIdentity: { businessId: String(auth.business_id), userId: String(auth.user_id), username: String(auth.username || '') },
            confirmedAt
          };
          identityConfirmationCreated = true;
        }
        plan.manifest.identityReview.batchConfirmation = identityConfirmation;
      }
      if (existing) {
        if (Array.isArray(existingManifest?.identityReviewDecisions)) plan.manifest.identityReviewDecisions = existingManifest.identityReviewDecisions;
      } else {
        // A destination already bound to a verified v1 batch may continue with
        // its v2 package. Any unrelated existing batch remains a hard conflict.
        if (business.batchId && !continuationInfo?.continuation) throw httpError(409, 'MIGRATION_BATCH_CONFLICT');
        batchId = randomUUID();
        await repo.rows(db, 'INSERT INTO migration_import_batches (id,business_id,source_business_key,source_business_name,package_sha256,package_version,status,current_stage,actor_business_id,actor_user_id,manifest,stage_results,created_at,updated_at) VALUES (?,?,?,?,?,? ,\'ARCHIVING\',\'ARCHIVE\',?,?,?,JSON_OBJECT(),UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))',
          [batchId, businessId, plan.sourceBusinessKey, plan.sourceBusinessName, plan.packageSha256, plan.packageVersion, String(auth.business_id), String(auth.user_id), JSON.stringify(plan.manifest)]);
        await repo.rows(db, 'INSERT INTO audit_logs (business_id,user_id,action,entity,entity_id,details,created_at) VALUES (?,NULL,?,?,?,?,UTC_TIMESTAMP(3))',
          [businessId, 'LOCAL_MIGRATION_ARCHIVE_STARTED', 'migration_import_batches', batchId, JSON.stringify({ batchId, sourceBusinessKey: plan.sourceBusinessKey, packageSha256: plan.packageSha256, fileSha256: plan.fileSha256, sourceBusinessName: plan.sourceBusinessName, targetBusinessId: String(business.id), recordsExpected: plan.manifest.recordsExpected, operatorUserId: String(auth.user_id), continuation: plan.manifest.continuation || null })]);
      }
      plan.manifest.identityReview.sourceEvidence.targetName = business.name;
      plan.manifest.identityReview.sourceEvidence.nameMatches = targetNameMatchesSource(business, plan);
      await repo.rows(db, 'UPDATE migration_import_batches SET manifest=?,updated_at=UTC_TIMESTAMP(3) WHERE business_id=? AND id=?', [JSON.stringify(plan.manifest), businessId, batchId]);
      if (identityConfirmationCreated) {
        await repo.rows(db, 'INSERT INTO audit_logs (business_id,user_id,action,entity,entity_id,details,created_at) VALUES (?,NULL,?,?,?,?,UTC_TIMESTAMP(3))',
          [businessId, 'LOCAL_MIGRATION_PACKAGE_AUTHORIZED', 'migration_import_batches', batchId, JSON.stringify({ ...identityConfirmation, batchId, packageSha256: plan.packageSha256, fileSha256: plan.fileSha256, continuation: plan.manifest.continuation || null })]);
      }
      if (!business.sourceBusinessKey || !business.batchId) {
        await repo.rows(db, 'UPDATE business_migration_controls SET source_business_key=?,batch_id=? WHERE business_id=? AND state=\'PENDING\' AND (source_business_key IS NULL OR source_business_key=?) AND (batch_id IS NULL OR batch_id=?)', [plan.sourceBusinessKey, batchId, businessId, plan.sourceBusinessKey, batchId]);
      } else if (continuationInfo.continuation && String(business.batchId) !== String(batchId)) {
        await repo.rows(db, 'UPDATE business_migration_controls SET batch_id=? WHERE business_id=? AND state=\'PENDING\' AND source_business_key=? AND batch_id=?', [batchId, businessId, effectiveSourceBusinessKey, continuationInfo.continuation.priorBatchId]);
      }
      const [binding] = await repo.rows(db, 'SELECT state,source_business_key AS sourceBusinessKey,batch_id AS batchId FROM business_migration_controls WHERE business_id=? FOR UPDATE', [businessId]);
      if (!binding || binding.state !== 'PENDING' || binding.sourceBusinessKey !== effectiveSourceBusinessKey || String(binding.batchId) !== String(batchId)) throw httpError(409, 'MIGRATION_BATCH_CONFLICT');
      if (business.id === 1) throw httpError(409, 'MIGRATION_SYSTEM_BUSINESS_CONFIRMATION_REQUIRED');
    });

    for (let offset = 0; offset < plan.records.length; offset += CHUNK_SIZE) {
      const chunk = plan.records.slice(offset, offset + CHUNK_SIZE);
      await repo.transaction(async db => {
        const [batch] = await repo.rows(db, 'SELECT id,package_sha256 AS packageSha256,status FROM migration_import_batches WHERE business_id=? AND id=? FOR UPDATE', [businessId, batchId]);
        if (!batch || batch.packageSha256 !== plan.packageSha256) throw httpError(409, 'MIGRATION_BATCH_CONFLICT');
        for (const item of chunk) {
          const [prior] = await repo.rows(db, 'SELECT source_fingerprint AS fingerprint,record_status AS recordStatus,pending_reason AS pendingReason FROM migration_source_records WHERE business_id=? AND batch_id=? AND entity_type=? AND source_record_key=? FOR UPDATE', [businessId, batchId, item.entity, item.key]);
          if (prior) {
            if (prior.fingerprint !== item.fingerprint) throw httpError(409, 'MIGRATION_RECORD_CONFLICT');
            if ((item.sharedLegacyIdentityRow || item.archiveOnlyEligible) && prior.recordStatus === 'PENDING' && String(prior.pendingReason || '') === String(item.originalReason || '')) {
              await repo.rows(db, 'UPDATE migration_source_records SET record_status=?,pending_reason=?,updated_at=UTC_TIMESTAMP(3) WHERE business_id=? AND batch_id=? AND entity_type=? AND source_record_key=? AND source_fingerprint=? AND record_status=\'PENDING\'', [item.status, item.reason, businessId, batchId, item.entity, item.key, item.fingerprint]);
            }
            continue;
          }
          const previousRow = continuationRecordMap.get(item.entity + ':' + item.key);
          let recordStatus = item.status, targetTable = null, targetRecordId = null, pendingReason = item.reason;
          if (previousRow?.recordStatus === 'PROJECTED' && !['configuration', 'categories'].includes(item.entity)) {
            recordStatus = 'PROJECTED'; targetTable = previousRow.targetTable; targetRecordId = previousRow.targetRecordId; pendingReason = previousRow.pendingReason;
          } else if (previousRow?.recordStatus === 'EXCLUDED') {
            recordStatus = 'EXCLUDED'; pendingReason = 'PREVIOUS_BATCH_EXCLUDED';
          }
          await repo.rows(db, 'INSERT INTO migration_source_records (business_id,batch_id,entity_type,source_record_key,source_fingerprint,record_status,target_table,target_record_id,source_actor,pending_reason,source_payload,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))',
            [businessId, batchId, item.entity, item.key, item.fingerprint, recordStatus, targetTable, targetRecordId, item.actor, pendingReason, JSON.stringify(item.payload)]);
        }
        await repo.rows(db, 'UPDATE migration_import_batches SET current_stage=\'ARCHIVE\',updated_at=UTC_TIMESTAMP(3) WHERE business_id=? AND id=?', [businessId, batchId]);
      });
    }

    const result = await repo.transaction(async db => {
      const [counts] = await repo.rows(db, 'SELECT COUNT(*) AS total, SUM(record_status=\'PENDING\') AS pending FROM migration_source_records WHERE business_id=? AND batch_id=?', [businessId, batchId]);
      if (Number(counts.total) !== plan.manifest.recordsExpected) throw httpError(409, 'MIGRATION_ARCHIVE_INCOMPLETE');
      const status = plan.manifest.blockers.length || Number(counts.pending) ? 'BLOCKED' : 'ARCHIVED';
      const [priorBatch] = await repo.rows(db, 'SELECT status FROM migration_import_batches WHERE business_id=? AND id=? FOR UPDATE', [businessId, batchId]);
      await repo.rows(db, 'UPDATE migration_import_batches SET status=?,current_stage=?,updated_at=UTC_TIMESTAMP(3) WHERE business_id=? AND id=?', [status, status === 'BLOCKED' ? 'REVIEW_REQUIRED' : 'ARCHIVE_COMPLETE', businessId, batchId]);
      if (!['ARCHIVED', 'BLOCKED'].includes(priorBatch?.status)) {
        await repo.rows(db, 'INSERT INTO audit_logs (business_id,user_id,action,entity,entity_id,details,created_at) VALUES (?,NULL,?,?,?,?,UTC_TIMESTAMP(3))',
          [businessId, 'LOCAL_MIGRATION_ARCHIVE_SAVED', 'migration_import_batches', batchId, JSON.stringify({ batchId, packageSha256: plan.packageSha256, records: Number(counts.total), pending: Number(counts.pending), blockers: plan.manifest.blockers })]);
      }
      return { batchId, status, recordsArchived: Number(counts.total), pendingRecords: Number(counts.pending), blockers: plan.manifest.blockers };
    });
    return { ok: true, ...result, sourceBusinessKey: plan.sourceBusinessKey, packageSha256: plan.packageSha256, fileSha256: plan.fileSha256, counts: plan.manifest.sourceCounts,
      startBlockers: [], reconciliationNotes: plan.manifest.blockers,
      identityConfirmation, identityConfirmationApplied: bulkIdentityConfirmedRows,
      identityConfirmedImportableRecords: identityAuthorization.recordsNowImportable,
      archiveOnlyRecords: identityAuthorization.archiveOnlyRecords,
      continuation: continuationInfo?.continuation || null,
      continuationConflicts: continuationInfo?.conflicts || [] };
  }

  async function reviewIdentityRecord(auth, businessId, batchId, entity, sourceRecordKey, decision, attestBelongsToSource = false) {
    requireSystemAdmin(auth);
    validateTarget(businessId);
    if (typeof batchId !== 'string' || !/^[0-9a-f-]{36}$/i.test(batchId) ||
        !Object.values(SOURCE_STORES).includes(entity) || typeof sourceRecordKey !== 'string' ||
        !sourceRecordKey.trim() || sourceRecordKey.length > 120 || hasControlChars(sourceRecordKey) ||
        !['INCLUDE', 'EXCLUDE'].includes(decision) || typeof attestBelongsToSource !== 'boolean') throw httpError(400, 'INVALID_INPUT');
    if (decision === 'INCLUDE' && attestBelongsToSource !== true) throw httpError(409, 'MIGRATION_IDENTITY_CONFIRMATION_REQUIRED');
    await assertSchema(repo.pool);
    return repo.transaction(async db => {
      const business = await assertTarget(db, businessId, true);
      const [batch] = await repo.rows(db, 'SELECT id,status,manifest FROM migration_import_batches WHERE business_id=? AND id=? FOR UPDATE', [businessId, batchId]);
      if (!batch) throw httpError(404, 'MIGRATION_BATCH_NOT_FOUND');
      if (batch.status !== 'BLOCKED') throw httpError(409, 'MIGRATION_IDENTITY_REVIEW_UNAVAILABLE');
      const [record] = await repo.rows(db, 'SELECT record_status AS recordStatus,pending_reason AS pendingReason FROM migration_source_records WHERE business_id=? AND batch_id=? AND entity_type=? AND source_record_key=? FOR UPDATE', [businessId, batchId, entity, sourceRecordKey]);
      if (!record) throw httpError(404, 'MIGRATION_RECORD_NOT_FOUND');
      if (record.recordStatus !== 'PENDING') throw httpError(409, 'MIGRATION_IDENTITY_ALREADY_REVIEWED');
      const pendingReason = String(record.pendingReason || '');
      if (!/(IDENTITY_UNCONFIRMED|MISSING_LOCAL_ID|DUPLICATE_LOCAL_ID|INCONSISTENT_REFERENCES):/.test(pendingReason) || pendingReason.includes('FOREIGN_BUSINESS_ID:')) throw httpError(409, 'MIGRATION_IDENTITY_REVIEW_UNAVAILABLE');
      const manifest = typeof batch.manifest === 'string' ? JSON.parse(batch.manifest) : batch.manifest;
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw httpError(409, 'MIGRATION_BATCH_CONFLICT');
      const ledger = Array.isArray(manifest.identityReviewDecisions) ? manifest.identityReviewDecisions : [];
      if (ledger.some(item => item.entity === entity && item.sourceRecordKey === sourceRecordKey)) throw httpError(409, 'MIGRATION_IDENTITY_ALREADY_REVIEWED');
      const [timestamp] = await repo.rows(db, 'SELECT UTC_TIMESTAMP(3) AS reviewedAt', []);
      const remainsPending = pendingReason.includes('DUPLICATE_LOCAL_ID:') || pendingReason.includes('MISSING_LOCAL_ID:') || pendingReason.includes('INCONSISTENT_REFERENCES:');
      const recordStatus = decision === 'EXCLUDE' ? 'EXCLUDED' : remainsPending ? 'PENDING' : 'ARCHIVED';
      const decisionReason = decision === 'EXCLUDE' ? 'IDENTITY_REVIEW_EXCLUDED' : 'IDENTITY_REVIEW_INCLUDED';
      const nextPendingReason = decision === 'INCLUDE' && remainsPending ? pendingReason.slice(0, 260) + ' ' + decisionReason.slice(0, 220) : decisionReason.slice(0, 500);
      await repo.rows(db, "UPDATE migration_source_records SET record_status=?,pending_reason=?,updated_at=UTC_TIMESTAMP(3) WHERE business_id=? AND batch_id=? AND entity_type=? AND source_record_key=? AND record_status='PENDING'", [recordStatus, nextPendingReason, businessId, batchId, entity, sourceRecordKey]);
      const decisionEntry = { entity, sourceRecordKey, decision, recordStatus, attestBelongsToSource, operatorUserId: String(auth.user_id), reviewedAt: timestamp.reviewedAt };
      ledger.push(decisionEntry);
      manifest.identityReviewDecisions = ledger;
      await repo.rows(db, "UPDATE migration_import_batches SET manifest=?,updated_at=UTC_TIMESTAMP(3) WHERE business_id=? AND id=? AND status='BLOCKED'", [JSON.stringify(manifest), businessId, batchId]);
      await repo.rows(db, 'INSERT INTO audit_logs (business_id,user_id,action,entity,entity_id,details,created_at) VALUES (?,NULL,?,?,?,?,UTC_TIMESTAMP(3))',
        [businessId, 'LOCAL_MIGRATION_IDENTITY_REVIEW', 'migration_source_records', sourceRecordKey, JSON.stringify({ batchId, entity, sourceRecordKey, decision, recordStatus, attestBelongsToSource, operatorUserId: String(auth.user_id), reviewedAt: timestamp.reviewedAt })]);
      return { ok: true, batchId, businessId, entity, sourceRecordKey, decision, recordStatus, remainsPending: recordStatus === 'PENDING', businessStatus: business.status, migrationState: business.migrationState };
    });
  }

  async function status(auth, businessId, batchId) {
    requireSystemAdmin(auth);
    validateTarget(businessId);
    if (typeof batchId !== 'string' || !/^[0-9a-f-]{36}$/i.test(batchId)) throw httpError(400, 'INVALID_INPUT');
    await assertSchema(repo.pool);
    const [batch] = await repo.rows(repo.pool, 'SELECT id,business_id,source_business_key AS sourceBusinessKey,source_business_name AS sourceBusinessName,package_sha256 AS packageSha256,package_version AS packageVersion,status,current_stage AS currentStage,manifest,stage_results AS stageResults,created_at AS createdAt,updated_at AS updatedAt,completed_at AS completedAt FROM migration_import_batches WHERE business_id=? AND id=?', [businessId, batchId]);
    if (!batch) throw httpError(404, 'MIGRATION_BATCH_NOT_FOUND');
    const rows = await repo.rows(repo.pool, 'SELECT entity_type AS entityType,record_status AS recordStatus,COUNT(*) AS count FROM migration_source_records WHERE business_id=? AND batch_id=? GROUP BY entity_type,record_status ORDER BY entity_type,record_status', [businessId, batchId]);
    const summary = {};
    for (const row of rows) summary[row.entityType] = { ...(summary[row.entityType] || {}), [row.recordStatus]: Number(row.count) };
    return { ok: true, batch: { ...batch, manifest: typeof batch.manifest === 'string' ? JSON.parse(batch.manifest) : batch.manifest, stageResults: typeof batch.stageResults === 'string' ? JSON.parse(batch.stageResults) : batch.stageResults }, records: summary };
  }

  async function listRecords(auth, businessId, batchId, query = {}) {
    requireSystemAdmin(auth);
    validateTarget(businessId);
    if (typeof batchId !== 'string' || !/^[0-9a-f-]{36}$/i.test(batchId)) throw httpError(400, 'INVALID_INPUT');
    const offset = Number(query.offset ?? 0), limit = Number(query.limit ?? 100);
    if (!Number.isInteger(offset) || offset < 0 || offset > 1000000 || !Number.isInteger(limit) || limit < 1 || limit > 250) throw httpError(400, 'INVALID_INPUT');
    await assertSchema(repo.pool);
    const params = [businessId, batchId];
    const filters = '';
    const rows = await repo.rows(repo.pool, 'SELECT entity_type AS entityType,source_record_key AS sourceRecordKey,source_fingerprint AS fingerprint,record_status AS recordStatus,target_table AS targetTable,target_record_id AS targetRecordId,source_actor AS sourceActor,pending_reason AS pendingReason,source_payload AS sourcePayload FROM migration_source_records WHERE business_id=? AND batch_id=?' + filters + ' ORDER BY entity_type,source_record_key LIMIT ? OFFSET ?', [...params, limit, offset]);
    return { ok: true, records: rows.map(row => ({ ...row, payload: typeof row.sourcePayload === 'string' ? JSON.parse(row.sourcePayload) : row.sourcePayload, sourcePayload: undefined })) };
  }

  return { preview, archive, reviewIdentityRecord, status, listRecords };
}

module.exports = { SOURCE_STORES, canonical, scrub, analyzePackageReferences, buildArchivePlan, createSystemAdminMigrationArchive };
