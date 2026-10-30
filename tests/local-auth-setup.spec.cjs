'use strict';
/* global localDB */
const { test, expect, chromium } = require('@playwright/test');

const ownerPassword = 'Clave-Propietario-Prueba-2026!';

test('los campos de configuracion del propietario permiten mostrar y ocultar contrasenas con teclado y en movil', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('#modeDescription')).toHaveText('Acceso del propietario configurado para este equipo.');
  await page.locator('#localOwnerSetupForm').evaluate(form => form.classList.remove('hidden'));

  const password = page.locator('#localOwnerPassword');
  const passwordToggle = page.locator('#toggleLocalOwnerPasswordBtn');
  await password.fill('Clave-temporal-para-prueba');
  await password.focus();
  await page.keyboard.press('Tab');
  await expect(passwordToggle).toBeFocused();
  await page.keyboard.press('Space');
  await expect(password).toHaveAttribute('type', 'text');
  await expect(passwordToggle).toHaveAttribute('aria-label', 'Ocultar contraseña');
  await expect(passwordToggle).toHaveAttribute('aria-pressed', 'true');
  expect(await password.inputValue()).toBe('Clave-temporal-para-prueba');
  const mobileTarget = await passwordToggle.boundingBox();
  expect(mobileTarget.width).toBeGreaterThanOrEqual(44);
  expect(mobileTarget.height).toBeGreaterThanOrEqual(44);

  const confirmation = page.locator('#localOwnerPasswordConfirm');
  const confirmationToggle = page.locator('#toggleLocalOwnerPasswordConfirmBtn');
  await confirmation.fill('Clave-temporal-para-prueba');
  await confirmationToggle.click();
  await expect(confirmation).toHaveAttribute('type', 'text');
  await expect(confirmationToggle).toHaveAttribute('aria-pressed', 'true');
  await confirmationToggle.click();
  await expect(confirmation).toHaveAttribute('type', 'password');
  await expect(confirmationToggle).toHaveAttribute('aria-label', 'Mostrar contraseña');

  await page.setViewportSize({ width: 1280, height: 900 });
  const desktopTarget = await confirmationToggle.boundingBox();
  expect(desktopTarget.width).toBeGreaterThanOrEqual(40);
  expect(desktopTarget.height).toBeGreaterThanOrEqual(40);
});

test('una instalación local nueva solicita configurar al propietario antes de mostrar el acceso', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    await localDB.transaction('rw', localDB.tables, async () => {
      for (const table of localDB.tables) await table.clear();
    });
    await window.PosLocalAuth.load(localDB);
  });
  await page.reload();
  await expect(page.locator('#localLicenseGate')).toBeVisible();
  await expect(page.locator('#localOwnerSetupForm')).toBeHidden();
  await expect(page.locator('#loginForm')).toBeHidden();
  await expect(page.locator('#app')).toBeHidden();
  const initial = await page.evaluate(async () => ({
    version: localDB.verno,
    owner: await localDB.localAuth.get('owner'),
    productCount: await localDB.products.count(),
    saleCount: await localDB.sales.count()
  }));
  expect(initial).toEqual({ version: 11, owner: undefined, productCount: 0, saleCount: 0 });
});

async function seedExistingData(page) {
  return page.evaluate(async () => {
    const request = indexedDB.open('POS_OfflineDB');
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction(['products', 'sales'], 'readwrite');
    const business_id = window.PosLocalIdentity.currentId();
    tx.objectStore('products').put({ id: 'existing-product', business_id, name: 'Producto existente', barcode: 'LOCAL-EXISTING-01', stock: 7, cost: '3.25' });
    tx.objectStore('sales').put({ id: 'existing-sale', business_id, numero: 41, total: '12.50', fecha: '2025-03-04', estado: 'COMPLETADA' });
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    db.close();
  });
}

async function snapshotExistingData(page) {
  return page.evaluate(async () => {
    const request = indexedDB.open('POS_OfflineDB');
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const values = await Promise.all(['products', 'sales'].map(name => new Promise((resolve, reject) => {
      const tx = db.transaction(name, 'readonly');
      const query = tx.objectStore(name).getAll();
      query.onsuccess = () => resolve(query.result);
      query.onerror = () => reject(query.error);
    })));
    db.close();
    return values;
  });
}

