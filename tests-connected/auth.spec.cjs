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
async function login(page, username = 'browseradmin', pass = password) {
  await page.locator('#loginUsername').fill(username); await page.locator('#loginPassword').fill(pass); await page.locator('#loginForm button[type=submit]').click(); await expect(page.locator('#app')).toBeVisible();
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

test('ADMIN inicia sesion real, negocio resuelto y restauracion mediante cookies', async ({ page }) => {
  await open(page); await expect(page.locator('#loginBusinessId')).toHaveCount(0);
  const loginBodies = []; page.on('request', request => { if (request.url() === apiBase + '/auth/login') loginBodies.push(JSON.parse(request.postData())); });
  await login(page); expect(loginBodies).toEqual([{ username: 'browseradmin', password }]); await expect(page.locator('#roleBadge')).toHaveText('Administrador'); await expect(page.locator('#businessContext')).toContainText('Browser fixture A');
  await page.locator('#navInventoryBtn').click(); await expect(page.locator('#inventoryView')).toBeVisible();
  await page.reload(); await expect(page.locator('#app')).toBeVisible(); await expect(page.locator('#salesView')).toBeVisible(); await expect(page.locator('#navUsersBtn')).toBeVisible();
});
test('VENDEDOR solo accede directamente a Ventas', async ({ page }) => {
  await open(page); await login(page, 'browserseller'); await expect(page.locator('#salesView')).toBeVisible(); await expect(page.locator('#navUsersBtn')).toBeHidden(); await page.locator('#navInventoryBtn').click(); await expect(page.locator('#authModal')).toBeVisible(); await expect(page.locator('#inventoryView')).toBeHidden();
});
test('no acepta usuarios locales en modo conectado y no revela si una cuenta existe', async ({ page }) => {
  await open(page); await page.locator('#loginUsername').fill('localonly'); await page.locator('#loginPassword').fill('4321'); await page.locator('#loginForm button[type=submit]').click(); await expect(page.locator('#loginError')).toContainText('El usuario o la contraseña no coinciden.'); await expect(page.locator('#app')).toBeHidden(); await expect(page.locator('#loginPassword')).toHaveValue('');
});
test('autorizacion temporal, rechazo de contrasena incorrecta y revocacion al cambiar', async ({ page }) => {
  await open(page); await login(page, 'browserseller'); await page.locator('#navInventoryBtn').click(); await page.locator('#grantAdminUsername').fill('browseradmin'); await page.locator('#gestorPassword').fill('wrong'); await page.locator('#authForm button[type=submit]').click(); await expect(page.locator('#authError')).toContainText('no coinciden'); await expect(page.locator('#gestorPassword')).toHaveValue('');
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
  await row.locator('select').selectOption('ADMIN'); await row.getByRole('button', { name: 'Guardar rol' }).click(); await expect(page.locator('#usersMessage')).toContainText('límite es uno'); await expect(row.locator('select')).toHaveValue('VENDEDOR');
  await row.getByRole('button', { name: 'Desactivar', exact: true }).click(); await expect(row).toContainText('Inactivo'); await row.getByRole('button', { name: 'Activar', exact: true }).click(); await expect(row).toContainText('Activo');
  await row.getByRole('button', { name: 'Cambiar contraseña' }).click(); await page.locator('#changedUserPassword').fill('Changed-browser-password-123!'); await page.locator('#userPasswordForm button[type=submit]').click(); await expect(page.locator('#usersMessage')).toContainText('Contraseña actualizada'); await expect(page.locator('#changedUserPassword')).toHaveValue('');
  await page.screenshot({ path: test.info().outputPath('users-desktop.png'), fullPage: true });
});
test('errores de conexion al login visibles sin acceso offline conectado', async ({ page }) => {
  await page.route(apiBase + '/**', route => route.abort()); await open(page); await expect(page.locator('#loginError')).toContainText('No hay conexión con el sistema'); await expect(page.locator('#app')).toBeHidden();
});
test('error de conexion al navegar oculta datos y no concede permisos', async ({ page }) => {
  await open(page); await login(page, 'browserseller'); await page.route(apiBase + '/**', route => route.abort()); await page.locator('#navInventoryBtn').click(); await expect(page.locator('#connectedNotice')).toContainText('No hay conexión con el sistema'); await expect(page.locator('#inventoryView')).toBeHidden();
});
test('respuesta invalida del servidor no crea identidad', async ({ page }) => {
  await page.route(apiBase + '/auth/me', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })); await open(page); await expect(page.locator('#loginError')).toContainText('No pudimos procesar la respuesta'); await expect(page.locator('#app')).toBeHidden();
});
test('no persiste contrasenas, tokens o CSRF en almacenamiento web', async ({ page }) => {
  await open(page); await login(page, 'browserseller'); await authorize(page);
  const result = await page.evaluate(async () => ({ local: JSON.stringify(localStorage), session: JSON.stringify(sessionStorage), connectedDexieDisabled: localDB === null, cookie: document.cookie, profile: currentUser }));
  expect(result.local).not.toContain(password); expect(result.session).not.toContain(password); expect(result.local).not.toContain('csrfToken'); expect(result.local).not.toContain('pos_session'); expect(result.cookie).not.toContain('pos_session'); expect(result.connectedDexieDisabled).toBe(true); expect(result.profile.password).toBeUndefined();
});
test('modo conectado no inicializa Dexie y conserva la identidad de cada negocio', async ({ page }) => {
  await open(page); await login(page, 'browserseller');
  const first = await page.evaluate(async () => ({ businessId: (await new window.PosApiClient(window.POS_API_BASE_URL).me()).user.businessId, dexieDisabled: localDB === null }));
  expect(first).toEqual({ businessId: business, dexieDisabled: true });
  await page.locator('#logoutBtn').click(); await expect(page.locator('#loginScreen')).toBeVisible(); await expect(page.locator('#loginForm button[type=submit]')).toBeEnabled(); await login(page, 'otheradmin');
  const second = await page.evaluate(async () => ({ businessId: (await new window.PosApiClient(window.POS_API_BASE_URL).me()).user.businessId, dexieDisabled: localDB === null }));
  expect(second).toEqual({ businessId: businessB, dexieDisabled: true }); expect(first.businessId).not.toBe(second.businessId);
});
test('modo local nuevo exige licencia antes del propietario y cambiar a conectado no conserva identidad', async ({ page }) => {
  const requests = []; page.on('request', req => { if (req.url().startsWith(apiBase)) requests.push(req.url()); });
  await page.goto('/'); await expect(page.locator('#localLicenseGate')).toBeVisible();
  await expect(page.locator('#localOwnerSetupForm')).toBeHidden(); await expect(page.locator('#loginForm')).toBeHidden();
  expect(await page.evaluate(() => localDB !== null)).toBe(true);
  expect(requests.filter(url => !url.includes('/api/local-license/'))).toEqual([]);
  requests.length = 0;
  await page.locator('#authMode').selectOption('connected'); await expect(page).toHaveURL(/mode=connected/);
  await expect(page.locator('#loginForm')).toBeVisible(); await expect(page.locator('#app')).toBeHidden();
  expect(await page.locator('#loginPassword').inputValue()).toBe('');
  expect(requests.map(url => new URL(url).pathname)).toEqual(['/api/auth/me']);
});

