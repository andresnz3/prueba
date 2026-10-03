'use strict';
const { Router } = require('express');
const { authMiddleware, requireModule } = require('../middleware/authentication');
const v = require('../middleware/validation');
const values = require('../services/inventory-values');
const { httpError } = require('../middleware/errors');
function inventoryRoutes(authentication, service) {
  const router = Router();
  const m = authMiddleware(authentication.repo, authentication.config);
  // Limitar middleware a estas rutas; no interceptar autenticacion ni otros modulos.
  router.use(['/products', '/catalog/products', '/inventory'], m.authenticate, (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.use(['/products', '/inventory'], requireModule(authentication.auth, 'inventory'));
  router.use(['/products', '/inventory'], (req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (!req.is('application/json')) throw httpError(415, 'JSON_REQUIRED');
      return m.csrf(req, res, next);
    }
    next();
  });
  function options(req) {
    const result = values.page(req.query, ['search']);
    if (req.query.search !== undefined) result.search = v.text(req.query.search, 180);
    return result;
  }
  router.get('/catalog/products', async (req, res) => res.json({ products: await service.list(req.auth, options(req), true) }));
  router.get('/products', async (req, res) => res.json({ products: await service.list(req.auth, options(req)) }));
  router.get('/products/:id', async (req, res) => { v.body(req.query, []); res.json({ product: await service.get(req.auth, v.id(req.params.id)) }); });
  router.get('/products/:id/stock', async (req, res) => { v.body(req.query, []); const product = await service.get(req.auth, v.id(req.params.id)); res.json({ productId: product.id, businessId: product.businessId, stock: product.stock, minStock: product.minStock, revision: product.revision }); });
  router.post('/products', async (req, res) => res.status(201).json({ product: await service.create(req.auth, values.product(req.body)) }));
  router.patch('/products/:id', async (req, res) => res.json({ product: await service.update(req.auth, v.id(req.params.id), values.product(req.body, true)) }));
  router.post('/products/:id/movements', async (req, res) => res.status(201).json({ product: await service.adjust(req.auth, v.id(req.params.id), values.movement(req.body)) }));
  router.get('/inventory/movements', async (req, res) => {
    const options = values.page(req.query, ['productId', 'maxId']);
    if (req.query.productId !== undefined) options.productId = v.id(req.query.productId);
    if (req.query.maxId !== undefined) options.maxId = v.id(req.query.maxId);
    res.json({ movements: await service.movements(req.auth, options) });
  });
  return router;
}
module.exports = { inventoryRoutes };
