'use strict';

const assert = require('node:assert/strict');
const { chromium } = require('@playwright/test');
const { verifyVendoredAssets } = require('../tests/helpers/vendor-assets-smoke.cjs');

async function main() {
  const origin = process.env.POS_DOCKER_WEB_ORIGIN || 'http://127.0.0.1:8080';
  const executablePath = process.env.POS_TEST_BROWSER_EXECUTABLE;
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  try {
    const context = await browser.newContext({ baseURL: origin });
    const page = await context.newPage();
    await verifyVendoredAssets(page, origin);
    const manifestResponse = await context.request.get(new URL('/manifest.webmanifest', origin).href);
    assert.equal(manifestResponse.status(), 200, 'El manifiesto PWA debe estar publicado');
    assert.match(manifestResponse.headers()['content-type'] || '', /application\/manifest\+json/);
    const manifest = await manifestResponse.json();
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.start_url, '/?mode=local');
    for (const icon of manifest.icons) {
      const iconResponse = await context.request.get(new URL(icon.src, origin).href);
      assert.equal(iconResponse.status(), 200, `Debe estar disponible el icono ${icon.src}`);
    }

    await page.goto(new URL('/?mode=local', origin).href);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    const workerResponse = await context.request.get(new URL('/service-worker.js', origin).href);
    assert.equal(workerResponse.status(), 200, 'El service worker debe estar publicado');
    const workerSource = await workerResponse.text();
    assert.doesNotMatch(workerSource, /__POS_/);
    assert.doesNotMatch(workerSource, /skipWaiting|clients\.claim/);
    assert.match(workerSource, /url\.pathname === '\/api' \|\| url\.pathname\.startsWith\('\/api\/'\)/);
    const beforeApi = await page.evaluate(async () => {
      const names = await caches.keys();
      const urls = (await Promise.all(names.map(async name => (await (await caches.open(name)).keys()).map(request => new URL(request.url).pathname)))).flat();
      return { names, urls };
    });
    assert.ok(beforeApi.names.some(name => name.startsWith('pos-pwa-shell-')), 'La caché estática de la PWA debe existir');
    assert.ok(beforeApi.urls.includes('/index.html'));
    assert.ok(beforeApi.urls.includes('/manifest.webmanifest'));
    assert.ok(beforeApi.urls.includes('/offline.html'));
    assert.ok(beforeApi.urls.every(url => !url.startsWith('/api/')), 'No se deben guardar respuestas API en Cache Storage');

    const health = await context.request.get(new URL('/api/health', origin).href);
    assert.equal(health.status(), 200, 'La API debe responder por el proxy de Nginx');
    const browserHealth = await page.evaluate(async () => (await fetch('/api/health', { cache: 'no-store' })).status);
    assert.equal(browserHealth, 200, 'El service worker debe dejar pasar la API sin cachearla');
    const afterApi = await page.evaluate(async () => {
      const names = await caches.keys();
      const urls = (await Promise.all(names.map(async name => (await (await caches.open(name)).keys()).map(request => new URL(request.url).pathname)))).flat();
      return { names, urls };
    });
    assert.deepEqual(afterApi.urls, beforeApi.urls);
    assert.equal(JSON.stringify(afterApi.names), JSON.stringify(beforeApi.names));

    const connectedPage = await context.newPage();
    await connectedPage.goto(new URL('/?mode=connected', origin).href);
    await connectedPage.locator('#loginScreen').waitFor();
    assert.equal(await connectedPage.locator('#authMode').inputValue(), 'connected', 'El modo conectado debe conservar su pantalla de acceso');
    await connectedPage.close();
    console.log('Frontend Docker verificado: PWA y caché estática, API sin cachear, modo conectado y activos locales.');
    await context.close();
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  const message = typeof error?.message === 'string' ? error.message : 'Error sin detalle';
  console.error('Falló la prueba del frontend Docker: ' + message);
  process.exitCode = 1;
});
