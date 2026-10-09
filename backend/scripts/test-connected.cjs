'use strict';
const { createServer } = require('node:http');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const { createDatabasePool } = require('../src/config/database');
const { readAuthConfig } = require('../src/config/auth');
const { createAuthRepository, rows } = require('../src/repositories/auth');
const { createAuthService } = require('../src/services/auth');
const { createUsersService } = require('../src/services/users');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/services/passwords');
const fixturePassword = 'Browser-fixture-password-123!';
const { imageDirectory, removeImages } = require('../tests/helpers/image-fixtures.cjs');
async function listen(server) { await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); }); return 'http://127.0.0.1:' + server.address().port; }
async function close(server) { if (server) await new Promise(resolveClose => { server.close(resolveClose); server.closeAllConnections(); }); }
async function runBrowserTests({ config, database, playwrightArgs = [] }) {
  if (!/^pos_auth_test_[a-f0-9]{24}$/.test(database) || database === config.database.database) throw new Error('Base de navegador insegura');
  const pool = createDatabasePool({ ...config.database, database });
  const imageRoot = await imageDirectory();
  config = { ...config, images: { ...config.images, root: imageRoot } };
  let web, apiServer;
  try {
    const passwordHash = await hashPassword(fixturePassword);
    const business = String((await rows(pool, 'INSERT INTO businesses (name) VALUES (?)', ['Browser fixture A'])).insertId);
    const businessB = String((await rows(pool, 'INSERT INTO businesses (name) VALUES (?)', ['Browser fixture B'])).insertId);
    for (const [businessId, username, role] of [[business, 'browseradmin', 'ADMIN'], [business, 'browserseller', 'VENDEDOR'], [businessB, 'otheradmin', 'ADMIN']]) await rows(pool, 'INSERT INTO users (business_id, username, full_name, password_hash, role) VALUES (?, ?, ?, ?, ?)', [businessId, username, username, passwordHash, role]);
    let apiUrl;
    const root = resolve(__dirname, '../..');
    const publicFiles = new Set(['index.html', 'app.js', 'data-tables.js', 'styles.css', 'icons.js', '404.html', 'api-client.js', 'connected-auth.js', 'connected-inventory.js', 'validation.js', 'connected-sales.js', 'connected-clients.js', 'connected-expenses.js', 'connected-purchases.js', 'connected-reports.js', 'dashboard-period.js', 'period-filters.js', 'connected-dashboard.js', 'local-cash-flow.js']);
    web = createServer((req, res) => {
      const name = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';
      if (name === 'api-config.js') { res.setHeader('Content-Type', 'application/javascript'); res.end('window.POS_API_BASE_URL = ' + JSON.stringify(apiUrl) + ';'); return; }
      if (!publicFiles.has(name)) { res.writeHead(404); res.end(); return; }
      const types = { js: 'application/javascript', html: 'text/html; charset=utf-8', css: 'text/css' };
      res.setHeader('Content-Type', types[name.split('.').pop()]); res.end(readFileSync(resolve(root, 'dist', name)));
    });
    const origin = await listen(web);
    const authConfig = readAuthConfig({ CSRF_SECRET: randomBytes(32).toString('hex'), AUTH_RATE_MAX: '100' });
    const repo = createAuthRepository(pool, authConfig);
    apiServer = createApp({ config: { ...config, origins: [origin] }, checkDatabase: async () => {}, authentication: { repo, config: authConfig, auth: createAuthService(repo, authConfig), users: createUsersService(repo) } });
    apiServer = require('node:http').createServer(apiServer);
    apiUrl = await listen(apiServer) + '/api';
    const child = spawn(process.execPath, [resolve(root, 'node_modules/@playwright/test/cli.js'), 'test', '--config', 'tests-connected/playwright.config.cjs', '--workers=1', '--reporter=line', ...playwrightArgs], { cwd: root, stdio: 'inherit', windowsHide: true, env: { ...process.env, POS_TEST_WEB_ORIGIN: origin, POS_TEST_API: apiUrl, POS_TEST_BUSINESS: business, POS_TEST_BUSINESS_B: businessB, POS_INTEGRATION_DATABASE: database } });
    return await new Promise((ok, fail) => { child.once('error', fail); child.once('exit', code => ok(code ?? 1)); });
  } finally { await close(apiServer); await close(web); await pool.end(); await removeImages(imageRoot); }
}
module.exports = { runBrowserTests };
