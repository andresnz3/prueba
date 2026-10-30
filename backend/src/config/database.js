'use strict';
const mysql = require('mysql2/promise');
const { createConnectionAdmission, installBoundedAdmission } = require('./connection-admission');
let lastDiagnosticAt = 0;
let suppressedDiagnostics = 0;
function createDatabasePool(config) {
  const { connectionQueueLimit = 20, acquireTimeout = 3000, ...mysqlConfig } = config;
  const admission = createConnectionAdmission({ limit: mysqlConfig.connectionLimit, queueLimit: connectionQueueLimit, timeoutMs: acquireTimeout });
  const pool = mysql.createPool({ ...mysqlConfig, waitForConnections: false, queueLimit: 0,
    multipleStatements: false, charset: 'utf8mb4', timezone: 'Z', supportBigNumbers: true,
    bigNumberStrings: true, decimalNumbers: false, enableKeepAlive: true });
  function logDiagnostic(waitMs, event = 'database_connection_wait') {
    const now = Date.now();
    if (now - lastDiagnosticAt < 1000) { suppressedDiagnostics += 1; return; }
    console.warn(JSON.stringify({ event, durationMs: Math.round(waitMs), pool: admission.snapshot(), ...(suppressedDiagnostics ? { suppressedSinceLastLog: suppressedDiagnostics } : {}) }));
    suppressedDiagnostics = 0;
    lastDiagnosticAt = now;
  }
  installBoundedAdmission(pool.pool, admission, (waitedMs, event) => {
    if (event === 'database_slow_statement' || waitedMs >= 250) logDiagnostic(waitedMs, event);
  });
  pool.diagnostics = admission.snapshot;
  pool.recordTransaction = durationMs => {
    admission.recordTransaction(durationMs);
    if (durationMs >= 1000) logDiagnostic(durationMs, 'database_slow_transaction');
  };
  return pool;
}
module.exports = { createDatabasePool };
