'use strict';
const path = require('node:path');
const os = require('node:os');
const { defineConfig } = require('@playwright/test');

const origin = 'http://127.0.0.1:5500';
module.exports = defineConfig({
  testDir: path.join(__dirname, 'tests'),
  testMatch: '**/*.spec.cjs',
  outputDir: path.join(os.tmpdir(), 'pos-local-playwright-results'),
  timeout: 30000,
  use: { baseURL: origin, browserName: 'chromium' },
  webServer: {
    command: 'node node_modules/http-server/bin/http-server dist -p 5500 -a 127.0.0.1 --silent',
    url: origin,
    reuseExistingServer: !process.env.CI,
    timeout: 30000
  }
});