test('sesion que vence durante la entrada al modulo vuelve al login', async ({ page, context }) => {
  await open(page); await login(page);
  await page.route(apiBase + '/auth/modules/inventory/enter', async route => {
    await new Promise(resolve => setTimeout(resolve, 150));
    await expireDatabaseSession(context);
    await route.continue();
  });
  await page.locator('#navInventoryBtn').click();
  await expect(page.locator('#loginScreen')).toBeVisible();
  await expect(page.locator('#inventoryView')).toBeHidden(); await expect(page.locator('#app')).toBeHidden();
});
test('login conectado usable en pantalla movil', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await open(page);
  await expect(page.locator('#loginBusinessId')).toHaveCount(0); await expect(page.locator('#loginUsername')).toBeVisible(); await expect(page.locator('#loginPassword')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('login-mobile.png'), fullPage: true });
});

test('mide navegación conectada y recibe sesión autorizada junto con la entrada al módulo', async ({ page }) => {
  await open(page); await login(page);
  await page.locator('#navInventoryBtn').click(); await expect(page.locator('#inventoryView')).toBeVisible();
  await page.waitForTimeout(350);
  const requests = [];
  page.on('request', request => {
    if (!request.url().startsWith(apiBase)) return;
    requests.push({ method: request.method(), path: new URL(request.url()).pathname, startedAt: Date.now() });
  });
  const startedAt = Date.now();
  await page.locator('#navSalesBtn').click();
  await expect(page.locator('#salesView')).toBeVisible();
  const elapsedMs = Date.now() - startedAt;
  const sessionChecks = requests.filter(request => request.path === '/api/auth/me');
  const moduleEntries = requests.filter(request => request.path === '/api/auth/modules/sales/enter');
  const dataPaths = requests.filter(request => ['/api/catalog/products', '/api/business-settings/sales-flow', '/api/sales/next-invoice', '/api/sales/clients'].includes(request.path));
  const dataStartSpanMs = dataPaths.length ? Math.max(...dataPaths.map(request => request.startedAt)) - Math.min(...dataPaths.map(request => request.startedAt)) : null;
  console.log('NAV_SALES_METRIC ' + JSON.stringify({ elapsedMs, sessionChecks: sessionChecks.length, moduleEntries: moduleEntries.length, dataRequests: dataPaths.length, dataStartSpanMs }));
  expect(sessionChecks).toHaveLength(0);
  expect(moduleEntries).toHaveLength(1);
  expect(dataPaths).toHaveLength(4);
});

