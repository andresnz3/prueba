'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { test } = require('node:test');
const { createApp } = require('../src/app');
const { readFrontendCsp } = require('../../tests/helpers/security-headers.cjs');

const root = path.resolve(__dirname, '../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('CSP del frontend limita orígenes y permite solo los usos inline existentes', () => {
  const policy = readFrontendCsp();
  assert.match(policy, /default-src 'self'/);
  assert.match(policy, /script-src 'self'(?:;|$)/);
  assert.match(policy, /script-src-attr 'unsafe-inline'/);
  assert.match(policy, /style-src 'self' 'unsafe-inline'/);
  assert.match(policy, /img-src 'self' data: blob:/);
  assert.match(policy, /media-src 'self' blob: mediastream:/);
  assert.match(policy, /connect-src 'self'/);
  assert.match(policy, /worker-src 'self' blob:/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.doesNotMatch(policy, /https?:|\*|unsafe-eval|upgrade-insecure-requests/);

  const nginx = read('docker/nginx/default.conf');
  const locations = [
    ['location = /index.html', 'index.html'],
    ['location = /offline.html', 'offline.html'],
    [String.raw`location ~* \.html$`, 'other HTML']
  ];
  for (const [needle, label] of locations) {
    const start = nginx.indexOf(needle);
    assert.notEqual(start, -1, `Debe existir location para ${label}`);
    const body = nginx.slice(start, nginx.indexOf('\n    }', start));
    assert.match(body, /add_header Content-Security-Policy \$pos_content_security_policy always;/);
  }
});

test('Nginx elimina duplicados de Express y mantiene una sola política en respuestas API', () => {
  const nginx = read('docker/nginx/default.conf');
  const api = nginx.slice(nginx.indexOf('location ^~ /api/'), nginx.indexOf('\n    }', nginx.indexOf('location ^~ /api/')));
  for (const name of ['Strict-Transport-Security', 'X-Content-Type-Options', 'Referrer-Policy', 'X-Frame-Options']) {
    assert.match(api, new RegExp(`proxy_hide_header ${name};`));
  }
  assert.equal((api.match(/add_header X-Content-Type-Options/g) || []).length, 1);
  assert.equal((api.match(/add_header Referrer-Policy/g) || []).length, 1);
  assert.equal((api.match(/add_header X-Frame-Options/g) || []).length, 1);
  assert.doesNotMatch(api, /add_header Strict-Transport-Security/);
});

test('Caddy normalizes headers at the public edge and preserves the private tunnel', () => {
  const caddy = read('deploy/contabo/Caddyfile.example');
  for (const host of ['softventaweb.com', 'www.softventaweb.com']) {
    const startMatch = new RegExp(`^${host.replaceAll('.', '\\.') }\\s*\\{`, 'm').exec(caddy);
    assert.ok(startMatch, `site block ${host} must exist`);
    const start = startMatch.index;
    const end = caddy.indexOf('\n}', start);
    const site = caddy.slice(start, end);
    for (const [header, value] of [
      ['Content-Security-Policy', "default-src 'self'"],
      ['Strict-Transport-Security', 'max-age=31536000'],
      ['X-Content-Type-Options', 'nosniff'],
      ['Referrer-Policy', 'strict-origin-when-cross-origin'],
      ['X-Frame-Options', 'DENY']
    ]) {
      assert.equal((site.match(new RegExp(`>${header}\\b`, 'g')) || []).length, 1, `${header} must be set once for ${host}`);
      assert.ok(site.includes(value), `${header} must use the approved value for ${host}`);
    }
    assert.doesNotMatch(site, /Set-Cookie|Access-Control-|Cache-Control/i);
  }
  assert.doesNotMatch(caddy, /includeSubDomains|preload/);
  assert.match(caddy, /www\.softventaweb\.com\s*\{[\s\S]*?redir https:\/\/softventaweb\.com\{uri\} 308/);
  assert.match(caddy, /softventaweb\.com\s*\{[\s\S]*?reverse_proxy 127\.0\.0\.1:8080/);
  const recovery = caddy.slice(caddy.indexOf('http://:8443'));
  assert.match(recovery, /bind 127\.0\.0\.1/);
  assert.doesNotMatch(recovery, /Content-Security-Policy|Strict-Transport-Security|X-Frame-Options/);
  assert.match(recovery, /reverse_proxy 127\.0\.0\.1:8080/);
});
test('Express conserva Helmet pero delega HSTS al proxy HTTPS público', async t => {
  const server = http.createServer(createApp({
    config: { trustProxyHops: 0, origins: [], jsonLimit: '1mb' },
    checkDatabase: async () => {}
  }));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/health`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy') || '', /default-src 'self'/);
  assert.equal(response.headers.get('strict-transport-security'), null);
  assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});
