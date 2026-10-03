'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { normalize, createImageStore, parseReference, MAX_SOURCE, MAX_OUTPUT } = require('../src/services/product-images');
const { readImageConfig } = require('../src/config/images');
const { product } = require('../src/services/inventory-values');
const { photo, imageDirectory, removeImages } = require('./helpers/image-fixtures.cjs');
test('regresion: Base64 mayor que TEXT exige carga independiente, sin INVALID_INPUT generico',async() => {
  const data = await photo(); assert.ok(data.toString('base64').length > 65000);
  assert.throws(()=>product({revision:'a'.repeat(64),image:'data:image/png;base64,'+data.toString('base64')},true),error=>error.publicCode==='IMAGE_REQUIRES_UPLOAD');
});
test('normaliza JPEG PNG WebP, reduce dimensiones y descarta metadatos',async() => {
  for (const format of ['jpeg','png','webp']) {
    const input = await sharp({create:{width:1600,height:1200,channels:3,background:'red'}})[format]().withMetadata().toBuffer();
    const output = await normalize(input,'image/'+format); const info = await sharp(output).metadata();
    assert.equal(info.format,'jpeg'); assert.equal(info.width,1024); assert.equal(info.height,768); assert.equal(info.exif,undefined); assert.equal(info.icc,undefined); assert.ok(output.length<=MAX_OUTPUT);
  }
});
test('rechaza tamano, formato falso, SVG, imagen corrupta y archivo vacio con errores especificos',async() => {
  const input = await photo();
  for (const [buffer,mime,code] of [[Buffer.alloc(MAX_SOURCE+1),'image/png','IMAGE_TOO_LARGE'],[input,'image/jpeg','IMAGE_FORMAT_INVALID'],[Buffer.from('<svg/>'),'image/svg+xml','IMAGE_FORMAT_INVALID'],[input.subarray(0,12),'image/png','IMAGE_INVALID'],[Buffer.alloc(0),'image/png','IMAGE_INVALID']]) await assert.rejects(normalize(buffer,mime),error=>error.publicCode===code);
});
test('referencias impiden traversal y acceso a otra empresa',() => {
  const reference='/api/product-images/1/'+'a'.repeat(32)+'.jpg'; assert.equal(parseReference(reference,'1'),'a'.repeat(32)+'.jpg');
  for (const value of [reference.replace('/1/','/2/'),'/api/product-images/1/../image.jpg','https://external/image.jpg']) assert.throws(()=>parseReference(value,'1'));
});
test('almacen privado, cuota, archivos faltantes y aislamiento de directorios',async t => {
  const root=await imageDirectory(); t.after(()=>removeImages(root));
  const buffer=await normalize(await photo(),'image/png'); const store=createImageStore({root,quota:buffer.length});
  const image=await store.save('1',buffer); assert.deepEqual(await store.read('1',image),buffer);
  await assert.rejects(store.save('1',buffer),error=>error.publicCode==='IMAGE_QUOTA_EXCEEDED');
  await assert.rejects(store.assertOwned('2',image),error=>error.publicCode==='IMAGE_REFERENCE_INVALID');
  await store.remove('1',image); await assert.rejects(store.assertOwned('1',image),error=>error.publicCode==='IMAGE_REFERENCE_INVALID');
});
test('config exige ruta privada absoluta en produccion y fuera del repositorio',() => {
  assert.throws(()=>readImageConfig({},'production'),/IMAGE_STORAGE_DIR/);
  assert.throws(()=>readImageConfig({IMAGE_STORAGE_DIR:'uploads'},'development'));
  assert.throws(()=>readImageConfig({IMAGE_STORAGE_DIR:process.cwd()},'development'));
  assert.ok(readImageConfig({},'development').root);
});
