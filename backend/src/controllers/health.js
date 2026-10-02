'use strict';
function healthController(checkDatabase) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      await checkDatabase();
      res.status(200).json({ status: 'ok', server: 'up', database: 'up' });
    } catch {
      res.status(503).json({ status: 'degraded', server: 'up', database: 'unavailable' });
    }
  };
}
module.exports = { healthController };
