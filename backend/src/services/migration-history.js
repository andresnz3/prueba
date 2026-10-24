'use strict';

const { httpError } = require('../middleware/errors');

const MODULES = Object.freeze({
  inventory: { permission: 'inventory', entities: ['products', 'inventoryMovements'] },
  purchases: { permission: 'purchases', entities: ['purchases', 'suppliers', 'abonos'] },
  payables: { permission: 'payables', entities: ['purchases', 'abonos'] },
  clients: { permission: 'clients', entities: ['clients', 'sales', 'abonos'] },
  history: { permission: 'history', entities: ['sales', 'abonos', 'saleOrders'] },
  cash: { permission: 'cash', entities: ['cashSessions'] },
  expenses: { permission: 'expenses', entities: ['expenses'] },
  settings: { permission: 'settings', entities: ['configuration', 'categories'] },
  reports: { permission: 'reports', entities: ['auditLogs'] }
});

const ABONO_KINDS = Object.freeze({
  purchases: ['proveedor'],
  payables: ['proveedor'],
  clients: ['cliente', 'factura'],
  history: ['cliente', 'factura']
});

function object(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function safePayload(value) {
  let hasImage = false;
  function strip(input) {
    if (Array.isArray(input)) return input.map(strip);
    if (!input || typeof input !== 'object') return input;
    const result = {};
    for (const [key, nested] of Object.entries(input)) {
      if (/^(image|logo)$/i.test(key) && typeof nested === 'string' && nested.startsWith('data:image/')) {
        hasImage = true;
        continue;
      }
      result[key] = strip(nested);
    }
    return result;
  }
  return { payload: strip(object(value)), hasImage };
}

function validPage(value, fallback, maximum) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > maximum) throw httpError(400, 'INVALID_INPUT');
  return parsed;
}

