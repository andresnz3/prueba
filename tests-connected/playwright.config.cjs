const { defineConfig } = require('@playwright/test');
if (!process.env.POS_TEST_WEB_ORIGIN || !process.env.POS_TEST_API) throw new Error('Ejecutar npm.cmd run test:frontend --prefix backend');
module.exports = defineConfig({ testDir: __dirname, testMatch: '**/*.spec.cjs', outputDir: '../test-results-connected', timeout: 30000, use: { baseURL: process.env.POS_TEST_WEB_ORIGIN } });
