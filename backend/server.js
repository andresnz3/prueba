'use strict';
const { readConfig } = require('./src/config/environment');
const { createDatabasePool } = require('./src/config/database');
const { createHealthCheck } = require('./src/services/health');
const { createApp } = require('./src/app');
const { createShutdown } = require('./src/services/shutdown');
async function start() {
  const config = readConfig();
  const authConfig = require('./src/config/auth').readAuthConfig();
  const pool = createDatabasePool(config.database);
  const repo = require('./src/repositories/auth').createAuthRepository(pool, authConfig);
  const authentication = { repo, config: authConfig, auth: require('./src/services/auth').createAuthService(repo, authConfig), users: require('./src/services/users').createUsersService(repo) };
  const app = createApp({ config, checkDatabase: createHealthCheck(pool, config.healthTimeout), authentication });
  const server = app.listen(config.port, config.host);
  try {
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  } catch { await pool.end(); throw new Error('No se pudo iniciar HTTP'); }
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  const shutdown = createShutdown({ server, pool, timeoutMs: config.shutdownTimeout });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    shutdown().catch(() => { console.error('Fallo el cierre del servicio'); process.exitCode = 1; });
  });
  console.log('POS API escuchando en puerto ' + config.port);
  return { server, pool, shutdown };
}
if (require.main === module) start().catch(() => {
  console.error('No se pudo iniciar POS API: revise las variables de entorno y el puerto'); process.exitCode = 1;
});
module.exports = { start };
