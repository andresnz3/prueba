'use strict';

const { test, expect } = require('@playwright/test');
const { createDatabasePool } = require('../backend/src/config/database');
const { readConfig } = require('../backend/src/config/environment');

const password = 'Browser-fixture-password-123!';

async function seedCashHistory() {
  const database = process.env.POS_INTEGRATION_DATABASE;
  const targetBusinessId = process.env.POS_TEST_BUSINESS_B;
  if (!/^pos_auth_test_[a-f0-9]{24}$/.test(database || '') || !/^[1-9]\d*$/.test(targetBusinessId || '')) throw new Error('Se requiere una base temporal y un negocio de prueba');
  const pool = createDatabasePool({ ...readConfig().database, database });
  try {
    const [[owner]] = await pool.execute('SELECT id FROM users WHERE business_id=? AND username=\'otheradmin\' AND active=TRUE', [targetBusinessId]);
    if (!owner) throw new Error('Falta el administrador del negocio ficticio de destino');
    const sessionIds = [];
    for (let index = 0; index < 5; index++) {
      const sourceWasOpen = index === 4;
      const day = String(10 + index).padStart(2, '0');
      const [session] = await pool.execute(
        'INSERT INTO cash_sessions (business_id,opened_by,opening_amount,opened_at,counted_amount,expected_amount,difference,closed_at,status,is_historical,source_opened_by,source_closed_by,source_status) VALUES (?,?,?, ?,?,?,?, ?,\'CLOSED\',TRUE,?,?,?)',
        [targetBusinessId, owner.id, (15 + index).toFixed(2), '2026-09-' + day + ' 08:00:00.000', sourceWasOpen ? null : '20.00', sourceWasOpen ? null : '20.00', sourceWasOpen ? null : '0.00', sourceWasOpen ? null : '2026-09-' + day + ' 18:00:00.000', 'Legacy cashier', sourceWasOpen ? null : 'Legacy manager', sourceWasOpen ? 'abierta' : 'cerrada']
      );
      sessionIds.push(String(session.insertId));
    }
    for (let index = 0; index < 32; index++) {
      const direction = index % 2 === 0 ? 'IN' : 'OUT';
      await pool.execute(
        'INSERT INTO cash_movements (business_id,cash_session_id,user_id,type,direction,amount,description,status,created_at,is_historical,source_actor,source_status,source_method) VALUES (?,?,?, ?,?,?,?,\'CONFIRMED\',?,TRUE,?,\'CONFIRMED\',?)',
        [targetBusinessId, sessionIds[index % sessionIds.length], owner.id, direction === 'IN' ? 'MANUAL_ENTRY' : 'MANUAL_EXIT', direction, (index + 1).toFixed(2), 'Migrated historical movement ' + (index + 1), '2026-09-' + String(10 + index % 5).padStart(2, '0') + ' 12:00:00.000', 'Legacy cashier', index < 2 ? null : 'CASH']
      );
    }
    const [[snapshot]] = await pool.execute('SELECT (SELECT COUNT(*) FROM cash_sessions WHERE business_id=?) AS sessions,(SELECT COUNT(*) FROM cash_movements WHERE business_id=?) AS movements,(SELECT SUM(amount) FROM cash_movements WHERE business_id=?) AS amount,(SELECT SUM(opening_amount) FROM cash_sessions WHERE business_id=?) AS opening', [targetBusinessId, targetBusinessId, targetBusinessId, targetBusinessId]);
    return { targetBusinessId, snapshot: Object.fromEntries(Object.entries(snapshot).map(([key, value]) => [key, String(value)])) };
  } finally { await pool.end(); }
}

