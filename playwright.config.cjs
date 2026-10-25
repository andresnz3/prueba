'use strict';
const path = require('node:path');
const os = require('node:os');
const { defineConfig } = require('@playwright/test');

const port = Number(process.env.POS_LOCAL_TEST_PORT) || 5501;
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('POS_LOCAL_TEST_PORT must be an unprivileged TCP port');
const origin = 'http://127.0.0.1:' + port;
const launchOptions = process.env.POS_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.POS_TEST_BROWSER_EXECUTABLE } : undefined;
const managedServer = process.env.POS_LOCAL_TEST_MANAGED_SERVER === '1';
module.exports = defineConfig({
  testDir: path.join(__dirname, 'tests'),
  testMatch: '**/*.spec.cjs',
  // Connected migration/admin flows have dedicated coverage with their API and database fixtures.
  // Keep the local browser profile limited to the static Dexie application.
  testIgnore: [
    '**/admin-migration-presentation.spec.cjs',
    '**/migration-credit-preview.spec.cjs',
    '**/migration-purchases.spec.cjs',
    '**/migration-sales-gate.spec.cjs',
    '**/pos-connected-layout.spec.cjs'
  ],
  outputDir: path.join(os.tmpdir(), 'pos-local-playwright-results'),
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  use: { baseURL: origin, browserName: 'chromium', ...(launchOptions ? { launchOptions } : {}) },
  ...(!managedServer ? { webServer: {
    command: 'node node_modules/http-server/bin/http-server dist -p ' + port + ' -a 127.0.0.1 --silent',
    url: origin,
    reuseExistingServer: false,
    timeout: 30000,
    gracefulShutdown: { signal: 'SIGINT', timeout: 5000 }
  } } : {})
});
