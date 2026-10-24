'use strict';

const { createHash } = require('node:crypto');
const { httpError } = require('../middleware/errors');
const { packageForImport, normalizeName } = require('./basic-migration-values');
const { decimal } = require('./inventory-values');
const { normalize: normalizeImage } = require('./product-images');

const TABLES = Object.freeze({ products: 'products', clients: 'clients', suppliers: 'suppliers', configuration: 'business_settings' });
const safeJson = value => {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; }
  catch { return {}; }
};
const text = (value, maximum) => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > maximum || [...value].some(character => character.charCodeAt(0) < 32)) throw httpError(409, 'MIGRATION_CATALOG_VALUE_INVALID');
  return value.trim() || null;
};
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const bool = value => value === true || value === 1 || value === '1';
function sameDecimal(actual, expected, scale) {
  if (actual === null || actual === undefined || expected === null || expected === undefined) return actual === expected;
  try { return decimal(String(actual), scale, 12, true) === decimal(String(expected), scale, 12, true); }
  catch { return false; }
}
function sameText(actual, expected) {
  const left = actual === null || actual === undefined || actual === '' ? null : String(actual);
  const right = expected === null || expected === undefined || expected === '' ? null : String(expected);
  return left === right;
}
const numericSettings = Object.freeze({
  retail_margin_default: { scale: 4, signed: true },
  wholesale_margin_default: { scale: 4, signed: true },
  min_stock_default: { scale: 3, signed: false },
  tax_rate_default: { scale: 4, signed: false }
});
function sameSetting(field, actual, expected) {
  const numeric = numericSettings[field];
  if (!numeric) return sameText(actual, expected);
  try { return decimal(String(actual), numeric.scale, 12, numeric.signed) === decimal(String(expected), numeric.scale, 12, numeric.signed); }
  catch { return false; }
}
const parseSourceKey = row => {
  const key = String(row.sourceRecordKey || '');
  return key.startsWith('id:') ? key.slice(3).split(':duplicate:')[0] : null;
};

