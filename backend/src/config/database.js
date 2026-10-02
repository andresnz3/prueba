'use strict';
const mysql = require('mysql2/promise');
function createDatabasePool(config) {
  return mysql.createPool({ ...config, waitForConnections: false, queueLimit: 0,
    multipleStatements: false, charset: 'utf8mb4', timezone: 'Z', supportBigNumbers: true,
    bigNumberStrings: true, decimalNumbers: false, enableKeepAlive: true });
}
module.exports = { createDatabasePool };
