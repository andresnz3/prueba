'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const fs = require('node:fs/promises');
const { join } = require('node:path');
const { readConfig } = require('../../src/config/environment');
const { readAuthConfig } = require('../../src/config/auth');
const { createDatabasePool } = require('../../src/config/database');
const { createAuthService } = require('../../src/services/auth');
const { createUsersService } = require('../../src/services/users');
const { hashPassword } = require('../../src/services/passwords');
const { hashToken } = require('../../src/services/tokens');
const { createApp } = require('../../src/app');
const { imageDirectory, removeImages } = require('../helpers/image-fixtures.cjs');

const database = process.env.POS_INTEGRATION_DATABASE;
if (!/^pos_auth_test_[a-f0-9]{24}$/.test(database || '') || database === process.env.DB_NAME) throw new Error('Use the isolated MySQL runner');

function apiClient(base) {
  const cookies = new Map();
  let csrf;
  async function request(path, method = 'GET', body) {
    const headers = { Cookie: [...cookies].map(([name, value]) => name + '=' + value).join('; ') };
    const options = { method, headers };
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      if (csrf) headers['X-CSRF-Token'] = csrf;
      options.body = JSON.stringify(body ?? {});
    }
    const response = await fetch(base + '/api' + path, options);
    const setCookies = response.headers.getSetCookie?.() || [response.headers.get('set-cookie')].filter(Boolean);
    for (const value of setCookies) {
      const first = value.split(';')[0], index = first.indexOf('=');
      if (index >= 0) cookies.set(first.slice(0, index), first.slice(index + 1));
    }
    const data = response.status === 204 ? undefined : await response.json();
    if (data?.csrfToken) csrf = data.csrfToken;
    return { status: response.status, data, response, cookies };
  }
  async function login(username, password) {
    assert.equal((await request('/auth/csrf')).status, 200);
    return request('/auth/login', 'POST', { username, password });
  }
  return { request, login };
}