function createSystemAdminMigrationProjection({ repo, requireSystemAdmin, imageStore }) {
  function validateIds(businessId, batchId) {
    if (typeof businessId !== 'string' || !/^[1-9]\d{0,19}$/.test(businessId) || BigInt(businessId) > 18446744073709551615n ||
        typeof batchId !== 'string' || !/^[0-9a-f-]{36}$/i.test(batchId)) throw httpError(400, 'INVALID_INPUT');
  }

  async function targetAndBatch(db, businessId, batchId, lock = false) {
    if (businessId === '1') throw httpError(409, 'MIGRATION_TARGET_PROTECTED');
    const suffix = lock ? ' FOR UPDATE' : '';
    const [business] = await repo.rows(db,
      'SELECT b.id,b.name,b.status,c.state AS migrationState,c.source_business_key AS sourceBusinessKey,c.batch_id AS batchId FROM businesses b JOIN business_migration_controls c ON c.business_id=b.id WHERE b.id=?' + suffix,
      [businessId]);
    if (!business) throw httpError(404, 'MIGRATION_TARGET_REQUIRED');
    if (business.status !== 'INACTIVE' || business.migrationState !== 'PENDING' || business.batchId !== batchId || !business.sourceBusinessKey) throw httpError(409, 'MIGRATION_TARGET_REQUIRED');
    const [batch] = await repo.rows(db,
      'SELECT id,status,source_business_key AS sourceBusinessKey,source_business_name AS sourceBusinessName,package_sha256 AS packageSha256,manifest,stage_results AS stageResults FROM migration_import_batches WHERE business_id=? AND id=?' + suffix,
      [businessId, batchId]);
    if (!batch || !['ARCHIVED','BLOCKED','PROJECTING'].includes(batch.status)) throw httpError(409, 'MIGRATION_BATCH_CONFLICT');
    const manifest = safeJson(batch.manifest);
    const sourceBusinessKey = manifest.continuation?.canonicalSourceBusinessKey || batch.sourceBusinessKey;
    if (sourceBusinessKey !== business.sourceBusinessKey ||
        (batch.sourceBusinessKey !== business.sourceBusinessKey && manifest.continuation?.mode !== 'V1_TO_V2_CONTINUATION')) throw httpError(409, 'MIGRATION_BATCH_CONFLICT');
    if (Array.isArray(manifest.securityBlockers) && manifest.securityBlockers.length) throw httpError(409, 'MIGRATION_SOURCE_SCOPE_REQUIRED');
    if (Number(manifest.identityReview?.counts?.sharedId || 0) > 0) {
      const confirmation = manifest.identityReview?.batchConfirmation;
      if (confirmation?.confirmed !== true || !['SHARED_LEGACY_BUSINESS_ID_ROWS_ONLY', 'PACKAGE_PROVENANCE_WITH_AUDIT_ONLY_QUEUE'].includes(confirmation.scope) || confirmation.packageSha256 !== batch.packageSha256 || String(confirmation.targetBusinessId) !== String(businessId) || !confirmation.adminIdentity?.userId || !confirmation.confirmedAt) {
        throw httpError(409, 'MIGRATION_LEGACY_IDENTITY_CONFIRMATION_REQUIRED');
      }
    }
    return { business, batch, manifest, sourceBusinessKey, stageResults: safeJson(batch.stageResults) };
  }

  async function archiveRecords(db, businessId, batchId) {
    const rows = await repo.rows(db,
      "SELECT entity_type AS entityType,source_record_key AS sourceRecordKey,source_fingerprint AS fingerprint,record_status AS recordStatus,target_table AS targetTable,target_record_id AS targetRecordId,source_actor AS sourceActor,pending_reason AS pendingReason,source_payload AS payload FROM migration_source_records WHERE business_id=? AND batch_id=? AND entity_type IN ('products','clients','suppliers','configuration','categories') ORDER BY entity_type,source_record_key FOR UPDATE",
      [businessId, batchId]);
    return rows.map(row => ({ ...row, payload: safeJson(row.payload), targetRecordId: row.targetRecordId === null ? null : String(row.targetRecordId) }));
  }

  async function mapRecord(db, businessId, batchId, row, targetTable, targetId, pendingReason = null) {
    await repo.rows(db,
      "UPDATE migration_source_records SET record_status='PROJECTED',target_table=?,target_record_id=?,pending_reason=?,updated_at=UTC_TIMESTAMP(3) WHERE business_id=? AND batch_id=? AND entity_type=? AND source_record_key=? AND record_status IN ('ARCHIVED','PROJECTED')",
      [targetTable, targetId === null ? null : String(targetId), pendingReason, businessId, batchId, row.entityType, row.sourceRecordKey]);
  }

  function decodeImage(source) {
    if (source === null || source === undefined || source === '') return null;
    const match = typeof source === 'string' && /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(source);
    if (!match) throw httpError(409, 'MIGRATION_IMAGE_REQUIRES_REVIEW');
    const buffer = Buffer.from(match[2], 'base64');
    if (!buffer.length || buffer.length > 8 * 1024 * 1024 || buffer.toString('base64') !== match[2]) throw httpError(409, 'MIGRATION_IMAGE_REQUIRES_REVIEW');
    return { buffer, mime: 'image/' + match[1] };
  }
  async function persistImage(businessId, batchId, entity, sourceRecordKey, source) {
    const decoded = decodeImage(source);
    if (!decoded) return null;
    if (!imageStore || typeof imageStore.saveMigration !== 'function') throw httpError(503, 'MIGRATION_IMAGE_STORAGE_REQUIRED');
    const normalized = await normalizeImage(decoded.buffer, decoded.mime);
    return imageStore.saveMigration(businessId, normalized, batchId + ':' + entity + ':' + sourceRecordKey);
  }
  async function imageMatches(businessId, reference, source) {
    const decoded = decodeImage(source);
    if (!decoded || !reference || !imageStore || typeof imageStore.read !== 'function') return false;
    const normalized = await normalizeImage(decoded.buffer, decoded.mime);
    try {
      const stored = await imageStore.read(businessId, reference);
      return Buffer.isBuffer(stored) && stored.equals(normalized);
    } catch (error) {
      if (error?.publicCode === 'IMAGE_REFERENCE_INVALID') return false;
      throw error;
    }
  }

  function sourcePackage(name, records) {
    const data = { products: [], clients: [], suppliers: [] };
    for (const row of records) if (Object.hasOwn(data, row.entityType) && row.recordStatus === 'ARCHIVED') data[row.entityType].push(row.payload);
    return { type: 'pos_local_migration_package', version: 2, business: { name }, data };
  }

  async function reconcile(db, businessId, batchId, sourceBusinessKey, sourceBusinessName, manifest, records, counts, pending, differences) {
    const links = records.filter(row => row.recordStatus === 'PROJECTED' && row.targetTable && row.targetRecordId);
    for (const row of links) {
      const table = TABLES[row.entityType];
      if (!table) continue;
      const [target] = await repo.rows(db, 'SELECT * FROM `' + table + '` WHERE business_id=? AND id=?', [businessId, row.targetRecordId]);
      if (!target) differences.push({ origin: row.sourceRecordKey, module: row.entityType, field: 'targetRecordId', expected: row.targetRecordId, found: null, reason: 'Falta el registro operativo enlazado.' });
      else {
        const raw = row.payload;
        const compare = (field, expected, found, equal) => {
          if (equal(found, expected)) return;
          if (!differences.some(item => item.origin === row.sourceRecordKey && item.module === row.entityType && item.field === field)) {
            differences.push({ origin: row.sourceRecordKey, module: row.entityType, field, expected, found: found ?? null, reason: 'El valor operativo no coincide con el paquete original.' });
          }
        };
        if (row.entityType === 'products') {
          const parsed = packageForImport({ type: 'pos_local_migration_package', version: 2, business: { name: 'origen' }, data: { products: [raw], clients: [], suppliers: [] } }).products[0];
          const expectedBarcode = parsed.barcode || 'MIG-' + hash(sourceBusinessKey + ':' + row.sourceRecordKey).slice(0, 24);
          const productFields = [
            ['barcode', expectedBarcode, sameText], ['name', parsed.name, sameText], ['category', parsed.category, sameText],
            ['cost', parsed.cost, (a,b) => sameDecimal(a,b,2)], ['retail_margin', parsed.marginRetail, (a,b) => sameDecimal(a,b,4)],
            ['wholesale_margin', parsed.marginWholesale, (a,b) => sameDecimal(a,b,4)], ['retail_price', parsed.retailPrice, (a,b) => sameDecimal(a,b,2)],
            ['wholesale_price', parsed.wholesalePrice, (a,b) => sameDecimal(a,b,2)], ['stock', parsed.stock, (a,b) => sameDecimal(a,b,3)],
            ['min_stock', parsed.minStock, (a,b) => sameDecimal(a,b,3)], ['tax_rate', parsed.taxRate, (a,b) => sameDecimal(a,b,4)],
            ['active', parsed.active, (a,b) => bool(a) === bool(b)], ['deleted', parsed.deleted, (a,b) => bool(a) === bool(b)]
          ];
          for (const [field, expected, equal] of productFields) compare(field, expected, target[field], equal);
          if (raw.image) {
            if (!await imageMatches(businessId, target.image, raw.image)) differences.push({
              origin: row.sourceRecordKey, module: row.entityType, field: 'image',
              expected: 'Contenido de imagen del paquete', found: target.image ? 'Contenido persistido distinto o no disponible' : 'Sin imagen',
              reason: 'La imagen del producto no coincide con el contenido original o no está disponible.'
            });
          }
        } else if (row.entityType === 'clients') {
          const parsed = packageForImport({ type: 'pos_local_migration_package', version: 2, business: { name: 'origen' }, data: { products: [], clients: [raw], suppliers: [] } }).clients[0];
          const clientFields = [
            ['name', parsed.name, sameText], ['phone', parsed.phone, sameText], ['ruc', parsed.ruc, sameText], ['address', parsed.address, sameText],
            ['credit_limit', decimal(raw.creditLimit ?? raw.credit_limit ?? '0', 2, 10), (a,b) => sameDecimal(a,b,2)],
            ['opening_balance', '0.00', (a,b) => sameDecimal(a,b,2)], ['active', parsed.active, (a,b) => bool(a) === bool(b)]
          ];
          for (const [field, expected, equal] of clientFields) compare(field, expected, target[field], equal);
        } else if (row.entityType === 'suppliers') {
          const parsed = packageForImport({ type: 'pos_local_migration_package', version: 2, business: { name: 'origen' }, data: { products: [], clients: [], suppliers: [raw] } }).suppliers[0];
          for (const [field, expected] of Object.entries({ name: parsed.name, contact: parsed.contact, phone: parsed.phone, ruc: parsed.ruc, address: parsed.address })) compare(field, expected, target[field], sameText);
          compare('active', parsed.active, target.active, (a,b) => bool(a) === bool(b));
        } else if (row.entityType === 'configuration') {
          const expectedFields = {
            business_name: text(raw.name || raw.businessName || sourceBusinessName,160), legal_name: text(raw.legalName,160),
            ruc: text(raw.ruc,64), phone: text(raw.phone,40), address: text(raw.address,255), invoice_prefix: text(raw.invoicePrefix || raw.invoice_prefix,32),
            ticket_header: text(raw.header || raw.ticketHeader || raw.ticket_header,500), ticket_footer: text(raw.footer || raw.ticketFooter || raw.ticket_footer,500),
            retail_margin_default: raw.marginRetail ?? raw.retailMargin ?? raw.retail_margin_default,
            wholesale_margin_default: raw.marginWholesale ?? raw.wholesaleMargin ?? raw.wholesale_margin_default,
            min_stock_default: raw.minStock ?? raw.minStockDefault ?? raw.min_stock_default,
            tax_rate_default: raw.tax ?? raw.taxRateDefault ?? raw.tax_rate_default
          };
          for (const field of ['business_name','legal_name','ruc','phone','address','invoice_prefix','ticket_header','ticket_footer']) {
            const expected = expectedFields[field];
            if (expected !== null) compare(field, expected, target[field], sameText);
          }
          for (const [field, value, scale, digits, signed] of [
            ['retail_margin_default', expectedFields.retail_margin_default, 4, 3, true],
            ['wholesale_margin_default', expectedFields.wholesale_margin_default, 4, 3, true],
            ['min_stock_default', expectedFields.min_stock_default, 3, 9, false],
            ['tax_rate_default', expectedFields.tax_rate_default, 4, 3, false]
          ]) {
            if (value !== undefined && value !== null && value !== '') compare(field, decimal(value,scale,digits,signed), target[field], (a,b) => sameDecimal(a,b,scale));
          }
          if (raw.logo && !differences.some(item => item.origin === row.sourceRecordKey && item.module === 'settings' && item.field === 'logo')) {
            if (!await imageMatches(businessId, target.logo, raw.logo)) differences.push({
              origin: row.sourceRecordKey, module: 'settings', field: 'logo',
              expected: 'Contenido de imagen del paquete', found: target.logo ? 'Contenido persistido distinto o no disponible' : 'Sin imagen',
              reason: 'El logo no coincide con el contenido original o no está disponible.'
            });
          }
          if (raw.currency && raw.currency !== 'C$') compare('currency', 'C$', target.currency, sameText);
        }
      }
    }
    const [totals] = await repo.rows(db,
      'SELECT (SELECT COUNT(*) FROM products WHERE business_id=?) AS products,(SELECT COUNT(*) FROM clients WHERE business_id=?) AS clients,(SELECT COUNT(*) FROM suppliers WHERE business_id=?) AS suppliers,(SELECT COUNT(*) FROM sales WHERE business_id=?) AS sales,(SELECT COUNT(*) FROM purchases WHERE business_id=?) AS purchases',
      [businessId,businessId,businessId,businessId,businessId]);
    const moduleRows = await repo.rows(db, 'SELECT entity_type AS entityType,record_status AS recordStatus,COUNT(*) AS total FROM migration_source_records WHERE business_id=? AND batch_id=? GROUP BY entity_type,record_status ORDER BY entity_type,record_status', [businessId,batchId]);
    const recordsByModule = {};
    for (const row of moduleRows) recordsByModule[row.entityType] = { ...(recordsByModule[row.entityType] || {}), [String(row.recordStatus).toLowerCase()]: Number(row.total) };
    for (const entity of ['products','clients','suppliers']) {
      const expected = records.filter(row => row.entityType === entity && row.recordStatus === 'PROJECTED').length;
      const found = Number(totals[entity] || 0);
      if (expected !== found) differences.push({ origin: batchId, module: entity, field: 'recordCount', expected, found, reason: 'El total de registros operativos no coincide con los enlaces guardados.' });
    }
    return {
      complete: false,
      stage: 'CATALOG_AND_SETTINGS',
      stageMatched: differences.length === 0 && Object.values(pending).every(value => Number(value) === 0),
      totals: { ...counts, existingProducts: Number(totals.products), existingClients: Number(totals.clients), existingSuppliers: Number(totals.suppliers) },
      pending,
      recordsByModule,
      differences,
      fullMigrationComplete: false,
      blockers: [...(Array.isArray(manifest?.blockers) ? manifest.blockers : []), 'Ventas, compras, créditos, abonos, caja, gastos, pagos a proveedores, Kardex histórico, órdenes pendientes y auditoría todavía requieren proyección y conciliación.']
    };
  }

  async function projectCatalog(auth, businessId, batchId) {
    requireSystemAdmin(auth);
    validateIds(businessId, batchId);
    return repo.transaction(async db => {
      const { business, batch, sourceBusinessKey, stageResults } = await targetAndBatch(db, businessId, batchId, true);
      const records = await archiveRecords(db, businessId, batchId);
      const [allPending] = await repo.rows(db,"SELECT COUNT(*) AS total FROM migration_source_records WHERE business_id=? AND batch_id=? AND record_status='PENDING'",[businessId,batchId]);
      if (stageResults.catalog) {
        const prior = stageResults.catalog;
        const priorDifferences = Array.isArray(prior.differences) ? prior.differences : [];
        const result = await reconcile(db,businessId,batchId,sourceBusinessKey,batch.sourceBusinessName,safeJson(batch.manifest),records,prior.counts || {},prior.pending || {},[...priorDifferences]);
        return { ok: true, batchId, businessId, businessStatus: business.status, migrationState: business.migrationState, reconciliation: result };
      }
      const pending = { identityOrValidation: 0, sourceExcluded: 0, creditOpeningBalance: 0, unsupportedCategories: 0, settingsConflicts: 0, images: 0 };
      const differences = [];
      const [unresolvedCounts] = await repo.rows(db,
        "SELECT SUM(record_status='PENDING' AND COALESCE(pending_reason,'') NOT LIKE 'OPENING_BALANCE_REQUIRES_RECONCILIATION%') AS identityPending,SUM(record_status='EXCLUDED') AS excluded FROM migration_source_records WHERE business_id=? AND batch_id=?",
        [businessId,batchId]);
      pending.identityOrValidation = Number(unresolvedCounts.identityPending || 0);
      pending.sourceExcluded = Number(unresolvedCounts.excluded || 0);
      const readyRows = records.filter(row => ['products','clients','suppliers'].includes(row.entityType) && row.recordStatus === 'ARCHIVED');
      const imported = packageForImport(sourcePackage(batch.sourceBusinessName, records));
      const claimedSourceRows = records.filter(row => row.recordStatus === 'PROJECTED' && TABLES[row.entityType]);
      const [existingCounts] = await repo.rows(db,
        'SELECT (SELECT COUNT(*) FROM products WHERE business_id=?) AS products,(SELECT COUNT(*) FROM clients WHERE business_id=?) AS clients,(SELECT COUNT(*) FROM suppliers WHERE business_id=?) AS suppliers FROM businesses WHERE id=?',
        [businessId,businessId,businessId,businessId]);
      const mappedCounts = Object.fromEntries(['products','clients','suppliers'].map(entity => [entity, claimedSourceRows.filter(row => row.entityType === entity).length]));
      for (const entity of ['products','clients','suppliers']) {
        if (Number(existingCounts[entity]) !== mappedCounts[entity]) throw httpError(409, 'MIGRATION_TARGET_HAS_DATA');
      }

      const created = { products: 0, clients: 0, suppliers: 0, settings: 0, productImages: 0, logo: 0 };
      const sourceBarcodes = new Set();
      for (const product of imported.products) {
        if (!product.barcode) continue;
        const key = product.barcode.trim().toLocaleLowerCase('en-US');
        if (sourceBarcodes.has(key)) throw httpError(409, 'MIGRATION_CATALOG_BARCODE_CONFLICT');
        sourceBarcodes.add(key);
      }
      for (const row of readyRows) {
        const parsed = packageForImport({ type: 'pos_local_migration_package', version: 2, business: { name: batch.sourceBusinessName }, data: { products: row.entityType === 'products' ? [row.payload] : [], clients: row.entityType === 'clients' ? [row.payload] : [], suppliers: row.entityType === 'suppliers' ? [row.payload] : [] } });
        const sourceId = parseSourceKey(row);
        if (!sourceId) throw httpError(409, 'MIGRATION_SOURCE_ID_REQUIRED');
        const actorDetails = { source: row.sourceActor || null, sourceRecordKey: row.sourceRecordKey, sourceFingerprint: row.fingerprint };
        if (row.entityType === 'products') {
          const product = parsed.products[0];
          let image = null;
          if (row.payload.image) {
            image = await persistImage(businessId, batchId, row.entityType, row.sourceRecordKey, row.payload.image);
            created.productImages++;
          }
          const barcode = product.barcode || 'MIG-' + hash(sourceBusinessKey + ':' + row.sourceRecordKey).slice(0, 24);
          const result = await repo.rows(db,
            'INSERT INTO products (business_id,barcode,name,category,cost,retail_margin,wholesale_margin,retail_price,wholesale_price,stock,min_stock,tax_rate,image,active,deleted) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            [businessId,barcode,product.name,product.category,product.cost,product.marginRetail,product.marginWholesale,product.retailPrice,product.wholesalePrice,product.stock,product.minStock,product.taxRate,image,product.active,product.deleted]);
          await mapRecord(db,businessId,batchId,row,'products',result.insertId);
          created.products++;
          await repo.rows(db, 'INSERT INTO audit_logs (business_id,user_id,action,entity,entity_id,details,created_at) VALUES (?,NULL,?,?,?,?,UTC_TIMESTAMP(3))',
            [businessId,'LOCAL_MIGRATION_RECORD_PROJECTED','products',String(result.insertId),JSON.stringify({ batchId, ...actorDetails })]);
        } else if (row.entityType === 'clients') {
          const raw = row.payload;
          const balanceRaw = raw.openingBalance ?? raw.opening_balance ?? raw.deudaSinFactura ?? raw.uninvoicedDebt ?? '0';
          let openingBalance;
          try { openingBalance = decimal(balanceRaw === '' || balanceRaw === null ? '0' : balanceRaw,2,10); }
          catch { openingBalance = null; }
          if (openingBalance === null || openingBalance !== '0.00') {
            pending.creditOpeningBalance++;
            await repo.rows(db, "UPDATE migration_source_records SET record_status='PENDING',pending_reason='OPENING_BALANCE_REQUIRES_RECONCILIATION',updated_at=UTC_TIMESTAMP(3) WHERE business_id=? AND batch_id=? AND entity_type='clients' AND source_record_key=?", [businessId,batchId,row.sourceRecordKey]);
            differences.push({ origin: row.sourceRecordKey, module: 'clients', field: 'openingBalance', expected: balanceRaw, found: '0.00', reason: 'La deuda de apertura no tiene factura equivalente; el cliente quedó pendiente y no se alteró ningún saldo.' });
            continue;
          }
          const rawCreditLimit = raw.creditLimit ?? raw.credit_limit ?? '0';
          let creditLimit;
          try { creditLimit = decimal(rawCreditLimit === '' || rawCreditLimit === null ? '0' : rawCreditLimit,2,10); }
          catch { throw httpError(409, 'MIGRATION_CATALOG_VALUE_INVALID'); }
          const client = parsed.clients[0];
          const result = await repo.rows(db,
            'INSERT INTO clients (business_id,name,phone,ruc,address,credit_limit,opening_balance,active) VALUES (?,?,?,?,?,?,0.00,?)',
            [businessId,client.name,client.phone,client.ruc,client.address,creditLimit,client.active]);
          await mapRecord(db,businessId,batchId,row,'clients',result.insertId);
          created.clients++;
          await repo.rows(db, 'INSERT INTO audit_logs (business_id,user_id,action,entity,entity_id,details,created_at) VALUES (?,NULL,?,?,?,?,UTC_TIMESTAMP(3))',
            [businessId,'LOCAL_MIGRATION_RECORD_PROJECTED','clients',String(result.insertId),JSON.stringify({ batchId, ...actorDetails })]);
        } else {
          const supplier = parsed.suppliers[0];
          const result = await repo.rows(db,
            'INSERT INTO suppliers (business_id,name,contact,phone,ruc,address,active) VALUES (?,?,?,?,?,?,?)',
            [businessId,supplier.name,supplier.contact,supplier.phone,supplier.ruc,supplier.address,supplier.active]);
          await mapRecord(db,businessId,batchId,row,'suppliers',result.insertId);
          created.suppliers++;
          await repo.rows(db, 'INSERT INTO audit_logs (business_id,user_id,action,entity,entity_id,details,created_at) VALUES (?,NULL,?,?,?,?,UTC_TIMESTAMP(3))',
            [businessId,'LOCAL_MIGRATION_RECORD_PROJECTED','suppliers',String(result.insertId),JSON.stringify({ batchId, ...actorDetails })]);
        }
      }

      for (const row of records.filter(item => item.entityType === 'products' && item.recordStatus === 'PROJECTED' && item.targetTable === 'products' && item.targetRecordId && item.payload.image)) {
        const [target] = await repo.rows(db, 'SELECT image FROM products WHERE business_id=? AND id=? FOR UPDATE', [businessId, row.targetRecordId]);
        if (!target) continue;
        if (!target.image) {
          const image = await persistImage(businessId, batchId, 'products', row.sourceRecordKey, row.payload.image);
          await repo.rows(db, 'UPDATE products SET image=? WHERE business_id=? AND id=? AND image IS NULL', [image, businessId, row.targetRecordId]);
          created.productImages++;
        }
      }

      const settingsRecord = records.find(row => row.entityType === 'configuration' && row.recordStatus === 'ARCHIVED');
      if (settingsRecord) {
        let settingsTargetId;
        const cfg = settingsRecord.payload;
        const existing = (await repo.rows(db, 'SELECT * FROM business_settings WHERE business_id=? FOR UPDATE', [businessId]))[0];
        const image = !existing?.logo && cfg.logo ? await persistImage(businessId,batchId,'configuration',settingsRecord.sourceRecordKey,cfg.logo) : (existing?.logo || null);
        if (!existing) {
          const name = text(cfg.name || cfg.businessName || batch.sourceBusinessName,160);
          const currency = cfg.currency === undefined || cfg.currency === 'C$' ? 'C$' : 'C$';
          if (cfg.currency && cfg.currency !== 'C$') differences.push({ origin: settingsRecord.sourceRecordKey, module: 'settings', field: 'currency', expected: cfg.currency, found: 'C$', reason: 'El POS conectado opera en C$; no se convirtió ni cambió el importe.' });
          const legalName = text(cfg.legalName,160), ruc = text(cfg.ruc,64), phone = text(cfg.phone,40), address = text(cfg.address,255);
          const invoicePrefix = text(cfg.invoicePrefix || cfg.invoice_prefix,32) || '';
          const marginRetail = cfg.marginRetail ?? cfg.retailMargin ?? cfg.retail_margin_default ?? '0';
          const marginWholesale = cfg.marginWholesale ?? cfg.wholesaleMargin ?? cfg.wholesale_margin_default ?? '0';
          const minStock = cfg.minStock ?? cfg.minStockDefault ?? cfg.min_stock_default ?? '5';
          const taxRate = cfg.tax ?? cfg.taxRateDefault ?? cfg.tax_rate_default ?? '0';
          const defaults = [decimal(marginRetail,4,3,true),decimal(marginWholesale,4,3,true),decimal(minStock,3,9),decimal(taxRate,4,3)];
          const header = text(cfg.header || cfg.ticketHeader || cfg.ticket_header,500);
          const footer = text(cfg.footer || cfg.ticketFooter || cfg.ticket_footer,500);
          const result = await repo.rows(db,
            'INSERT INTO business_settings (business_id,business_name,legal_name,ruc,phone,address,currency,logo,invoice_prefix,retail_margin_default,wholesale_margin_default,min_stock_default,tax_rate_default,ticket_header,ticket_footer) VALUES (?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?)',
            [businessId,name,legalName,ruc,phone,address,currency,image,invoicePrefix,...defaults,header,footer]);
          await mapRecord(db,businessId,batchId,settingsRecord,'business_settings',result.insertId);
          settingsTargetId = String(result.insertId);
          created.settings++; if (image) created.logo++;
        } else {
          const sourceFields = {
            business_name: text(cfg.name || cfg.businessName || batch.sourceBusinessName,160),
            legal_name: text(cfg.legalName,160), ruc: text(cfg.ruc,64), phone: text(cfg.phone,40), address: text(cfg.address,255),
            invoice_prefix: text(cfg.invoicePrefix || cfg.invoice_prefix,32),
            ticket_header: text(cfg.header || cfg.ticketHeader || cfg.ticket_header,500), ticket_footer: text(cfg.footer || cfg.ticketFooter || cfg.ticket_footer,500),
            retail_margin_default: cfg.marginRetail ?? cfg.retailMargin ?? cfg.retail_margin_default,
            wholesale_margin_default: cfg.marginWholesale ?? cfg.wholesaleMargin ?? cfg.wholesale_margin_default,
            min_stock_default: cfg.minStock ?? cfg.minStockDefault ?? cfg.min_stock_default,
            tax_rate_default: cfg.tax ?? cfg.taxRateDefault ?? cfg.tax_rate_default
          };
          if (image) sourceFields.logo = image;
          const updates = [], values = [];
          for (const [field,value] of Object.entries(sourceFields)) {
            if (value === undefined || value === null || value === '') continue;
            if (existing[field] === null || existing[field] === undefined || existing[field] === '') { updates.push('`' + field + '`=?'); values.push(value); }
            else if (!sameSetting(field, existing[field], value)) {
              pending.settingsConflicts++;
              differences.push({ origin: settingsRecord.sourceRecordKey, module: 'settings', field, expected: value, found: String(existing[field]), reason: 'Se conservó el dato que ya existía en el negocio conectado.' });
            }
          }
          settingsTargetId = String(existing.id);
          if (cfg.logo && existing.logo && !await imageMatches(businessId, existing.logo, cfg.logo)) {
            pending.settingsConflicts++;
            differences.push({ origin: settingsRecord.sourceRecordKey, module: 'settings', field: 'logo', expected: 'Contenido de imagen del paquete', found: 'Contenido persistido distinto o no disponible', reason: 'Se conservó el logo existente; el contenido del paquete no coincide.' });
          }
          const sourceCurrency = cfg.currency || 'C$';
          if (sourceCurrency !== 'C$' || existing.currency !== 'C$') {
            pending.settingsConflicts++;
            differences.push({ origin: settingsRecord.sourceRecordKey, module: 'settings', field: 'currency', expected: sourceCurrency, found: existing.currency, reason: 'La moneda de esta versión conectada está fijada en C$; no se convirtió ningún importe.' });
          }
          if (updates.length) { await repo.rows(db,'UPDATE business_settings SET ' + updates.join(',') + ' WHERE business_id=?',[...values,businessId]); created.settings++; }
          if (image && !existing.logo) created.logo++;
          await mapRecord(db,businessId,batchId,settingsRecord,'business_settings',settingsTargetId,pending.settingsConflicts ? 'EXISTING_SETTINGS_PRESERVED' : null);
        }
        await repo.rows(db, 'INSERT INTO audit_logs (business_id,user_id,action,entity,entity_id,details,created_at) VALUES (?,NULL,?,?,?,?,UTC_TIMESTAMP(3))',
          [businessId,'LOCAL_MIGRATION_RECORD_PROJECTED','business_settings',settingsTargetId,JSON.stringify({ batchId, sourceRecordKey: settingsRecord.sourceRecordKey, sourceFingerprint: settingsRecord.fingerprint, operatorUserId: String(auth.user_id) })]);
      } else {
        pending.settingsConflicts++;
        differences.push({ origin: batchId, module: 'settings', field: 'configuration', expected: 'Configuración comercial del paquete', found: null, reason: 'No se incluyó la configuración de origen; no se completó la etapa.' });
      }

      for (const row of records.filter(item => item.entityType === 'categories' && item.recordStatus === 'ARCHIVED')) {
        const mapped = await repo.rows(db,'SELECT category FROM products WHERE business_id=? GROUP BY category',[businessId]);
        const actual = new Set(mapped.map(item => normalizeName(item.category)));
        const categories = Array.isArray(row.payload) ? row.payload : [];
        const unrepresented = categories.filter(category => !actual.has(normalizeName(category)));
        if (unrepresented.length) {
          pending.unsupportedCategories += unrepresented.length;
          for (const category of unrepresented) differences.push({ origin: row.sourceRecordKey, module: 'categories', field: 'category', expected: category, found: null, reason: 'Esta categoría no tiene ningún producto y no existe como entidad operativa independiente en el sistema conectado.' });
        }
        await mapRecord(db,businessId,batchId,row,'products.category','derived',unrepresented.length ? 'CATEGORY_NOT_REPRESENTED_SEPARATELY' : null);
      }

      const differencesAfter = [...differences];
      const currentRecords = await archiveRecords(db,businessId,batchId);
      const batchStatuses = await repo.rows(db, 'SELECT record_status AS recordStatus,COUNT(*) AS total FROM migration_source_records WHERE business_id=? AND batch_id=? GROUP BY record_status', [businessId,batchId]);
      const statusCounts = Object.fromEntries(batchStatuses.map(row => [String(row.recordStatus).toLowerCase(), Number(row.total)]));
      const result = await reconcile(db,businessId,batchId,sourceBusinessKey,batch.sourceBusinessName,safeJson(batch.manifest),currentRecords,{...created,...statusCounts},pending,differencesAfter);
      const nextStageResults = { ...stageResults, catalog: { ranAt: new Date().toISOString(), counts: result.totals, pending: result.pending, differences: result.differences, complete: result.stageMatched } };
      const anyPending = Number(allPending.total) > 0 || pending.identityOrValidation > 0 || pending.sourceExcluded > 0 || pending.creditOpeningBalance > 0 || pending.settingsConflicts > 0 || pending.unsupportedCategories > 0;
      const nextStatus = anyPending ? 'BLOCKED' : 'PROJECTING';
      await repo.rows(db,'UPDATE migration_import_batches SET status=?,current_stage=?,stage_results=?,updated_at=UTC_TIMESTAMP(3) WHERE business_id=? AND id=?',
        [nextStatus,'CATALOG_AND_SETTINGS',JSON.stringify(nextStageResults),businessId,batchId]);
      await repo.rows(db,'INSERT INTO audit_logs (business_id,user_id,action,entity,entity_id,details,created_at) VALUES (?,NULL,?,?,?,?,UTC_TIMESTAMP(3))',
        [businessId,'LOCAL_MIGRATION_OPERATIONAL_STAGE','migration_import_batches',batchId,JSON.stringify({ actorUserId:String(auth.user_id),actorBusinessId:String(auth.business_id),stage:'CATALOG_AND_SETTINGS',counts:result.totals,unresolved:result.pending,differences:result.differences.length })]);
      return { ok: true, batchId, businessId, businessStatus: business.status, migrationState: business.migrationState, reconciliation: result };
    });
  }

  return { projectCatalog };
}

module.exports = { createSystemAdminMigrationProjection };
