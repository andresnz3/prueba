const { test, expect } = require('@playwright/test');
const { randomBytes } = require('node:crypto');
const { createDatabasePool } = require('../backend/src/config/database');
const { readConfig } = require('../backend/src/config/environment');
const password = 'Browser-fixture-password-123!';

async function open(page) {
  await page.goto('/?mode=connected');
  await expect(page.locator('#loginForm button[type=submit]')).toBeEnabled();
}

async function login(page, username) {
  await page.locator('#loginUsername').fill(username);
  await page.locator('#loginPassword').fill(password);
  await page.locator('#loginForm button[type=submit]').click();
  await expect(page.locator('#app')).toBeVisible();
}

test('usuario normal no ve el panel ni puede eliminar negocios por el API', async ({ page }) => {
  await open(page); await login(page, 'browserseller');
  await expect(page.locator('#navSystemAdminBtn')).toBeHidden();
  await expect(page.locator('#systemAdminView')).toBeHidden();
  await page.goto('/?mode=connected&view=systemAdminView');
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#navSystemAdminBtn')).toBeHidden();
  const result = await page.evaluate(async () => {
    await window.PosConnected.navigate('systemAdminView');
    window.renderPosView('systemAdminView');
    const response = await fetch(window.POS_API_BASE_URL + '/admin/businesses', { credentials: 'include' });
    const csrf = await fetch(window.POS_API_BASE_URL + '/auth/csrf', { credentials: 'include' }).then(value => value.json());
    const deletion = await fetch(window.POS_API_BASE_URL + '/admin/businesses/1', { method: 'DELETE', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.csrfToken }, body: JSON.stringify({ confirmation: 'ELIMINAR' }) });
    const deletionBody = await deletion.json();
    const support = await fetch(window.POS_API_BASE_URL + '/admin/support-session', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.csrfToken }, body: JSON.stringify({ businessId: '1' }) });
    const supportBody = await support.json();
    return { visible: !document.getElementById('systemAdminView').classList.contains('hidden'), status: response.status, deleteStatus: deletion.status, deleteCode: deletionBody.error?.code, supportStatus: support.status, supportCode: supportBody.error?.code };
  });
  expect(result.visible).toBe(false); expect(result.status).toBe(403); expect(result.deleteStatus).toBe(403); expect(result.deleteCode).toBe('SYSTEM_ADMIN_REQUIRED'); expect(result.supportStatus).toBe(403); expect(result.supportCode).toBe('SYSTEM_ADMIN_REQUIRED');
  await expect(page.locator('#salesView')).toBeVisible();
});

