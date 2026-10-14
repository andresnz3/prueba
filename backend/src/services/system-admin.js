'use strict';
const { hashPassword } = require('./passwords');
const { randomToken, hashToken } = require('./tokens');
const { publicUser } = require('../repositories/auth');
const { httpError } = require('../middleware/errors');
const billingValues = require('./system-admin-billing-values');
const { packageForImport, normalizeName } = require('./basic-migration-values');
const { createSystemAdminInventoryMigration } = require('./system-admin-inventory-migration');
const { randomUUID } = require('node:crypto');

const isSystemAdmin = auth => auth?.username === 'andres' && auth.role === 'ADMIN' && String(auth.business_id) === '1';
const requireSystemAdmin = auth => { if (!isSystemAdmin(auth)) throw httpError(403, 'SYSTEM_ADMIN_REQUIRED'); };
const businessRecord = row => ({ id: String(row.id), name: row.name, status: row.status, createdAt: row.created_at, userCount: Number(row.user_count || 0) });
const operationalTables = [
  'products', 'clients', 'suppliers', 'sales', 'sale_items', 'purchases', 'purchase_items',
  'cash_sessions', 'cash_movements', 'inventory_movements', 'audit_logs', 'sale_orders',
  'sale_order_items', 'customer_payments', 'supplier_payments', 'expenses', 'document_sequences',
  'pos_operations'
];
const removableConfigurationTables = ['business_settings'];
const PLAN_CATALOG = Object.freeze([
  Object.freeze({ code: 'LOCAL', name: 'Local (pago único)', billingType: 'Pago único', monthly: false, reminders: false, includedUsers: 1 }),
  Object.freeze({ code: 'CONECTADO_BASICO', name: 'Conectado Básico', billingType: 'Mensual', monthly: true, reminders: true, includedUsers: 2 }),
  Object.freeze({ code: 'CONECTADO_PREMIUM', name: 'Conectado Premium', billingType: 'Mensual', monthly: true, reminders: true, includedUsers: 10 })
]);
const planByCode = new Map(PLAN_CATALOG.map(plan => [plan.code, plan]));

