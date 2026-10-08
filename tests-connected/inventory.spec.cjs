const { test, expect } = require('@playwright/test');
const { randomBytes } = require('node:crypto');
const business = process.env.POS_TEST_BUSINESS, businessB = process.env.POS_TEST_BUSINESS_B, api = process.env.POS_TEST_API;
const password = 'Browser-fixture-password-123!';
const errors = new WeakMap();
test.beforeEach(async ({ page, context }) => { await context.addInitScript({ path: require.resolve('../tests/dexie-search-shim.js') }); const list = []; errors.set(page, list); page.on('pageerror', error => list.push(error.message)); });
test.afterEach(async ({ page }) => { expect(errors.get(page)).toEqual([]); });
async function login(page, username = 'browseradmin', tenant = business) {
  await page.goto('/?mode=connected'); await expect(page.locator('#loginForm button')).toBeEnabled();
  await page.locator('#loginBusinessId').fill(tenant); await page.locator('#loginUsername').fill(username); await page.locator('#loginPassword').fill(password); await page.locator('#loginForm button').click(); await expect(page.locator('#app')).toBeVisible();
}
async function inventory(page) { await page.locator('#navInventoryBtn').click(); await expect(page.locator('#inventoryView')).toBeVisible(); }
async function closeAlert(page) { await expect(page.locator('#customAlertModal')).toBeVisible(); await page.locator('#customAlertModal .close-modal-btn').click(); await expect(page.locator('#customAlertModal')).toBeHidden(); }
async function create(page, stock = '5.125') {
  const suffix = randomBytes(5).toString('hex'), name = 'Producto ' + suffix, barcode = 'UI-' + suffix;
  await page.locator('#addNewProductBtn').click();
  for (const [id, value] of Object.entries({ prodBarcode: barcode, prodName: name, prodCost: '10.00', prodMargenRetail: '25', prodMargenWholesale: '10', prodStock: stock, prodMinStock: '1.001' })) await page.locator('#' + id).fill(value);
  await page.locator('#productForm button[type=submit]').click(); await expect(page.locator('#customAlertMessage')).toContainText('MySQL'); await closeAlert(page);
  const row = page.locator('#inventoryTableBody tr').filter({ hasText: name }); await expect(row).toHaveCount(1);
  return { name, barcode, row };
}
async function adjust(page, row, type, quantity, reason) {
  await row.getByRole('button', { name: 'Ajuste' }).click();
  await page.locator('#ajusteTipo').selectOption(type); await page.locator('#ajusteCantidad').fill(quantity); await page.locator('#ajusteMotivo').fill(reason);
  await page.locator('#ajusteInventarioForm button[type=submit]').click();
}
async function call(page, method, ...args) {
  return page.evaluate(async ({ method, args, api }) => { const client = new window.PosApiClient(api); await client.me(); try { return { value: await client[method](...args) }; } catch (error) { return { code: error.code, status: error.status }; } }, { method, args, api });
}
test('búsqueda conectada encuentra el código de barras exacto en inventario y POS', async ({ page }) => {
  const barcode = '7501234567890', name = 'Producto búsqueda ' + randomBytes(4).toString('hex');
  await page.addInitScript({ path: require.resolve('../tests/dexie-search-shim.js') });
  await login(page); await inventory(page); await page.locator('#addNewProductBtn').click();
  for (const [id, value] of Object.entries({ prodBarcode: barcode, prodName: name, prodCost: '5', prodMargenRetail: '20', prodMargenWholesale: '10', prodStock: '10', prodMinStock: '1' })) await page.locator('#' + id).fill(value);
  await page.locator('#prodCategory').selectOption('Bebidas');
  await page.locator('#productForm button[type=submit]').click(); await expect(page.locator('#customAlertMessage')).toContainText('MySQL'); await closeAlert(page);
  const row = page.locator('#inventoryTableBody tr').filter({ hasText: name }); await expect(row).toHaveCount(1);
  await page.locator('#inventorySearchInput').fill('  ' + barcode + '  '); await expect(row).toHaveCount(1);
  await page.locator('#inventorySearchInput').fill(name.toUpperCase()); await expect(row).toHaveCount(1);
  await page.locator('#inventorySearchInput').fill('BEBIDAS'); await expect(row).toHaveCount(1);

  await page.locator('#navSalesBtn').click(); await expect(page.locator('#salesView')).toBeVisible();
  await page.locator('#searchProductInput').fill('  ' + barcode + '  ');
  const card = page.locator('.product-card').filter({ hasText: name }); await expect(card.first()).toBeVisible();
  await page.locator('#searchProductInput').press('Enter');
  await expect(page.locator('#cartItems .cart-item-row')).toHaveCount(1);
  await page.locator('#barcodeInput').fill(' ' + barcode + ' '); await page.locator('#barcodeInput').press('Enter');
  await expect(page.locator('#cartItems .cart-item-row input[type=number]')).toHaveValue('2');
  await page.locator('#searchProductInput').fill(name.toUpperCase()); await expect(card.first()).toBeVisible();
  expect(await page.evaluate(async () => ({ sales: await localDB.sales.count(), queue: await localDB.sync_queue.count() }))).toEqual({ sales: 0, queue: 0 });
});
test('filtros y orden de inventario conectado son solo de lectura y no escriben en Dexie', async ({ page }) => {
  await login(page); await inventory(page);
  const first = await create(page, '5.125'), second = await create(page, '7.25');
  const rowFor = name => page.locator('#inventoryTableBody tr').filter({ hasText: name });
  const initialRowCount = await page.locator('#inventoryTableBody tr:visible:not(.data-table-no-results)').count();
  const before = await page.evaluate(async () => ({ products: await localDB.products.count(), sales: await localDB.sales.count(), queue: await localDB.sync_queue.count() }));
  await page.locator('#inventorySearchInput').fill(first.barcode);
  await expect(rowFor(first.name)).toBeVisible(); await expect(rowFor(second.name)).toBeHidden();
  await page.locator('#inventoryView .data-table-column-filter').nth(1).fill(first.name);
  await expect(rowFor(first.name)).toBeVisible(); await expect(page.locator('#inventoryTableBody tr:visible:not(.data-table-no-results)')).toHaveCount(1);
  await page.locator('#inventoryView .data-table-clear').click();
  await expect(page.locator('#inventoryTableBody tr:visible:not(.data-table-no-results)')).toHaveCount(initialRowCount);
  await page.locator('#inventoryView table thead tr:first-child th').nth(3).locator('button').click();
  const stockOrder = await page.locator('#inventoryTableBody tr:visible:not(.data-table-no-results)').evaluateAll(rows => rows.map(row => Number(row.cells[3].textContent.match(/[\d.]+/)[0])));
  expect(stockOrder).toEqual([...stockOrder].sort((left, right) => left - right));
  const after = await page.evaluate(async () => ({ products: await localDB.products.count(), sales: await localDB.sales.count(), queue: await localDB.sync_queue.count() }));
  expect(after).toEqual(before);
});
test('crear y editar sin proveedor no bloquea el formulario ni envia datos ficticios', async ({ page }) => {
  const writes = [];
  page.on('request', request => {
    if (['POST', 'PATCH'].includes(request.method()) && new URL(request.url()).pathname.startsWith('/api/products')) writes.push(request.postDataJSON());
  });
  await login(page); await inventory(page);
  const item = await create(page);
  const supplier = page.locator('#prodSupplier');
  await expect(supplier).toBeHidden(); await expect(supplier).toBeDisabled(); await expect(supplier).toHaveValue('');
  expect(await supplier.evaluate(node => ({ required: node.required, customError: node.validity.customError, willValidate: node.willValidate }))).toEqual({ required: false, customError: false, willValidate: false });
  await item.row.getByRole('button', { name: 'Editar', exact: true }).click(); await expect(page.locator('#productModal')).toBeVisible();
  await expect(supplier).toBeHidden(); await expect(supplier).toHaveValue('');
  const updatedName = item.name + ' Sin proveedor';
  await page.locator('#prodName').fill(updatedName);
  expect(await page.locator('#productForm').evaluate(form => form.checkValidity())).toBe(true);
  await page.locator('#productForm button[type=submit]').click(); await expect(page.locator('#customAlertMessage')).toContainText('MySQL'); await closeAlert(page);
  expect(writes).toHaveLength(2);
  for (const body of writes) expect(Object.keys(body).filter(key => /supplier|proveedor/i.test(key))).toEqual([]);
  await page.reload(); await expect(page.locator('#app')).toBeVisible(); await inventory(page);
  await expect(page.locator('#inventoryTableBody tr').filter({ hasText: updatedName })).toHaveCount(1);
  const result = await call(page, 'products');
  const product = result.value.find(value => value.barcode === item.barcode);
  expect(product.name).toBe(updatedName); expect(product).not.toHaveProperty('supplier');
});
test('crear producto con precios y margenes persiste en MySQL al recargar', async ({ page }) => {
  await login(page); await inventory(page); const item = await create(page);
  await expect(item.row).toContainText('5.125'); await expect(item.row).toContainText('12.50'); await expect(item.row).toContainText('11.00');
  expect(await page.evaluate(() => window.PosRuntime.productImage())).toBeNull();
  await page.reload(); await expect(page.locator('#app')).toBeVisible(); await inventory(page);
  await expect(page.locator('#inventoryTableBody tr').filter({ hasText: item.name })).toContainText('5.125');
  const result = await call(page, 'products'); const product = result.value.find(value => value.barcode === item.barcode);
  expect(product.marginRetail).toBe(25); expect(product.marginWholesale).toBe(10); expect(product.minStock).toBe(1.001);
});
test('editar producto y stock conserva precios y registra MANUAL_EDIT', async ({ page }) => {
  await login(page); await inventory(page); const item = await create(page);
  await item.row.getByRole('button', { name: 'Editar', exact: true }).click(); await expect(page.locator('#productModal')).toBeVisible();
  await page.locator('#prodName').fill(item.name + ' Editado'); await page.locator('#prodStock').fill('6.126'); await page.locator('#productForm button[type=submit]').click(); await closeAlert(page);
  await item.row.getByRole('button', { name: 'Kardex' }).click(); await expect(page.locator('#kardexTableBody')).toContainText('MANUAL_EDIT'); await expect(page.locator('#kardexTableBody')).toContainText('1.001'); await expect(page.locator('#kardexTableBody')).toContainText('browseradmin');
});
test('codigo duplicado se rechaza sin crear filas', async ({ page }) => {
  await login(page); await inventory(page); const item = await create(page);
  await page.locator('#addNewProductBtn').click();
  for (const [id, value] of Object.entries({ prodBarcode: item.barcode, prodName: 'Duplicado', prodCost: '2', prodStock: '0' })) await page.locator('#' + id).fill(value);
  await page.locator('#productForm button[type=submit]').click(); await expect(page.locator('#customAlertMessage')).toContainText('ya existe'); await expect(page.locator('#productModal')).toBeVisible(); expect((await call(page, 'products')).value.filter(p => p.barcode === item.barcode)).toHaveLength(1);
});
test('ajuste y merma usan decimales y aparecen en Kardex despues de recargar', async ({ page }) => {
  await login(page); await inventory(page); const item = await create(page);
  await adjust(page, item.row, 'AJUSTE_POSITIVO', '1.001', 'Conteo fisico'); await closeAlert(page); await expect(item.row).toContainText('6.126');
  await adjust(page, item.row, 'MERMA', '0.126', 'Rotura'); await closeAlert(page); await expect(item.row).toContainText('6');
  await page.reload(); await expect(page.locator('#app')).toBeVisible(); await inventory(page); await item.row.getByRole('button', { name: 'Kardex' }).click(); await expect(page.locator('#kardexTableBody')).toContainText('ADJUSTMENT'); await expect(page.locator('#kardexTableBody')).toContainText('WASTE'); await expect(page.locator('#kardexTableBody')).toContainText('Rotura');
});
test('merma superior al stock no altera el producto', async ({ page }) => {
  await login(page); await inventory(page); const item = await create(page, '1'); await adjust(page, item.row, 'MERMA', '2', 'Exceso'); await expect(page.locator('#customAlertMessage')).toContainText('existencias suficientes'); expect((await call(page, 'products')).value.find(p => p.barcode === item.barcode).stock).toBe(1);
});
test('inactivar conserva historial y permite reactivar', async ({ page }) => {
  await login(page); await inventory(page); const item = await create(page);
  await item.row.getByRole('button', { name: 'Inactivar', exact: true }).click(); await expect(page.locator('#customConfirmModal')).toBeVisible(); await page.locator('#customConfirmBtn').click(); await closeAlert(page); await expect(item.row).toContainText('Inactivo');
  await item.row.getByRole('button', { name: 'Kardex' }).click(); await expect(page.locator('#kardexTableBody')).toContainText('INITIAL'); await page.locator('#kardexModal .close-modal-btn').click();
  await item.row.getByRole('button', { name: 'Activar', exact: true }).click(); await page.locator('#customConfirmBtn').click(); await closeAlert(page); await expect(item.row).not.toContainText('Inactivo');
});
test('edicion obsoleta se rechaza y preserva el cambio de otra sesion', async ({ page }) => {
  await login(page); await inventory(page); const item = await create(page); await item.row.getByRole('button', { name: 'Editar', exact: true }).click();
  const before = (await call(page, 'products')).value.find(p => p.barcode === item.barcode);
  expect((await call(page, 'updateProduct', before.id, { revision: before.revision, name: item.name + ' Remoto' })).value.name).toContain('Remoto');
  await page.locator('#prodName').fill(item.name + ' Obsoleto'); await page.locator('#productForm button[type=submit]').click(); await expect(page.locator('#customAlertMessage')).toContainText('otra sesi'); expect((await call(page, 'product', before.id)).value.name).toContain('Remoto');
});
test('vendedor requiere autorizacion real y no puede escribir tras abandonar inventario', async ({ page }) => {
  await login(page, 'browserseller'); expect((await call(page, 'products')).code).toBe('MODULE_FORBIDDEN');
  await page.locator('#navInventoryBtn').click(); await page.locator('#grantAdminUsername').fill('browseradmin'); await page.locator('#gestorPassword').fill(password); await page.locator('#authForm button[type=submit]').click(); await expect(page.locator('#inventoryView')).toBeVisible();
  const item = await create(page, '2'); const product = (await call(page, 'products')).value.find(p => p.barcode === item.barcode);
  await page.locator('#navSalesBtn').click(); await expect(page.locator('#salesView')).toBeVisible(); expect((await call(page, 'adjustProduct', product.id, { type: 'WASTE', quantity: '1', reason: 'Ya salio' })).code).toBe('MODULE_FORBIDDEN');
});
test('permiso vencido en MySQL rechaza escritura aunque la UI aun muestre formulario', async ({ page }) => {
  await login(page, 'browserseller'); await page.locator('#navInventoryBtn').click(); await page.locator('#grantAdminUsername').fill('browseradmin'); await page.locator('#gestorPassword').fill(password); await page.locator('#authForm button[type=submit]').click(); await expect(page.locator('#inventoryView')).toBeVisible();
  const item = await create(page); const product = (await call(page, 'products')).value.find(p => p.barcode === item.barcode);
  await item.row.getByRole('button', { name: 'Ajuste' }).click(); await expect(page.locator('#ajusteInventarioModal')).toBeVisible();
  const { createDatabasePool } = require('../backend/src/config/database'); const { readConfig } = require('../backend/src/config/environment');
  const database = process.env.POS_INTEGRATION_DATABASE;
  if (!/^pos_auth_test_[a-f0-9]{24}$/.test(database || '') || database === process.env.DB_NAME) throw new Error('Base insegura');
  const pool = createDatabasePool({ ...readConfig().database, database });
  try { await pool.execute('UPDATE session_authorizations SET expires_at = TIMESTAMPADD(SECOND, -1, UTC_TIMESTAMP(3)) WHERE business_id = ?', [business]); } finally { await pool.end(); }
  await page.locator('#ajusteCantidad').fill('1'); await page.locator('#ajusteMotivo').fill('Expirado'); await page.locator('#ajusteInventarioForm button[type=submit]').click();
  await expect(page.locator('#ajusteInventarioModal')).toBeHidden(); await expect(page.locator('#authModal')).toBeVisible();
  expect((await call(page, 'products', true)).value.find(p => p.id === product.id).stock).toBe(5.125);
});
test('otro negocio no ve productos ni movimientos ajenos', async ({ page }) => {
  await login(page); await inventory(page); const item = await create(page); const product = (await call(page, 'products')).value.find(p => p.barcode === item.barcode);
  await page.locator('#logoutBtn').click(); await expect(page.locator('#loginForm button')).toBeEnabled();
  await page.locator('#loginBusinessId').fill(businessB); await page.locator('#loginUsername').fill('otheradmin'); await page.locator('#loginPassword').fill(password); await page.locator('#loginForm button').click(); await expect(page.locator('#app')).toBeVisible();
  expect((await call(page, 'products')).value.some(p => p.barcode === item.barcode)).toBe(false); expect((await call(page, 'product', product.id)).code).toBe('PRODUCT_NOT_FOUND'); expect((await call(page, 'movements', product.id)).code).toBe('PRODUCT_NOT_FOUND');
});
test('fallo de lectura no utiliza productos de Dexie como respaldo', async ({ page }) => {
  await login(page); await page.route(api + '/products?**', route => route.abort()); await page.locator('#navInventoryBtn').click(); await expect(page.locator('#connectedNotice')).toContainText('conectar'); await expect(page.locator('#inventoryView')).toBeHidden();
});
test('fallo de escritura no crea producto fantasma ni reintenta automaticamente', async ({ page }) => {
  await login(page); await inventory(page); let writes = 0; await page.route(api + '/products', route => { writes++; return route.abort(); }); await page.locator('#addNewProductBtn').click();
  for (const [id, value] of Object.entries({ prodBarcode: 'NETWORK-' + randomBytes(4).toString('hex'), prodName: 'Fallo de red', prodCost: '2', prodStock: '0' })) await page.locator('#' + id).fill(value);
  await page.locator('#productForm button[type=submit]').click(); await expect(page.locator('#customAlertMessage')).toContainText('conectar'); expect(writes).toBe(1); await expect(page.locator('#inventoryTableBody tr').filter({ hasText: 'Fallo de red' })).toHaveCount(0);
});
test('ventas y caja MySQL, compras bloqueadas, sin documentos en Dexie', async ({ page }) => {
  await login(page); await inventory(page); const item = await create(page, '3'); await page.locator('#navSalesBtn').click(); await expect(page.locator('#salesView')).toBeVisible();
  await page.locator('#productGrid .product-card').filter({ hasText: item.name }).click(); await page.locator('#processSaleBtn').click(); await expect(page.locator('#customAlertMessage')).toHaveText('Debes abrir caja antes de facturar o cobrar'); await closeAlert(page);
  await page.locator('#navPurchasesBtn').click(); await expect(page.locator('#purchasesView')).toBeVisible(); await page.locator('#addNewPurchaseBtn').click(); await expect(page.locator('#customAlertMessage')).toContainText('pendiente'); await closeAlert(page);
  await page.evaluate(async () => { await window.confirmarAnularVenta(); }); await expect(page.locator('#customAlertMessage')).toContainText('Selecciona una venta'); await closeAlert(page);
  expect((await call(page, 'products')).value.find(p => p.barcode === item.barcode).stock).toBe(3);
  await page.locator('#navCajaBtn').click(); await expect(page.locator('#cajaView')).toBeVisible(); await page.locator('#cajaEfectivoInicialInput').fill('10'); await page.locator('#abrirCajaBtn').click(); await expect(page.locator('#customAlertMessage')).toContainText('Caja abierta en MySQL'); await closeAlert(page); await expect(page.locator('#cajaAbiertaBox')).toBeVisible();
  const local = await page.evaluate(async () => Promise.all(['products', 'inventory_movements', 'sales', 'purchases', 'cajaSessions', 'abonos', 'gastos', 'sync_queue'].map(name => localDB.table(name).count()))); expect(local).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
});
test('cambio de cookie a otro negocio no reintenta una escritura recuperando CSRF', async ({ page, context }) => {
  await login(page); await page.evaluate(async () => { window.phase52Client = new window.PosApiClient(window.POS_API_BASE_URL); await window.phase52Client.me(); });
  const otherPage = await context.newPage(); await otherPage.goto('/?mode=connected'); await expect(otherPage.locator('#app')).toBeVisible();
  await otherPage.evaluate(async ({ tenant, password }) => { const client = new window.PosApiClient(window.POS_API_BASE_URL); await client.login(tenant, 'otheradmin', password); }, { tenant: businessB, password });
  await otherPage.reload(); await expect(otherPage.locator('#app')).toBeVisible();
  const barcode = 'CROSS-' + randomBytes(5).toString('hex');
  const result = await page.evaluate(async barcode => { try { await window.phase52Client.createProduct({ barcode, name: 'No cruzar', category: 'Bebidas', cost: '1', marginRetail: '0', marginWholesale: '0', retailPrice: '1', wholesalePrice: '1', stock: '0', minStock: '0' }); return 'CREATED'; } catch (error) { return error.code; } }, barcode);
  expect(result).toBe('INVALID_SESSION'); expect((await call(otherPage, 'products')).value.some(p => p.barcode === barcode)).toBe(false); await otherPage.close();
});
