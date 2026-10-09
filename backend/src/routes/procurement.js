'use strict';
const { Router } = require('express');
const { authMiddleware } = require('../middleware/authentication');
const v = require('../middleware/validation');
const values = require('../services/procurement-values');
const inventoryValues = require('../services/inventory-values');
const { httpError } = require('../middleware/errors');
function procurementRoutes(authentication, service) {
  const router = Router(), m = authMiddleware(authentication.repo, authentication.config);
  router.use(['/suppliers', '/purchases', '/payables'], m.authenticate, (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (!req.is('application/json')) throw httpError(415, 'JSON_REQUIRED');
      return m.csrf(req, res, next);
    }
    next();
  });
  const page = query => {
    const options = inventoryValues.page(query, ['q']);
    const q = query.q === undefined ? null : v.text(query.q, 100);
    return { ...options, q };
  };
  router.get('/suppliers', async (req, res) => res.json({ suppliers: await service.listSuppliers(req.auth, page(req.query)) }));
  router.post('/suppliers', async (req, res) => res.status(201).json(await service.createSupplier(req.auth, values.supplier(req.body))));
  router.get('/purchases/suppliers', async (req, res) => res.json({ suppliers: await service.listSuppliers(req.auth, page(req.query), 'purchases') }));
  router.post('/purchases/suppliers', async (req, res) => res.status(201).json(await service.createSupplier(req.auth, values.supplier(req.body), 'purchases')));
  router.get('/suppliers/:id', async (req, res) => { v.body(req.query, []); res.json({ supplier: await service.getSupplier(req.auth, v.id(req.params.id)) }); });
  router.patch('/suppliers/:id', async (req, res) => res.json(await service.updateSupplier(req.auth, v.id(req.params.id), values.supplier(req.body, true))));
  router.patch('/suppliers/:id/active', async (req, res) => res.json(await service.setSupplierActive(req.auth, v.id(req.params.id), values.active(req.body))));
  router.get('/suppliers/:id/statement', async (req, res) => { v.body(req.query, ['limit', 'offset'], []); res.json(await service.statement(req.auth, v.id(req.params.id), inventoryValues.page(req.query))); });
  router.get('/purchases/products', async (req, res) => res.json({ products: await service.purchaseProducts(req.auth, page(req.query)) }));
  router.post('/purchases/products', async (req, res) => res.status(201).json(await service.createPurchaseProduct(req.auth, inventoryValues.product(req.body))));
  router.get('/purchases', async (req, res) => res.json({ purchases: await service.listPurchases(req.auth, page(req.query)) }));
  router.post('/purchases', async (req, res) => res.status(201).json(await service.recordPurchase(req.auth, values.purchase(req.body))));
  router.get('/purchases/:id', async (req, res) => { v.body(req.query, []); res.json({ purchase: await service.getPurchase(req.auth, v.id(req.params.id)) }); });
  router.post('/purchases/:id/cancel', async (req, res) => res.json(await service.cancelPurchase(req.auth, v.id(req.params.id), values.cancellation(req.body))));
  router.get('/payables', async (req, res) => res.json({ payables: await service.listPayables(req.auth, page(req.query)) }));
  router.get('/payables/summary', async (req, res) => { v.body(req.query, []); res.json({ summary: await service.payablesSummary(req.auth) }); });
  router.get('/payables/:id', async (req, res) => { v.body(req.query, []); res.json({ purchase: await service.getPayable(req.auth, v.id(req.params.id)) }); });
  router.post('/payables/:id/payments', async (req, res) => res.status(201).json(await service.payInvoice(req.auth, v.id(req.params.id), values.payment(req.body))));
  return router;
}
module.exports = { procurementRoutes };
