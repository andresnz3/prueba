'use strict';
/* global localDB */

const { test, expect, chromium } = require('@playwright/test');
const { createHash, generateKeyPairSync, randomBytes, sign } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const origin = process.env.POS_LOCAL_TEST_ORIGIN || 'http://127.0.0.1:5501';
const keyId = 'pwa-qa-ephemeral';
const serverKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicJwk = serverKeys.publicKey.export({ format: 'jwk' });
const corsHeaders = {
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-POS-License-Request',
  'Access-Control-Max-Age': '600',
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8'
};
const b64url = value => Buffer.from(value).toString('base64url');
const installationHash = id => createHash('sha256').update('pos-local-installation-v1\0' + id).digest('hex');
function signedEnvelope(payload) {
  const body = b64url(Buffer.from(JSON.stringify({ ...payload, keyId })));
  const signature = sign('sha256', Buffer.from(body), { key: serverKeys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return body + '.' + signature;
}

test('shell PWA permite reabrir el modo local sin red y no guarda datos comerciales en Cache Storage', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-pwa-offline-'));
  const executablePath = process.env.POS_TEST_BROWSER_EXECUTABLE;
  const publicRoot = path.resolve(__dirname, '..', 'dist');
  let context;
  let temporaryWorkerPath = null;
  let ownsTemporaryWorker = false;
  let updatedCacheName;
  let offline = false;
  let offlineApiAttempts = 0;
  let activationRequests = 0;
  let statusRequests = 0;
  const challengePurpose = new Map();
  const installation = { id: null, licenseId: 'QA-PWA-001' };
  const apiHandler = async route => {
    if (offline) {
      offlineApiAttempts += 1;
      return route.abort('internetdisconnected');
    }
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: corsHeaders });
    const body = request.postDataJSON();
    const requestPath = new URL(request.url()).pathname;
    if (requestPath.endsWith('/challenge')) {
      const challengeId = randomBytes(16).toString('hex');
      challengePurpose.set(challengeId, body.purpose);
      return route.fulfill({ status: 200, headers: corsHeaders, body: JSON.stringify({
        challengeId,
        challenge: b64url(randomBytes(32)),
        expiresAt: new Date(Date.now() + 300000).toISOString()
      }) });
    }
    if (requestPath.endsWith('/activate')) {
      activationRequests += 1;
      if (challengePurpose.get(body.challengeId) !== 'ACTIVATE') return route.fulfill({ status: 400, headers: corsHeaders, body: '{}' });
      installation.id = body.installationId;
      return route.fulfill({ status: 200, headers: corsHeaders, body: JSON.stringify({
        permit: signedEnvelope({ type: 'POS_LOCAL_LICENSE', version: 1, licenseId: installation.licenseId, installationHash: installationHash(installation.id), issuedAt: new Date().toISOString(), permanent: true }),
        licenseId: installation.licenseId,
        status: 'ACTIVE'
      }) });
    }
    if (requestPath.endsWith('/status')) {
      statusRequests += 1;
      if (challengePurpose.get(body.challengeId) !== 'STATUS') return route.fulfill({ status: 400, headers: corsHeaders, body: '{}' });
      return route.fulfill({ status: 200, headers: corsHeaders, body: JSON.stringify({
        signedStatus: signedEnvelope({ type: 'POS_LOCAL_LICENSE_STATUS', version: 1, licenseId: installation.licenseId, installationHash: installationHash(installation.id), status: 'ACTIVE', checkedAt: new Date().toISOString() }),
        status: 'ACTIVE'
      }) });
    }
    return route.fulfill({ status: 404, headers: corsHeaders, body: '{}' });
  };

  const launch = () => chromium.launchPersistentContext(profile, {
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
    serviceWorkers: 'allow'
  });

  try {
    context = await launch();
    await context.addInitScript(({ id, jwk }) => {
      window.POS_LOCAL_LICENSE_PUBLIC_KEYS = { [id]: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } };
    }, { id: keyId, jwk: publicJwk });
    await context.route('http://127.0.0.1:3000/api/local-license/**', apiHandler);
    let page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(origin + '/?mode=local');
    await expect(page.locator('#localLicenseGate')).toBeVisible();
    const activationInputColor = await page.locator('#localLicenseCode').evaluate(input => getComputedStyle(input).backgroundColor);
    expect(activationInputColor).not.toBe('rgb(0, 0, 0)');
    const manifestResponse = await page.request.get(origin + '/manifest.webmanifest');
    expect(manifestResponse.ok()).toBeTruthy();
    expect(manifestResponse.headers()['content-type']).toContain('application/manifest+json');
    const manifest = await manifestResponse.json();
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/?mode=local');
    expect(manifest.icons).toEqual(expect.arrayContaining([
      expect.objectContaining({ sizes: '192x192', type: 'image/png' }),
      expect.objectContaining({ sizes: '512x512', type: 'image/png' })
    ]));
    for (const icon of manifest.icons) {
      const iconResponse = await page.request.get(new URL(icon.src, origin).href);
      expect(iconResponse.ok()).toBe(true);
    }
    const workerResponse = await page.request.get(origin + '/service-worker.js');
    const workerSource = await workerResponse.text();
    expect(workerResponse.ok()).toBe(true);
    expect(workerSource).not.toContain('__POS_');
    expect(workerSource).not.toContain('skipWaiting');
    expect(workerSource).not.toContain('clients.claim');
    expect(workerSource).toContain("url.pathname === '/api' || url.pathname.startsWith('/api/')");
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.locator('#localLicenseCode').fill('POSL-12345678-90ABCDEF-12345678-90ABCDEF-12345678-90ABCDEF');
    offline = true;
    await context.setOffline(true);
    await page.locator('#localLicenseSubmit').click();
    await expect(page.locator('#localLicenseMessage')).toContainText('Comprueba tu conexión');
    await expect(page.locator('#localOwnerSetupForm')).toBeHidden();
    expect(activationRequests).toBe(0);
    offline = false;
    await context.setOffline(false);
    await page.locator('#localLicenseSubmit').click();
    await expect(page.locator('#localOwnerSetupForm')).toBeVisible();
    await page.locator('#localOwnerUsername').fill('propietaria-qa');
    await page.locator('#localOwnerPassword').fill('Clave-PWA-QA-2026-Temporal!');
    await page.locator('#localOwnerPasswordConfirm').fill('Clave-PWA-QA-2026-Temporal!');
    await page.locator('#localOwnerSetupSubmit').click();
    await expect(page.locator('#app')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.PosLocalPwa.storagePersistence())).not.toBe('not-requested');
    expect(activationRequests).toBe(1);
    await page.reload();
    await page.evaluate(() => navigator.serviceWorker.ready);
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    const staticCache = await page.evaluate(async () => {
      const names = await caches.keys();
      const urls = [];
      const bodies = [];
      for (const name of names) {
        const cache = await caches.open(name);
        for (const request of await cache.keys()) {
          urls.push(new URL(request.url).pathname);
          const response = await cache.match(request);
          if (response) bodies.push(await response.clone().text().catch(() => ''));
        }
      }
      return { names, urls, bodies };
    });
    expect(staticCache.names.some(name => name.startsWith('pos-pwa-shell-'))).toBe(true);
    expect(staticCache.urls.length).toBeGreaterThan(10);
    expect(staticCache.urls.every(url => !url.startsWith('/api/'))).toBe(true);
    expect(staticCache.bodies).not.toContain('POSL-12345678');
    expect(staticCache.bodies).not.toContain('propietaria-qa');
    expect(staticCache.bodies).not.toContain('Clave-PWA-QA');

    await context.close();
    context = null;
    offline = true;
    offlineApiAttempts = 0;
    context = await launch();
    await context.addInitScript(({ id, jwk }) => {
      window.POS_LOCAL_LICENSE_PUBLIC_KEYS = { [id]: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } };
    }, { id: keyId, jwk: publicJwk });
    await context.route('http://127.0.0.1:3000/api/local-license/**', apiHandler);
    await context.setOffline(true);
    page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(origin + '/?mode=local', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#loginForm')).toBeVisible();
    const loginInputColor = await page.locator('#loginPassword').evaluate(input => getComputedStyle(input).backgroundColor);
    expect(loginInputColor).not.toBe('rgb(0, 0, 0)');
    await page.locator('#loginUsername').fill('propietaria-qa');
    await page.locator('#loginPassword').fill('Clave-PWA-QA-2026-Temporal!');
    await page.locator('#loginForm button[type="submit"]').click();
    await expect(page.locator('#app')).toBeVisible();
    expect(await page.evaluate(() => window.PosLocalLicense.status())).toBe('ACTIVE');

    await page.locator('#navInventoryBtn').click();
    await page.locator('#addNewProductBtn').click();
    await page.locator('#prodBarcode').fill('PWA-OFFLINE-001');
    await page.locator('#prodName').fill('Producto PWA sin conexión');
    await page.locator('#prodCost').fill('5');
    await page.locator('#prodRetail').fill('10');
    await page.locator('#prodWholesale').fill('8');
    await page.locator('#prodStock').fill('5');
    await page.locator('#prodMinStock').fill('0');
    await page.locator('#productForm button[type="submit"]').click();
    await expect(page.locator('#productModal')).toBeHidden();
    await page.locator('#customAlertModal .close-modal-btn').click();

    await page.locator('#navClientsBtn').click();
    await page.locator('#addNewClientBtn').click();
    await page.locator('#clientName').fill('Cliente PWA ficticio');
    await page.locator('#clientLimit').fill('500');
    await page.locator('#clientDebt').fill('0');
    await page.locator('#clientForm button[type="submit"]').click();
    await expect(page.locator('#clientsTableBody')).toContainText('Cliente PWA ficticio');

    await page.locator('#navSuppliersBtn').click();
    await page.locator('#addNewSupplierBtn').click();
    await page.locator('#suppName').fill('Proveedor PWA ficticio');
    await page.locator('#suppContact').fill('Contacto de prueba');
    await page.locator('#suppPhone').fill('88880000');
    await page.locator('#supplierForm button[type="submit"]').click();
    await page.locator('#customAlertModal .close-modal-btn').click();

    await page.locator('#navCajaBtn').click();
    await page.locator('#cajaEfectivoInicialInput').fill('20');
    await page.locator('#abrirCajaBtn').click();
    await expect(page.locator('#cajaAbiertaBox')).toBeVisible();

    await page.locator('#navSalesBtn').click();
    await page.locator('input[name="paymentMethod"][value="cash"]').check();
    await page.locator('#barcodeInput').fill('PWA-OFFLINE-001');
    await page.locator('#addBarcodeBtn').click();
    await page.locator('#processSaleBtn').click();
    await page.locator('#cashReceivedInput').fill('10');
    await page.locator('#confirmCashBtn').click();
    await expect(page.locator('#ticketModal')).toBeVisible();
    await page.locator('#newSaleBtn').click();

    await page.locator('#navPurchasesBtn').click();
    await page.locator('#addNewPurchaseBtn').click();
    await page.locator('#purchSupplier').fill('Proveedor PWA ficticio');
    await page.locator('#purchInvoice').fill('PWA-QA-CREDIT-001');
    await page.locator('#purchType').selectOption('credito');
    await page.locator('#purchProductTemp').fill('PWA-OFFLINE-001');
    await page.locator('#purchQtyTemp').fill('2');
    await page.locator('#purchCostTemp').fill('5');
    await page.locator('#btnAddItemToPurch').click();
    await page.locator('#purchaseForm button[type="submit"]').click();
    await expect(page.locator('#purchaseModal')).toBeHidden();
    await page.locator('#customAlertModal .close-modal-btn').click();

    await page.locator('#navReportesBtn').click();
    await expect(page.locator('#reportesView')).toBeVisible();
    const snapshot = await page.evaluate(async () => ({
      product: await localDB.products.where('barcode').equals('PWA-OFFLINE-001').first(),
      clients: await localDB.clients.where('name').equals('Cliente PWA ficticio').count(),
      suppliers: await localDB.suppliers.where('name').equals('Proveedor PWA ficticio').count(),
      sales: await localDB.sales.toArray(),
      purchases: await localDB.purchases.toArray(),
      cash: await localDB.cajaSessions.toArray()
    }));
    expect(snapshot.product.stock).toBe(6);
    expect(snapshot.clients).toBe(1);
    expect(snapshot.suppliers).toBe(1);
    expect(snapshot.sales).toHaveLength(1);
    expect(snapshot.purchases).toHaveLength(1);
    expect(snapshot.cash[0].movimientos.length).toBeGreaterThan(0);
    expect(offlineApiAttempts).toBe(0);

    await context.close();
    context = null;
    offline = true;
    context = await launch();
    await context.addInitScript(({ id, jwk }) => {
      window.POS_LOCAL_LICENSE_PUBLIC_KEYS = { [id]: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } };
    }, { id: keyId, jwk: publicJwk });
    await context.route('http://127.0.0.1:3000/api/local-license/**', apiHandler);
    await context.setOffline(true);
    page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(origin + '/?mode=local', { waitUntil: 'domcontentloaded' });
    await page.locator('#loginUsername').fill('propietaria-qa');
    await page.locator('#loginPassword').fill('Clave-PWA-QA-2026-Temporal!');
    await page.locator('#loginForm button[type="submit"]').click();
    await expect(page.locator('#app')).toBeVisible();
    const afterBrowserRestart = await page.evaluate(async () => ({
      product: await localDB.products.where('barcode').equals('PWA-OFFLINE-001').first(),
      sales: await localDB.sales.count(),
      purchases: await localDB.purchases.count(),
      clients: await localDB.clients.where('name').equals('Cliente PWA ficticio').count(),
      suppliers: await localDB.suppliers.where('name').equals('Proveedor PWA ficticio').count(),
      cash: await localDB.cajaSessions.toArray()
    }));
    expect(afterBrowserRestart.product.stock).toBe(6);
    expect(afterBrowserRestart.sales).toBe(1);
    expect(afterBrowserRestart.purchases).toBe(1);
    expect(afterBrowserRestart.clients).toBe(1);
    expect(afterBrowserRestart.suppliers).toBe(1);
    expect(afterBrowserRestart.cash).toHaveLength(1);
    expect(afterBrowserRestart.cash[0].movimientos).toHaveLength(1);
    expect(offlineApiAttempts).toBe(0);
    const commercialCacheContent = await page.evaluate(async () => {
      const names = await caches.keys();
      const paths = [];
      const bodies = [];
      for (const name of names) {
        const cache = await caches.open(name);
        for (const request of await cache.keys()) {
          paths.push(new URL(request.url).pathname);
          const response = await cache.match(request);
          if (response) bodies.push(await response.clone().text().catch(() => ''));
        }
      }
      return { paths, text: bodies.join('\n') };
    });
    expect(commercialCacheContent.paths.every(url => !url.startsWith('/api/'))).toBe(true);
    expect(commercialCacheContent.text).not.toContain('Producto PWA sin conexión');
    expect(commercialCacheContent.text).not.toContain('Cliente PWA ficticio');
    expect(commercialCacheContent.text).not.toContain('Proveedor PWA ficticio');

    await context.setOffline(false);
    offline = false;
    const status = await page.evaluate(() => window.PosLocalLicense.checkStatus());
    expect(status).toBe('ACTIVE');
    expect(statusRequests).toBeGreaterThan(0);
    const afterReconnect = await page.evaluate(async () => ({
      products: await localDB.products.count(), sales: await localDB.sales.count(), purchases: await localDB.purchases.count()
    }));
    expect(afterReconnect.products).toBeGreaterThan(0);
    expect(afterReconnect.sales).toBe(1);
    expect(afterReconnect.purchases).toBe(1);

    temporaryWorkerPath = path.join(publicRoot, 'service-worker-update-qa.js');
    if (!temporaryWorkerPath.startsWith(publicRoot + path.sep) || fs.existsSync(temporaryWorkerPath)) {
      throw new Error('No se puede crear el archivo temporal de actualización PWA.');
    }
    let updatedWorker = fs.readFileSync(path.join(publicRoot, 'service-worker.js'), 'utf8');
    const cacheDeclaration = updatedWorker.match(/const CACHE_NAME = '([^']+)'/);
    if (!cacheDeclaration) throw new Error('No se encontró la versión de caché del service worker generado.');
    updatedCacheName = 'pos-pwa-shell-qa-' + randomBytes(6).toString('hex');
    updatedWorker = updatedWorker.replace(cacheDeclaration[0], "const CACHE_NAME = '" + updatedCacheName + "'");
    fs.writeFileSync(temporaryWorkerPath, updatedWorker, { encoding: 'utf8', flag: 'wx' });
    ownsTemporaryWorker = true;
    await page.evaluate(async () => navigator.serviceWorker.register('/service-worker-update-qa.js', { scope: '/', updateViaCache: 'none' }));
    await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration('/'))?.waiting?.scriptURL || '')).toContain('/service-worker-update-qa.js');
    const waitingState = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration('/');
      return {
        active: registration?.active?.scriptURL || '',
        waiting: registration?.waiting?.scriptURL || '',
        controller: navigator.serviceWorker.controller?.scriptURL || '',
        cacheNames: await caches.keys()
      };
    });
    expect(waitingState.active).toContain('/service-worker.js');
    expect(waitingState.controller).toContain('/service-worker.js');
    expect(waitingState.waiting).toContain('/service-worker-update-qa.js');
    expect(waitingState.cacheNames).toContain(updatedCacheName);

    await context.close();
    context = null;
    context = await launch();
    await context.addInitScript(({ id, jwk }) => {
      window.POS_LOCAL_LICENSE_PUBLIC_KEYS = { [id]: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } };
    }, { id: keyId, jwk: publicJwk });
    await context.route('http://127.0.0.1:3000/api/local-license/**', apiHandler);
    page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(origin + '/offline.html', { waitUntil: 'domcontentloaded' });
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL || '')).toContain('/service-worker-update-qa.js');
    await expect(page.getByRole('heading', { name: 'No se pudo abrir el POS' })).toBeVisible();
    const updateResult = await page.evaluate(async () => {
      const names = await caches.keys();
      const request = indexedDB.open('POS_OfflineDB');
      const database = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const transaction = database.transaction('products', 'readonly');
      const productsRequest = transaction.objectStore('products').getAll();
      const products = await new Promise((resolve, reject) => {
        productsRequest.onsuccess = () => resolve(productsRequest.result);
        productsRequest.onerror = () => reject(productsRequest.error);
      });
      database.close();
      return { names, products };
    });
    expect(updateResult.names.filter(name => name.startsWith('pos-pwa-shell-'))).toEqual([updatedCacheName]);
    expect(updateResult.products.find(product => product.barcode === 'PWA-OFFLINE-001')?.stock).toBe(6);
    expect(pageErrors).toEqual([]);
  } finally {
    if (context) await context.close();
    if (ownsTemporaryWorker && temporaryWorkerPath && temporaryWorkerPath.startsWith(publicRoot + path.sep)) fs.unlinkSync(temporaryWorkerPath);
    const resolved = path.resolve(profile);
    if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('pos-pwa-offline-')) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
});

