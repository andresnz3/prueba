/* Local owner access. This browser gate is not protection from someone controlling the device. */
'use strict';
(() => {
  const STORE_KEY = 'owner';
  const ALGORITHM = 'PBKDF2-HMAC-SHA-256';
  const ITERATIONS = 600000;
  const encoder = new TextEncoder();
  let database = null;
  let cachedState = 'unavailable';
  let cachedValue = null;
  let cachedSalt = null;
  let cachedVerifier = null;

  function supported() {
    return Boolean(window.isSecureContext && window.crypto?.subtle && window.crypto?.getRandomValues);
  }

  function connectPasswordToggle(buttonId, inputId) {
    const button = document.getElementById(buttonId);
    const input = document.getElementById(inputId);
    if (!button || !input) return;
    button.addEventListener('click', () => {
      const showPassword = input.type === 'password';
      input.type = showPassword ? 'text' : 'password';
      const label = showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña';
      button.setAttribute('aria-pressed', String(showPassword));
      button.setAttribute('aria-label', label);
      button.title = label;
      button.querySelector('.password-toggle-eye')?.classList.toggle('hidden', showPassword);
      button.querySelector('.password-toggle-eye-off')?.classList.toggle('hidden', !showPassword);
    });
  }

  function toBase64Url(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function fromBase64Url(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
    try {
      const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
      return Uint8Array.from(binary, character => character.charCodeAt(0));
    } catch { return null; }
  }

  function cache(record) {
    cachedValue = null;
    cachedSalt = null;
    cachedVerifier = null;
    if (!record) { cachedState = 'missing'; return cachedState; }
    const salt = fromBase64Url(record.salt), verifier = fromBase64Url(record.verifier);
    if (record.key !== STORE_KEY || record.version !== 1 || record.algorithm !== ALGORITHM ||
        typeof record.username !== 'string' || !/^[A-Za-z0-9_.-]{3,100}$/.test(record.username) ||
        !Number.isSafeInteger(record.iterations) || record.iterations < ITERATIONS || record.iterations > 2000000 ||
        salt?.length !== 16 || verifier?.length !== 32) {
      cachedState = 'invalid';
      return cachedState;
    }
    cachedState = 'configured';
    cachedValue = record;
    cachedSalt = salt;
    cachedVerifier = verifier;
    return cachedState;
  }

  async function load(db) {
    if (!db?.localAuth) { database = null; cache(null); cachedState = 'unavailable'; return cachedState; }
    database = db;
    try { return cache(await database.localAuth.get(STORE_KEY)); }
    catch { cachedState = 'unavailable'; cachedValue = null; cachedSalt = null; cachedVerifier = null; return cachedState; }
  }

  async function derive(password, salt, iterations) {
    const key = await crypto.subtle.importKey('raw', encoder.encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
  }

  function username(value) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!/^[A-Za-z0-9_.-]{3,100}$/.test(normalized)) throw new Error('OWNER_USERNAME_INVALID');
    return normalized;
  }

  function password(value) {
    if (typeof value !== 'string' || [...value].length < 12 || encoder.encode(value).length > 256) throw new Error('OWNER_PASSWORD_INVALID');
    return value;
  }

  async function prepare(ownerUsername, ownerPassword) {
    if (!supported()) throw new Error('OWNER_CRYPTO_UNAVAILABLE');
    const normalizedUsername = username(ownerUsername), normalizedPassword = password(ownerPassword);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    return {
      key: STORE_KEY,
      version: 1,
      algorithm: ALGORITHM,
      iterations: ITERATIONS,
      username: normalizedUsername,
      salt: toBase64Url(salt),
      verifier: toBase64Url(await derive(normalizedPassword, salt, ITERATIONS))
    };
  }

  async function save(prepared) {
    if (!database || cachedState !== 'missing') throw new Error(cachedState === 'unavailable' ? 'OWNER_STORAGE_UNAVAILABLE' : 'OWNER_ALREADY_CONFIGURED');
    const salt = fromBase64Url(prepared?.salt), verifier = fromBase64Url(prepared?.verifier);
    if (prepared?.key !== STORE_KEY || prepared.version !== 1 || prepared.algorithm !== ALGORITHM || !Number.isSafeInteger(prepared.iterations) ||
        prepared.iterations < ITERATIONS || prepared.iterations > 2000000 ||
        !/^[A-Za-z0-9_.-]{3,100}$/.test(prepared.username || '') || salt?.length !== 16 || verifier?.length !== 32) {
      throw new Error('OWNER_CREDENTIAL_INVALID');
    }
    try { await database.localAuth.add(prepared); }
    catch (error) {
      const wrapped = new Error(error?.name === 'ConstraintError' ? 'OWNER_ALREADY_CONFIGURED' : 'OWNER_STORAGE_UNAVAILABLE', { cause: error });
      throw wrapped;
    }
    cache(prepared);
    return prepared.username;
  }

  async function verify(ownerUsername, ownerPassword) {
    if (cachedState !== 'configured' || !supported()) return false;
    let normalizedUsername, normalizedPassword;
    try { normalizedUsername = username(ownerUsername); normalizedPassword = password(ownerPassword); }
    catch { return false; }
    if (normalizedUsername !== cachedValue.username) return false;
    const candidate = await derive(normalizedPassword, cachedSalt, cachedValue.iterations);
    let difference = candidate.length ^ cachedVerifier.length;
    for (let index = 0; index < cachedVerifier.length; index++) difference |= candidate[index] ^ cachedVerifier[index];
    return difference === 0;
  }

  connectPasswordToggle('toggleLoginPasswordBtn', 'loginPassword');
  connectPasswordToggle('toggleLocalOwnerPasswordBtn', 'localOwnerPassword');
  connectPasswordToggle('toggleLocalOwnerPasswordConfirmBtn', 'localOwnerPasswordConfirm');

  window.PosLocalAuth = Object.freeze({ load, status: () => cachedState, supported, prepare, save, verify });
})();
