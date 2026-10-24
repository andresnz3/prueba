'use strict';
const { hashPassword } = require('./passwords');
const { randomToken, hashToken } = require('./tokens');
const { publicUser } = require('../repositories/auth');
const { httpError } = require('../middleware/errors');
const billingValues = require('./system-admin-billing-values');
const { packageForImport, normalizeName } = require('./basic-migration-values');
const { createSystemAdminInventoryMigration } = require('./system-admin-inventory-migration');
const { createSystemAdminSalesMigration } = require('./system-admin-sales-migration');
const { createSystemAdminPurchasesMigration } = require('./system-admin-purchases-migration');
const { createSystemAdminCreditMigration } = require('./system-admin-credit-migration');
const { createSystemAdminMigrationArchive } = require('./system-admin-migration-archive');
const { randomUUID, createHash } = require('node:crypto');
const { PLAN_CATALOG, CONNECTED_PLAN_CODES, planByCode, businessPlan, businessUserCounts, assertWithinPlan, assertUserAddition, capacityView } = require('./business-plans');

const isSystemAdmin = auth => auth?.username === 'andres' && auth.role === 'ADMIN' && String(auth.business_id) === '1';
const requireSystemAdmin = auth => { if (!isSystemAdmin(auth)) throw httpError(403, 'SYSTEM_ADMIN_REQUIRED'); };
const businessRecord = row => ({ id: String(row.id), name: row.name, status: row.status, migrationState: row.migration_state || 'NOT_REQUIRED', createdAt: row.created_at, userCount: Number(row.user_count || 0) });
const migrationProtectionTables = ['migration_import_batches', 'migration_source_records', 'business_migration_controls'];
const migrationTargetRequiredTables = [
  'users', 'sessions', 'session_authorizations', 'products', 'clients', 'suppliers', 'sales', 'sale_items',
  'purchases', 'purchase_items', 'cash_sessions', 'cash_movements', 'inventory_movements', 'customer_payments',
  'supplier_payments', 'expenses', 'audit_logs', 'business_settings', 'document_sequences', 'pos_operations',
  'sale_orders', 'sale_order_items', 'business_subscriptions', 'business_subscription_payments',
  'migration_sales_references', 'migration_purchase_references', 'migration_credit_payment_references',
  ...migrationProtectionTables
];
const preservedMigrationTargetTables = new Set([
  'users', 'sessions', 'session_authorizations', 'business_settings', 'audit_logs',
  'business_subscriptions', 'business_subscription_payments'
]);
const migrationTargetAreas = Object.freeze({
  products: 'Productos e inventario', clients: 'Clientes', suppliers: 'Proveedores',
  sales: 'Ventas', sale_items: 'Ventas', purchases: 'Compras', purchase_items: 'Compras',
  cash_sessions: 'Caja', cash_movements: 'Caja', inventory_movements: 'Inventario',
  customer_payments: 'Abonos de clientes', supplier_payments: 'Pagos a proveedores', expenses: 'Gastos',
  document_sequences: 'Comprobantes', pos_operations: 'Operaciones comerciales',
  sale_orders: 'Órdenes pendientes', sale_order_items: 'Órdenes pendientes',
  migration_sales_references: 'Importaciones anteriores', migration_purchase_references: 'Importaciones anteriores',
  migration_credit_payment_references: 'Importaciones anteriores', migration_import_batches: 'Importaciones anteriores',
  migration_source_records: 'Importaciones anteriores'
});
const businessDeletionLabels = Object.freeze({
  users: 'Usuarios', sessions: 'Sesiones', session_authorizations: 'Permisos de sesión',
  products: 'Productos', clients: 'Clientes', suppliers: 'Proveedores', sales: 'Ventas',
  sale_items: 'Detalles de ventas', purchases: 'Compras', purchase_items: 'Detalles de compras',
  cash_sessions: 'Sesiones de caja', cash_movements: 'Movimientos de caja',
  inventory_movements: 'Movimientos de inventario', customer_payments: 'Abonos de clientes',
  supplier_payments: 'Pagos a proveedores', expenses: 'Gastos', audit_logs: 'Auditoría del negocio',
  business_settings: 'Configuración del negocio', document_sequences: 'Comprobantes',
  pos_operations: 'Operaciones del POS', sale_orders: 'Órdenes pendientes',
  sale_order_items: 'Detalles de órdenes', business_subscriptions: 'Planes del negocio',
  business_subscription_payments: 'Pagos del plan', migration_sales_references: 'Referencias de ventas migradas',
  migration_purchase_references: 'Referencias de compras migradas', migration_credit_payment_references: 'Referencias de abonos migrados',
  migration_supplier_payment_references: 'Referencias de pagos a proveedores migrados', migration_import_batches: 'Lotes de migración',
  migration_source_records: 'Registros de migración', business_migration_controls: 'Control de migración',
  migration_zero_inventory_events: 'Eventos históricos de inventario'
});
const quoteIdentifier = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_]+$/.test(value)) throw httpError(503, 'BUSINESS_DELETE_SCHEMA_UNSUPPORTED');
  return '`' + value + '`';
};
const businessDeletionPreviewToken = summary => createHash('sha256').update(JSON.stringify({
  business: summary.business, counts: summary.counts, totalRecords: summary.totalRecords, images: summary.images
})).digest('hex');
function createSystemAdminService(repo, options = {}) {
  const inventoryMigration = createSystemAdminInventoryMigration({ repo, requireSystemAdmin });
  const creditMigration = createSystemAdminCreditMigration({ repo, requireSystemAdmin });
  const salesMigration = createSystemAdminSalesMigration({ repo, requireSystemAdmin });
  const purchasesMigration = createSystemAdminPurchasesMigration({ repo, requireSystemAdmin });
  const migrationArchive = createSystemAdminMigrationArchive({ repo, requireSystemAdmin });
  const migrationProjection = require('./system-admin-migration-projection').createSystemAdminMigrationProjection({ repo, requireSystemAdmin, imageStore: options.imageStore });
  const migrationOperations = require('./system-admin-migration-operations').createSystemAdminMigrationOperations({ repo, requireSystemAdmin, salesMigration, creditMigration, purchasesMigration, migrationProjection });
  async function assertBillingTables() {
    const rows = await repo.rows(repo.pool, 'SELECT TABLE_NAME AS tableName FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?, ?)', ['business_subscriptions', 'business_subscription_payments']);
    if (rows.length !== 2) throw httpError(503, 'SYSTEM_ADMIN_BILLING_MIGRATION_REQUIRED');
  }

  async function assertPlanCodeSupported(db, plan) {
    if (plan.code !== 'CONECTADO_ESTANDAR') return;
    const [row] = await repo.rows(db,
      'SELECT cc.check_clause AS checkClause FROM information_schema.check_constraints cc JOIN information_schema.table_constraints tc ON tc.constraint_schema=cc.constraint_schema AND tc.constraint_name=cc.constraint_name WHERE cc.constraint_schema=DATABASE() AND tc.table_name = ? AND tc.constraint_name = ? AND tc.constraint_type=\'CHECK\'',
      ['business_subscriptions', 'chk_business_subscriptions_plan']);
    if (!String(row?.checkClause || '').toUpperCase().includes('CONECTADO_ESTANDAR')) {
      throw httpError(503, 'BUSINESS_PLAN_STANDARD_MIGRATION_REQUIRED');
    }
  }

  async function migrationControlTableExists(db) {
    const [row] = await repo.rows(db, 'SELECT COUNT(*) AS present FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'business_migration_controls\'', []);
    return Number(row.present) === 1;
  }

  async function businessDeletionPlan(db, businessId) {
    const scopedRows = await repo.rows(db,
      'SELECT t.TABLE_NAME AS tableName FROM INFORMATION_SCHEMA.TABLES t JOIN INFORMATION_SCHEMA.COLUMNS c ON c.TABLE_SCHEMA=t.TABLE_SCHEMA AND c.TABLE_NAME=t.TABLE_NAME WHERE t.TABLE_SCHEMA=DATABASE() AND t.TABLE_TYPE=\'BASE TABLE\' AND c.COLUMN_NAME=\'business_id\' ORDER BY t.TABLE_NAME', []);
    const scopedTables = new Set(scopedRows.map(row => row.tableName));
    const foreignKeyRows = await repo.rows(db,
      'SELECT TABLE_NAME AS childTable, CONSTRAINT_NAME AS constraintName, COLUMN_NAME AS childColumn, REFERENCED_TABLE_NAME AS parentTable, REFERENCED_COLUMN_NAME AS parentColumn, ORDINAL_POSITION AS position FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE CONSTRAINT_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION', []);
    const groups = new Map();
    for (const row of foreignKeyRows) {
      const key = row.childTable + '\0' + row.constraintName;
      if (!groups.has(key)) groups.set(key, { childTable: row.childTable, constraintName: row.constraintName, parentTable: row.parentTable, columns: [] });
      groups.get(key).columns.push({ childColumn: row.childColumn, parentColumn: row.parentColumn });
    }
    const foreignKeys = [...groups.values()];

    // Keep references from other businesses and global tables intact. Such a reference
    // is a real dependency that must be reviewed instead of crossing tenant boundaries.
    for (const foreignKey of foreignKeys) {
      const parentIsTenant = scopedTables.has(foreignKey.parentTable);
      const parentIsBusiness = foreignKey.parentTable === 'businesses';
      if (!parentIsTenant && !parentIsBusiness) continue;
      const childScoped = scopedTables.has(foreignKey.childTable);
      const join = foreignKey.columns.map(column => 'c.' + quoteIdentifier(column.childColumn) + ' = p.' + quoteIdentifier(column.parentColumn)).join(' AND ');
      const parentFilter = parentIsTenant ? 'p.' + quoteIdentifier('business_id') + ' = ?' : 'p.' + quoteIdentifier(foreignKey.columns[0].parentColumn) + ' = ?';
      const childFilter = childScoped ? ' AND c.' + quoteIdentifier('business_id') + ' <> ?' : '';
      const found = await repo.rows(db,
        'SELECT 1 AS present FROM ' + quoteIdentifier(foreignKey.childTable) + ' c JOIN ' + quoteIdentifier(foreignKey.parentTable) + ' p ON ' + join + ' WHERE ' + parentFilter + childFilter + ' LIMIT 1',
        childScoped ? [businessId, businessId] : [businessId]);
      if (found.length) throw httpError(409, 'BUSINESS_DELETE_BLOCKED');
    }

    const childrenByParent = new Map([...scopedTables].map(table => [table, new Set()]));
    const selfReferences = [];
    for (const foreignKey of foreignKeys) {
      if (!scopedTables.has(foreignKey.childTable) || !scopedTables.has(foreignKey.parentTable)) continue;
      if (foreignKey.childTable === foreignKey.parentTable) selfReferences.push(foreignKey);
      else childrenByParent.get(foreignKey.parentTable).add(foreignKey.childTable);
    }
    const state = new Map();
    const deleteOrder = [];
    function visit(parent) {
      const current = state.get(parent) || 0;
      if (current === 2) return;
      if (current === 1) throw httpError(503, 'BUSINESS_DELETE_SCHEMA_UNSUPPORTED');
      state.set(parent, 1);
      for (const child of [...(childrenByParent.get(parent) || [])].sort()) visit(child);
      state.set(parent, 2);
      deleteOrder.push(parent);
    }
    for (const table of [...scopedTables].sort()) visit(table);
    return { tables: deleteOrder, selfReferences };
  }

  async function businessBillingArchive(db, business, plan) {
    const archive = { subscriptions: [], payments: [] };
    if (plan.tables.includes('business_subscriptions')) {
      archive.subscriptions = await repo.rows(db,
        'SELECT plan_code AS planCode, next_due_date AS nextDueDate, created_at AS createdAt, updated_at AS updatedAt FROM business_subscriptions WHERE business_id = ?', [business.id]);
    }
    if (plan.tables.includes('business_subscription_payments')) {
      archive.payments = await repo.rows(db,
        'SELECT p.id, p.amount, p.payment_date AS paymentDate, p.created_by_user_id AS createdByUserId, u.business_id AS creatorBusinessId, u.username AS creatorUsername, u.full_name AS creatorFullName, u.role AS creatorRole, p.created_at AS createdAt FROM business_subscription_payments p LEFT JOIN users u ON u.id = p.created_by_user_id WHERE p.business_id = ? ORDER BY p.id', [business.id]);
    }
    return archive;
  }

  async function businessDeletionSummary(db, business, plan) {
    const counts = [{ table: 'businesses', label: 'Negocio', count: 1 }];
    let totalRecords = 1;
    for (const table of plan.tables) {
      const [row] = await repo.rows(db, 'SELECT COUNT(*) AS recordCount FROM ' + quoteIdentifier(table) + ' WHERE business_id = ?', [business.id]);
      const count = Number(row.recordCount);
      if (!Number.isSafeInteger(count) || count < 0) throw httpError(503, 'BUSINESS_DELETE_SCHEMA_UNSUPPORTED');
      if (count) {
        counts.push({ table, label: businessDeletionLabels[table] || table, count });
        totalRecords += count;
      }
    }
    const billingArchive = await businessBillingArchive(db, business, plan);
    const images = typeof options.imageStore?.countBusinessFiles === 'function'
      ? await options.imageStore.countBusinessFiles(business.id)
      : { count: 0, bytes: 0 };
    if (images.count) counts.push({ table: 'business_files', label: 'Imágenes y archivos del negocio', count: images.count });
    totalRecords += images.count;
    return {
      business: { id: String(business.id), name: business.name, status: business.status },
      counts, totalRecords,
      sessions: counts.find(item => item.table === 'sessions')?.count || 0,
      images,
      retainedBilling: { subscriptions: billingArchive.subscriptions.length, payments: billingArchive.payments.length }
    };
  }

  async function previewBusinessDeletion(auth, businessId) {
    requireSystemAdmin(auth);
    const id = String(businessId);
    if (id === '1') throw httpError(409, 'BUSINESS_DELETE_PROTECTED');
    const [business] = await repo.rows(repo.pool, 'SELECT id, name, status FROM businesses WHERE id = ?', [id]);
    if (!business) throw httpError(404, 'BUSINESS_NOT_FOUND');
    const plan = await businessDeletionPlan(repo.pool, id);
    const summary = await businessDeletionSummary(repo.pool, business, plan);
    return { ...summary, previewToken: businessDeletionPreviewToken(summary) };
  }

  async function assertMigrationProtectionSchema(db) {
    const tables = await repo.rows(db,
      'SELECT TABLE_NAME AS tableName FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (' + migrationTargetRequiredTables.map(() => '?').join(', ') + ')',
      migrationTargetRequiredTables
    );
    const present = new Set(tables.map(row => row.tableName));
    if (migrationTargetRequiredTables.some(table => !present.has(table))) throw httpError(503, 'MIGRATION_GATE_SCHEMA_REQUIRED');
  }

  async function inspectMigrationTargetRecord(db, businessId, lock = false) {
    if (String(businessId) === '1') throw httpError(409, 'MIGRATION_TARGET_PROTECTED');
    await assertMigrationProtectionSchema(db);
    const [business] = await repo.rows(db,
      'SELECT id,name,status,phone,address,created_at FROM businesses WHERE id=?' + (lock ? ' FOR UPDATE' : ''),
      [businessId]
    );
    if (!business) throw httpError(404, 'BUSINESS_NOT_FOUND');
    const [control] = await repo.rows(db, 'SELECT state FROM business_migration_controls WHERE business_id=?' + (lock ? ' FOR UPDATE' : ''), [businessId]);
    if (control) throw httpError(409, 'MIGRATION_TARGET_ALREADY_PREPARED');

    const scopedTables = await repo.rows(db,
      'SELECT t.TABLE_NAME AS tableName FROM INFORMATION_SCHEMA.TABLES t JOIN INFORMATION_SCHEMA.COLUMNS c ON c.TABLE_SCHEMA=t.TABLE_SCHEMA AND c.TABLE_NAME=t.TABLE_NAME WHERE t.TABLE_SCHEMA=DATABASE() AND t.TABLE_TYPE=\'BASE TABLE\' AND c.COLUMN_NAME=\'business_id\' ORDER BY t.TABLE_NAME',
      []
    );
    const installed = new Set(scopedTables.map(row => row.tableName));
    if (migrationTargetRequiredTables.some(table => !installed.has(table))) throw httpError(503, 'MIGRATION_GATE_SCHEMA_REQUIRED');

    const recordCounts = new Map();
    for (const { tableName } of scopedTables) {
      if (!/^[A-Za-z0-9_]+$/.test(tableName)) throw httpError(503, 'MIGRATION_GATE_SCHEMA_REQUIRED');
      const [count] = await repo.rows(db, 'SELECT COUNT(*) AS total FROM `' + tableName + '` WHERE business_id=?', [businessId]);
      recordCounts.set(tableName, Number(count.total));
    }

    const blockingAreas = new Map();
    let unclassifiedRecords = 0;
    for (const [tableName, count] of recordCounts) {
      if (!count || preservedMigrationTargetTables.has(tableName)) continue;
      const area = migrationTargetAreas[tableName];
      if (!area) { unclassifiedRecords += count; continue; }
      blockingAreas.set(area, (blockingAreas.get(area) || 0) + count);
    }
    const blockers = [...blockingAreas].map(([area, count]) => `${area}: ${count} registro(s)`);
    if (unclassifiedRecords) blockers.push('Información adicional que requiere revisión: ' + unclassifiedRecords + ' registro(s)');
    const preserved = {
      users: recordCounts.get('users') || 0,
      settings: recordCounts.get('business_settings') || 0,
      auditLogs: recordCounts.get('audit_logs') || 0,
      sessions: recordCounts.get('sessions') || 0,
      subscriptions: (recordCounts.get('business_subscriptions') || 0) + (recordCounts.get('business_subscription_payments') || 0),
      businessPhone: Boolean(business.phone),
      businessAddress: Boolean(business.address)
    };
    const [activeSessions] = await repo.rows(db, 'SELECT COUNT(*) AS total FROM sessions WHERE business_id=? AND revoked_at IS NULL AND expires_at>UTC_TIMESTAMP(3)', [businessId]);
    const [sessionsToRevoke] = await repo.rows(db, 'SELECT COUNT(*) AS total FROM sessions WHERE business_id=? AND revoked_at IS NULL', [businessId]);
    const accessChanges = {
      activeSessions: Number(activeSessions.total),
      sessionsToRevoke: Number(sessionsToRevoke.total),
      authorizationsToRemove: recordCounts.get('session_authorizations') || 0
    };
    const warnings = [];
    if (business.status === 'ACTIVE') warnings.push('El negocio está activo. Al prepararlo se suspenderá el acceso y se revocarán las sesiones actuales.');
    if (preserved.users) warnings.push(`Se conservarán ${preserved.users} usuario(s); no podrán ingresar mientras la migración esté pendiente.`);
    if (accessChanges.sessionsToRevoke) warnings.push(`Se revocarán ${accessChanges.sessionsToRevoke} sesión(es) para bloquear el acceso durante la preparación.`);
    if (preserved.settings) warnings.push('La configuración existente se conservará sin sobrescribirla.');
    if (preserved.auditLogs) warnings.push('El historial de auditoría existente se conservará.');
    if (preserved.subscriptions) warnings.push('Los datos de plan y pagos del servicio se conservarán.');
    if (preserved.businessPhone || preserved.businessAddress) warnings.push('Los datos de contacto del negocio se conservarán sin cambios.');
    return {
      business: businessRecord({ ...business, migration_state: 'NOT_REQUIRED', user_count: preserved.users }),
      eligible: blockers.length === 0,
      blockers,
      warnings,
      preserved,
      accessChanges
    };
  }

  async function migrationState(db, businessId) {
    if (!await migrationControlTableExists(db)) return 'NOT_REQUIRED';
    const [control] = await repo.rows(db, 'SELECT state FROM business_migration_controls WHERE business_id = ?', [businessId]);
    return control?.state || 'NOT_REQUIRED';
  }

  function billingBusiness(row, today, soon) {
    const plan = planByCode.get(row.plan_code) || null;
    const nextDueDate = billingValues.dateOnly(row.next_due_date);
    const daysUntilDue = nextDueDate ? billingValues.dayDifference(today, nextDueDate) : null;
    let paymentStatus = 'UNASSIGNED';
    if (plan && !plan.monthly) paymentStatus = 'NOT_APPLICABLE';
    else if (plan?.monthly) {
      if (!nextDueDate) paymentStatus = 'DATE_PENDING';
      else if (daysUntilDue < 0) paymentStatus = 'OVERDUE';
      else if (daysUntilDue === 0) paymentStatus = 'DUE_TODAY';
      else if (daysUntilDue <= soon) paymentStatus = 'DUE_SOON';
      else paymentStatus = 'CURRENT';
    }
    return {
      id: String(row.id), name: row.name, status: row.status, migrationState: row.migration_state || 'NOT_REQUIRED', userCount: Number(row.user_count || 0),
      activeUserCount: Number(row.active_user_count || 0), inactiveUserCount: Number(row.inactive_user_count || 0), activeAdminCount: Number(row.active_admin_count || 0),
      planCode: plan?.code || null, planName: plan?.name || 'Sin asignar', monthly: Boolean(plan?.monthly),
      includedUsers: plan?.includedUsers ?? null, nextDueDate, daysUntilDue, paymentStatus,
      lastPayment: row.last_payment_date ? { date: billingValues.dateOnly(row.last_payment_date), amount: String(row.last_payment_amount) } : null
    };
  }

  async function listBilling(auth) {
    requireSystemAdmin(auth);
    await assertBillingTables();
    const hasMigrationControls = await migrationControlTableExists(repo.pool);
    const migrationStateSelect = hasMigrationControls ? 'COALESCE(mc.state, \'NOT_REQUIRED\')' : '\'NOT_REQUIRED\'';
    const migrationJoin = hasMigrationControls ? ' LEFT JOIN business_migration_controls mc ON mc.business_id = b.id' : '';
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const soon = 7;
    const businesses = await repo.rows(repo.pool,
      `SELECT b.id, b.name, b.status, ` + migrationStateSelect + ` AS migration_state, COUNT(DISTINCT u.id) AS user_count,
        COUNT(DISTINCT CASE WHEN u.active = TRUE AND NOT (u.business_id = 1 AND u.username = 'andres' AND u.role = 'ADMIN') THEN u.id END) AS active_user_count,
        COUNT(DISTINCT CASE WHEN u.active = FALSE AND NOT (u.business_id = 1 AND u.username = 'andres' AND u.role = 'ADMIN') THEN u.id END) AS inactive_user_count,
        COUNT(DISTINCT CASE WHEN u.active = TRUE AND u.role = 'ADMIN' AND NOT (u.business_id = 1 AND u.username = 'andres' AND u.role = 'ADMIN') THEN u.id END) AS active_admin_count,
        s.plan_code, s.next_due_date,
        (SELECT p.payment_date FROM business_subscription_payments p WHERE p.business_id = b.id ORDER BY p.payment_date DESC, p.id DESC LIMIT 1) AS last_payment_date,
        (SELECT p.amount FROM business_subscription_payments p WHERE p.business_id = b.id ORDER BY p.payment_date DESC, p.id DESC LIMIT 1) AS last_payment_amount
       FROM businesses b
       LEFT JOIN users u ON u.business_id = b.id
       LEFT JOIN business_subscriptions s ON s.business_id = b.id` + migrationJoin + `
       GROUP BY b.id, b.name, b.status, s.plan_code, s.next_due_date
       ` + (hasMigrationControls ? ', mc.state' : '') + ` ORDER BY b.id`, []);
    const records = businesses.map(row => billingBusiness(row, today, soon));
    const reminder = records.filter(item => item.monthly && item.daysUntilDue !== null && item.daysUntilDue >= 0 && item.daysUntilDue <= soon)
      .sort((a, b) => a.daysUntilDue - b.daysUntilDue || a.id.localeCompare(b.id))[0] || null;
    return {
      plans: PLAN_CATALOG.map(plan => ({ ...plan })),
      summary: {
        activeBusinesses: records.filter(item => item.status === 'ACTIVE').length,
        localPlans: records.filter(item => item.planCode === 'LOCAL').length,
        monthlyPlans: records.filter(item => item.monthly).length,
        paymentsDueSoon: records.filter(item => item.paymentStatus === 'DUE_SOON' || item.paymentStatus === 'DUE_TODAY').length,
        paymentsOverdue: records.filter(item => item.paymentStatus === 'OVERDUE').length,
        unassignedPlans: records.filter(item => item.paymentStatus === 'UNASSIGNED').length
      },
      today, reminder: reminder ? { businessId: reminder.id, businessName: reminder.name, dueDate: reminder.nextDueDate, daysUntil: reminder.daysUntilDue } : null,
      businesses: records
    };
  }

  async function setBusinessPlan(auth, businessId, planCode, nextDueDate) {
    requireSystemAdmin(auth);
    await assertBillingTables();
    const plan = planByCode.get(planCode);
    if (!plan) throw httpError(400, 'BUSINESS_PLAN_INVALID');
    let dueDate = null;
    if (nextDueDate !== null && nextDueDate !== '') dueDate = billingValues.date(nextDueDate, 'nextDueDate');
    if (!plan.monthly) dueDate = null;
    return repo.transaction(async db => {
      const [business] = await repo.rows(db, 'SELECT id FROM businesses WHERE id = ? FOR UPDATE', [businessId]);
      if (!business) throw httpError(404, 'BUSINESS_NOT_FOUND');
      await assertPlanCodeSupported(db, plan);
      assertWithinPlan(plan, await businessUserCounts(repo, db, businessId));
      await repo.rows(db, 'INSERT INTO business_subscriptions (business_id, plan_code, next_due_date, updated_at) VALUES (?, ?, ?, UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE plan_code = VALUES(plan_code), next_due_date = VALUES(next_due_date), updated_at = UTC_TIMESTAMP(3)', [businessId, plan.code, dueDate]);
      await repo.audit(db, auth, 'UPDATE_BUSINESS_PLAN', 'businesses', businessId, { planCode: plan.code, nextDueDate: dueDate });
      return { businessId: String(businessId), planCode: plan.code, planName: plan.name, nextDueDate: dueDate, monthly: plan.monthly };
    });
  }

  async function listSubscriptionPayments(auth, businessId) {
    requireSystemAdmin(auth);
    await assertBillingTables();
    const [business] = await repo.rows(repo.pool, 'SELECT id FROM businesses WHERE id = ?', [businessId]);
    if (!business) throw httpError(404, 'BUSINESS_NOT_FOUND');
    const payments = await repo.rows(repo.pool, 'SELECT id, amount, payment_date, created_at FROM business_subscription_payments WHERE business_id = ? ORDER BY payment_date DESC, id DESC LIMIT 50', [businessId]);
    return payments.map(payment => ({ id: String(payment.id), amount: String(payment.amount), paymentDate: billingValues.dateOnly(payment.payment_date), createdAt: payment.created_at }));
  }

  async function recordSubscriptionPayment(auth, businessId, amount, paymentDate) {
    requireSystemAdmin(auth);
    await assertBillingTables();
    const validAmount = billingValues.amount(amount);
    const validDate = billingValues.date(paymentDate, 'paymentDate');
    const today = new Date().toISOString().slice(0, 10);
    if (validDate > today) throw httpError(400, 'PAYMENT_DATE_FUTURE');
    const nextDueDate = billingValues.addMonth(validDate);
    return repo.transaction(async db => {
      const [business] = await repo.rows(db, 'SELECT id FROM businesses WHERE id = ? FOR UPDATE', [businessId]);
      if (!business) throw httpError(404, 'BUSINESS_NOT_FOUND');
      const [subscription] = await repo.rows(db, 'SELECT plan_code FROM business_subscriptions WHERE business_id = ? FOR UPDATE', [businessId]);
      const plan = planByCode.get(subscription?.plan_code);
      if (!plan?.monthly) throw httpError(409, 'BUSINESS_PLAN_NOT_MONTHLY');
      const result = await repo.rows(db, 'INSERT INTO business_subscription_payments (business_id, amount, payment_date, created_by_user_id, created_at) VALUES (?, ?, ?, ?, UTC_TIMESTAMP(3))', [businessId, validAmount, validDate, auth.user_id]);
      await repo.rows(db, 'UPDATE business_subscriptions SET next_due_date = ?, updated_at = UTC_TIMESTAMP(3) WHERE business_id = ?', [nextDueDate, businessId]);
      await repo.audit(db, auth, 'RECORD_SUBSCRIPTION_PAYMENT', 'businesses', businessId, { paymentId: String(result.insertId), amount: validAmount, currency: 'USD', paymentDate: validDate, nextDueDate });
      return {
        payment: { id: String(result.insertId), amount: validAmount, currency: 'USD', paymentDate: validDate },
        subscription: { businessId: String(businessId), planCode: plan.code, planName: plan.name, nextDueDate }
      };
    });
  }

  async function migrateBasic(auth, targetBusinessId, sourcePackage, confirmSystemBusiness) {
    requireSystemAdmin(auth);
    if (typeof targetBusinessId !== 'string' || !/^[1-9]\d{0,19}$/.test(targetBusinessId) ||
        BigInt(targetBusinessId) > 18446744073709551615n) throw httpError(400, 'INVALID_INPUT');
    if (String(targetBusinessId) === '1' && confirmSystemBusiness !== true) {
      throw httpError(409, 'MIGRATION_SYSTEM_BUSINESS_CONFIRMATION_REQUIRED');
    }
    const imported = packageForImport(sourcePackage);
    return repo.transaction(async db => {
      const [business] = await repo.rows(db, 'SELECT id, name, status FROM businesses WHERE id = ? FOR UPDATE', [targetBusinessId]);
      if (!business) throw httpError(404, 'BUSINESS_NOT_FOUND');
      if (business.status !== 'ACTIVE') throw httpError(409, 'MIGRATION_TARGET_INACTIVE');

      const existingProducts = await repo.rows(db, 'SELECT barcode, name FROM products WHERE business_id = ? FOR UPDATE', [targetBusinessId]);
      const existingClients = await repo.rows(db, 'SELECT name FROM clients WHERE business_id = ? FOR UPDATE', [targetBusinessId]);
      const existingSuppliers = await repo.rows(db, 'SELECT name FROM suppliers WHERE business_id = ? FOR UPDATE', [targetBusinessId]);
      const productBarcodes = new Set(existingProducts.map(item => normalizeName(item.barcode)));
      const productNames = new Set(existingProducts.map(item => normalizeName(item.name)));
      const clientNames = new Set(existingClients.map(item => normalizeName(item.name)));
      const supplierNames = new Set(existingSuppliers.map(item => normalizeName(item.name)));
      const created = { products: 0, clients: 0, suppliers: 0 };
      const skipped = { products: 0, clients: 0, suppliers: 0 };
      let createdProductsWithStock = 0;

      for (const product of imported.products) {
        if (product.deleted) { skipped.products++; continue; }
        const normalizedName = normalizeName(product.name);
        const normalizedBarcode = normalizeName(product.barcode);
        if ((normalizedBarcode && productBarcodes.has(normalizedBarcode)) || (!normalizedBarcode && productNames.has(normalizedName))) {
          skipped.products++;
          continue;
        }
        const barcode = product.barcode || 'MIG-' + randomUUID();
        try {
          await repo.rows(db,
            'INSERT INTO products (business_id, barcode, name, category, cost, retail_margin, wholesale_margin, retail_price, wholesale_price, stock, min_stock, tax_rate, image, active, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, FALSE)',
            [targetBusinessId, barcode, product.name, product.category, product.cost, product.marginRetail, product.marginWholesale, product.retailPrice, product.wholesalePrice, product.stock, product.minStock, product.taxRate, product.active]);
        } catch (failure) {
          if (failure.code !== 'ER_DUP_ENTRY' || !normalizedBarcode) throw failure;
          skipped.products++;
          continue;
        }
        created.products++;
        if (Number(product.stock) > 0) createdProductsWithStock++;
        if (normalizedBarcode) productBarcodes.add(normalizedBarcode);
        productNames.add(normalizedName);
      }

      for (const client of imported.clients) {
        const name = normalizeName(client.name);
        if (clientNames.has(name)) { skipped.clients++; continue; }
        await repo.rows(db, 'INSERT INTO clients (business_id, name, phone, ruc, address, credit_limit, opening_balance, active) VALUES (?, ?, ?, ?, ?, 0.00, 0.00, ?)',
          [targetBusinessId, client.name, client.phone, client.ruc, client.address, client.active]);
        created.clients++;
        clientNames.add(name);
      }

      for (const supplier of imported.suppliers) {
        const name = normalizeName(supplier.name);
        if (supplierNames.has(name)) { skipped.suppliers++; continue; }
        await repo.rows(db, 'INSERT INTO suppliers (business_id, name, contact, phone, ruc, address, active) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [targetBusinessId, supplier.name, supplier.contact, supplier.phone, supplier.ruc, supplier.address, supplier.active]);
        created.suppliers++;
        supplierNames.add(name);
      }

      const warnings = [];
      if (imported.deletedProducts) warnings.push('Se omitieron ' + imported.deletedProducts + ' productos marcados como eliminados.');
      if (imported.productsWithImage) warnings.push('No se importaron las imágenes de ' + imported.productsWithImage + ' productos.');
      if (createdProductsWithStock) warnings.push('Se importó el stock actual de ' + createdProductsWithStock + ' productos; no se creó historial de movimientos de inventario.');
      const summary = { created, skipped };
      const auditDetails = {
        actor: { userId: String(auth.user_id), username: auth.username, role: auth.role, businessId: String(auth.business_id) },
        targetBusinessId: String(targetBusinessId),
        sourceBusinessName: imported.sourceBusinessName,
        packageExportedAt: imported.exportedAt,
        summary
      };
      await repo.rows(db,
        'INSERT INTO audit_logs (business_id, user_id, action, entity, entity_id, details, created_at) VALUES (?, NULL, ?, ?, ?, ?, UTC_TIMESTAMP(3))',
        [targetBusinessId, 'MIGRATION_BASIC_IMPORT', 'businesses', String(targetBusinessId), JSON.stringify(auditDetails)]);
      return { ok: true, created, skipped, categoriesDetected: imported.categoriesDetected, warnings };
    });
  }

  async function listBusinesses(auth) {
    requireSystemAdmin(auth);
    const hasMigrationControls = await migrationControlTableExists(repo.pool);
    const migrationStateSelect = hasMigrationControls ? 'COALESCE(mc.state, \'NOT_REQUIRED\')' : '\'NOT_REQUIRED\'';
    const migrationJoin = hasMigrationControls ? ' LEFT JOIN business_migration_controls mc ON mc.business_id = b.id' : '';
    const businesses = await repo.rows(repo.pool, 'SELECT b.id, b.name, b.status, b.created_at, ' + migrationStateSelect + ' AS migration_state, COUNT(u.id) AS user_count FROM businesses b LEFT JOIN users u ON u.business_id = b.id' + migrationJoin + ' GROUP BY b.id, b.name, b.status, b.created_at' + (hasMigrationControls ? ', mc.state' : '') + ' ORDER BY b.id', []);
    return businesses.map(businessRecord);
  }

  async function createBusiness(auth, name, planCode) {
    requireSystemAdmin(auth);
    const plan = planByCode.get(planCode);
    if (!plan || !CONNECTED_PLAN_CODES.includes(plan.code)) throw httpError(400, 'BUSINESS_PLAN_INVALID');
    await assertBillingTables();
    return repo.transaction(async db => {
      await assertPlanCodeSupported(db, plan);
      const result = await repo.rows(db, 'INSERT INTO businesses (name, status) VALUES (?, \'ACTIVE\')', [name]);
      await repo.rows(db, 'INSERT INTO business_subscriptions (business_id, plan_code, next_due_date, updated_at) VALUES (?, ?, NULL, UTC_TIMESTAMP(3))', [result.insertId, plan.code]);
      const [created] = await repo.rows(db, 'SELECT id, name, status, created_at, 0 AS user_count FROM businesses WHERE id = ?', [String(result.insertId)]);
      await repo.audit(db, auth, 'CREATE_BUSINESS', 'businesses', result.insertId, { planCode: plan.code });
      return { ...businessRecord(created), planCode: plan.code, planName: plan.name, includedUsers: plan.includedUsers };
    });
  }

  async function createMigrationTarget(auth, name, planCode) {
    requireSystemAdmin(auth);
    const plan = planByCode.get(planCode);
    if (!plan || !CONNECTED_PLAN_CODES.includes(plan.code)) throw httpError(400, 'BUSINESS_PLAN_INVALID');
    await assertBillingTables();
    return repo.transaction(async db => {
      await assertPlanCodeSupported(db, plan);
      await assertMigrationProtectionSchema(db);
      const result = await repo.rows(db, 'INSERT INTO businesses (name, status) VALUES (?, \'INACTIVE\')', [name]);
      const businessId = String(result.insertId);
      await repo.rows(db, 'INSERT INTO business_subscriptions (business_id, plan_code, next_due_date, updated_at) VALUES (?, ?, NULL, UTC_TIMESTAMP(3))', [businessId, plan.code]);
      await repo.rows(db, 'INSERT INTO business_migration_controls (business_id,state,actor_business_id,actor_user_id,created_at) VALUES (?,\'PENDING\',?,?,UTC_TIMESTAMP(3))', [businessId, String(auth.business_id), String(auth.user_id)]);
      await repo.audit(db, auth, 'CREATE_MIGRATION_TARGET', 'businesses', businessId, { name, status: 'INACTIVE', migrationState: 'PENDING', planCode: plan.code });
      const [created] = await repo.rows(db, 'SELECT id,name,status,created_at,\'PENDING\' AS migration_state,0 AS user_count FROM businesses WHERE id = ?', [businessId]);
      return { ...businessRecord(created), planCode: plan.code, planName: plan.name, includedUsers: plan.includedUsers };
    });
  }

  async function inspectExistingMigrationTarget(auth, businessId) {
    requireSystemAdmin(auth);
    return inspectMigrationTargetRecord(repo.pool, businessId);
  }

  async function prepareExistingMigrationTarget(auth, businessId, confirmed) {
    requireSystemAdmin(auth);
    if (confirmed !== true) throw httpError(409, 'MIGRATION_TARGET_CONFIRMATION_REQUIRED');
    return repo.transaction(async db => {
      const inspection = await inspectMigrationTargetRecord(db, businessId, true);
      if (!inspection.eligible) throw httpError(409, 'MIGRATION_TARGET_HAS_DATA');

      const wasActive = inspection.business.status === 'ACTIVE';
      if (wasActive) await repo.rows(db, 'UPDATE businesses SET status = \'INACTIVE\' WHERE id = ?', [businessId]);
      const authorizationsRemoved = await repo.rows(db, 'DELETE FROM session_authorizations WHERE business_id = ?', [businessId]);
      const sessionsRevoked = await repo.rows(db, 'UPDATE sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE business_id = ? AND revoked_at IS NULL', [businessId]);
      await repo.rows(db, 'INSERT INTO business_migration_controls (business_id,state,actor_business_id,actor_user_id,created_at) VALUES (?,\'PENDING\',?,?,UTC_TIMESTAMP(3))', [businessId, String(auth.business_id), String(auth.user_id)]);
      await repo.audit(db, auth, 'PREPARE_EXISTING_MIGRATION_TARGET', 'businesses', businessId, {
        businessId: String(businessId), previousStatus: inspection.business.status, status: 'INACTIVE', migrationState: 'PENDING',
        preserved: inspection.preserved, accessChanges: inspection.accessChanges, authorizationsRemoved: Number(authorizationsRemoved.affectedRows || 0), sessionsRevoked: Number(sessionsRevoked.affectedRows || 0)
      });
      const [updated] = await repo.rows(db,
        'SELECT b.id,b.name,b.status,b.created_at,\'PENDING\' AS migration_state,COUNT(u.id) AS user_count FROM businesses b LEFT JOIN users u ON u.business_id=b.id WHERE b.id=? GROUP BY b.id,b.name,b.status,b.created_at',
        [businessId]
      );
      return {
        business: businessRecord(updated),
        preserved: inspection.preserved,
        accessChanges: inspection.accessChanges,
        accessSuspended: true,
        sessionsRevoked: Number(sessionsRevoked.affectedRows || 0),
        authorizationsRemoved: Number(authorizationsRemoved.affectedRows || 0)
      };
    });
  }

  async function setBusinessStatus(auth, businessId, status) {
    requireSystemAdmin(auth);
    if (String(businessId) === '1' && status === 'INACTIVE') throw httpError(409, 'BUSINESS_PROTECTED');
    return repo.transaction(async db => {
      const [business] = await repo.rows(db, 'SELECT id, name, status, created_at FROM businesses WHERE id = ? FOR UPDATE', [businessId]);
      if (!business) throw httpError(404, 'BUSINESS_NOT_FOUND');
      if (status === 'ACTIVE' && await migrationState(db, businessId) === 'PENDING') throw httpError(409, 'MIGRATION_RECONCILIATION_REQUIRED');
      if (status === 'ACTIVE' && business.status !== 'ACTIVE') {
        const plan = await businessPlan(repo, db, businessId, { lock: true });
        assertWithinPlan(plan, await businessUserCounts(repo, db, businessId), 'BUSINESS_PLAN_ACTIVATION_BLOCKED');
      }
      if (business.status !== status) {
        await repo.rows(db, 'UPDATE businesses SET status = ? WHERE id = ?', [status, businessId]);
        if (status === 'INACTIVE') {
          await repo.rows(db, 'DELETE FROM session_authorizations WHERE business_id = ?', [businessId]);
          await repo.rows(db, 'UPDATE sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE business_id = ? AND revoked_at IS NULL', [businessId]);
        }
      }
      await repo.audit(db, auth, 'UPDATE_BUSINESS_STATUS', 'businesses', businessId, { businessId: String(businessId), status });
      const [updated] = await repo.rows(db, 'SELECT b.id, b.name, b.status, b.created_at, COUNT(u.id) AS user_count FROM businesses b LEFT JOIN users u ON u.business_id = b.id WHERE b.id = ? GROUP BY b.id, b.name, b.status, b.created_at', [businessId]);
      updated.migration_state = await migrationState(db, businessId);
      return businessRecord(updated);
    });
  }

  async function deleteBusiness(auth, businessId, confirmation, previewToken) {
    requireSystemAdmin(auth);
    if (confirmation !== 'ELIMINAR') throw httpError(400, 'BUSINESS_DELETE_CONFIRMATION_REQUIRED');
    const id = String(businessId);
    if (id === '1') throw httpError(409, 'BUSINESS_DELETE_PROTECTED');
    let result;
    try {
      result = await repo.transaction(async db => {
      const [business] = await repo.rows(db, 'SELECT id, name, status FROM businesses WHERE id = ? FOR UPDATE', [id]);
      if (!business) throw httpError(404, 'BUSINESS_NOT_FOUND');
      const plan = await businessDeletionPlan(db, id);
      const summary = await businessDeletionSummary(db, business, plan);
      if (typeof previewToken !== 'string' || !/^[a-f0-9]{64}$/.test(previewToken)) throw httpError(400, 'BUSINESS_DELETE_PREVIEW_REQUIRED');
      if (previewToken !== businessDeletionPreviewToken(summary)) throw httpError(409, 'BUSINESS_DELETE_PREVIEW_STALE');
      const billingArchive = await businessBillingArchive(db, business, plan);

      for (const foreignKey of plan.selfReferences) {
        const childColumns = foreignKey.columns.map(column => column.childColumn);
        const nullableRows = await repo.rows(db,
          'SELECT COLUMN_NAME AS columnName FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME IN (' + childColumns.map(() => '?').join(', ') + ') AND IS_NULLABLE=\'YES\'',
          [foreignKey.childTable, ...childColumns]);
        const nullableColumns = nullableRows.map(row => row.columnName);
        if (!nullableColumns.length) throw httpError(503, 'BUSINESS_DELETE_SCHEMA_UNSUPPORTED');
        await repo.rows(db, 'UPDATE ' + quoteIdentifier(foreignKey.childTable) + ' SET ' + nullableColumns.map(column => quoteIdentifier(column) + '=NULL').join(', ') + ' WHERE business_id = ?', [id]);
      }

      for (const table of plan.tables) {
        await repo.rows(db, 'DELETE FROM ' + quoteIdentifier(table) + ' WHERE business_id = ?', [id]);
      }
      await repo.audit(db, auth, 'DELETE_BUSINESS', 'businesses', id, {
        businessId: id,
        businessName: business.name,
        previousStatus: business.status,
        deletedRecordCounts: summary.counts,
        totalDeletedRecords: summary.totalRecords,
        revokedSessions: summary.sessions,
        retainedBillingRecords: billingArchive,
        filesMovedToRecoverableCleanup: summary.images.count
      });
      const deleted = await repo.rows(db, 'DELETE FROM businesses WHERE id = ?', [id]);
      if (Number(deleted.affectedRows) !== 1) throw httpError(409, 'BUSINESS_DELETE_BLOCKED');
      return { id, name: business.name, counts: summary.counts, totalDeletedRecords: summary.totalRecords, revokedSessions: summary.sessions };
      });
    } catch (error) {
      if (error.code === 'ER_ROW_IS_REFERENCED_2' || error.errno === 1451) throw httpError(409, 'BUSINESS_DELETE_BLOCKED');
      throw error;
    }
    let filesPendingCleanup = false;
    if (typeof options.imageStore?.removeBusinessFiles === 'function') {
      try { filesPendingCleanup = !(await options.imageStore.removeBusinessFiles(id)); }
      catch { filesPendingCleanup = true; }
    }
    return { ...result, filesPendingCleanup };
  }

  async function listBusinessUsers(auth, businessId) {
    requireSystemAdmin(auth);
    const [business] = await repo.rows(repo.pool, 'SELECT id FROM businesses WHERE id = ?', [businessId]);
    if (!business) throw httpError(404, 'BUSINESS_NOT_FOUND');
    const users = await repo.rows(repo.pool, 'SELECT id, business_id, username, full_name, role, active FROM users WHERE business_id = ? ORDER BY id', [businessId]);
    return users.map(publicUser);
  }

  async function businessUserCapacity(auth, businessId) {
    requireSystemAdmin(auth);
    const [business] = await repo.rows(repo.pool, 'SELECT id FROM businesses WHERE id = ?', [businessId]);
    if (!business) throw httpError(404, 'BUSINESS_NOT_FOUND');
    const plan = await businessPlan(repo, repo.pool, businessId, { required: false });
    return { businessId: String(businessId), ...capacityView(plan, await businessUserCounts(repo, repo.pool, businessId)) };
  }

  async function createBusinessUser(auth, businessId, input) {
    requireSystemAdmin(auth);
    const passwordHash = await hashPassword(input.password);
    return repo.transaction(async db => {
      const [business] = await repo.rows(db, 'SELECT id FROM businesses WHERE id = ? FOR UPDATE', [businessId]);
      if (!business) throw httpError(404, 'BUSINESS_NOT_FOUND');
      const duplicate = await repo.rows(db, 'SELECT id FROM users WHERE username = ? LIMIT 1 FOR UPDATE', [input.username]);
      if (duplicate.length) throw httpError(409, 'USERNAME_EXISTS');
      const plan = await businessPlan(repo, db, businessId, { lock: true });
      assertUserAddition(plan, await businessUserCounts(repo, db, businessId), { role: input.role, businessId, username: input.username });
      let result;
      try {
        result = await repo.rows(db, 'INSERT INTO users (business_id, username, full_name, password_hash, role, active) VALUES (?, ?, ?, ?, ?, TRUE)', [businessId, input.username, input.fullName, passwordHash, input.role]);
      } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') throw httpError(409, 'USERNAME_EXISTS');
        throw error;
      }
      const user = publicUser({ id: result.insertId, business_id: businessId, username: input.username, full_name: input.fullName, role: input.role, active: true });
      await repo.audit(db, auth, 'CREATE_BUSINESS_USER', 'users', result.insertId, { businessId: String(businessId), role: input.role });
      return user;
    });
  }

  async function setUserStatus(auth, userId, active) {
    requireSystemAdmin(auth);
    return repo.transaction(async db => {
      const [identity] = await repo.rows(db, 'SELECT id, business_id FROM users WHERE id = ?', [userId]);
      if (!identity) throw httpError(404, 'USER_NOT_FOUND');
      const [business] = await repo.rows(db, 'SELECT id FROM businesses WHERE id = ? FOR UPDATE', [identity.business_id]);
      if (!business) throw httpError(404, 'USER_NOT_FOUND');
      const [user] = await repo.rows(db, 'SELECT id, business_id, username, full_name, role, active FROM users WHERE business_id = ? AND id = ? FOR UPDATE', [identity.business_id, userId]);
      if (!user) throw httpError(404, 'USER_NOT_FOUND');
      if (!active && user.username === 'andres' && user.role === 'ADMIN' && String(user.business_id) === '1') throw httpError(409, 'SYSTEM_ADMIN_PROTECTED');
      if (Boolean(user.active) !== active) {
        if (active) {
          const plan = await businessPlan(repo, db, user.business_id, { lock: true });
          assertUserAddition(plan, await businessUserCounts(repo, db, user.business_id), { role: user.role, active, businessId: user.business_id, username: user.username });
        }
        if (user.role === 'ADMIN' && user.active && !active) {
          const admins = await repo.rows(db, 'SELECT id FROM users WHERE business_id = ? AND role = \'ADMIN\' AND active = TRUE FOR UPDATE', [user.business_id]);
          if (admins.length <= 1) throw httpError(409, 'LAST_ACTIVE_ADMIN');
        }
        await repo.rows(db, 'UPDATE users SET active = ? WHERE business_id = ? AND id = ?', [active, user.business_id, userId]);
        await repo.revokeUser(db, user.business_id, userId);
      }
      await repo.audit(db, auth, 'UPDATE_BUSINESS_USER_STATUS', 'users', userId, { businessId: String(user.business_id), active });
      return publicUser({ ...user, active });
    });
  }

  async function startSupportSession(auth, businessId, metadata) {
    requireSystemAdmin(auth);
    if (String(businessId) === '1') throw httpError(409, 'SUPPORT_TARGET_INVALID');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    const tokenHash = hashToken(randomToken());
    return repo.transaction(async db => {
      const [business] = await repo.rows(db, 'SELECT id, name, status FROM businesses WHERE id = ? FOR UPDATE', [businessId]);
      if (!business) throw httpError(404, 'BUSINESS_NOT_FOUND');
      if (business.status !== 'ACTIVE') throw httpError(409, 'SUPPORT_BUSINESS_UNAVAILABLE');
      const [target] = await repo.rows(db, 'SELECT u.id AS user_id, u.business_id, u.username, u.full_name, u.role, u.active, b.name AS business_name, b.status AS business_status FROM users u JOIN businesses b ON b.id = u.business_id WHERE u.business_id = ? AND u.role = \'ADMIN\' AND u.active = TRUE AND b.status = \'ACTIVE\' ORDER BY u.id LIMIT 1 FOR UPDATE', [businessId]);
      if (!target) throw httpError(409, 'SUPPORT_ADMIN_REQUIRED');
      const supportSession = await repo.rows(db, 'INSERT INTO sessions (business_id, user_id, token_hash, expires_at, created_at, ip_address, user_agent) VALUES (?, ?, ?, ?, UTC_TIMESTAMP(3), ?, ?)', [businessId, target.user_id, tokenHash, expiresAt, metadata.ip, metadata.agent]);
      await repo.audit(db, auth, 'START_SUPPORT_SESSION', 'businesses', businessId, { businessId: String(businessId), businessName: business.name, expiresAt: expiresAt.toISOString() });
      return { businessId: String(business.id), businessName: business.name, expiresAt, user: publicUser(target), supportSession: { session_id: String(supportSession.insertId), token_hash: tokenHash } };
    });
  }

  async function endSupportSession(auth, claims) {
    requireSystemAdmin(auth);
    if (!claims) return;
    await repo.transaction(async db => {
      await repo.rows(db, 'UPDATE sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE business_id = ? AND id = ? AND token_hash = ? AND revoked_at IS NULL', [claims.businessId, claims.supportSessionId, claims.supportTokenHash]);
      await repo.audit(db, auth, 'END_SUPPORT_SESSION', 'businesses', claims.businessId, { businessId: String(claims.businessId), supportSessionId: String(claims.supportSessionId) });
    });
  }

  return {
    isSystemAdmin, listBusinesses, listBilling, setBusinessPlan, listSubscriptionPayments, recordSubscriptionPayment,
    createBusiness, createMigrationTarget, inspectExistingMigrationTarget, prepareExistingMigrationTarget, setBusinessStatus, previewBusinessDeletion, deleteBusiness, listBusinessUsers, businessUserCapacity, createBusinessUser, setUserStatus,
    startSupportSession, endSupportSession, migrateBasic,
    previewInventoryMigration: inventoryMigration.preview,
    migrateInventory: inventoryMigration.migrate,
    previewCreditMigration: creditMigration.preview,
    migrateCreditMigration: creditMigration.migrate,
    previewSalesMigration: salesMigration.preview,
    migrateSales: salesMigration.migrate,
    previewPurchasesMigration: purchasesMigration.preview,
    migratePurchases: purchasesMigration.migrate,
    previewFullMigration: migrationArchive.preview,
    archiveFullMigration: migrationArchive.archive,
    reviewMigrationIdentityRecord: migrationArchive.reviewIdentityRecord,
    migrationBatchStatus: migrationArchive.status,
    migrationBatchRecords: migrationArchive.listRecords,
    projectMigrationCatalog: migrationProjection.projectCatalog,
    projectMigrationOperations: migrationOperations.project
  };
}

module.exports = { createSystemAdminService, isSystemAdmin, requireSystemAdmin };
