'use strict';

const { test } = require('@playwright/test');
const { verifyVendoredAssets } = require('../tests/helpers/vendor-assets-smoke.cjs');

test('frontend conectado carga librerías y tipografía locales sin solicitudes externas', async ({ page, baseURL }) => {
  await verifyVendoredAssets(page, baseURL);
});
