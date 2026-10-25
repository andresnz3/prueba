'use strict';

const { test, expect } = require('@playwright/test');
const apiBase = process.env.POS_TEST_API;
const password = 'Browser-fixture-password-123!';
const navigation = [
  ['navSalesBtn', 'salesView'], ['navInventoryBtn', 'inventoryView'], ['navPurchasesBtn', 'purchasesView'],
  ['navPayablesBtn', 'payablesView'], ['navClientsBtn', 'clientsView'], ['navSuppliersBtn', 'suppliersView'],
  ['navHistoryBtn', 'historyView'], ['navCajaBtn', 'cajaView'], ['navGastosBtn', 'gastosView'],
  ['navReportesBtn', 'reportesView'], ['navDashboardBtn', 'dashboardView'], ['navUsersBtn', 'usersView'],
  ['navConfigBtn', 'configView']
];
const forbidden = [
  /\uFFFD|\u00C3[\u0080-\u00FF]|\u00C2[\u0080-\u00FF]|\u00E2\u20AC./,
  /\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+\b/,
  /\b(?:HTTP\s*[45]\d{2}|Error\s*[45]\d{2})\b/i,
  /(?<![A-Z0-9_-])(?:ADMIN|VENDEDOR|ACTIVE|INACTIVE|PENDING|COMPLETED|CANCELLED|CANCELED|VOID|POSTED|CONFIRMED|PARTIAL|OPEN|CLOSED|CASH|CARD|TRANSFER|CREDIT|OTHER|DIRECT|CENTRALIZED|SALE|CUSTOMER_PAYMENT|SUPPLIER_PAYMENT|MANUAL_ENTRY|MANUAL_EXIT|EXPENSE|REVERSAL)(?![A-Z0-9_-])/,
  /\b(?:Internal Server Error|TypeError|ReferenceError|SyntaxError|RangeError|ConstraintError|DatabaseClosedError|IndexedDB|Dexie|MySQL|Docker|Node(?:\.js)?|Express|SQL|API|endpoint|node_modules)\b/i,
  /\b(?:Bad Request|Unauthorized|Forbidden|Not Found|Method Not Allowed|Service Unavailable|Invalid Input|Request Failed|Failed to Fetch|NetworkError|Unhandled Promise Rejection|Cannot read properties|Access Denied|DOMException|AbortError|database|backend|frontend|server)\b/i,
  /\b(?:undefined|null|NaN|businessId|business_id|userId|user_id|productId|product_id|supplierId|supplier_id|clientId|client_id|cashSessionId|cash_session_id|targetBusinessId|sourceBusinessKey|localBusinessId|local_id|source_id|target_id|payment_method|password_hash|fechaTS|ID local|ID interno|UUID local)\b|\[object Object\]|\/api\/|\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/|\bat\s+[^\n]+\.(?:js|cjs):\d+/i,
  /^\s*\{\s*["'](?:error|message|code)["']\s*:/m
];

function assertNoTechnicalLeak(text, screen) {
  for (const pattern of forbidden) expect(text, `Información técnica visible en ${screen}`).not.toMatch(pattern);
}

async function loginAsSystemAdmin(page) {
  await page.goto('/?mode=connected');
  await page.locator('#loginUsername').fill('andres');
  await page.locator('#loginPassword').fill(password);
  await page.locator('#loginForm button[type="submit"]').click();
  await expect(page.locator('#app')).toBeVisible();
}

test('las pantallas conectadas no muestran detalles técnicos en escritorio ni en móvil', async ({ page }) => {
  await loginAsSystemAdmin(page);
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    for (const [button, panel] of navigation) {
      await page.locator('#' + button).click();
      await expect(page.locator('#' + panel)).toBeVisible();
      assertNoTechnicalLeak(await page.locator('body').innerText(), panel + ' ' + viewport.width);
    }
    await page.locator('#navSystemAdminBtn').click();
    await expect(page.locator('#systemAdminView')).toBeVisible();
    for (const [button, panel] of [
      ['systemAdminBusinessesTab', 'systemAdminBusinessesPanel'], ['systemAdminUsersTab', 'systemAdminUsersPanel'],
      ['systemAdminBillingTab', 'systemAdminBillingPanel'], ['systemAdminMigrationTab', 'systemAdminMigrationPanel']
    ]) {
      await page.locator('#' + button).click();
      await expect(page.locator('#' + panel)).toBeVisible();
      assertNoTechnicalLeak(await page.locator('body').innerText(), panel + ' ' + viewport.width);
    }
  }
});

test('un error inesperado del servidor se explica sin mostrar el código ni la consulta recibida', async ({ page }) => {
  await loginAsSystemAdmin(page);
  const apiUrl = new URL(apiBase);
  await page.route(url => url.origin === apiUrl.origin && url.pathname === apiUrl.pathname + '/products', route => route.fulfill({
    status: 500,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify({ error: { code: 'INTERNAL_SQL_COLUMN_012', message: 'SELECT password FROM users' } })
  }));
  await page.locator('#navInventoryBtn').click();
  await expect(page.locator('#connectedNotice')).toBeVisible();
  const message = await page.locator('#connectedNotice').innerText();
  expect(message).toBe('No se pudo completar la solicitud. Inténtalo nuevamente.');
  expect(message).not.toContain('INTERNAL_SQL_COLUMN_012');
  expect(message).not.toContain('SELECT password');
  assertNoTechnicalLeak(message, 'mensaje de error del inventario');
});
