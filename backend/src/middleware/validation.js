'use strict';
const { httpError } = require('./errors');
const MODULES = Object.freeze(['sales', 'inventory', 'purchases', 'payables', 'clients', 'suppliers', 'history', 'cash', 'expenses', 'reports', 'dashboard', 'settings']);
function invalid() { throw httpError(400, 'INVALID_INPUT'); }
function body(value, allowed, mandatory = allowed) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(key => !allowed.includes(key)) || mandatory.some(key => !Object.hasOwn(value, key))) invalid();
  return value;
}
function text(value, max) { if (typeof value !== 'string' || !value.trim() || value.length > max || [...value].some(character => character.charCodeAt(0) <= 0x1f)) invalid(); return value.trim(); }
function username(value) { if (typeof value !== 'string' || !/^[a-zA-Z0-9_.-]{3,100}$/.test(value)) invalid(); return value; }
function password(value, creating = false) { if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > 256 || (creating && value.length < 12)) invalid(); return value; }
function id(value) { if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value) || BigInt(value) > 18446744073709551615n) invalid(); return value; }
function role(value) { if (!['ADMIN', 'VENDEDOR'].includes(value)) invalid(); return value; }
function moduleName(value) { if (!MODULES.includes(value)) invalid(); return value; }
module.exports = { MODULES, invalid, body, text, username, password, id, role, moduleName };
