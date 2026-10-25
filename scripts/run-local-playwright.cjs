'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const port = Number(process.env.POS_LOCAL_TEST_PORT) || 5501;
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('POS_LOCAL_TEST_PORT must be an unprivileged TCP port');
const publicRoot = path.resolve(__dirname, '..', 'dist');
const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'], ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'], ['.jpeg', 'image/jpeg'], ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'], ['.svg', 'image/svg+xml; charset=utf-8'], ['.webp', 'image/webp'], ['.woff2', 'font/woff2']
]);

function createPublicServer() {
  return http.createServer((request, response) => {
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname); }
    catch { response.writeHead(400).end(); return; }
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const filename = path.resolve(publicRoot, relative);
    if (filename !== publicRoot && !filename.startsWith(publicRoot + path.sep)) {
      response.writeHead(404).end();
      return;
    }
    fs.stat(filename, (error, stats) => {
      if (error || !stats.isFile()) { response.writeHead(404).end(); return; }
      response.writeHead(200, {
        'Content-Type': mimeTypes.get(path.extname(filename).toLowerCase()) || 'application/octet-stream',
        'Content-Length': stats.size,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      if (request.method === 'HEAD') response.end();
      else fs.createReadStream(filename).pipe(response);
    });
  });
}

async function main() {
  if (!fs.existsSync(path.join(publicRoot, 'index.html'))) throw new Error('Build público no disponible; ejecuta scripts/build-static.cjs primero.');
  const server = createPublicServer();
  let child;
  let code;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    child = spawn(process.execPath, [require.resolve('@playwright/test/cli'), 'test', ...process.argv.slice(2)], {
      cwd: path.resolve(__dirname, '..'),
      stdio: 'inherit',
      windowsHide: true,
      env: { ...process.env, POS_LOCAL_TEST_MANAGED_SERVER: '1', POS_LOCAL_TEST_ORIGIN: 'http://127.0.0.1:' + port }
    });
    code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
    });
  } finally {
    if (child && child.exitCode === null && !child.killed) child.kill();
    await new Promise(resolve => {
      if (!server.listening) { resolve(); return; }
      server.close(resolve);
      server.closeAllConnections();
    });
  }
  process.exitCode = code;
}

main().catch(error => {
  const message = typeof error?.message === 'string' ? error.message : 'Error sin detalle';
  console.error('Falló Playwright local: ' + message);
  process.exitCode = 1;
});
