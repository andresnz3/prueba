'use strict';
function createHealthCheck(pool, timeoutMs) {
  return async function checkDatabase() {
    let expired = false;
    let connection;
    let timer;
    const probe = (async () => {
      connection = await pool.getConnection();
      if (expired) { connection.destroy(); connection = undefined; throw new Error('Health timeout'); }
      await connection.execute('SELECT ? AS health', [1]);
    })();
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        expired = true;
        if (connection) { connection.destroy(); connection = undefined; }
        reject(new Error('Health timeout'));
      }, timeoutMs);
    });
    try { await Promise.race([probe, timeout]); }
    finally { clearTimeout(timer); if (connection) connection.release(); }
  };
}
module.exports = { createHealthCheck };