test('clics repetidos durante una navegación no duplican autorización ni cargas', async ({ page }) => {
  await open(page); await login(page);
  const requests = [];
  page.on('request', request => { if (request.url().startsWith(apiBase)) requests.push(new URL(request.url()).pathname); });
  await page.route(apiBase + '/auth/modules/inventory/enter', async route => {
    await new Promise(resolve => setTimeout(resolve, 250)); await route.continue();
  });
  await page.locator('#navInventoryBtn').click();
  await page.evaluate(() => document.getElementById('navInventoryBtn').click());
  await expect(page.locator('#inventoryView')).toBeVisible();
  expect(requests.filter(path => path === '/api/auth/modules/inventory/enter')).toHaveLength(1);
  expect(requests.filter(path => path === '/api/products')).toHaveLength(1);
});

test('cargas simultáneas de Inventario comparten la misma lectura del catálogo', async ({ page }) => {
  await open(page); await login(page);
  const productRequests = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/products') productRequests.push(request); });
  await page.route(apiBase + '/products**', async route => {
    await new Promise(resolve => setTimeout(resolve, 250)); await route.continue();
  });
  await page.evaluate(() => Promise.all([window.PosInventory.load('inventoryView'), window.PosInventory.load('inventoryView')]));
  expect(productRequests).toHaveLength(1);
});

test('la navegación muestra estado accesible sin mostrar el módulo destino antes de autorizarlo', async ({ page }) => {
  await open(page); await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route(apiBase + '/auth/modules/inventory/enter', async route => {
    await new Promise(resolve => setTimeout(resolve, 250)); await route.continue();
  });
  await page.locator('#navInventoryBtn').click();
  await expect(page.locator('#connectedNavigationStatus')).toContainText('Cargando Inventario');
  await expect(page.locator('#connectedNavigationStatus')).toHaveAttribute('role', 'status');
  await expect(page.locator('#app')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#inventoryView')).toBeHidden();
  const statusBounds = await page.locator('#connectedNavigationStatus').boundingBox();
  expect(statusBounds.x).toBeGreaterThanOrEqual(0);
  expect(statusBounds.x + statusBounds.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator('#inventoryView')).toBeVisible();
  await expect(page.locator('#connectedNavigationStatus')).toBeHidden();
});

test('cargas simultáneas de Reportes comparten la misma solicitud sin cachear datos', async ({ page }) => {
  await open(page); await login(page); await page.locator('#navReportesBtn').click();
  await expect(page.locator('#reportesView')).toBeVisible(); await expect(page.locator('#connectedReportStatus')).toBeHidden();
  const reportRequests = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/reports/connected') reportRequests.push(request); });
  await page.route(apiBase + '/reports/connected**', async route => {
    await new Promise(resolve => setTimeout(resolve, 250)); await route.continue();
  });
  await page.evaluate(() => Promise.all([window.PosReports.load(), window.PosReports.load()]));
  expect(reportRequests).toHaveLength(1);
});

test('Historial carga ventas, órdenes y resumen en paralelo y una sola vez', async ({ page }) => {
  await open(page); await login(page);
  const requests = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (['/api/sales', '/api/sales/orders/history', '/api/reports/connected'].includes(path)) requests.push({ path, startedAt: Date.now() });
  });
  await page.locator('#navHistoryBtn').click(); await expect(page.locator('#historyView')).toBeVisible();
  await expect(page.locator('#connectedHistoryStatus')).toBeHidden();
  const required = ['/api/sales', '/api/sales/orders/history', '/api/reports/connected'];
  for (const path of required) expect(requests.filter(request => request.path === path)).toHaveLength(1);
  const starts = requests.map(request => request.startedAt);
  expect(Math.max(...starts) - Math.min(...starts)).toBeLessThanOrEqual(100);
  requests.length = 0;
  await Promise.all([
    page.evaluate(() => window.PosSales.load('historyView')),
    page.evaluate(() => window.PosSales.load('historyView'))
  ]);
  for (const path of required) expect(requests.filter(request => request.path === path)).toHaveLength(1);
});

