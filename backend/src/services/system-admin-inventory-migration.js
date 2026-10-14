'use strict';

const { httpError } = require('../middleware/errors');
const { packageForInventoryImport, normalizeName } = require('./basic-migration-values');

const MIGRATION_TYPE = 'MIGRACION_INICIAL';
const PRODUCT_BATCH_SIZE = 250;
const INITIAL_REASON = 'Migración inicial desde paquete local';

function validTargetId(value) {
  return typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n;
}

function detailsObject(value) {
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stockUnits(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 1000) : null;
}

function matchesBasicImport(rows, imported) {
  return rows.some(row => {
    const details = detailsObject(row.details);
    if (!details || normalizeName(details.sourceBusinessName) !== normalizeName(imported.sourceBusinessName)) return false;
    return imported.exportedAt === null || details.packageExportedAt === imported.exportedAt;
  });
}

function mapProducts(sourceProducts, targetProducts, movementState) {
  const byBarcode = new Map();
  const byName = new Map();
  for (const product of targetProducts) {
    const barcode = normalizeName(product.barcode);
    if (barcode) byBarcode.set(barcode, product);
    const name = normalizeName(product.name);
    if (name) {
      const matches = byName.get(name) || [];
      matches.push(product);
      byName.set(name, matches);
    }
  }

  const counts = {
    productsWithStock: 0,
    productsWithoutStock: 0,
    productsToSkip: 0,
    inventoryMovementsToCreate: 0
  };
  const reasons = { deleted: 0, noStock: 0, unmapped: 0, ambiguous: 0, duplicateSource: 0, stockMismatch: 0, alreadyImported: 0, existingHistory: 0 };
  const mapped = [];

  for (const source of sourceProducts) {
    if (source.deleted) { reasons.deleted++; counts.productsToSkip++; continue; }
    const stock = stockUnits(source.stock);
    if (stock !== null && stock > 0) counts.productsWithStock++;
    else counts.productsWithoutStock++;
    let target = null;
    const barcode = normalizeName(source.barcode);
    if (barcode) target = byBarcode.get(barcode) || null;
    else {
      const named = byName.get(normalizeName(source.name)) || [];
      if (named.length === 1) target = named[0];
      else if (named.length > 1) { reasons.ambiguous++; counts.productsToSkip++; continue; }
    }
    if (!target) { reasons.unmapped++; counts.productsToSkip++; continue; }
    mapped.push({ source, target, stock });
  }

  const byTargetId = new Map();
  for (const candidate of mapped) {
    const id = String(candidate.target.id);
    const group = byTargetId.get(id) || [];
    group.push(candidate);
    byTargetId.set(id, group);
  }

  const toCreate = [];
  for (const [id, group] of byTargetId) {
    if (group.length > 1) {
      reasons.duplicateSource += group.length;
      counts.productsToSkip += group.length;
      continue;
    }
    const [candidate] = group;
    const { target, stock } = candidate;
    if (stock === null || stock <= 0) {
      reasons.noStock++;
      counts.productsToSkip++;
    } else if (stockUnits(target.stock) !== stock) {
      reasons.stockMismatch++;
      counts.productsToSkip++;
    } else if (movementState.initial.has(id)) {
      reasons.alreadyImported++;
      counts.productsToSkip++;
    } else if (movementState.history.has(id)) {
      reasons.existingHistory++;
      counts.productsToSkip++;
    } else {
      toCreate.push(candidate);
    }
  }
  counts.inventoryMovementsToCreate = toCreate.length;

  const warnings = [];
  const warning = (key, message) => { if (reasons[key]) warnings.push(message(reasons[key])); };
  warning('deleted', count => `Se omitieron ${count} productos marcados como eliminados.`);
  warning('noStock', count => `Se omitieron ${count} productos sin stock; el esquema no admite movimientos con cantidad cero.`);
  warning('unmapped', count => `Se omitieron ${count} productos que no se encontraron en el negocio destino.`);
  warning('ambiguous', count => `Se omitieron ${count} productos cuyo nombre coincide con varios productos del destino.`);
  warning('duplicateSource', count => `Se omitieron ${count} registros del paquete que apuntan al mismo producto destino.`);
  warning('stockMismatch', count => `Se omitieron ${count} productos porque el stock destino no coincide con el stock local; no se modificó el producto.`);
  warning('alreadyImported', count => `Se omitieron ${count} productos que ya tienen un movimiento MIGRACION_INICIAL.`);
  warning('existingHistory', count => `Se omitieron ${count} productos con historial de inventario en el destino.`);
  return { counts, warnings, toCreate, mapped };
}