test('andres elimina un negocio vacío con confirmación exacta y el servidor protege el negocio 1', async ({ page }) => {
  await open(page); await login(page, 'andres');
  await page.locator('#navSystemAdminBtn').click(); await expect(page.locator('#systemAdminView')).toBeVisible();
  const businessName = 'Negocio eliminable ' + randomBytes(4).toString('hex');
  const username = 'delete_' + randomBytes(5).toString('hex');
  const businessId = await page.evaluate(async ({ businessName, username, password }) => {
    const api = new window.PosApiClient(window.POS_API_BASE_URL); await api.me();
    const business = await api.createAdminBusiness(businessName);
    await api.createAdminUser(business.id, { username, fullName: 'Usuario eliminable', password, role: 'ADMIN' });
    return business.id;
  }, { businessName, username, password });
  const database = process.env.POS_INTEGRATION_DATABASE, config = readConfig();
  if (!/^pos_auth_test_[a-f0-9]{24}$/.test(database || '') || database === config.database.database) throw new Error('Base temporal de eliminación insegura');
  const pool = createDatabasePool({ ...config.database, database });
  try { await pool.execute('INSERT INTO business_settings (business_id, business_name) VALUES (?, ?)', [businessId, businessName]); }
  finally { await pool.end(); }
  await page.locator('#systemAdminRefreshBtn').click();
  const systemRow = page.locator('#systemAdminBusinessesBody tr[data-business-id="1"]');
  await systemRow.getByRole('button', { name: 'Eliminar' }).click();
  await expect(page.locator('#systemAdminDeleteModal')).toBeVisible();
  await expect(page.locator('#systemAdminDeleteError')).toHaveText('No se puede eliminar el negocio principal del sistema.');
  await expect(page.locator('#systemAdminDeleteConfirmBtn')).toBeDisabled();
  await page.locator('#systemAdminDeleteCancelBtn').click();
  const protectedResult = await page.evaluate(async () => {
    const api = new window.PosApiClient(window.POS_API_BASE_URL); await api.me();
    try { await api.deleteAdminBusiness('1', 'ELIMINAR'); return { code: null, status: 0 }; }
    catch (failure) { return { code: failure.code, status: failure.status }; }
  });
  expect(protectedResult).toEqual({ code: 'BUSINESS_DELETE_PROTECTED', status: 409 });
  const missingResult = await page.evaluate(async () => {
    const api = new window.PosApiClient(window.POS_API_BASE_URL); await api.me();
    try { await api.deleteAdminBusiness('999999999', 'ELIMINAR'); return { code: null, status: 0 }; }
    catch (failure) { return { code: failure.code, status: failure.status }; }
  });
  expect(missingResult).toEqual({ code: 'BUSINESS_NOT_FOUND', status: 404 });
  const businessRow = page.locator('#systemAdminBusinessesBody tr[data-business-id="' + businessId + '"]');
  await expect(businessRow).toBeVisible();
  await businessRow.getByRole('button', { name: 'Eliminar' }).click();
  await expect(page.locator('#systemAdminDeleteModal')).toBeVisible();
  await expect(page.locator('#systemAdminDeleteTitle')).toHaveText('Eliminar negocio');
  await expect(page.locator('#systemAdminDeleteMessage')).toHaveText('Para eliminar «' + businessName + '», escribe exactamente ELIMINAR. Esta acción no se puede deshacer.');
  await page.locator('#systemAdminDeleteInput').fill('ELIMINAR ');
  await page.locator('#systemAdminDeleteConfirmBtn').click();
  await expect(page.locator('#systemAdminDeleteError')).toHaveText('Debes escribir exactamente ELIMINAR para confirmar.');
  await expect(businessRow).toBeVisible();
  await page.locator('#systemAdminDeleteInput').fill('ELIMINAR');
  await page.locator('#systemAdminDeleteConfirmBtn').click();
  await expect(page.locator('#systemAdminDeleteModal')).toBeHidden();
  await expect(page.locator('#systemAdminBusinessesBody tr[data-business-id="' + businessId + '"]')).toHaveCount(0);
  await expect(page.locator('#systemAdminMessage')).toHaveText('Negocio eliminado correctamente.');
  const verifyPool = createDatabasePool({ ...config.database, database });
  try {
    const [businesses] = await verifyPool.execute('SELECT id FROM businesses WHERE id = ?', [businessId]);
    const [users] = await verifyPool.execute('SELECT id FROM users WHERE business_id = ?', [businessId]);
    const [settings] = await verifyPool.execute('SELECT id FROM business_settings WHERE business_id = ?', [businessId]);
    expect(businesses).toHaveLength(0); expect(users).toHaveLength(0); expect(settings).toHaveLength(0);
  } finally { await verifyPool.end(); }
});

