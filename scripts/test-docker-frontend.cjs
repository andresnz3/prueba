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
    const health = await context.request.get(new URL('/api/health', origin).href);
    assert.equal(health.status(), 200, 'La API debe responder por el proxy de Nginx');
    console.log('Frontend Docker verificado: activos locales, IndexedDB, XLSX, PDF, QR, Inter y API por Nginx.');
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
