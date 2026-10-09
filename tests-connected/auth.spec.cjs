const { test, expect } = require('@playwright/test');
const { createHash, randomBytes } = require('node:crypto');
const { createDatabasePool } = require('../backend/src/config/database');
const { readConfig } = require('../backend/src/config/environment');
const business = process.env.POS_TEST_BUSINESS, businessB = process.env.POS_TEST_BUSINESS_B, apiBase = process.env.POS_TEST_API;
const password = 'Browser-fixture-password-123!';
const errors = new WeakMap();
test.beforeEach(async ({ page, context }) => { await context.addInitScript({ path: require.resolve('../tests/dexie-search-shim.js') }); const list = []; errors.set(page, list); page.on('pageerror', e => list.push(e.message)); });
test.afterEach(async ({ page }) => { expect(errors.get(page)).toEqual([]); });
async function open(page) { await page.goto('/?mode=connected'); await expect(page.locator('#loginForm button[type=submit]')).toBeEnabled(); }
async function login(page, username = 'browseradmin', id = business, pass = password) {
  await page.locator('#loginBusinessId').fill(id); await page.locator('#loginUsername').fill(username); await page.locator('#loginPassword').fill(pass); await page.locator('#loginForm button[type=submit]').click(); await expect(page.locator('#app')).toBeVisible();
}
async function authorize(page, button = 'navInventoryBtn', view = 'inventoryView') {
  await page.locator('#' + button).click(); await expect(page.locator('#authModal')).toBeVisible();
  await page.locator('#grantAdminUsername').fill('browseradmin'); await page.locator('#gestorPassword').fill(password); await page.locator('#authForm button[type=submit]').click(); await expect(page.locator('#' + view)).toBeVisible();
}
async function expireDatabaseSession(context, table = 'sessions') {
  const database = process.env.POS_INTEGRATION_DATABASE;
  if (!/^pos_auth_test_[a-f0-9]{24}$/.test(database || '') || database === process.env.DB_NAME) throw new Error('Entorno inseguro');
  const config = readConfig(); const pool = createDatabasePool({ ...config.database, database });
  try {
    const cookie = (await context.cookies(apiBase)).find(c => c.name === 'pos_session');
    const tokenHash = createHash('sha256').update(cookie.value).digest('hex');
    if (table === 'sessions') await pool.execute('UPDATE sessions SET expires_at = TIMESTAMPADD(SECOND, -1, UTC_TIMESTAMP(3)) WHERE business_id = ? AND token_hash = ?', [business, tokenHash]);
    else await pool.execute('UPDATE session_authorizations SET expires_at = TIMESTAMPADD(SECOND, -1, UTC_TIMESTAMP(3)) WHERE business_id = ? AND session_id IN (SELECT id FROM sessions WHERE business_id = ? AND token_hash = ?)', [business, business, tokenHash]);
  } finally { await pool.end(); }
}
test('ojito de contraseña funciona por teclado y permite el login conectado',async({page})=>{
  await open(page); const passwordInput=page.locator('#loginPassword'),toggle=page.locator('#toggleLoginPasswordBtn');
  await expect(passwordInput).toHaveAttribute('type','password'); await toggle.click(); await expect(passwordInput).toHaveAttribute('type','text'); await expect(toggle).toHaveAttribute('aria-pressed','true');
  await toggle.click(); await expect(passwordInput).toHaveAttribute('type','password'); await expect(toggle).toHaveAttribute('aria-pressed','false');
  await login(page); await expect(page.locator('#salesView')).toBeVisible();
});

