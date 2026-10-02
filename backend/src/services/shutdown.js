'use strict';
function createShutdown({ server, pool, timeoutMs, forceExit = code => process.exit(code) }) {
  let closing;
  return function shutdown() {
    if (closing) return closing;
    closing = (async () => {
      const timer = setTimeout(() => { server.closeAllConnections(); forceExit(1); }, timeoutMs);
      try {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await pool.end();
      } finally { clearTimeout(timer); }
    })();
    return closing;
  };
}
module.exports = { createShutdown };
