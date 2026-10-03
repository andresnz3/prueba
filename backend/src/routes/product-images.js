'use strict';
const express = require('express');
const { authMiddleware, requireModule } = require('../middleware/authentication');
const { httpError } = require('../middleware/errors');
const { MAX_SOURCE } = require('../services/product-images');
const v = require('../middleware/validation');
const { createAuthRateLimit } = require('../middleware/auth-rate-limit');
function productImageRoutes(authentication, service) {
  const router = express.Router();
  const m = authMiddleware(authentication.repo,authentication.config);
  const rate = createAuthRateLimit({rateMax:30,rateWindowSeconds:60});
  let inFlight = 0;
  router.use(m.authenticate,(req,res,next) => { res.set('Cache-Control','no-store'); next(); });
  router.post('/',requireModule(authentication.auth,'inventory'),m.csrf,rate,(req,res,next) => {
    v.body(req.query,[]);
    if (!['image/jpeg','image/png','image/webp'].includes(req.get('Content-Type'))) throw httpError(415,'IMAGE_FORMAT_INVALID');
    if (inFlight >= 2) { res.set('Retry-After','2'); throw httpError(429,'IMAGE_BUSY'); }
    inFlight++;
    let released = false;
    const release = () => { if (!released) { released = true; inFlight--; } };
    res.once('finish',release); res.once('close',release); next();
  },express.raw({type:()=>true,limit:MAX_SOURCE,inflate:false}),async(req,res) => {
    res.status(201).json({ image: await service.uploadImage(req.auth,req.body,req.get('Content-Type')), businessId: String(req.auth.business_id) });
  });
  router.get('/:businessId/:name',async(req,res) => {
    v.body(req.query,[]);
    if (req.params.businessId !== String(req.auth.business_id) || !/^[a-f0-9]{32}\.jpg$/.test(req.params.name)) throw httpError(404,'IMAGE_NOT_FOUND');
    const image = '/api/product-images/' + req.params.businessId + '/' + req.params.name;
    const buffer = await service.readImage(req.auth,image);
    res.set('Cross-Origin-Resource-Policy','cross-origin'); res.type('jpeg').send(buffer);
  });
  return router;
}
module.exports = { productImageRoutes };