test('andres no puede eliminar un negocio con productos registrados', async ({ page }) => {
  await open(page); await login(page, 'andres');
  await page.locator('#navSystemAdminBtn').click(); await expect(page.locator('#systemAdminView')).toBeVisible();
  const businessName = 'Negocio con datos ' + randomBytes(4).toString('hex');
  const businessId = await page.evaluate(async businessName => {
    const api = new window.PosApiClient(window.POS_API_BASE_URL); await api.me();
    return (await api.createAdminBusiness(businessName)).id;
  }, businessName);
  const database = process.env.POS_INTEGRATION_DATABASE, config = readConfig();
  if (!/^pos_auth_test_[a-f0-9]{24}$/.test(database || '') || database === config.database.database) throw new Error('Base temporal de eliminación insegura');
  const pool = createDatabasePool({ ...config.database, database });
  try { await pool.execute('INSERT INTO products (business_id, barcode, name, category) VALUES (?, ?, ?, ?)', [businessId, 'DEL-' + randomBytes(4).toString('hex'), 'Producto protegido', 'Pruebas']); }
  finally { await pool.end(); }
  await page.locator('#systemAdminRefreshBtn').click();
  const businessRow = page.locator('#systemAdminBusinessesBody tr[data-business-id="' + businessId + '"]');
  await businessRow.getByRole('button', { name: 'Eliminar' }).click();
  await page.locator('#systemAdminDeleteInput').fill('ELIMINAR');
  await page.locator('#systemAdminDeleteConfirmBtn').click();
  await expect(page.locator('#systemAdminDeleteError')).toHaveText('No se puede eliminar porque el negocio ya tiene información registrada. Puede suspenderlo.');
  await expect(page.locator('#systemAdminDeleteModal')).toBeVisible();
  await expect(businessRow).toBeVisible();
  const protectedResult = await page.evaluate(async businessId => {
    const api = new window.PosApiClient(window.POS_API_BASE_URL); await api.me();
    try { await api.deleteAdminBusiness(businessId, 'ELIMINAR'); return { code: null, status: 0 }; }
    catch (failure) { return { code: failure.code, status: failure.status }; }
  }, businessId);
  expect(protectedResult).toEqual({ code: 'BUSINESS_HAS_DATA', status: 409 });
});