test('Caja histórica del negocio administrado permite reintento sin pantalla en blanco ni cambios de saldo', async ({ page }) => {
  const { targetBusinessId, snapshot } = await seedCashHistory();
  await page.goto('/?mode=connected');
  await page.locator('#loginUsername').fill('andres');
  await page.locator('#loginPassword').fill(password);
  await page.locator('#loginForm button[type=submit]').click();
  await expect(page.locator('#app')).toBeVisible();
  await page.locator('#navSystemAdminBtn').click();
  await expect(page.locator('#systemAdminView')).toBeVisible();
  const businessRow = page.locator('#systemAdminBusinessesBody tr[data-business-id="' + targetBusinessId + '"]');
  await expect(businessRow).toBeVisible();
  await businessRow.getByRole('button', { name: 'Administrar negocio' }).click();
  await expect(page.locator('#supportSessionBanner')).toBeVisible();
  await expect(page.locator('#supportSessionBusinessName')).toHaveText('Browser fixture B');

  const identities = await page.evaluate(async () => {
    const api = new window.PosApiClient(window.POS_API_BASE_URL);
    const current = await api.me();
    return { ownerBusinessId: current.user.businessId, supportBusinessId: current.support?.businessId, effectiveBusinessId: window.PosConnected.effectiveBusinessId() };
  });
  expect(identities).toEqual({ ownerBusinessId: '1', supportBusinessId: targetBusinessId, effectiveBusinessId: targetBusinessId });

  let failNextOverview = true;
  await page.route('**/cash/overview', async route => {
    if (!failNextOverview) return route.continue();
    failNextOverview = false;
    return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TEMPORARY_TEST_FAILURE', message: 'Fallo temporal de prueba' } }) });
  });
  await page.locator('#navCajaBtn').click();
  await expect(page.locator('#cajaView')).toBeVisible();
  await expect(page.locator('#cashLoadStatus')).toBeVisible();
  await expect(page.locator('#cashLoadMessage')).toContainText('No se pudo cargar Caja. Revisa la conexión e inténtalo nuevamente.');
  await expect(page.locator('#retryCashLoadBtn')).toBeVisible();
  await expect(page.locator('#abrirCajaBtn')).toBeDisabled();
  await expect(page.locator('#salesView')).toBeHidden();

  const rawResponse = await page.evaluate(async () => {
    const api = new window.PosApiClient(window.POS_API_BASE_URL);
    await api.me();
    const sessions = await api.cashSessions();
    const overview = await api.cashOverview();
    return { businessIds: sessions.map(session => session.businessId), sessions: sessions.length, sessionMovements: sessions.reduce((sum, session) => sum + session.movements.length, 0), overviewMovements: overview.movements.length, missingExpected: sessions.filter(session => session.expectedAmount === null).length };
  });
  expect(rawResponse).toEqual({ businessIds: Array(5).fill(targetBusinessId), sessions: 5, sessionMovements: 32, overviewMovements: 32, missingExpected: 1 });

  for (const [button, view] of [['navSalesBtn', 'salesView'], ['navInventoryBtn', 'inventoryView'], ['navPurchasesBtn', 'purchasesView'], ['navReportesBtn', 'reportesView']]) {
    await page.locator('#' + button).click();
    await expect(page.locator('#' + view)).toBeVisible();
  }
  await page.locator('#navCajaBtn').click();
  await expect(page.locator('#cashLoadStatus')).toBeHidden();
  await expect(page.locator('#cajaHistorialBody tr[data-table-date]')).toHaveCount(5);
  await expect(page.locator('#cajaMovimientosBody tr[data-table-date]')).toHaveCount(32);
  const movementText = await page.locator('#cajaMovimientosBody').innerText();
  expect(movementText).toContain('Ingreso manual');
  expect(movementText).toContain('Retiro manual');
  expect(movementText).not.toMatch(/MANUAL_(?:ENTRY|EXIT)/);
  await expect(page.locator('#abrirCajaBtn')).toBeEnabled();
  const noCloseData = page.locator('#cajaHistorialBody tr[data-table-date]').filter({ hasText: 'No registrado' }).last();
  await noCloseData.getByRole('button', { name: 'Detalles' }).click();
  await expect(page.locator('#detalleCierreCajaModal')).toBeVisible();
  await expect(page.locator('#cajaDetalleResumen')).toContainText('No disponible');
  await expect(page.locator('#cajaDetalleResumen')).toContainText('No registrado');
  await page.locator('#detalleCierreCajaModal .close-modal-btn').click();

  failNextOverview = true;
  await page.locator('#navSalesBtn').click();
  await page.locator('#navCajaBtn').click();
  await expect(page.locator('#cashLoadStatus')).toBeVisible();
  await expect(page.locator('#abrirCajaBtn')).toBeDisabled();
  await page.locator('#retryCashLoadBtn').click();
  await expect(page.locator('#cashLoadStatus')).toBeHidden();
  await expect(page.locator('#cajaHistorialBody tr[data-table-date]')).toHaveCount(5);
  await expect(page.locator('#cajaMovimientosBody tr[data-table-date]')).toHaveCount(32);

  const database = process.env.POS_INTEGRATION_DATABASE;
  const pool = createDatabasePool({ ...readConfig().database, database });
  try {
    const [[after]] = await pool.execute('SELECT (SELECT COUNT(*) FROM cash_sessions WHERE business_id=?) AS sessions,(SELECT COUNT(*) FROM cash_movements WHERE business_id=?) AS movements,(SELECT SUM(amount) FROM cash_movements WHERE business_id=?) AS amount,(SELECT SUM(opening_amount) FROM cash_sessions WHERE business_id=?) AS opening', [targetBusinessId, targetBusinessId, targetBusinessId, targetBusinessId]);
    expect(Object.fromEntries(Object.entries(after).map(([key, value]) => [key, String(value)]))).toEqual(snapshot);
  } finally { await pool.end(); }
});