function createMigrationHistoryService({ repo, auth }) {
  async function schemaReady(db) {
    const rows = await repo.rows(db,
      "SELECT TABLE_NAME AS tableName,COLUMN_NAME AS columnName FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('migration_import_batches','migration_source_records')",
      []);
    const columns = new Map();
    for (const row of rows) columns.set(row.tableName, [...(columns.get(row.tableName) || []), row.columnName]);
    const required = {
      migration_import_batches: ['id', 'business_id', 'source_business_name', 'status', 'manifest'],
      migration_source_records: ['business_id', 'batch_id', 'entity_type', 'source_record_key', 'record_status', 'target_table', 'target_record_id', 'source_actor', 'pending_reason', 'source_payload', 'created_at']
    };
    return Object.entries(required).every(([table, names]) => names.every(name => columns.get(table)?.includes(name)));
  }

  async function list(session, module, query = {}) {
    const definition = MODULES[module];
    if (!definition) throw httpError(400, 'INVALID_INPUT');
    const offset = validPage(query.offset, 0, 1000000);
    const limit = validPage(query.limit, 50, 100);
    if (limit < 1) throw httpError(400, 'INVALID_INPUT');

    return repo.tenant(session, async (db, current) => {
      if (!await auth.canAccess(current, definition.permission, db)) throw httpError(403, 'MODULE_FORBIDDEN');
      if (!await schemaReady(db)) {
        return {
          businessId: String(current.business_id), available: false,
          records: [], total: 0, offset, limit,
          reconciliation: { complete: false, archiveIntegrity: 'UNAVAILABLE', operationalComparison: 'NOT_RUN', differences: [] }
        };
      }

      const entityHolders = definition.entities.map(() => '?').join(',');
      const params = [String(current.business_id), ...definition.entities];
      const abonoKinds = ABONO_KINDS[module];
      const abonoSql = abonoKinds
        ? " AND (r.entity_type <> 'abonos' OR JSON_UNQUOTE(JSON_EXTRACT(r.source_payload, '$.tipo')) IN (" + abonoKinds.map(() => '?').join(',') + '))'
        : '';
      const abonoParams = abonoKinds || [];
      const [count] = await repo.rows(db,
        'SELECT COUNT(*) AS total FROM migration_source_records r WHERE r.business_id=? AND r.entity_type IN (' + entityHolders + ')' + abonoSql,
        [...params, ...abonoParams]);
      const rows = await repo.rows(db,
        'SELECT r.batch_id AS batchId,b.source_business_name AS sourceBusinessName,b.status AS batchStatus,r.entity_type AS entityType,r.source_record_key AS sourceRecordKey,r.record_status AS recordStatus,r.target_table AS targetTable,r.target_record_id AS targetRecordId,r.source_actor AS sourceActor,r.pending_reason AS pendingReason,r.source_payload AS sourcePayload,r.created_at AS archivedAt FROM migration_source_records r JOIN migration_import_batches b ON b.business_id=r.business_id AND b.id=r.batch_id WHERE r.business_id=? AND r.entity_type IN (' + entityHolders + ')' + abonoSql + ' ORDER BY r.created_at DESC,r.entity_type,r.source_record_key LIMIT ? OFFSET ?',
        [...params, ...abonoParams, limit, offset]);

      const batchRows = await repo.rows(db,
        'SELECT b.id AS batchId,b.source_business_name AS sourceBusinessName,b.status AS batchStatus,b.manifest,(SELECT COUNT(*) FROM migration_source_records allr WHERE allr.business_id=b.business_id AND allr.batch_id=b.id) AS totalRecords,r.entity_type AS entityType,r.record_status AS recordStatus,COUNT(*) AS recordCount FROM migration_import_batches b LEFT JOIN migration_source_records r ON r.business_id=b.business_id AND r.batch_id=b.id AND r.entity_type IN (' + entityHolders + ')' + abonoSql + ' WHERE b.business_id=? GROUP BY b.id,b.source_business_name,b.status,b.manifest,b.created_at,r.entity_type,r.record_status ORDER BY b.created_at DESC',
        [...definition.entities, ...abonoParams, String(current.business_id)]);

      const batches = new Map();
      for (const row of batchRows) {
        if (!batches.has(row.batchId)) batches.set(row.batchId, {
          batchId: row.batchId, sourceBusinessName: row.sourceBusinessName, batchStatus: row.batchStatus,
          manifest: object(row.manifest), totalRecords: Number(row.totalRecords || 0), statusCounts: {}, actualByEntity: {}
        });
        const batch = batches.get(row.batchId);
        if (row.entityType) {
          batch.statusCounts[row.recordStatus] = (batch.statusCounts[row.recordStatus] || 0) + Number(row.recordCount);
          batch.actualByEntity[row.entityType] = (batch.actualByEntity[row.entityType] || 0) + Number(row.recordCount);
        }
      }

      const differences = [];
      let unresolved = 0, archiveIntegrityMatches = true;
      const batchSummaries = [...batches.values()].map(batch => {
        const sourceCounts = object(batch.manifest.sourceCounts);
        const expectedRecords = Number(batch.manifest.recordsExpected || 0);
        const actualRecords = Number(batch.totalRecords || 0);
        const actualStatuses = batch.statusCounts;
        const batchUnresolved = Number(actualStatuses.ARCHIVED || 0) + Number(actualStatuses.PENDING || 0) + Number(actualStatuses.EXCLUDED || 0);
        unresolved += batchUnresolved;
        if (expectedRecords !== actualRecords) {
          archiveIntegrityMatches = false;
          differences.push({ origin: batch.sourceBusinessName, module, expected: expectedRecords, found: actualRecords,
            reason: 'La cantidad archivada no coincide con el manifiesto de origen.' });
        }
        for (const entity of definition.entities) {
          const found = Number(batch.actualByEntity[entity] || 0);
          let expected = Number(sourceCounts[entity] || 0);
          if (entity === 'categories') expected = Object.hasOwn(sourceCounts, 'categories') ? 1 : 0;
          if (entity === 'configuration') expected = Object.hasOwn(sourceCounts, 'configuration') ? 1 : 0;
          if (entity === 'abonos' && abonoKinds) {
            differences.push({ origin: batch.sourceBusinessName, module, entity, expected: null, found, reason: 'El manifiesto no separa los abonos por tipo; requiere conciliación del origen.' });
          } else if (expected !== found) {
            archiveIntegrityMatches = false;
            differences.push({ origin: batch.sourceBusinessName, module, entity, expected, found, reason: 'El archivo conservado no coincide con el conteo declarado para este grupo.' });
          }
        }
        if (batchUnresolved) differences.push({
          origin: batch.sourceBusinessName, module, expected: 'Todos los registros enlazados', found: batchUnresolved + ' sin enlace',
          reason: 'El archivo histórico todavía no está conciliado con las tablas del POS.'
        });
        return {
          batchId: batch.batchId, sourceBusinessName: batch.sourceBusinessName, status: batch.batchStatus,
          archiveIntegrity: expectedRecords === actualRecords ? 'MATCH' : 'DIFFERENT',
          expectedRecords, archivedRecords: actualRecords, unresolvedRecords: batchUnresolved
        };
      });

      return {
        businessId: String(current.business_id), available: true, records: rows.map(row => ({
          batchId: row.batchId, sourceBusinessName: row.sourceBusinessName, batchStatus: row.batchStatus,
          entityType: row.entityType, sourceRecordKey: row.sourceRecordKey, recordStatus: row.recordStatus,
          targetTable: row.targetTable || null, targetRecordId: row.targetRecordId || null,
          sourceActor: row.sourceActor || null, pendingReason: row.pendingReason || null,
          archivedAt: row.archivedAt, ...safePayload(row.sourcePayload)
        })), total: Number(count.total), offset, limit,
        reconciliation: {
          complete: false,
          archiveIntegrity: batchSummaries.length ? (archiveIntegrityMatches ? 'MATCH' : 'DIFFERENT') : 'NO_ARCHIVE',
          operationalComparison: 'NOT_RUN', unresolvedRecords: unresolved,
          batches: batchSummaries, differences
        }
      };
    });
  }

  return { list };
}

module.exports = { MODULES, safePayload, createMigrationHistoryService };