test('configura un propietario personalizado sin alterar datos comerciales ni incluir la clave en el paquete', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#loginScreen')).toBeVisible();
  await expect(page.locator('#localOwnerSetupForm')).toBeHidden();
  await seedExistingData(page);
  const before = await snapshotExistingData(page);

  await page.evaluate(async () => { await localDB.localAuth.delete('owner'); localStorage.removeItem('posLoginFailState'); });
  await page.reload();
  await expect(page.locator('#localOwnerSetupForm')).toBeVisible();
  await expect(page.locator('#loginForm')).toBeHidden();

  await page.locator('#localOwnerUsername').fill('propietaria');
  await page.locator('#localOwnerPassword').fill('corta');
  await page.locator('#localOwnerPasswordConfirm').fill('corta');
  await page.locator('#localOwnerSetupSubmit').click();
  await expect(page.locator('#localOwnerSetupMessage')).toBeVisible();
  await expect(page.locator('#localOwnerSetupMessage')).toContainText('12 caracteres');
  expect(await page.evaluate(() => localDB.localAuth.get('owner'))).toBeUndefined();

  await page.locator('#localOwnerPassword').fill(ownerPassword);
  await page.locator('#localOwnerPasswordConfirm').fill('Otra-clave-distinta-2026!');
  await page.locator('#localOwnerSetupSubmit').click();
  await expect(page.locator('#localOwnerSetupMessage')).toBeVisible();
  await expect(page.locator('#localOwnerSetupMessage')).toContainText('no coinciden');
  expect(await page.evaluate(() => localDB.localAuth.get('owner'))).toBeUndefined();

  await page.locator('#localOwnerPasswordConfirm').fill(ownerPassword);
  await page.locator('#localOwnerSetupSubmit').click();
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#roleBadge')).toHaveText('Propietario');
  await expect(page.locator('#sellerName')).toHaveText('propietaria');
  await expect(page.locator('#navUsersBtn')).toBeHidden();
  await expect(page.locator('#localOwnerSetupForm')).toBeHidden();

  const stored = await page.evaluate(() => localDB.localAuth.get('owner'));
  expect(stored).toMatchObject({ version: 1, algorithm: 'PBKDF2-HMAC-SHA-256', username: 'propietaria' });
  expect(stored.iterations).toBeGreaterThanOrEqual(600000);
  expect(stored.salt).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(stored.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(JSON.stringify(stored)).not.toContain(ownerPassword);
  expect(await page.evaluate(() => localStorage.getItem('posLocalOwnerAuthV1'))).toBeNull();
  expect(await snapshotExistingData(page)).toEqual(before);

  await page.locator('#logoutBtn').click();
  await expect(page.locator('#loginForm')).toBeVisible();
  await page.locator('#loginUsername').fill('propietaria');
  await page.locator('#loginPassword').fill('Prueba-Local-Propietario-2026!');
  await page.locator('#loginForm button[type="submit"]').click();
  await expect(page.locator('#loginError')).toHaveText('Credenciales incorrectas');
  await page.locator('#loginUsername').fill('propietaria');
  await page.locator('#loginPassword').fill(ownerPassword);
  await page.locator('#loginForm button[type="submit"]').click();
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#inventoryView')).toBeHidden();

  await page.locator('#navUpgradeBtn').click();
  await page.locator('#migrationExportGenerateBtn').click();
  await expect(page.locator('#migrationExportReview')).toBeVisible();
  await expect(page.locator('#migrationExportReview')).not.toContainText('PBKDF2-HMAC-SHA-256');
  await expect(page.locator('#migrationExportReview')).not.toContainText('posLocalOwnerAuthV1');
});