test('la pantalla de respaldo sin conexión es legible en escritorio y móvil', async ({ page }) => {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto('/offline.html');
    await expect(page.getByRole('heading', { name: 'No se pudo abrir el POS' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Intentar de nuevo' })).toBeVisible();
    const layout = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      background: getComputedStyle(document.documentElement).backgroundColor,
      cardBackground: getComputedStyle(document.querySelector('main')).backgroundColor
    }));
    expect(layout.document).toBeLessThanOrEqual(layout.viewport);
    expect(layout.background).toBe('rgb(243, 245, 248)');
    expect(layout.cardBackground).toBe('rgb(255, 255, 255)');
  }
});

test('Docker y Nginx publican el shell PWA y excluyen APIs del caché', () => {
  const root = path.resolve(__dirname, '..');
  const dockerfile = fs.readFileSync(path.join(root, 'docker/frontend.Dockerfile'), 'utf8');
  const dockerIgnore = fs.readFileSync(path.join(root, 'docker/frontend.Dockerfile.dockerignore'), 'utf8');
  const nginx = fs.readFileSync(path.join(root, 'docker/nginx/default.conf'), 'utf8');
  const apiConfigCopy = dockerfile.indexOf('COPY docker/frontend/api-config.js ./api-config.js');
  const buildCommand = dockerfile.indexOf('RUN node scripts/build-static.cjs');
  expect(dockerfile).toContain('COPY assets/pwa/ ./assets/pwa/');
  expect(dockerfile).toContain('offline.html manifest.webmanifest pwa.js service-worker.js');
  expect(apiConfigCopy).toBeGreaterThanOrEqual(0);
  expect(buildCommand).toBeGreaterThan(apiConfigCopy);
  expect(dockerIgnore).toContain('!assets/pwa/**');
  expect(nginx).toContain('default_type application/manifest+json;');
  expect(nginx).toContain('location = /manifest.webmanifest');
  expect(nginx).toContain('location ^~ /api/');
  expect(nginx).toContain('add_header Cache-Control "no-store" always;');
  expect(nginx).toContain('location ~* \\.(?:css|js)$');
});
