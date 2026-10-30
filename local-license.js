/* global connectedMode */
'use strict';
(() => {
  const DB_NAME = 'POS_LocalLicenseState';
  const STORE = 'authorization';
  const encoder = new TextEncoder();
  let database = null;
  let current = null;
  let currentState = 'UNAVAILABLE';

  function supported() {
    return Boolean(window.isSecureContext && window.crypto?.subtle && window.crypto?.getRandomValues && window.indexedDB);
  }

  function base64url(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function fromBase64url(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('LOCAL_LICENSE_INVALID');
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'key' }); };
      request.onsuccess = () => { database = request.result; resolve(database); };
      request.onerror = () => reject(request.error || new Error('LOCAL_LICENSE_STORAGE'));
      request.onblocked = () => reject(new Error('LOCAL_LICENSE_STORAGE'));
    });
  }

  function readRecord() {
    return new Promise((resolve, reject) => {
      const request = database.transaction(STORE, 'readonly').objectStore(STORE).get('current');
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error('LOCAL_LICENSE_STORAGE'));
    });
  }

  function saveRecord(record) {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).put(record);
      transaction.oncomplete = () => { current = record; resolve(); };
      transaction.onerror = () => reject(transaction.error || new Error('LOCAL_LICENSE_STORAGE'));
      transaction.onabort = () => reject(transaction.error || new Error('LOCAL_LICENSE_STORAGE'));
    });
  }

  function apiUrl(path) {
    let api;
    try { api = new URL(window.POS_API_BASE_URL); } catch { throw new Error('LOCAL_LICENSE_SERVER_UNAVAILABLE'); }
    if (!['http:', 'https:'].includes(api.protocol) || !api.pathname.replace(/\/$/, '').endsWith('/api') || api.username || api.password || api.search || api.hash) {
      throw new Error('LOCAL_LICENSE_SERVER_UNAVAILABLE');
    }
    if (location.protocol === 'https:' && api.protocol !== 'https:') throw new Error('LOCAL_LICENSE_SERVER_UNAVAILABLE');
    return api.href.replace(/\/$/, '') + path;
  }

  async function request(path, body) {
    let response;
    try {
      response = await fetch(apiUrl(path), {
        method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
        headers: { 'Content-Type': 'application/json', 'X-POS-License-Request': '1' },
        body: JSON.stringify(body)
      });
    } catch { throw new Error('LOCAL_LICENSE_SERVER_UNAVAILABLE'); }
    let value;
    try { value = await response.json(); } catch { throw new Error('LOCAL_LICENSE_SERVER_UNAVAILABLE'); }
    if (!response.ok) {
      const failure = new Error(value?.error?.code || 'LOCAL_LICENSE_SERVER_UNAVAILABLE');
      failure.retryAfter = Number(response.headers.get('Retry-After')) || 0;
      throw failure;
    }
    return value;
  }

  function canonicalCode(value) {
    const code = typeof value === 'string' ? value.trim().toUpperCase().replace(/^POSL-/, '').replace(/[-\s]/g, '') : '';
    if (!/^[A-F0-9]{48}$/.test(code)) throw new Error('LOCAL_LICENSE_CODE_INVALID');
    return code;
  }

  function localBusinessId() {
    const saved = typeof current?.localBusinessId === 'string' ? current.localBusinessId : '';
    const configured = typeof window.PosLocalIdentity?.stableId === 'function' ? window.PosLocalIdentity.stableId() : '';
    const value = (saved || configured || '').trim().toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
      throw new Error('LOCAL_LICENSE_BUSINESS_ID_UNAVAILABLE');
    }
    return value;
  }

  async function verifyEnvelope(value, expectedType) {
    if (typeof value !== 'string' || value.length > 4096) return null;
    const parts = value.split('.');
    if (parts.length !== 2) return null;
    try {
      const payloadBytes = fromBase64url(parts[0]);
      const payload = JSON.parse(new TextDecoder().decode(payloadBytes));
      const key = window.POS_LOCAL_LICENSE_PUBLIC_KEYS?.[payload.keyId];
      if (!key || payload.type !== expectedType || payload.version !== 1) return null;
      const publicKey = await crypto.subtle.importKey('jwk', key, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, fromBase64url(parts[1]), encoder.encode(parts[0]));
      return valid ? payload : null;
    } catch { return null; }
  }

  async function ensureIdentity() {
    if (!supported()) throw new Error('LOCAL_LICENSE_CRYPTO_UNAVAILABLE');
    if (!database) await openDatabase();
    if (current?.installationId && current.privateKey && current.publicKey) return current;
    const installationId = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const publicKey = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const record = { key: 'current', installationId, privateKey: pair.privateKey, publicKey: { kty: publicKey.kty, crv: publicKey.crv, x: publicKey.x, y: publicKey.y }, licenseId: null, permit: null, signedStatus: null };
    await saveRecord(record);
    return record;
  }

  async function signMessage(record, message) {
    return base64url(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, record.privateKey, encoder.encode(message))));
  }

  async function getChallenge(purpose) {
    const result = await request('/local-license/challenge', { purpose });
    if (!result || !/^[a-f0-9]{32}$/.test(result.challengeId || '') || !/^[A-Za-z0-9_-]{43}$/.test(result.challenge || '') || !Number.isFinite(Date.parse(result.expiresAt))) throw new Error('LOCAL_LICENSE_SERVER_UNAVAILABLE');
    return result;
  }

  async function activate(code) {
    const normalizedCode = canonicalCode(code);
    const record = await ensureIdentity();
    const businessId = localBusinessId();
    const challenge = await getChallenge('ACTIVATE');
    const bodyToSign = ['POS_LOCAL_LICENSE_ACTIVATE_V2', challenge.challengeId, challenge.challenge, normalizedCode, record.installationId, businessId, await publicKeyHash(record.publicKey)].join('\n');
    const signature = await signMessage(record, bodyToSign);
    const result = await request('/local-license/activate', {
      licenseCode: code.trim(), installationId: record.installationId, localBusinessId: businessId, publicKey: record.publicKey,
      challengeId: challenge.challengeId, challenge: challenge.challenge, signature
    });
    const permit = await verifyEnvelope(result?.permit, 'POS_LOCAL_LICENSE');
    if (!permit || permit.permanent !== true || permit.licenseId !== String(result?.licenseId || '') || permit.installationHash !== await installationHash(record.installationId)) throw new Error('LOCAL_LICENSE_SIGNATURE_INVALID');
    record.licenseId = String(permit.licenseId);
    record.localBusinessId = businessId;
    record.permit = result.permit;
    record.signedStatus = null;
    currentState = 'ACTIVE';
    await saveRecord(record);
    await checkStatus().catch(() => {});
    return currentState;
  }

  async function checkStatus() {
    if (!current?.permit || !current?.licenseId || !current?.privateKey || !current?.installationId) return currentState;
    const businessId = localBusinessId();
    const challenge = await getChallenge('STATUS');
    const bodyToSign = ['POS_LOCAL_LICENSE_STATUS_V2', challenge.challengeId, challenge.challenge, current.licenseId, current.installationId, businessId].join('\n');
    const signature = await signMessage(current, bodyToSign);
    const result = await request('/local-license/status', {
      licenseId: current.licenseId, installationId: current.installationId, localBusinessId: businessId,
      challengeId: challenge.challengeId, challenge: challenge.challenge, signature
    });
    const status = await verifyEnvelope(result?.signedStatus, 'POS_LOCAL_LICENSE_STATUS');
    if (!status || status.licenseId !== current.licenseId || status.installationHash !== await installationHash(current.installationId) || !['ACTIVE', 'REVOKED', 'TRANSFERRED'].includes(status.status) || !Number.isFinite(Date.parse(status.checkedAt))) return currentState;
    const oldStatus = current.signedStatus ? await verifyEnvelope(current.signedStatus, 'POS_LOCAL_LICENSE_STATUS') : null;
    if (!oldStatus || Date.parse(status.checkedAt) >= Date.parse(oldStatus.checkedAt)) {
      current.signedStatus = result.signedStatus;
      current.localBusinessId = businessId;
      currentState = status.status;
      await saveRecord(current);
    }
    return currentState;
  }

  async function installationHash(value) {
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode('pos-local-installation-v1\0' + value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  async function publicKeyHash(value) {
    const canonical = JSON.stringify({ crv: value.crv, kty: value.kty, x: value.x, y: value.y });
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(canonical)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  async function load() {
    if (connectedMode) { currentState = 'NOT_APPLICABLE'; return currentState; }
    if (!supported()) { currentState = 'UNAVAILABLE'; return currentState; }
    try {
      await openDatabase();
      current = await readRecord();
      if (!current) { currentState = 'MISSING'; return currentState; }
      if (current.key !== 'current' || !/^[A-Za-z0-9_-]{43}$/.test(current.installationId || '') || !current.publicKey || !current.privateKey) {
        currentState = 'INVALID'; return currentState;
      }
      if (!current.permit) { currentState = 'PENDING'; return currentState; }
      const permit = await verifyEnvelope(current.permit, 'POS_LOCAL_LICENSE');
      if (!permit || permit.licenseId !== String(current.licenseId) || permit.permanent !== true || permit.installationHash !== await installationHash(current.installationId)) {
        currentState = 'INVALID'; return currentState;
      }
      currentState = 'ACTIVE';
      if (current.signedStatus) {
        const signedStatus = await verifyEnvelope(current.signedStatus, 'POS_LOCAL_LICENSE_STATUS');
        if (!signedStatus || signedStatus.licenseId !== String(current.licenseId) || signedStatus.installationHash !== await installationHash(current.installationId)) {
          currentState = 'INVALID'; return currentState;
        }
        if (['REVOKED', 'TRANSFERRED'].includes(signedStatus.status)) currentState = signedStatus.status;
      }
      if (navigator.onLine && currentState === 'ACTIVE') await checkStatus().catch(() => {});
      return currentState;
    } catch { currentState = 'UNAVAILABLE'; return currentState; }
  }

  window.PosLocalLicense = Object.freeze({ load, status: () => currentState, supported, activate, checkStatus });
})();