test('una identidad de otro negocio recibida al entrar al módulo obliga a iniciar sesión nuevamente', async ({ page }) => {
  await open(page); await login(page);
  await page.route(apiBase + '/auth/modules/inventory/enter', async route => {
    const response = await route.fetch(); const value = await response.json();
    if (value.allowed === true) { value.user.businessId = businessB; value.user.username = 'otheradmin'; }
    await route.fulfill({ response, json: value });
  });
  await page.locator('#navInventoryBtn').click();
  await expect(page.locator('#loginScreen')).toBeVisible();
  await expect(page.locator('#loginError')).toContainText('sesi');
  await expect(page.locator('#inventoryView')).toBeHidden();
});

test('el backend vuelve a validar la sesión en lecturas después de la verificación de navegación', async ({ page, context }) => {
  await open(page); await login(page);
  const productStatuses = [];
  page.on('response', response => { if (new URL(response.url()).pathname === '/api/products') productStatuses.push(response.status()); });
  await page.route(apiBase + '/products**', async route => {
    await expireDatabaseSession(context);
    await route.continue();
  });
  await page.locator('#navInventoryBtn').click();
  await expect(page.locator('#loginScreen')).toBeVisible();
  expect(productStatuses).toContain(401);
  await expect(page.locator('#inventoryView')).toBeHidden();
});

test('eventos consecutivos de foco y visibilidad se agrupan en una sola comprobación', async ({ page }) => {
  await open(page); await login(page);
  await page.waitForTimeout(2100);
  const requests = [];
  page.on('request', request => {
    if (!request.url().startsWith(apiBase)) return;
    const path = new URL(request.url()).pathname;
    if (path === '/api/auth/me' || path === '/api/auth/access/sales') requests.push(path);
  });
  await page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'));
    setTimeout(() => document.dispatchEvent(new Event('visibilitychange')), 70);
    window.dispatchEvent(new Event('focus'));
    setTimeout(() => window.dispatchEvent(new Event('focus')), 120);
  });
  await expect.poll(() => requests.filter(path => path === '/api/auth/access/sales').length).toBe(1);
  expect(requests.filter(path => path === '/api/auth/me')).toHaveLength(1);
  expect(requests.filter(path => path === '/api/auth/access/sales')).toHaveLength(1);
});

test('Compras, Caja y Reportes validan una vez y cargan solo los datos necesarios', async ({ page }) => {
  await open(page); await login(page);
  const requests = [];
  page.on('request', request => {
    if (request.url().startsWith(apiBase)) requests.push(new URL(request.url()).pathname);
  });
  const navigateAndCapture = async (button, view, waitForStatus) => {
    const start = requests.length;
    await page.locator('#' + button).click(); await expect(page.locator('#' + view)).toBeVisible();
    if (waitForStatus) await expect(page.locator('#' + waitForStatus)).toBeHidden();
    return requests.slice(start);
  };
  const purchases = await navigateAndCapture('navPurchasesBtn', 'purchasesView');
  expect(purchases.filter(path => path === '/api/auth/me')).toHaveLength(0);
  expect(purchases.filter(path => path === '/api/auth/modules/purchases/enter')).toHaveLength(1);
  expect(purchases.filter(path => ['/api/purchases/suppliers', '/api/purchases/products', '/api/purchases'].includes(path))).toHaveLength(3);
  const cash = await navigateAndCapture('navCajaBtn', 'cajaView');
  expect(cash.filter(path => path === '/api/auth/me')).toHaveLength(0);
  expect(cash.filter(path => path === '/api/auth/modules/cash/enter')).toHaveLength(1);
  expect(cash.filter(path => ['/api/cash/sessions', '/api/cash/overview'].includes(path))).toHaveLength(2);
  expect(cash).not.toContain('/api/business-settings/sales-flow');
  expect(cash).not.toContain('/api/sales/next-invoice');
  const reports = await navigateAndCapture('navReportesBtn', 'reportesView', 'connectedReportStatus');
  expect(reports.filter(path => path === '/api/auth/me')).toHaveLength(0);
  expect(reports.filter(path => path === '/api/auth/modules/reports/enter')).toHaveLength(1);
  expect(reports.filter(path => path === '/api/reports/connected')).toHaveLength(1);
  const dashboard = await navigateAndCapture('navDashboardBtn', 'dashboardView', 'dashboardStatus');
  expect(dashboard.filter(path => path === '/api/auth/me')).toHaveLength(0);
  expect(dashboard.filter(path => path === '/api/auth/modules/reports/enter')).toHaveLength(1);
  expect(dashboard.filter(path => path === '/api/reports/connected')).toHaveLength(1);
});