test('andres administra otro negocio sin sustituir su sesión y vuelve al panel del sistema', async ({ page }) => {
  await open(page); await login(page, 'andres');
  await expect(page.locator('#navSystemAdminBtn')).toBeVisible();
  await page.locator('#navSystemAdminBtn').click();
  await expect(page.locator('#systemAdminView')).toBeVisible();
  await expect(page.locator('#systemAdminTitle')).toHaveText('Administración del sistema');
  const businessName = 'Panel UI ' + randomBytes(4).toString('hex');
  await page.locator('#systemAdminBusinessName').fill(businessName);
  await page.locator('#systemAdminBusinessForm button[type=submit]').click();
  const businessRow = page.locator('#systemAdminBusinessesBody tr').filter({ hasText: businessName });
  await expect(businessRow).toBeVisible(); await expect(businessRow).toContainText('Activo');
  const createdBusinessId = await businessRow.getAttribute('data-business-id');
  await businessRow.getByRole('button', { name: 'Ver usuarios' }).click();
  await expect(page.locator('#systemAdminUsersPanel')).toBeVisible();
  await expect(page.locator('#systemAdminUserBusinessId')).toHaveValue(createdBusinessId);
  const username = 'panel_' + randomBytes(5).toString('hex');
  await page.locator('#systemAdminUsername').fill(username);
  await page.locator('#systemAdminFullName').fill('Usuario de prueba');
  await page.locator('#systemAdminPassword').fill(password);
  await page.locator('#systemAdminRole').selectOption('ADMIN');
  await page.locator('#systemAdminUserForm button[type=submit]').click();
  const adminRow = page.locator('#systemAdminUsersBody tr').filter({ hasText: username });
  await expect(adminRow).toBeVisible(); await expect(adminRow).toContainText(businessName); await expect(adminRow).toContainText('ADMIN'); await expect(page.locator('#systemAdminPassword')).toHaveValue('');
  await adminRow.getByRole('button', { name: 'Desactivar' }).click(); await expect(page.locator('#systemAdminMessage')).toContainText('administrador activo');
  await page.locator('#systemAdminUsername').fill(username + '_seller');
  await page.locator('#systemAdminFullName').fill('Vendedor de prueba');
  await page.locator('#systemAdminPassword').fill(password);
  await page.locator('#systemAdminRole').selectOption('VENDEDOR');
  await page.locator('#systemAdminUserForm button[type=submit]').click();
  const userRow = page.locator('#systemAdminUsersBody tr').filter({ hasText: username + '_seller' });
  await expect(userRow).toBeVisible(); await expect(userRow).toContainText('VENDEDOR');
  await userRow.getByRole('button', { name: 'Desactivar' }).click(); await expect(userRow).toContainText('Inactivo');
  await userRow.getByRole('button', { name: 'Activar' }).click(); await expect(userRow).toContainText('Activo');
  await page.locator('#systemAdminBusinessesTab').click();
  const businessId = process.env.POS_TEST_BUSINESS_B;
  if (!/^[1-9]\d{0,19}$/.test(businessId || '')) throw new Error('Negocio temporal de destino inválido');
  const targetRow = page.locator('#systemAdminBusinessesBody tr[data-business-id="' + businessId + '"]');
  const targetBusinessName = (await targetRow.locator('td').nth(1).textContent()).trim();
  await targetRow.getByRole('button', { name: 'Administrar negocio' }).click();
  await expect(page.locator('#supportSessionBanner')).toBeVisible();
  await expect(page.locator('#supportSessionBanner')).toContainText('Administrando negocio: ' + targetBusinessName);
  const ownerSession = await page.evaluate(async () => new window.PosApiClient(window.POS_API_BASE_URL).me());
  expect(ownerSession.user.username).toBe('andres'); expect(ownerSession.user.businessId).toBe('1');
  expect(ownerSession.support.businessId).toBe(businessId);
  await expect(page.locator('#salesView')).toBeVisible();
  await page.locator('#navInventoryBtn').click(); await expect(page.locator('#inventoryView')).toBeVisible();
  const suffix = randomBytes(5).toString('hex'), productName = 'Producto soporte ' + suffix, barcode = 'SUP-' + suffix;
  await page.locator('#addNewProductBtn').click();
  for (const [id, value] of Object.entries({ prodBarcode: barcode, prodName: productName, prodCost: '10.00', prodMargenRetail: '25', prodMargenWholesale: '10', prodStock: '5', prodMinStock: '1' })) await page.locator('#' + id).fill(value);
  await page.locator('#prodCategory').selectOption('Bebidas');
  await page.locator('#productForm button[type=submit]').click();
  await expect(page.locator('#customAlertMessage')).toHaveText('Producto guardado.');
  await page.locator('#customAlertModal .close-modal-btn').click();
  await expect(page.locator('#inventoryTableBody tr').filter({ hasText: productName })).toHaveCount(1);
  const clientName = 'Cliente soporte ' + suffix, supplierName = 'Proveedor soporte ' + suffix;
  const managedRecords = await page.evaluate(async ({ clientName, supplierName }) => {
    const api = new window.PosApiClient(window.POS_API_BASE_URL); await api.me();
    const client = await api.createClient({ name: clientName, phone: '5551234', ruc: null, address: 'Centro', creditLimit: '100.00', creditDays: 15 });
    const supplier = await api.createSupplier({ name: supplierName, contact: 'Contacto', phone: '5555678', ruc: null, address: 'Centro' });
    return { clientBusinessId: client.businessId, supplierBusinessId: supplier.businessId };
  }, { clientName, supplierName });
  expect(managedRecords).toEqual({ clientBusinessId: businessId, supplierBusinessId: businessId });
  const database = process.env.POS_INTEGRATION_DATABASE, config = readConfig();
  if (!/^pos_auth_test_[a-f0-9]{24}$/.test(database || '') || database === config.database.database) throw new Error('Base de soporte insegura');
  const pool = createDatabasePool({ ...config.database, database });
  try {
    const [products] = await pool.execute('SELECT business_id FROM products WHERE barcode = ?', [barcode]);
    const [clients] = await pool.execute('SELECT business_id FROM clients WHERE name = ?', [clientName]);
    const [suppliers] = await pool.execute('SELECT business_id FROM suppliers WHERE name = ?', [supplierName]);
    expect(products).toHaveLength(1); expect(String(products[0].business_id)).toBe(businessId);
    expect(clients).toHaveLength(1); expect(String(clients[0].business_id)).toBe(businessId);
    expect(suppliers).toHaveLength(1); expect(String(suppliers[0].business_id)).toBe(businessId);
  } finally { await pool.end(); }
  await page.locator('#supportSessionEndBtn').click();
  await expect(page.locator('#systemAdminView')).toBeVisible();
  await expect(page.locator('#supportSessionBanner')).toBeHidden();
  const returnedSession = await page.evaluate(async () => new window.PosApiClient(window.POS_API_BASE_URL).me());
  expect(returnedSession.user.username).toBe('andres'); expect(returnedSession.user.businessId).toBe('1'); expect(returnedSession.support).toBeNull();
});
