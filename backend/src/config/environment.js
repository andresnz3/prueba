'use strict';
function readConfig(env = process.env) {
  function required(key) {
    if (typeof env[key] !== 'string' || !env[key].trim()) throw new Error('Configuracion obligatoria: ' + key);
    return env[key];
  }
  function integer(key, fallback, min, max) {
    const raw = env[key] === undefined ? String(fallback) : env[key];
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < min || Number(raw) > max) throw new Error('Configuracion invalida: ' + key);
    return Number(raw);
  }
  const mode = env.NODE_ENV || 'development';
  if (!['development', 'test', 'production'].includes(mode)) throw new Error('Configuracion invalida: NODE_ENV');
  const origins = required('CORS_ORIGINS').split(',').map(value => value.trim());
  for (const origin of origins) {
    let url;
    try { url = new URL(origin); } catch { throw new Error('Configuracion invalida: CORS_ORIGINS'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) throw new Error('Configuracion invalida: CORS_ORIGINS');
  }
  return {
    mode, host: required('HOST'), port: integer('PORT', 3000, 1, 65535), origins,
    jsonLimit: integer('JSON_LIMIT_BYTES', 16384, 1024, 1048576),
    healthTimeout: integer('HEALTH_TIMEOUT_MS', 4000, 100, 30000),
    shutdownTimeout: integer('SHUTDOWN_TIMEOUT_MS', 10000, 100, 60000),
    database: {
      host: required('DB_HOST'), port: integer('DB_PORT', undefined, 1, 65535),
      database: required('DB_NAME'), user: required('DB_USER'), password: required('DB_PASSWORD'),
      connectionLimit: integer('DB_CONNECTION_LIMIT', 5, 1, 50),
      connectTimeout: integer('DB_CONNECT_TIMEOUT_MS', 3000, 100, 30000)
    }
  };
}
module.exports = { readConfig };