test('system admin can permanently delete a tenant atomically while preserving the system and other tenants', async t => {
  const baseConfig = readConfig();
  const imageRoot = await imageDirectory();
  const config = { ...baseConfig, images: { ...baseConfig.images, root: imageRoot } };
  const pool = createDatabasePool({ ...config.database, database, connectionLimit: 8 });
  const authConfig = readAuthConfig({ CSRF_SECRET: randomBytes(32).toString('hex'), AUTH_RATE_MAX: '100' });
  const repo = require('../../src/repositories/auth').createAuthRepository(pool, authConfig);
  let server;
  t.after(async () => {
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await pool.end();
    await removeImages(imageRoot);
  });

  const systemPassword = 'Deletion-system-password-123!';
  const tenantPassword = 'Deletion-tenant-password-123!';
  const systemBusiness = String((await pool.execute("INSERT INTO businesses (name,status) VALUES ('System business','ACTIVE')"))[0].insertId);
  assert.equal(systemBusiness, '1');
  const systemHash = await hashPassword(systemPassword);
  const [systemUserResult] = await pool.execute('INSERT INTO users (business_id,username,full_name,password_hash,role) VALUES (?,?,?,?,?)', [systemBusiness, 'andres', 'System administrator', systemHash, 'ADMIN']);
  const systemUser = String(systemUserResult.insertId);
  const target = String((await pool.execute("INSERT INTO businesses (name,status) VALUES ('Tenant to delete','ACTIVE')"))[0].insertId);
  const targetHash = await hashPassword(tenantPassword);
  const [targetUserResult] = await pool.execute('INSERT INTO users (business_id,username,full_name,password_hash,role) VALUES (?,?,?,?,?)', [target, 'tenantadmin', 'Tenant administrator', targetHash, 'ADMIN']);
  const targetUser = String(targetUserResult.insertId);
  const other = String((await pool.execute("INSERT INTO businesses (name,status) VALUES ('Independent tenant','ACTIVE')"))[0].insertId);
  const [otherUserResult] = await pool.execute('INSERT INTO users (business_id,username,full_name,password_hash,role) VALUES (?,?,?,?,?)', [other, 'independentadmin', 'Independent administrator', systemHash, 'ADMIN']);
  const otherUser = String(otherUserResult.insertId);

  const [productResult] = await pool.execute('INSERT INTO products (business_id,barcode,name,category,cost,retail_price,stock) VALUES (?,?,?,?,?,?,?)', [target, 'DEL-' + randomUUID().slice(0, 12), 'Tenant product', 'General', '2.00', '5.00', '4.000']);
  const productId = String(productResult.insertId);
  const [clientResult] = await pool.execute('INSERT INTO clients (business_id,name,credit_limit) VALUES (?,?,?)', [target, 'Tenant client', '100.00']);
  const clientId = String(clientResult.insertId);
  const [supplierResult] = await pool.execute('INSERT INTO suppliers (business_id,name) VALUES (?,?)', [target, 'Tenant supplier']);
  const supplierId = String(supplierResult.insertId);
  const [cashResult] = await pool.execute('INSERT INTO cash_sessions (business_id,opened_by,opening_amount,status) VALUES (?,?,?,?)', [target, targetUser, '20.00', 'OPEN']);
  const cashId = String(cashResult.insertId);
  const [saleResult] = await pool.execute("INSERT INTO sales (business_id,user_id,client_id,cash_session_id,invoice_number,sale_type,payment_method,subtotal,total,status) VALUES (?,?,?,?,?,'CASH','CASH','5.00','5.00','COMPLETED')", [target, targetUser, clientId, cashId, 'DEL-SALE']);
  const saleId = String(saleResult.insertId);
  await pool.execute('INSERT INTO sale_items (business_id,sale_id,product_id,product_name,quantity,unit_price,subtotal,total,cost_at_sale) VALUES (?,?,?,?,?,?,?,?,?)', [target, saleId, productId, 'Tenant product', '1.000', '5.00', '5.00', '5.00', '2.00']);
  const [purchaseResult] = await pool.execute("INSERT INTO purchases (business_id,user_id,supplier_id,supplier_name,invoice_number,purchase_type,subtotal,total,status) VALUES (?,?,?,?,?,'CASH','2.00','2.00','COMPLETED')", [target, targetUser, supplierId, 'Tenant supplier', 'DEL-PURCHASE']);
  const purchaseId = String(purchaseResult.insertId);
  await pool.execute('INSERT INTO purchase_items (business_id,purchase_id,product_id,product_name,quantity,unit_cost,subtotal,total) VALUES (?,?,?,?,?,?,?,?)', [target, purchaseId, productId, 'Tenant product', '1.000', '2.00', '2.00', '2.00']);
  const [customerPaymentResult] = await pool.execute("INSERT INTO customer_payments (business_id,user_id,client_id,amount,payment_method,status) VALUES (?,?,?,'1.00','CASH','POSTED')", [target, targetUser, clientId]);
  const customerPaymentId = String(customerPaymentResult.insertId);
  const [supplierPaymentResult] = await pool.execute("INSERT INTO supplier_payments (business_id,user_id,supplier_id,amount,payment_method,status) VALUES (?,?,?,'1.00','TRANSFER','POSTED')", [target, targetUser, supplierId]);
  const supplierPaymentId = String(supplierPaymentResult.insertId);
  await pool.execute("INSERT INTO expenses (business_id,user_id,cash_session_id,description,category,amount,payment_method,status) VALUES (?,?,?,'Tenant expense','Services','1.00','CASH','POSTED')", [target, targetUser, cashId]);
  await pool.execute("INSERT INTO inventory_movements (business_id,product_id,user_id,type,quantity,stock_after,unit_cost) VALUES (?,?,?,'ADJUSTMENT','-1.000','3.000','2.00')", [target, productId, targetUser]);
  const [cashMovementResult] = await pool.execute("INSERT INTO cash_movements (business_id,cash_session_id,user_id,type,direction,amount,supplier_payment_id,description,status) VALUES (?,?,?,'SUPPLIER_PAYMENT','OUT','1.00',?,'Tenant supplier payment','CONFIRMED')", [target, cashId, targetUser, supplierPaymentId]);
  const cashMovementId = String(cashMovementResult.insertId);
  await pool.execute("INSERT INTO cash_movements (business_id,cash_session_id,user_id,type,direction,amount,reversal_of_movement_id,description,status) VALUES (?,?,?,'REVERSAL','IN','1.00',?,'Tenant reversal','CONFIRMED')", [target, cashId, targetUser, cashMovementId]);
  await pool.execute("INSERT INTO audit_logs (business_id,user_id,action,entity,entity_id,details) VALUES (?,?,'CREATE','sales',?,'{}')", [target, targetUser, saleId]);
  await pool.execute('INSERT INTO business_settings (business_id,business_name,ruc) VALUES (?,?,?)', [target, 'Tenant to delete', 'RUC-DELETE']);
  await pool.execute("INSERT INTO document_sequences (business_id,document_type,prefix,current_number) VALUES (?,'SALE','V-',28)", [target]);
  await pool.execute('INSERT INTO pos_operations (business_id,operation_key,user_id,kind,request_hash,result) VALUES (?,?,?,?,?,?)', [target, randomUUID(), targetUser, 'SALE', randomBytes(32).toString('hex'), JSON.stringify({ saleId })]);
  const [orderResult] = await pool.execute("INSERT INTO sale_orders (business_id,created_by_user_id,status,price_type,discount_percent,estimated_subtotal,estimated_discount,estimated_total,detail) VALUES (?,?,'PENDING','RETAIL','0.0000','5.00','0.00','5.00','Pending order')", [target, targetUser]);
  const orderId = String(orderResult.insertId);
  await pool.execute('INSERT INTO sale_order_items (business_id,order_id,line_number,product_id,product_name,quantity,estimated_unit_price,estimated_subtotal) VALUES (?,?,1,?,?,\'1.000\',\'5.00\',\'5.00\')', [target, orderId, productId, 'Tenant product']);
  await pool.execute("INSERT INTO business_subscriptions (business_id,plan_code,next_due_date) VALUES (?,'CONECTADO_BASICO','2030-01-01')", [target]);
  await pool.execute("INSERT INTO business_subscription_payments (business_id,amount,payment_date,created_by_user_id) VALUES (?,'29.50','2026-10-01',?)", [target, systemUser]);

  const batchId = randomUUID();
  const sourceKey = 'a'.repeat(64), fingerprint = 'b'.repeat(64), paymentKey = 'c'.repeat(64);
  await pool.execute("INSERT INTO migration_import_batches (id,business_id,source_business_key,source_business_name,package_sha256,package_version,status,actor_business_id,actor_user_id,manifest,stage_results) VALUES (?,?,?,'Legacy tenant',?,2,'BLOCKED',?,?, '{}','{}')", [batchId, target, sourceKey, fingerprint, systemBusiness, systemUser]);
  await pool.execute("INSERT INTO migration_source_records (business_id,batch_id,entity_type,source_record_key,source_fingerprint,record_status,source_payload) VALUES (?,?, 'products','local-product',?,'PROJECTED','{}')", [target, batchId, fingerprint]);
  await pool.execute("INSERT INTO migration_sales_references (business_id,source_business_key,source_sale_key,fingerprint,sale_id) VALUES (?,?,?, ?,?)", [target, sourceKey, 'd'.repeat(64), fingerprint, saleId]);
  await pool.execute("INSERT INTO migration_purchase_references (business_id,source_business_key,source_purchase_key,fingerprint,purchase_id) VALUES (?,?,?, ?,?)", [target, sourceKey, 'e'.repeat(64), fingerprint, purchaseId]);
  await pool.execute("INSERT INTO migration_credit_payment_references (business_id,source_business_key,source_payment_key,source_payment_id,source_client_id,source_sale_key,fingerprint,customer_payment_id,created_at) VALUES (?,?,?,'local-payment',? ,?, ?,?,UTC_TIMESTAMP(3))", [target, sourceKey, paymentKey, clientId, 'd'.repeat(64), fingerprint, customerPaymentId]);
  await pool.execute("INSERT INTO migration_supplier_payment_references (business_id,source_business_key,source_payment_key,source_payment_id,fingerprint,supplier_payment_id) VALUES (?,?,?,'local-supplier-payment',?,?)", [target, sourceKey, 'f'.repeat(64), fingerprint, supplierPaymentId]);
  await pool.execute("INSERT INTO migration_zero_inventory_events (business_id,batch_id,source_record_key,product_id,source_type,quantity,source_payload,occurred_at) VALUES (?,?,?,?,'INITIAL',0,'{}',UTC_TIMESTAMP(3))", [target, batchId, 'legacy-zero-event', productId]);

  const otherProduct = await pool.execute('INSERT INTO products (business_id,barcode,name,category,cost,retail_price,stock) VALUES (?,?,?,?,?,?,?)', [other, 'KEEP-' + randomUUID().slice(0, 12), 'Independent product', 'General', '3.00', '8.00', '7.000']);
  const otherProductId = String(otherProduct[0].insertId);
  await pool.execute('INSERT INTO inventory_movements (business_id,product_id,user_id,type,quantity,stock_after,unit_cost) VALUES (?,?,? ,\'ADJUSTMENT\',\'2.000\',\'7.000\',\'3.00\')', [other, otherProductId, otherUser]);

  const targetToken = randomBytes(32).toString('base64url');
  await pool.execute('INSERT INTO sessions (business_id,user_id,token_hash,expires_at,created_at,ip_address,user_agent) VALUES (?,?,?,TIMESTAMPADD(HOUR,1,UTC_TIMESTAMP(3)),UTC_TIMESTAMP(3),?,?)', [target, targetUser, hashToken(targetToken), '127.0.0.1', 'deletion integration']);
  const [[targetSession]] = await pool.execute('SELECT id FROM sessions WHERE business_id=? AND user_id=?', [target, targetUser]);
  await pool.execute("INSERT INTO session_authorizations (business_id,session_id,module,expires_at) VALUES (?,?,'reports',TIMESTAMPADD(MINUTE,5,UTC_TIMESTAMP(3)))", [target, targetSession.id]);
  assert.ok(await repo.session(hashToken(targetToken)), 'The tenant session exists and is valid before it is locked for migration');
  await pool.execute('UPDATE businesses SET status=\'INACTIVE\' WHERE id=?', [target]);
  await pool.execute('INSERT INTO business_migration_controls (business_id,state,source_business_key,batch_id,actor_business_id,actor_user_id) VALUES (?,\'PENDING\',?,?,?,?)', [target, sourceKey, batchId, systemBusiness, systemUser]);

  await fs.mkdir(join(imageRoot, target), { recursive: true });
  await fs.writeFile(join(imageRoot, target, '0123456789abcdef0123456789abcdef.jpg'), Buffer.from('tenant image fixture'));

  const scopedTables = await repo.rows(pool, 'SELECT DISTINCT TABLE_NAME AS tableName FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND COLUMN_NAME=\'business_id\' ORDER BY TABLE_NAME', []);
  const otherSnapshot = new Map();

  const app = createApp({ config, checkDatabase: async () => {}, authentication: { repo, config: authConfig, auth: createAuthService(repo, authConfig), users: createUsersService(repo) } });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const admin = apiClient(base);
  assert.equal((await admin.login('andres', systemPassword)).status, 200);
  const externalBatchId = randomUUID();
  await pool.execute("INSERT INTO migration_import_batches (id,business_id,source_business_key,source_business_name,package_sha256,package_version,status,actor_business_id,actor_user_id,manifest,stage_results) VALUES (?,?,?,'Independent migration actor',?,2,'BLOCKED',?,?, '{}','{}')", [externalBatchId, other, '9'.repeat(64), '8'.repeat(64), target, targetUser]);
  const blockedBySharedReference = await admin.request('/admin/businesses/' + target + '/deletion-preview');
  assert.equal(blockedBySharedReference.status, 409);
  assert.equal(blockedBySharedReference.data.error.code, 'BUSINESS_DELETE_BLOCKED');
  const [[unchangedTarget]] = await pool.execute('SELECT (SELECT COUNT(*) FROM businesses WHERE id=?) AS business,(SELECT COUNT(*) FROM products WHERE business_id=?) AS products', [target, target]);
  assert.deepEqual([Number(unchangedTarget.business), Number(unchangedTarget.products)], [1, 1]);
  await pool.execute('UPDATE migration_import_batches SET actor_business_id=?,actor_user_id=? WHERE id=? AND business_id=?', [systemBusiness, systemUser, externalBatchId, other]);
  for (const { tableName } of scopedTables) {
    const [records] = await pool.execute('SELECT * FROM `' + tableName + '` WHERE business_id=?', [other]);
    otherSnapshot.set(tableName, records.map(record => JSON.stringify(record)).sort());
  }
  const protectedAttempt = await admin.request('/admin/businesses/1', 'DELETE', { confirmation: 'ELIMINAR' });
  assert.equal(protectedAttempt.status, 409);
  assert.equal(protectedAttempt.data.error.code, 'BUSINESS_DELETE_PROTECTED');
  const protectedPreview = await admin.request('/admin/businesses/1/deletion-preview');
  assert.equal(protectedPreview.status, 409);
  assert.equal(protectedPreview.data.error.code, 'BUSINESS_DELETE_PROTECTED');

  const preview = await admin.request('/admin/businesses/' + target + '/deletion-preview');
  assert.equal(preview.status, 200);
  assert.equal(preview.data.business.id, target);
  assert.equal(preview.data.business.name, 'Tenant to delete');
  assert.equal(preview.data.images.count, 1);
  assert.ok(preview.data.counts.some(item => item.table === 'migration_source_records' && item.count === 1));
  assert.ok(preview.data.counts.some(item => item.table === 'sale_items' && item.count === 1));
  const noPreviewToken = await admin.request('/admin/businesses/' + target, 'DELETE', { confirmation: 'ELIMINAR' });
  assert.equal(noPreviewToken.status, 400);
  assert.equal(noPreviewToken.data.error.code, 'BUSINESS_DELETE_PREVIEW_REQUIRED');
  await pool.execute('INSERT INTO products (business_id,barcode,name,category) VALUES (?,?,?,?)', [target, 'LATE-' + randomUUID().slice(0, 12), 'Added after preview', 'General']);
  const stalePreview = await admin.request('/admin/businesses/' + target, 'DELETE', { confirmation: 'ELIMINAR', previewToken: preview.data.previewToken });
  assert.equal(stalePreview.status, 409);
  assert.equal(stalePreview.data.error.code, 'BUSINESS_DELETE_PREVIEW_STALE');
  const freshPreview = await admin.request('/admin/businesses/' + target + '/deletion-preview');
  assert.ok(freshPreview.data.counts.some(item => item.table === 'products' && item.count === 2));

  await pool.query("CREATE TRIGGER fail_business_delete BEFORE DELETE ON products FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected deletion failure'");
  const failed = await admin.request('/admin/businesses/' + target, 'DELETE', { confirmation: 'ELIMINAR', previewToken: freshPreview.data.previewToken });
  assert.equal(failed.status, 500);
  const [stillPresent] = await pool.execute('SELECT COUNT(*) AS businesses,(SELECT COUNT(*) FROM products WHERE business_id=?) AS products,(SELECT COUNT(*) FROM sessions WHERE business_id=?) AS sessions,(SELECT COUNT(*) FROM migration_import_batches WHERE business_id=?) AS batches,(SELECT COUNT(*) FROM business_migration_controls WHERE business_id=?) AS controls FROM businesses WHERE id=?', [target, target, target, target, target]);
  assert.deepEqual([Number(stillPresent[0].businesses), Number(stillPresent[0].products), Number(stillPresent[0].sessions), Number(stillPresent[0].batches), Number(stillPresent[0].controls)], [1, 2, 1, 1, 1]);
  assert.equal((await fs.stat(join(imageRoot, target, '0123456789abcdef0123456789abcdef.jpg'))).isFile(), true);
  await pool.query('DROP TRIGGER fail_business_delete');

  const currentPreview = await admin.request('/admin/businesses/' + target + '/deletion-preview');
  const [[pendingState]] = await pool.execute('SELECT b.status,c.state FROM businesses b JOIN business_migration_controls c ON c.business_id=b.id WHERE b.id=?', [target]);
  assert.deepEqual([pendingState.status, pendingState.state], ['INACTIVE', 'PENDING']);
  const deleted = await admin.request('/admin/businesses/' + target, 'DELETE', { confirmation: 'ELIMINAR', previewToken: currentPreview.data.previewToken });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.data.id, target);
  assert.equal(deleted.data.filesPendingCleanup, false);
  assert.ok(deleted.data.counts.some(item => item.table === 'migration_zero_inventory_events' && item.count === 1));
  assert.ok(deleted.data.counts.some(item => item.table === 'business_subscription_payments' && item.count === 1));
  assert.equal((await admin.request('/admin/businesses')).data.businesses.some(item => item.id === target), false);
  const [businessLeft] = await pool.execute('SELECT COUNT(*) AS count FROM businesses WHERE id=?', [target]);
  assert.equal(Number(businessLeft[0].count), 0);
  const [sessionLeft] = await pool.execute('SELECT (SELECT COUNT(*) FROM sessions WHERE business_id=?) AS sessions,(SELECT COUNT(*) FROM session_authorizations WHERE business_id=?) AS authorizations', [target, target]);
  assert.deepEqual([Number(sessionLeft[0].sessions), Number(sessionLeft[0].authorizations)], [0, 0]);
  assert.equal(await repo.session(hashToken(targetToken)), undefined);
  await assert.rejects(fs.stat(join(imageRoot, target)), error => error.code === 'ENOENT');

  for (const { tableName } of scopedTables) {
    const [records] = await pool.execute('SELECT * FROM `' + tableName + '` WHERE business_id=?', [other]);
    assert.deepEqual(records.map(record => JSON.stringify(record)).sort(), otherSnapshot.get(tableName), 'Independent tenant data changed in ' + tableName);
  }
  const [[protectedData]] = await pool.execute('SELECT (SELECT COUNT(*) FROM businesses WHERE id=1) AS business,(SELECT COUNT(*) FROM users WHERE business_id=1 AND username=\'andres\') AS admin,(SELECT COUNT(*) FROM audit_logs WHERE business_id=1 AND action=\'DELETE_BUSINESS\' AND entity_id=?) AS deletionAudit', [target]);
  assert.deepEqual([Number(protectedData.business), Number(protectedData.admin), Number(protectedData.deletionAudit)], [1, 1, 1]);
  const [[billingArchive]] = await pool.execute("SELECT details FROM audit_logs WHERE business_id=1 AND action='DELETE_BUSINESS' AND entity_id=?", [target]);
  const deletionDetails = typeof billingArchive.details === 'string' ? JSON.parse(billingArchive.details) : billingArchive.details;
  assert.equal(deletionDetails.retainedBillingRecords.payments.length, 1);
  assert.equal(String(deletionDetails.retainedBillingRecords.payments[0].amount), '29.50');
  const imageStore = app.locals.businessImageStore;
  const pendingTarget = join(imageRoot, '.deleted-business-' + target);
  await fs.mkdir(pendingTarget, { recursive: true });
  await fs.writeFile(join(pendingTarget, 'recoverable.jpg'), Buffer.from('orphaned deleted-tenant file'));
  const interruptedTenant = join(imageRoot, '.deleted-business-' + other);
  await fs.mkdir(interruptedTenant, { recursive: true });
  await fs.writeFile(join(interruptedTenant, 'recoverable.jpg'), Buffer.from('tenant directory restored after interruption'));
  assert.equal(await imageStore.recoverBusinessFiles(async id => id === other), 0);
  await assert.rejects(fs.stat(pendingTarget), error => error.code === 'ENOENT');
  assert.equal((await fs.stat(join(imageRoot, other, 'recoverable.jpg'))).isFile(), true);
  const [fkChecks] = await pool.execute('SELECT @@FOREIGN_KEY_CHECKS AS enabled');
  assert.equal(Number(fkChecks[0].enabled), 1);
});