function createSystemAdminInventoryMigration({ repo, requireSystemAdmin }) {
  async function assertMigrationSchema(db) {
    const [column] = await repo.rows(db,
      "SELECT COLUMN_TYPE AS columnType FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inventory_movements' AND COLUMN_NAME = 'type'",
      []);
    if (!column || !String(column.columnType).includes("'MIGRACION_INICIAL'")) throw httpError(503, 'MIGRATION_INVENTORY_SCHEMA_REQUIRED');
  }

  async function targetBusiness(db, targetBusinessId, lock) {
    const [business] = await repo.rows(db,
      'SELECT id, name, status FROM businesses WHERE id = ?' + (lock ? ' FOR UPDATE' : ''), [targetBusinessId]);
    if (!business) throw httpError(404, 'BUSINESS_NOT_FOUND');
    if (business.status !== 'ACTIVE') throw httpError(409, 'MIGRATION_TARGET_INACTIVE');
    return business;
  }

  async function hasBasicImport(db, targetBusinessId, imported) {
    const audits = await repo.rows(db,
      "SELECT details FROM audit_logs WHERE business_id = ? AND action = 'MIGRATION_BASIC_IMPORT' ORDER BY id DESC LIMIT 100",
      [targetBusinessId]);
    return matchesBasicImport(audits, imported);
  }

  async function inventoryHistory(db, targetBusinessId, products) {
    const history = new Set(), initial = new Set();
    const ids = [...new Set(products.map(product => String(product.id)))];
    for (let offset = 0; offset < ids.length; offset += PRODUCT_BATCH_SIZE) {
      const batch = ids.slice(offset, offset + PRODUCT_BATCH_SIZE);
      const rows = await repo.rows(db,
        'SELECT product_id AS productId, type FROM inventory_movements WHERE business_id = ? AND product_id IN (' + batch.map(() => '?').join(', ') + ')',
        [targetBusinessId, ...batch]);
      for (const row of rows) {
        const id = String(row.productId);
        history.add(id);
        if (row.type === MIGRATION_TYPE) initial.add(id);
      }
    }
    return { history, initial };
  }

  async function lockMappedProducts(db, targetBusinessId, candidates) {
    const ids = [...new Set(candidates.map(candidate => String(candidate.target.id)))];
    const locked = [];
    for (let offset = 0; offset < ids.length; offset += PRODUCT_BATCH_SIZE) {
      const batch = ids.slice(offset, offset + PRODUCT_BATCH_SIZE);
      const rows = await repo.rows(db,
        'SELECT id, barcode, name, stock FROM products WHERE business_id = ? AND deleted = FALSE AND id IN (' + batch.map(() => '?').join(', ') + ') FOR UPDATE',
        [targetBusinessId, ...batch]);
      locked.push(...rows);
    }
    return locked;
  }

  async function inspect(db, targetBusinessId, imported, lock = false) {
    await assertMigrationSchema(db);
    const business = await targetBusiness(db, targetBusinessId, lock);
    const basicReady = await hasBasicImport(db, targetBusinessId, imported);
    if (!basicReady) return { business, basicReady, plan: null };
    const availableProducts = await repo.rows(db,
      'SELECT id, barcode, name, stock FROM products WHERE business_id = ? AND deleted = FALSE', [targetBusinessId]);
    const initiallyMapped = mapProducts(imported.products, availableProducts, { history: new Set(), initial: new Set() }).mapped;
    const products = lock ? await lockMappedProducts(db, targetBusinessId, initiallyMapped) : availableProducts;
    const mapped = mapProducts(imported.products, products, { history: new Set(), initial: new Set() }).mapped;
    const history = await inventoryHistory(db, targetBusinessId, mapped.map(candidate => candidate.target));
    return { business, basicReady, plan: mapProducts(imported.products, products, history) };
  }

  async function preview(auth, targetBusinessId, sourcePackage) {
    requireSystemAdmin(auth);
    if (!validTargetId(targetBusinessId)) throw httpError(400, 'INVALID_INPUT');
    const imported = packageForInventoryImport(sourcePackage);
    const state = await inspect(repo.pool, targetBusinessId, imported);
    if (!state.basicReady) {
      return {
        ok: true,
        eligible: false,
        products: {
          productsWithStock: imported.products.filter(item => !item.deleted && stockUnits(item.stock) > 0).length,
          productsWithoutStock: imported.products.filter(item => !item.deleted && stockUnits(item.stock) <= 0).length,
          productsToSkip: imported.products.length,
          inventoryMovementsToCreate: 0
        },
        warnings: ['Primero completa la migración básica de productos para este paquete y negocio.']
      };
    }
    return { ok: true, eligible: true, products: state.plan.counts, warnings: state.plan.warnings };
  }

  async function migrate(auth, targetBusinessId, sourcePackage) {
    requireSystemAdmin(auth);
    if (!validTargetId(targetBusinessId)) throw httpError(400, 'INVALID_INPUT');
    const imported = packageForInventoryImport(sourcePackage);
    return repo.transaction(async db => {
      const state = await inspect(db, targetBusinessId, imported, true);
      if (!state.basicReady) throw httpError(409, 'MIGRATION_BASIC_REQUIRED');
      const created = { inventoryMovements: 0 };
      const skipped = { inventoryMovements: state.plan.counts.productsToSkip };
      for (const candidate of state.plan.toCreate) {
        const { source, target } = candidate;
        await repo.rows(db,
          'INSERT INTO inventory_movements (business_id, product_id, user_id, type, quantity, stock_after, reason, unit_cost, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))',
          [targetBusinessId, String(target.id), MIGRATION_TYPE, source.stock, source.stock, INITIAL_REASON, source.cost]);
        created.inventoryMovements++;
      }
      const warnings = state.plan.warnings;
      const summary = { created, skipped };
      const auditDetails = {
        actor: { userId: String(auth.user_id), username: auth.username, role: auth.role, businessId: String(auth.business_id) },
        targetBusinessId,
        sourceBusinessName: imported.sourceBusinessName,
        packageExportedAt: imported.exportedAt,
        summary,
        warnings
      };
      await repo.rows(db,
        'INSERT INTO audit_logs (business_id, user_id, action, entity, entity_id, details, created_at) VALUES (?, NULL, ?, ?, ?, ?, UTC_TIMESTAMP(3))',
        [targetBusinessId, 'MIGRATION_INVENTORY_IMPORT', 'businesses', targetBusinessId, JSON.stringify(auditDetails)]);
      return { ok: true, created, skipped, warnings };
    });
  }

  return { preview, migrate };
}

module.exports = { createSystemAdminInventoryMigration };
