'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.resolve(__dirname, '../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('Compose mantiene MySQL privado, persistente y aislado', () => {
  const compose = read('compose.yaml');
  const mysql = compose.split('  mysql:\n')[1]?.split('\n  backend:\n')[0] || '';
  assert.match(mysql, /image:\s*mysql:8\.4\.13/);
  assert.doesNotMatch(mysql, /^\s+ports:/m);
  assert.match(mysql, /mysql_data:\/var\/lib\/mysql/);
  assert.match(mysql, /networks:\n\s+- database/);
  assert.match(compose, /database:\n\s+driver: bridge\n\s+internal: true/);
  assert.match(compose, /MYSQL_DATABASE:\s*pos_docker_local/);
  assert.match(compose, /DB_NAME:\s*pos_docker_local/);
  assert.match(mysql, /mysql --user=root .*--execute="SELECT 1"/);
  assert.doesNotMatch(mysql, /healthcheck\.sh|mysqladmin|mysqlcheck/);
});

test('Compose publica solo Nginx en loopback y exige secretos privados', () => {
  const compose = read('compose.yaml');
  assert.match(compose, /127\.0\.0\.1:\$\{POS_HTTP_PORT:-8080\}:80/);
  assert.match(compose, /MYSQL_ROOT_PASSWORD: \$\{MYSQL_ROOT_PASSWORD:\?Set/);
  assert.match(compose, /DB_PASSWORD: \$\{MYSQL_APP_PASSWORD:\?Set/);
  assert.match(compose, /CSRF_SECRET:\?Set/);
  assert.match(compose, /CORS_ORIGINS:\?Set/);
  assert.match(compose, /product_images:\/var\/lib\/pos\/product-images/);
  const frontend = compose.split('  frontend:\n')[1]?.split('\n  migrate:\n')[0] || '';
  assert.doesNotMatch(frontend, /depends_on:/);
});

test('Migraciones quedan manuales y la imagen backend no arranca como root', () => {
  const compose = read('compose.yaml');
  const backend = read('backend/Dockerfile');
  const migrate = compose.split('  migrate:\n')[1]?.split('\nnetworks:\n')[0] || '';
  assert.match(migrate, /profiles:\s*\[tools\]/);
  assert.match(migrate, /--plan/);
  assert.match(migrate, /--install-base-schema/);
  assert.doesNotMatch(backend, /migrate-all\.cjs.*--apply/);
  assert.match(backend, /^USER node$/m);
  assert.match(backend, /npm ci --omit=dev/);
  assert.match(backend, /HEALTHCHECK/);
});

test('Frontend Docker usa API del mismo origen y limita el contenido publicado', () => {
  assert.match(read('docker/frontend/api-config.js'), /new URL\('\/api', window\.location\.origin\)/);
  assert.match(read('docker/nginx/default.conf'), /proxy_pass http:\/\/backend:3000/);
  assert.match(read('docker/nginx/default.conf'), /client_max_body_size 9m/);
  const frontendIgnore = read('docker/frontend.Dockerfile.dockerignore');
  assert.match(frontendIgnore, /^\*\*/m);
  assert.match(frontendIgnore, /!index\.html/);
  assert.doesNotMatch(frontendIgnore, /!\.env/);
  assert.doesNotMatch(read('docker/frontend.Dockerfile'), /COPY \. /);
});

test('Scripts de respaldo/restauración solo permiten destinos temporales explícitos', () => {
  const backup = read('scripts/docker-backup.cjs');
  const restore = read('scripts/docker-restore-check.cjs');
  assert.match(backup, /Backups must be stored outside the repository/);
  assert.match(backup, /flags: 'wx'/);
  assert.match(backup, /pos-docker-backup-v2/);
  assert.match(backup, /--routines --triggers --events/);
  assert.match(restore, /pos_auth_test_/);
  assert.match(restore, /pos-docker-backup-v2/);
  assert.match(restore, /'network', 'create', '--internal'/);
  assert.match(restore, /'volume', 'rm'/);
  assert.match(restore, /database inventory differs/);
});

test('Comprobaciones Docker usan utilidades presentes en MySQL 8.4', () => {
  const backup = read('scripts/docker-backup.cjs');
  const restore = read('scripts/docker-restore-check.cjs');
  assert.match(backup, /compose', 'ps'.*'backend', 'frontend'/);
  assert.match(backup, /mysql --user=root .*--execute="SELECT 1"/);
  assert.match(restore, /--host=127\.0\.0\.1 .*--execute="SELECT 1"/);
  assert.match(restore, /information_schema\.TABLES/);
  assert.match(restore, /CHECK TABLE/);
  assert.match(restore, /messageType === 'status' && message === 'OK'/);
  assert.doesNotMatch(backup + restore, /mysqlcheck|healthcheck\.sh|mysqladmin/);
});