test('instalaciones antiguas muestran la configuración inicial sin borrar sus datos comerciales', async ({ page }) => {
  await page.goto('/');
  await seedExistingData(page);
  await page.evaluate(async () => localDB.localAuth.delete('owner'));
  await page.reload();
  await expect(page.locator('#localOwnerSetupForm')).toBeVisible();
  await expect(page.locator('#loginForm')).toBeHidden();
  await expect(page.locator('#localOwnerSetupNote')).toContainText('se conservarán');
  await expect(page.locator('#loginScreen')).toBeVisible();
  await expect(page.locator('#app')).toBeHidden();
  expect(await snapshotExistingData(page)).toHaveLength(2);
});

test('la configuración inicial del propietario funciona en una pantalla móvil', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  await page.evaluate(async () => {
    const business_id = window.PosLocalIdentity.currentId();
    await localDB.products.put({ id: 'legacy-mobile-owner-fixture', business_id, name: 'Producto heredado de prueba', barcode: 'LEGACY-MOBILE-01', stock: 1, cost: '1.00' });
    await localDB.localAuth.delete('owner');
  });
  await page.reload();
  await expect(page.locator('#localOwnerSetupForm')).toBeVisible();
  await expect(page.locator('#localOwnerUsername')).toBeVisible();
  await expect(page.locator('#localOwnerPassword')).toBeVisible();
  await expect(page.locator('#localOwnerSetupSubmit')).toBeVisible();
  const layout = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
  expect(layout.document).toBeLessThanOrEqual(layout.viewport);
});

test('el modo conectado conserva su inicio de sesión y no muestra el alta de propietario local', async ({ page }) => {
  await page.route('**/api/**', route => route.fulfill({
    status: 401,
    contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'INVALID_SESSION' } })
  }));
  await page.goto('/?mode=connected');
  await expect(page.locator('#loginScreen')).toBeVisible();
  await expect(page.locator('#authMode')).toHaveValue('connected');
  await expect(page.locator('#localOwnerSetupForm')).toBeHidden();
  await expect(page.locator('#loginForm')).toBeVisible();
  await expect(page.locator('#adminUsernameGroup')).not.toHaveClass(/hidden/);
  await expect(page.locator('#grantAdminUsername')).toBeEnabled();
  await expect(page.locator('#grantAdminUsername')).toHaveAttribute('required', '');
});

