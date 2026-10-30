'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, randomBytes } = require('node:crypto');
const { readLocalLicenseConfig } = require('../src/config/local-licenses');
const { readConfig } = require('../src/config/environment');
const { codeDisplay, codeNormalized, installationDigest, localBusinessIdNormalized, localBusinessDigest } = require('../src/services/local-licenses');

test('local license secrets remain disabled unless all server-only settings are valid', () => {
  assert.deepEqual(readLocalLicenseConfig({}), { enabled: false });
  assert.deepEqual(readLocalLicenseConfig({
    LOCAL_LICENSE_CODE_PEPPER: '',
    LOCAL_LICENSE_SIGNING_KEY_ID: '',
    LOCAL_LICENSE_SIGNING_PRIVATE_KEY: ''
  }), { enabled: false });
  assert.deepEqual(readLocalLicenseConfig({
    LOCAL_LICENSE_CODE_PEPPER: randomBytes(32).toString('hex')
  }), { enabled: false });
  const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  const configured = readLocalLicenseConfig({
    LOCAL_LICENSE_CODE_PEPPER: randomBytes(32).toString('hex'),
    LOCAL_LICENSE_SIGNING_KEY_ID: 'unit-test-key',
    LOCAL_LICENSE_SIGNING_PRIVATE_KEY: key
  });
  assert.equal(configured.enabled, true);
  assert.equal(configured.privateKey.asymmetricKeyType, 'ec');
  assert.equal(readLocalLicenseConfig({
    LOCAL_LICENSE_CODE_PEPPER: 'not-a-secret',
    LOCAL_LICENSE_SIGNING_KEY_ID: 'unit-test-key',
    LOCAL_LICENSE_SIGNING_PRIVATE_KEY: key
  }).enabled, false);
});

test('connected backend configuration remains valid when local license issuance is disabled', () => {
  const config = readConfig({
    NODE_ENV: 'production',
    HOST: '0.0.0.0',
    PORT: '3000',
    CORS_ORIGINS: 'https://pos.example.invalid',
    DB_HOST: 'mysql',
    DB_PORT: '3306',
    DB_NAME: 'pos_production',
    DB_USER: 'pos_app',
    DB_PASSWORD: 'unit-test-database-password',
    CSRF_SECRET: 'a'.repeat(64),
    IMAGE_STORAGE_DIR: '/var/lib/pos/product-images'
  });
  assert.equal(config.mode, 'production');
  assert.equal(config.database.database, 'pos_production');
  assert.deepEqual(readLocalLicenseConfig({}), { enabled: false });
});

test('license codes contain 192 random bits in a normalized printable format', () => {
  const code = codeDisplay(randomBytes(24));
  assert.match(code, /^POSL-(?:[A-F0-9]{4}-){11}[A-F0-9]{4}$/);
  assert.equal(codeNormalized(code), code.replace('POSL-', '').replaceAll('-', ''));
  assert.equal(codeNormalized('0'.repeat(48)), '0'.repeat(48));
  assert.equal(codeNormalized('invalid'), '');
  assert.equal(installationDigest('test-installation').length, 64);
  assert.equal(localBusinessIdNormalized(' A0000000-0000-4000-8000-000000000001 '), 'a0000000-0000-4000-8000-000000000001');
  assert.equal(localBusinessIdNormalized('biz-abc'), '');
  assert.equal(localBusinessIdNormalized('00000000-0000-0000-0000-000000000000'), '');
  assert.equal(localBusinessIdNormalized('bad\nid'), '');
  assert.equal(localBusinessDigest('a0000000-0000-4000-8000-000000000001'), localBusinessDigest('a0000000-0000-4000-8000-000000000001'));
  assert.notEqual(localBusinessDigest('a0000000-0000-4000-8000-000000000001'), localBusinessDigest('b0000000-0000-4000-8000-000000000002'));
});