test('ADMIN inicia sesion real, negocio fijo y restauracion mediante cookies', async ({ page }) => {
  await open(page); await login(page); await expect(page.locator('#roleBadge')).toHaveText('Administrador'); await expect(page.locator('#businessContext')).toContainText(business); await expect(page.locator('#loginBusinessId')).toBeDisabled();
  await page.locator('#navInventoryBtn').click(); await expect(page.locator('#inventoryView')).toBeVisible();
  await page.reload(); await expect(page.locator('#app')).toBeVisible(); await expect(page.locator('#salesView')).toBeVisible(); await expect(page.locator('#navUsersBtn')).toBeVisible();
});
test('VENDEDOR solo accede directamente a Ventas', async ({ page }) => {
  await open(page); await login(page, 'browserseller'); await expect(page.locator('#salesView')).toBeVisible(); await expect(page.locator('#navUsersBtn')).toBeHidden(); await page.locator('#navInventoryBtn').click(); await expect(page.locator('#authModal')).toBeVisible(); await expect(page.locator('#inventoryView')).toBeHidden();
});
test('no acepta usuarios locales en modo conectado', async ({ page }) => {
  await open(page); await page.locator('#loginBusinessId').fill(business); await page.locator('#loginUsername').fill('andres'); await page.locator('#loginPassword').fill('4321'); await page.locator('#loginForm button[type=submit]').click(); await expect(page.locator('#loginError')).toContainText('Credenciales incorrectas'); await expect(page.locator('#app')).toBeHidden(); await expect(page.locator('#loginPassword')).toHaveValue('');
});
test('autorizacion temporal, rechazo de contrasena incorrecta y revocacion al cambiar', async ({ page }) => {
  await open(page); await login(page, 'browserseller'); await page.locator('#navInventoryBtn').click(); await page.locator('#grantAdminUsername').fill('browseradmin'); await page.locator('#gestorPassword').fill('wrong'); await page.locator('#authForm button[type=submit]').click(); await expect(page.locator('#authError')).toContainText('Credenciales incorrectas'); await expect(page.locator('#gestorPassword')).toHaveValue('');
  await page.locator('#gestorPassword').fill(password); await page.locator('#authForm button[type=submit]').click(); await expect(page.locator('#inventoryView')).toBeVisible();
  await page.locator('#navSalesBtn').click(); await expect(page.locator('#salesView')).toBeVisible();
  const access = await page.evaluate(async () => { try { await new window.PosApiClient(window.POS_API_BASE_URL).access('inventory'); return 'allowed'; } catch (e) { return e.code; } }); expect(access).toBe('MODULE_FORBIDDEN');
  await page.locator('#navInventoryBtn').click(); await expect(page.locator('#authModal')).toBeVisible();
});
test('autorizacion no concede administracion general ni otro modulo', async ({ page }) => {
  await open(page); await login(page, 'browserseller'); await authorize(page); expect(await page.evaluate(() => isAdmin('configView'))).toBe(false); expect(await page.evaluate(() => isAdmin('inventoryView'))).toBe(true); expect(await page.evaluate(() => window.PosConnected.canView('usersView'))).toBe(false); expect(await page.evaluate(() => window.PosConnected.canView('purchasesView'))).toBe(false);
  const code = await page.evaluate(async () => { currentUser.role = 'ADMIN'; unlockedModuleId = 'usersView'; try { await new window.PosApiClient(window.POS_API_BASE_URL).users(); return 'allowed'; } catch (e) { return e.code; } }); expect(code).toBe('ADMIN_REQUIRED');
});
test('expiracion real de sesion devuelve al login sin fallback local', async ({ page, context }) => {
  await open(page); await login(page); await expireDatabaseSession(context); await page.locator('#navDashboardBtn').click(); await expect(page.locator('#loginScreen')).toBeVisible(); await expect(page.locator('#app')).toBeHidden(); await expect(page.locator('#loginError')).toContainText('sesión'); await expect(page.locator('#authMode')).toHaveValue('connected');
});
test('expiracion real de permiso vuelve a solicitar administrador', async ({ page, context }) => {
  await open(page); await login(page, 'browserseller'); await authorize(page); await expireDatabaseSession(context, 'session_authorizations'); await page.locator('#navInventoryBtn').click(); await expect(page.locator('#authModal')).toBeVisible(); await expect(page.locator('#inventoryView')).toBeHidden();
});
test('renovar rota cookie y revoca permiso temporal', async ({ page, context }) => {
  await open(page); await login(page, 'browserseller'); await authorize(page); const before = (await context.cookies(apiBase)).find(c => c.name === 'pos_session').value;
  await page.locator('#renewSessionBtn').click(); await expect(page.locator('#salesView')).toBeVisible(); await expect(page.locator('#connectedNotice')).toContainText('renovada'); const after = (await context.cookies(apiBase)).find(c => c.name === 'pos_session').value; expect(after).not.toBe(before);
  await page.locator('#navInventoryBtn').click(); await expect(page.locator('#authModal')).toBeVisible();
});
test('ADMIN crea vendedor, modifica rol/estado y cambia contrasena con API', async ({ page }) => {
  await open(page); await login(page); await page.locator('#navUsersBtn').click(); await expect(page.locator('#usersView')).toBeVisible();
  const username = 'ui_' + randomBytes(5).toString('hex');
  await page.locator('#newUsername').fill(username); await page.locator('#newFullName').fill('Usuario de navegador'); await page.locator('#newUserPassword').fill(password); await page.locator('#createUserForm button').click();
  const row = page.locator('#usersTableBody tr').filter({ hasText: username }); await expect(row).toBeVisible(); await expect(page.locator('#newUserPassword')).toHaveValue('');
  await row.locator('select').selectOption('ADMIN'); await row.getByRole('button', { name: 'Guardar rol' }).click(); await expect(row.locator('select')).toHaveValue('ADMIN');
  await row.getByRole('button', { name: 'Desactivar', exact: true }).click(); await expect(row).toContainText('Inactivo'); await row.getByRole('button', { name: 'Activar', exact: true }).click(); await expect(row).toContainText('Activo');
  await row.getByRole('button', { name: 'Cambiar contraseña' }).click(); await page.locator('#changedUserPassword').fill('Changed-browser-password-123!'); await page.locator('#userPasswordForm button[type=submit]').click(); await expect(page.locator('#usersMessage')).toContainText('Contraseña actualizada'); await expect(page.locator('#changedUserPassword')).toHaveValue('');
  await page.screenshot({ path: test.info().outputPath('users-desktop.png'), fullPage: true });
});
test('errores de conexion al login visibles sin acceso offline conectado', async ({ page }) => {
  await page.route(apiBase + '/**', route => route.abort()); await open(page); await expect(page.locator('#loginError')).toContainText('conectar'); await expect(page.locator('#app')).toBeHidden();
});
test('error de conexion al navegar oculta datos y no concede permisos', async ({ page }) => {
  await open(page); await login(page, 'browserseller'); await page.route(apiBase + '/**', route => route.abort()); await page.locator('#navInventoryBtn').click(); await expect(page.locator('#connectedNotice')).toContainText('conectar'); await expect(page.locator('#inventoryView')).toBeHidden();
});
test('respuesta invalida del servidor no crea identidad', async ({ page }) => {
  await page.route(apiBase + '/auth/me', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })); await open(page); await expect(page.locator('#loginError')).toContainText('inesperada'); await expect(page.locator('#app')).toBeHidden();
});
test('no persiste contrasenas, tokens o CSRF en almacenamiento web', async ({ page }) => {
  await open(page); await login(page, 'browserseller'); await authorize(page);
  const result = await page.evaluate(async () => ({ local: JSON.stringify(localStorage), session: JSON.stringify(sessionStorage), tables: localDB.tables.map(t => t.name), cookie: document.cookie, profile: currentUser }));
  expect(result.local).not.toContain(password); expect(result.session).not.toContain(password); expect(result.local).not.toContain('csrfToken'); expect(result.local).not.toContain('pos_session'); expect(result.cookie).not.toContain('pos_session'); expect(result.tables).not.toContain('sessions'); expect(result.profile.password).toBeUndefined();
});
test('Dexie separa modo local y dos negocios sin copiar datos', async ({ page }) => {
  await open(page); await page.evaluate(async () => { const db = createPosDatabase('POS_OfflineDB'); await db.products.put({ id: 1, barcode: 'LOCAL', name: 'LOCAL SECRET' }); db.close(); }); await login(page);
  expect(await page.evaluate(() => localDB.products.count())).toBe(0);
  await page.evaluate(() => localDB.products.put({ id: 2, barcode: 'A', name: 'BUSINESS A SECRET', business_id: DEFAULT_BUSINESS_ID }));
  await page.locator('#logoutBtn').click(); await expect(page.locator('#loginScreen')).toBeVisible(); await expect(page.locator('#loginForm button[type=submit]')).toBeEnabled(); await login(page, 'otheradmin', businessB);
  expect(await page.evaluate(() => localDB.products.count())).toBe(0); expect(await page.evaluate(() => DEFAULT_BUSINESS_ID)).toBe(businessB);
});
test('modo local no invoca API y cambio de modalidad recarga sin conservar identidad', async ({ page }) => {
  const requests = []; page.on('request', req => { if (req.url().startsWith(apiBase)) requests.push(req.url()); });
  await page.goto('/'); await page.locator('#loginUsername').fill('andres'); await page.locator('#loginPassword').fill('4321'); await page.locator('#loginForm button[type=submit]').click(); await expect(page.locator('#app')).toBeVisible(); expect(requests).toEqual([]);
  expect(await page.locator('#purchInvoice').evaluate(input => input.required)).toBe(true);
  expect(await page.locator('#connectedPurchaseNumberField').evaluate(node => node.classList.contains('hidden'))).toBe(true);
  const localDateStyle = await page.locator('#reporteDesdeInput').evaluate(input => ({ scheme: getComputedStyle(input).colorScheme, background: getComputedStyle(input).backgroundColor, calendar: getComputedStyle(input, '::-webkit-calendar-picker-indicator').display }));
  expect(localDateStyle).toEqual({ scheme: 'light', background: 'rgb(255, 255, 255)', calendar: 'block' });
  await page.locator('#logoutBtn').click(); await page.locator('#authMode').selectOption('connected'); await expect(page).toHaveURL(/mode=connected/); await expect(page.locator('#loginScreen')).toBeVisible(); expect(await page.evaluate(() => currentUser)).toBeNull();
});

test('respuesta tardia no reabre una sesion vencida', async ({ page }) => {
  await open(page); await login(page);
  await page.route(apiBase + '/auth/me', async route => {
    const response = await route.fetch(); const data = await response.json();
    data.expiresAt = new Date(Date.now() + 150).toISOString();
    await route.fulfill({ response, json: data });
  });
  await page.route(apiBase + '/auth/modules/inventory/enter', async route => {
    await new Promise(resolve => setTimeout(resolve, 500)); await route.continue();
  });
  await page.locator('#navInventoryBtn').click();
  await expect(page.locator('#loginScreen')).toBeVisible();
  await page.waitForTimeout(700);
  await expect(page.locator('#inventoryView')).toBeHidden(); await expect(page.locator('#app')).toBeHidden();
});
test('login conectado usable en pantalla movil', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await open(page);
  await expect(page.locator('#loginBusinessId')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('login-mobile.png'), fullPage: true });
});