function createSystemAdminService(repo) {
  const inventoryMigration = createSystemAdminInventoryMigration({ repo, requireSystemAdmin });
  async function assertBillingTables() {
    const rows = await repo.rows(repo.pool, 'SELECT TABLE_NAME AS tableName FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?, ?)', ['business_subscriptions', 'business_subscription_payments']);
    if (rows.length !== 2) throw httpError(503, 'SYSTEM_ADMIN_BILLING_MIGRATION_REQUIRED');
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
      id: String(row.id), name: row.name, status: row.status, userCount: Number(row.user_count || 0),
      planCode: plan?.code || null, planName: plan?.name || 'Sin asignar', monthly: Boolean(plan?.monthly),
      includedUsers: plan?.includedUsers ?? null, nextDueDate, daysUntilDue, paymentStatus,
      lastPayment: row.last_payment_date ? { date: billingValues.dateOnly(row.last_payment_date), amount: String(row.last_payment_amount) } : null
    };
  }

  async function listBilling(auth) {
    requireSystemAdmin(auth);
    await assertBillingTables();
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const soon = 7;
    const businesses = await repo.rows(repo.pool,
      `SELECT b.id, b.name, b.status, COUNT(DISTINCT u.id) AS user_count,
        s.plan_code, s.next_due_date,
        (SELECT p.payment_date FROM business_subscription_payments p WHERE p.business_id = b.id ORDER BY p.payment_date DESC, p.id DESC LIMIT 1) AS last_payment_date,
        (SELECT p.amount FROM business_subscription_payments p WHERE p.business_id = b.id ORDER BY p.payment_date DESC, p.id DESC LIMIT 1) AS last_payment_amount
       FROM businesses b
       LEFT JOIN users u ON u.business_id = b.id
       LEFT JOIN business_subscriptions s ON s.business_id = b.id
       GROUP BY b.id, b.name, b.status, s.plan_code, s.next_due_date
       ORDER BY b.id`, []);
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
    const businesses = await repo.rows(repo.pool, 'SELECT b.id, b.name, b.status, b.created_at, COUNT(u.id) AS user_count FROM businesses b LEFT JOIN users u ON u.business_id = b.id GROUP BY b.id, b.name, b.status, b.created_at ORDER BY b.id', []);
    return businesses.map(businessRecord);
  }

  async function createBusiness(auth, name) {
    requireSystemAdmin(auth);
    return repo.transaction(async db => {
      const result = await repo.rows(db, 'INSERT INTO businesses (name, status) VALUES (?, \'ACTIVE\')', [name]);
      const [created] = await repo.rows(db, 'SELECT id, name, status, created_at, 0 AS user_count FROM businesses WHERE id = ?', [String(result.insertId)]);
      await repo.audit(db, auth, 'CREATE_BUSINESS', 'businesses', result.insertId, {});
      return businessRecord(created);
    });
  }

  async function setBusinessStatus(auth, businessId, status) {
    requireSystemAdmin(auth);
    if (String(businessId) === '1' && status === 'INACTIVE') throw httpError(409, 'BUSINESS_PROTECTED');
    return repo.transaction(async db => {
      const [business] = await repo.rows(db, 'SELECT id, name, status, created_at FROM businesses WHERE id = ? FOR UPDATE', [businessId]);
      if (!business) throw httpError(404, 'BUSINESS_NOT_FOUND');
      if (business.status !== status) {
        await repo.rows(db, 'UPDATE businesses SET status = ? WHERE id = ?', [status, businessId]);
        if (status === 'INACTIVE') {
          await repo.rows(db, 'DELETE FROM session_authorizations WHERE business_id = ?', [businessId]);
          await repo.rows(db, 'UPDATE sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE business_id = ? AND revoked_at IS NULL', [businessId]);
        }
      }
      await repo.audit(db, auth, 'UPDATE_BUSINESS_STATUS', 'businesses', businessId, { businessId: String(businessId), status });
      const [updated] = await repo.rows(db, 'SELECT b.id, b.name, b.status, b.created_at, COUNT(u.id) AS user_count FROM businesses b LEFT JOIN users u ON u.business_id = b.id WHERE b.id = ? GROUP BY b.id, b.name, b.status, b.created_at', [businessId]);
      return businessRecord(updated);
    });
  }

  async function deleteBusiness(auth, businessId, confirmation) {
    requireSystemAdmin(auth);
    if (confirmation !== 'ELIMINAR') throw httpError(400, 'BUSINESS_DELETE_CONFIRMATION_REQUIRED');
    const id = String(businessId);
    if (id === '1') throw httpError(409, 'BUSINESS_DELETE_PROTECTED');
    try {
      return await repo.transaction(async db => {
        const [business] = await repo.rows(db, 'SELECT id, name FROM businesses WHERE id = ? FOR UPDATE', [id]);
        if (!business) throw httpError(404, 'BUSINESS_NOT_FOUND');

        const tablesToFind = [...operationalTables, ...removableConfigurationTables];
        const installed = await repo.rows(db,
          'SELECT TABLE_NAME AS tableName FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (' + tablesToFind.map(() => '?').join(', ') + ')',
          tablesToFind
        );
        const installedTables = new Set(installed.map(row => row.tableName));
        for (const table of operationalTables) {
          if (!installedTables.has(table)) continue;
          const [record] = await repo.rows(db, 'SELECT 1 AS present FROM `' + table + '` WHERE business_id = ? LIMIT 1', [id]);
          if (record) throw httpError(409, 'BUSINESS_HAS_DATA');
        }

        await repo.rows(db, 'DELETE FROM session_authorizations WHERE business_id = ?', [id]);
        await repo.rows(db, 'DELETE FROM sessions WHERE business_id = ?', [id]);
        if (installedTables.has('business_settings')) await repo.rows(db, 'DELETE FROM business_settings WHERE business_id = ?', [id]);
        await repo.rows(db, 'DELETE FROM users WHERE business_id = ?', [id]);
        await repo.audit(db, auth, 'DELETE_BUSINESS', 'businesses', id, { businessName: business.name });
        await repo.rows(db, 'DELETE FROM businesses WHERE id = ?', [id]);
        return { id, name: business.name };
      });
    } catch (error) {
      if (error.code === 'ER_ROW_IS_REFERENCED_2' || error.errno === 1451) throw httpError(409, 'BUSINESS_HAS_DATA');
      throw error;
    }
  }

  async function listBusinessUsers(auth, businessId) {
    requireSystemAdmin(auth);
    const [business] = await repo.rows(repo.pool, 'SELECT id FROM businesses WHERE id = ?', [businessId]);
    if (!business) throw httpError(404, 'BUSINESS_NOT_FOUND');
    const users = await repo.rows(repo.pool, 'SELECT id, business_id, username, full_name, role, active FROM users WHERE business_id = ? ORDER BY id', [businessId]);
    return users.map(publicUser);
  }

  async function createBusinessUser(auth, businessId, input) {
    requireSystemAdmin(auth);
    const passwordHash = await hashPassword(input.password);
    return repo.transaction(async db => {
      const [business] = await repo.rows(db, 'SELECT id FROM businesses WHERE id = ? FOR UPDATE', [businessId]);
      if (!business) throw httpError(404, 'BUSINESS_NOT_FOUND');
      const duplicate = await repo.rows(db, 'SELECT id FROM users WHERE username = ? LIMIT 1 FOR UPDATE', [input.username]);
      if (duplicate.length) throw httpError(409, 'USERNAME_EXISTS');
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
      const [user] = await repo.rows(db, 'SELECT id, business_id, username, full_name, role, active FROM users WHERE id = ? FOR UPDATE', [userId]);
      if (!user) throw httpError(404, 'USER_NOT_FOUND');
      if (!active && user.username === 'andres' && user.role === 'ADMIN' && String(user.business_id) === '1') throw httpError(409, 'SYSTEM_ADMIN_PROTECTED');
      if (Boolean(user.active) !== active) {
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
    createBusiness, setBusinessStatus, deleteBusiness, listBusinessUsers, createBusinessUser, setUserStatus,
    startSupportSession, endSupportSession, migrateBasic,
    previewInventoryMigration: inventoryMigration.preview,
    migrateInventory: inventoryMigration.migrate
  };
}

module.exports = { createSystemAdminService, isSystemAdmin, requireSystemAdmin };
