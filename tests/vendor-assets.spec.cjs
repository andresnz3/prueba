'use strict';

const { test } = require('@playwright/test');
const { verifyVendoredAssets } = require('./helpers/vendor-assets-smoke.cjs');

test('librerías y tipografía funcionan localmente sin solicitudes externas', async ({ page, baseURL }) => {
  await verifyVendoredAssets(page, baseURL);
});