test('actualiza la estructura local anterior sin perder registros comerciales', async () => {
  const origin = test.info().project.use.baseURL;
  const executablePath = process.env.POS_TEST_BROWSER_EXECUTABLE;
  const isolatedBrowser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const context = await isolatedBrowser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(new URL('/404.html', origin).href);
    const legacyStoreNames = await page.evaluate(async () => {
    if ((await indexedDB.databases()).some(database => database.name === 'POS_OfflineDB')) {
      await new Promise((resolve, reject) => {
        const deletion = indexedDB.deleteDatabase('POS_OfflineDB');
        deletion.onsuccess = resolve;
        deletion.onerror = () => reject(deletion.error);
        deletion.onblocked = () => reject(new Error('La base aislada de prueba quedó bloqueada.'));
      });
    }
    const stores = {
      products: ['id', ['barcode', 'name', 'category', 'business_id', 'deleted']],
      clients: ['id', ['name', 'phone', 'business_id']],
      suppliers: ['id', ['name', 'business_id']],
      sales: ['id', ['numero', 'fecha', 'business_id']],
      purchases: ['id', ['fecha', 'business_id']],
      sync_queue: ['id', ['action', 'table_name', 'status'], true],
      cajaSessions: ['id', ['business_id', 'estado', 'fechaAperturaTS'], true],
      gastos: ['id', ['business_id', 'fecha', 'categoria', 'sessionId'], true],
      abonos: ['id', ['business_id', 'tipo', 'referenciaId', 'monto', 'fecha', 'fechaTS', 'usuario'], true],
      inventory_movements: ['id', ['business_id', 'producto_id', 'fechaTS'], true],
      audit_logs: ['id', ['business_id', 'fechaTS', 'usuario', 'modulo', 'accion'], true],
      saleOrders: ['id', ['business_id', 'status', 'createdAt']]
    };
    const records = {
      products: [
        { id: 'v10-product', name: 'Producto anterior', barcode: 'V10-001', category: 'Pruebas', stock: 9, cost: '3.25', price: '6.00', business_id: '00000000-0000-0000-0000-000000000000' },
        { id: 'v10-product-2', name: 'Producto adicional', barcode: 'V10-002', category: 'Pruebas', stock: 2, cost: '7.10', price: '10.00', business_id: '00000000-0000-0000-0000-000000000000' }
      ],
      clients: [{ id: 'v10-client', name: 'Cliente anterior', phone: '5550101', creditLimit: '80.00', balance: '31.25', debt: '31.25', deudaSinFactura: '0.00', business_id: '00000000-0000-0000-0000-000000000000' }],
      suppliers: [{ id: 'v10-supplier', name: 'Proveedor anterior', phone: '5550102', balance: '4.75', business_id: '00000000-0000-0000-0000-000000000000' }],
      sales: [{ id: 'v10-sale', numero: 18, total: '41.25', subtotal: '45.00', descuento: '3.75', estado: 'COMPLETADA', metodo: 'Crédito', fecha: '2024-05-06', clienteId: 'v10-client', items: [{ productId: 'v10-product', quantity: 3, price: '15.00', cost: '3.25' }], business_id: '00000000-0000-0000-0000-000000000000' }],
      purchases: [{ id: 'v10-purchase', fecha: '2024-05-07', total: '18.00', saldoPendiente: '4.75', proveedorId: 'v10-supplier', items: [{ productId: 'v10-product-2', quantity: 2, cost: '7.10' }], business_id: '00000000-0000-0000-0000-000000000000' }],
      sync_queue: [{ id: 13, action: 'CREATE', table_name: 'sales', status: 'PENDING', payload: { reference: 'v10-sale' } }],
      cajaSessions: [{ id: 8, estado: 'CERRADA', fechaAperturaTS: 1714990000000, saldoInicial: '100.00', saldoFinal: '141.25', diferencia: '0.00', business_id: '00000000-0000-0000-0000-000000000000' }],
      gastos: [{ id: 9, fecha: '2024-05-08', categoria: 'Servicios', monto: '2.00', sessionId: 8, business_id: '00000000-0000-0000-0000-000000000000' }],
      abonos: [{ id: 10, tipo: 'cliente', referenciaId: 'v10-client', facturaId: 'v10-sale', monto: '10.00', fecha: '2024-05-09', fechaTS: 1715240000000, usuario: 'Propietario anterior', business_id: '00000000-0000-0000-0000-000000000000' }],
      inventory_movements: [{ id: 11, producto_id: 'v10-product', tipo: 'SALIDA', cantidad: 3, stockAnterior: 12, stockNuevo: 9, costo: '3.25', fechaTS: 1714990000000, business_id: '00000000-0000-0000-0000-000000000000' }],
      audit_logs: [{ id: 12, fechaTS: 1714990000000, usuario: 'Propietario anterior', modulo: 'Ventas', accion: 'VENTA_REGISTRADA', business_id: '00000000-0000-0000-0000-000000000000' }],
      saleOrders: [{ id: 'v10-order', status: 'PENDING', createdAt: '2024-05-10T12:00:00.000Z', items: [{ productId: 'v10-product', quantity: 1 }], business_id: '00000000-0000-0000-0000-000000000000' }]
    };
    const legacyStoreNames = Object.keys(stores);
    const request = indexedDB.open('POS_OfflineDB', 100);
    const db = await new Promise((resolve, reject) => {
      request.onupgradeneeded = () => {
        const database = request.result;
        for (const [name, [keyPath, indexes, autoIncrement = false]] of Object.entries(stores)) {
          const store = database.createObjectStore(name, { keyPath, autoIncrement });
          for (const index of indexes) store.createIndex(index, index, { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = db.transaction(legacyStoreNames, 'readwrite');
    for (const [name, values] of Object.entries(records)) for (const record of values) transaction.objectStore(name).put(record);
    await new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); });
    db.close();
    return Object.keys(stores);
    });

    const beforeUpgrade = await page.evaluate(async () => {
      const request = indexedDB.open('POS_OfflineDB');
      const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const result = {};
      for (const name of Array.from(db.objectStoreNames)) {
        result[name] = await new Promise((resolve, reject) => {
          const tx = db.transaction(name, 'readonly');
          const query = tx.objectStore(name).getAll();
          query.onsuccess = () => resolve(query.result);
          query.onerror = () => reject(query.error);
        });
      }
      db.close();
      return result;
    });

    await page.goto(new URL('/', origin).href);
    await expect(page.locator('#localOwnerSetupForm')).toBeVisible();
    const upgraded = await page.evaluate(async storeNames => {
      const data = {};
      for (const name of storeNames) data[name] = await localDB.table(name).toArray();
      return { version: localDB.verno, data, authState: window.PosLocalAuth.status() };
    }, legacyStoreNames);
    expect(upgraded.version).toBe(11);
    expect(upgraded.data).toEqual(beforeUpgrade);
    expect(upgraded.data.products).toHaveLength(2);
    expect(upgraded.data.sales[0]).toMatchObject({ total: '41.25', subtotal: '45.00', descuento: '3.75', clienteId: 'v10-client' });
    expect(upgraded.data.purchases[0]).toMatchObject({ total: '18.00', saldoPendiente: '4.75', proveedorId: 'v10-supplier' });
    expect(upgraded.data.abonos[0]).toMatchObject({ referenciaId: 'v10-client', facturaId: 'v10-sale', monto: '10.00' });
    expect(upgraded.data.inventory_movements[0]).toMatchObject({ producto_id: 'v10-product', cantidad: 3, stockAnterior: 12, stockNuevo: 9 });
    expect(upgraded.data.cajaSessions[0]).toMatchObject({ saldoInicial: '100.00', saldoFinal: '141.25', diferencia: '0.00' });
    expect(upgraded.data.saleOrders[0]).toMatchObject({ id: 'v10-order', status: 'PENDING' });
    expect(upgraded.authState).toBe('missing');

    await page.locator('#localOwnerUsername').fill('propietaria');
    await page.locator('#localOwnerPassword').fill(ownerPassword);
    await page.locator('#localOwnerPasswordConfirm').fill(ownerPassword);
    await page.locator('#localOwnerSetupSubmit').click();
    await expect(page.locator('#app')).toBeVisible();
    const afterOwnerSetup = await page.evaluate(async storeNames => {
      const data = {};
      for (const name of storeNames) data[name] = await localDB.table(name).toArray();
      return data;
    }, legacyStoreNames);
    for (const [name, originalRows] of Object.entries(beforeUpgrade)) {
      expect(afterOwnerSetup[name]).toEqual(expect.arrayContaining(originalRows));
    }
    expect(afterOwnerSetup.clients[0]).toMatchObject({ debt: '31.25', deudaSinFactura: '0.00' });
    expect(afterOwnerSetup.sales[0]).toMatchObject({ total: '41.25', metodo: 'Crédito' });
    expect(afterOwnerSetup.abonos[0]).toMatchObject({ monto: '10.00', referenciaId: 'v10-client', facturaId: 'v10-sale' });
    expect(afterOwnerSetup.cajaSessions[0]).toMatchObject({ saldoInicial: '100.00', saldoFinal: '141.25', diferencia: '0.00' });

    await page.locator('#logoutBtn').click();
    await expect(page.locator('#loginForm')).toBeVisible();
    for (const [username, password] of [['admin', '1234'], ['andres', '4321'], ['propietaria', '4321']]) {
      await page.locator('#loginUsername').fill(username);
      await page.locator('#loginPassword').fill(password);
      await page.evaluate(() => localStorage.removeItem('posLoginFailState'));
      await page.locator('#loginForm button[type="submit"]').click();
      await expect(page.locator('#loginError')).toHaveText('Credenciales incorrectas');
      await expect(page.locator('#app')).toBeHidden();
    }
    await page.locator('#loginUsername').fill('propietaria');
    await page.locator('#loginPassword').fill(ownerPassword);
    await page.locator('#loginForm button[type="submit"]').click();
    await expect(page.locator('#app')).toBeVisible();
  } finally { await context.close(); await isolatedBrowser.close(); }
});
