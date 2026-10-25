'use strict';

const { test, expect } = require('@playwright/test');
const navigation = [
  ['navSalesBtn', 'salesView'], ['navInventoryBtn', 'inventoryView'], ['navPurchasesBtn', 'purchasesView'],
  ['navPayablesBtn', 'payablesView'], ['navClientsBtn', 'clientsView'], ['navSuppliersBtn', 'suppliersView'],
  ['navHistoryBtn', 'historyView'], ['navCajaBtn', 'cajaView'], ['navGastosBtn', 'gastosView'],
  ['navReportesBtn', 'reportesView'], ['navDashboardBtn', 'dashboardView'], ['navUsersBtn', 'usersView'], ['navConfigBtn', 'configView']
];
const forbidden = [
  /\uFFFD|\u00C3[\u0080-\u00FF]|\u00C2[\u0080-\u00FF]|\u00E2\u20AC./,
  /\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+\b/,
  /\b(?:HTTP\s*[45]\d{2}|Error\s*[45]\d{2})\b/i,
  /(?<![A-Z0-9_-])(?:ADMIN|VENDEDOR|ACTIVE|INACTIVE|PENDING|COMPLETED|CANCELLED|CANCELED|VOID|POSTED|CONFIRMED|PARTIAL|OPEN|CLOSED|CASH|CARD|TRANSFER|CREDIT|OTHER|DIRECT|CENTRALIZED|SALE|CUSTOMER_PAYMENT|SUPPLIER_PAYMENT|MANUAL_ENTRY|MANUAL_EXIT|EXPENSE|REVERSAL)(?![A-Z0-9_-])/,
  /\b(?:Internal Server Error|TypeError|ReferenceError|SyntaxError|RangeError|ConstraintError|DatabaseClosedError|IndexedDB|Dexie|MySQL|Docker|Node(?:\.js)?|Express|SQL|API|endpoint|node_modules|businessId|business_id|userId|productId|supplierId|clientId|cashSessionId|targetBusinessId|sourceBusinessKey|localBusinessId|fechaTS)\b/i,
  /\b(?:Bad Request|Unauthorized|Forbidden|Not Found|Method Not Allowed|Service Unavailable|Invalid Input|Request Failed|Failed to Fetch|NetworkError|Unhandled Promise Rejection|Cannot read properties|Access Denied|DOMException|AbortError|database|backend|frontend|server)\b/i,
  /\b(?:undefined|null|NaN|businessId|business_id|userId|user_id|productId|product_id|supplierId|supplier_id|clientId|client_id|cashSessionId|cash_session_id|targetBusinessId|sourceBusinessKey|localBusinessId|local_id|source_id|target_id|payment_method|password_hash|fechaTS|ID local|ID interno|UUID local)\b|\[object Object\]|\/api\/|\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/|\bat\s+[^\n]+\.(?:js|cjs):\d+/i,
  /^\s*\{\s*["'](?:error|message|code)["']\s*:/m
];

function assertNoTechnicalLeak(text, screen) {
  for (const pattern of forbidden) expect(text, `Información técnica visible en ${screen}`).not.toMatch(pattern);
}

async function login(page) {
  await page.goto('/?mode=local');
  await page.locator('#loginUsername').fill('andres');
  await page.locator('#loginPassword').fill('4321');
  await page.locator('#loginForm button[type="submit"]').click();
  await expect(page.locator('#app')).toBeVisible();
}

test('las pantallas locales usan textos comprensibles y presentan fallos de almacenamiento de forma segura', async ({ page }) => {
  await page.goto('/?mode=local');
  assertNoTechnicalLeak(await page.locator('body').innerText(), 'inicio de sesión local');
  await expect(page.locator('body')).not.toContainText('MySQL');
  await login(page);
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    for (const [button, panel] of navigation) {
      const navigationButton = page.locator('#' + button);
      if (!await navigationButton.isVisible()) continue;
      await navigationButton.click();
      await expect(page.locator('#' + panel)).toBeVisible();
      assertNoTechnicalLeak(await page.locator('body').innerText(), panel + ' ' + viewport.width);
    }
  }
  await page.evaluate(() => window.showAlert('ConstraintError: IndexedDB failed at storage.js:12'));
  await expect(page.locator('#customAlertMessage')).toHaveText('No se pudo completar la solicitud. Inténtalo nuevamente.');
  assertNoTechnicalLeak(await page.locator('#customAlertMessage').innerText(), 'mensaje de error local');
  await page.evaluate(() => window.showConfirm('PURCHASE_CASH_REFUND_REQUIRED: SELECT balance FROM cash'));
  await expect(page.locator('#customConfirmMessage')).toHaveText('Confirma esta acción después de revisar la información.');
  assertNoTechnicalLeak(await page.locator('#customConfirmMessage').innerText(), 'confirmación de operación');
  await page.evaluate(() => window.PosValidation.field('prodName', 'DatabaseClosedError: IndexedDB unavailable'));
  await expect(page.locator('#prodNameFieldError')).toHaveText('Revisa este campo e inténtalo nuevamente.');
  assertNoTechnicalLeak(await page.locator('#prodNameFieldError').innerText(), 'validación de formulario');
});
