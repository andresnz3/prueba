'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs/promises');
const { join } = require('node:path');
const sharp = require('sharp');
const { readConfig } = require('../../src/config/environment');
const { readAuthConfig } = require('../../src/config/auth');
const { createDatabasePool } = require('../../src/config/database');
const { createAuthRepository, rows } = require('../../src/repositories/auth');
const { createAuthService } = require('../../src/services/auth');
const { createUsersService } = require('../../src/services/users');
const { hashPassword } = require('../../src/services/passwords');
const { createApp } = require('../../src/app');
const { photo, imageDirectory, removeImages } = require('../helpers/image-fixtures.cjs');
const database=process.env.POS_INTEGRATION_DATABASE;
if (!/^pos_auth_test_[a-f0-9]{24}$/.test(database||'') || database===process.env.DB_NAME)throw new Error('Usar MySQL temporal');
const password='Image-fixture-password-123!';
const input=(barcode,image=null)=>({barcode,name:'Producto con foto',category:'Bebidas',cost:'10.00',marginRetail:'25',marginWholesale:'10',retailPrice:'12.50',wholesalePrice:'11.00',stock:'0',minStock:'1',image});
function client(base) {
  const jar=new Map(); let csrf;
  async function request(path,method='GET',body,headers={}) {
    const response=await fetch(base+path,{method,headers:{Cookie:[...jar].map(([key,value])=>key+'='+value).join('; '),...(method==='GET'?{}:{'Content-Type':Buffer.isBuffer(body)?'image/png':'application/json','X-CSRF-Token':csrf||''}),...headers},body:method==='GET'?undefined:(Buffer.isBuffer(body)?body:JSON.stringify(body))});
    for (const cookie of response.headers.getSetCookie()) {const pair=cookie.split(';')[0],index=pair.indexOf('=');jar.set(pair.slice(0,index),pair.slice(index+1));}
    const data=response.status===204?{}:response.headers.get('content-type')?.startsWith('image/')?Buffer.from(await response.arrayBuffer()):await response.json();
    if(data.csrfToken)csrf=data.csrfToken;
    return {status:response.status,data,headers:response.headers};
  }
  async function login(businessId,username) {await request('/api/auth/csrf');assert.equal((await request('/api/auth/login','POST',{businessId,username,password})).status,200);}
  return {request,login};
}
test('Integracion MySQL y almacenamiento privado de fotografias',async t=>{
  const root=await imageDirectory();t.after(()=>removeImages(root));
  const config={...readConfig(),images:{root,quota:256*1024*1024}},authConfig=readAuthConfig({CSRF_SECRET:randomBytes(32).toString('hex'),AUTH_RATE_MAX:'100'});
  const pool=createDatabasePool({...config.database,database});t.after(()=>pool.end());
  const business=String((await rows(pool,'INSERT INTO businesses (name) VALUES (?)',['Images A'])).insertId),otherBusiness=String((await rows(pool,'INSERT INTO businesses (name) VALUES (?)',['Images B'])).insertId);
  const hash=await hashPassword(password);
  for(const [owner,name,role]of[[business,'imgadmin','ADMIN'],[business,'imgseller','VENDEDOR'],[otherBusiness,'imgadmin','ADMIN']])await rows(pool,'INSERT INTO users (business_id, username, full_name, password_hash, role) VALUES (?, ?, ?, ?, ?)',[owner,name,name,hash,role]);
  const repo=createAuthRepository(pool,authConfig),authentication={repo,config:authConfig,auth:createAuthService(repo,authConfig),users:createUsersService(repo)};
  async function serve(options=config){const server=createApp({config:options,checkDatabase:async()=>{},authentication}).listen(0,'127.0.0.1');await new Promise(ok=>server.once('listening',ok));t.after(()=>new Promise(ok=>{server.close(ok);server.closeAllConnections();}));return 'http://127.0.0.1:'+server.address().port;}
  const base=await serve(),admin=client(base),other=client(base),seller=client(base),anon=client(base);
  await admin.login(business,'imgadmin');await other.login(otherBusiness,'imgadmin');await seller.login(business,'imgseller');
  const source=await photo();let image,product;
  await t.test('regresion: JSON Base64 no llega a MySQL y el limite JSON sigue en 16 KiB',async()=>{
    assert.ok(source.toString('base64').length>65000);
    assert.equal((await admin.request('/api/products','POST',input('BASE64','data:image/png;base64,'+source.toString('base64')))).status,413);
    const result=await admin.request('/api/products','POST',input('BASE64','data:image/png;base64,AA=='));assert.equal(result.status,400);assert.equal(result.data.error.code,'IMAGE_REQUIRES_UPLOAD');
    assert.equal((await rows(pool,'SELECT id FROM products WHERE business_id = ?',[business])).length,0);
  });
  await t.test('carga binaria mayor que 96 KiB guarda solo una referencia corta en TEXT',async()=>{
    assert.ok(source.length>98304);const uploaded=await admin.request('/api/product-images','POST',source);assert.equal(uploaded.status,201);image=uploaded.data.image;
    assert.equal((await admin.request(image)).status,404);
    const created=await admin.request('/api/products','POST',input('PHOTO',image));assert.equal(created.status,201);product=created.data.product;
    const [row]=await rows(pool,'SELECT image FROM products WHERE business_id = ? AND id = ?',[business,product.id]);assert.equal(row.image,image);assert.ok(row.image.length<128);assert.ok(!row.image.includes('base64'));
    const result=await admin.request(image);assert.equal(result.status,200);assert.equal(result.headers.get('cache-control'),'no-store');assert.equal((await sharp(result.data).metadata()).format,'jpeg');
  });
  await t.test('editar sin fotografia conserva referencia; reemplazarla persiste otra y oculta la anterior',async()=>{
    let updated=await admin.request('/api/products/'+product.id,'PATCH',{revision:product.revision,name:'Foto conservada'});assert.equal(updated.status,200);assert.equal(updated.data.product.image,image);
    const replacement=(await admin.request('/api/product-images','POST',source)).data.image;
    updated=await admin.request('/api/products/'+product.id,'PATCH',{revision:updated.data.product.revision,image:replacement});assert.equal(updated.status,200);
    assert.equal((await admin.request(image)).status,404);image=replacement;
    assert.equal((await admin.request('/api/products/'+product.id)).data.product.image,image);
  });
  await t.test('descarga exige sesion; carga exige inventario y CSRF',async()=>{
    assert.equal((await anon.request(image)).status,401);assert.equal((await anon.request('/api/product-images','POST',source)).status,401);
    assert.equal((await seller.request('/api/product-images','POST',source)).status,403);
    assert.equal((await admin.request('/api/product-images','POST',source,{'X-CSRF-Token':'wrong'})).status,403);
    assert.equal((await seller.request(image)).status,200);
    const copy=(await admin.request('/api/products','POST',input('SHARED',image))).data.product;
    const current=(await admin.request('/api/products/'+product.id)).data.product;
    assert.equal((await admin.request('/api/products/'+product.id,'PATCH',{revision:current.revision,active:false})).status,200);
    assert.equal((await seller.request(image)).status,200);
    assert.equal((await admin.request('/api/products/'+copy.id,'PATCH',{revision:copy.revision,active:false})).status,200);
    assert.equal((await seller.request(image)).status,404);assert.equal((await admin.request(image)).status,200);
    assert.equal((await seller.request('/api/auth/authorizations','POST',{module:'inventory',adminUsername:'imgadmin',adminPassword:password})).status,201);
    assert.equal((await seller.request(image)).status,200);
    assert.equal((await seller.request('/api/auth/authorizations/inventory','DELETE',{})).status,204);
    assert.equal((await seller.request(image)).status,404);
  });
  await t.test('aislamiento: otro negocio no descarga ni asigna fotografias ajenas',async()=>{
    assert.equal((await other.request(image)).status,404);
    const attach=await other.request('/api/products','POST',input('FOREIGN',image));assert.equal(attach.status,400);assert.equal(attach.data.error.code,'IMAGE_REFERENCE_INVALID');
    const forged=image.replace('/'+business+'/','/'+otherBusiness+'/');assert.equal((await other.request('/api/products','POST',input('FORGED',forged))).status,400);
    assert.equal((await other.request('/api/products','POST',input('PATH','/api/product-images/'+otherBusiness+'/../secret.jpg'))).status,400);
  });
  await t.test('errores especificos de tamano, formato, archivo corrupto y parametros desconocidos',async()=>{
    for(const [body,headers,status,code]of[[Buffer.alloc(8*1024*1024+1),{},413,'IMAGE_TOO_LARGE'],[source,{'Content-Type':'image/jpeg'},415,'IMAGE_FORMAT_INVALID'],[source.subarray(0,12),{},400,'IMAGE_INVALID'],[Buffer.from('<svg/>'),{'Content-Type':'image/svg+xml'},415,'IMAGE_FORMAT_INVALID']]){const result=await admin.request('/api/product-images','POST',body,headers);assert.equal(result.status,status);assert.equal(result.data.error.code,code);}
    assert.equal((await admin.request('/api/product-images?businessId='+otherBusiness,'POST',source)).status,400);
  });
  await t.test('permiso temporal vencido impide carga sin crear archivos',async()=>{
    assert.equal((await seller.request('/api/auth/authorizations','POST',{module:'inventory',adminUsername:'imgadmin',adminPassword:password})).status,201);
    await rows(pool,'UPDATE session_authorizations SET expires_at = TIMESTAMPADD(SECOND, -1, UTC_TIMESTAMP(3)) WHERE business_id = ? AND module = ?',[business,'inventory']);
    const before=await fs.readdir(join(root,business));assert.equal((await seller.request('/api/product-images','POST',source)).status,403);assert.deepEqual(await fs.readdir(join(root,business)),before);
  });
  await t.test('almacen inaccesible devuelve 503 sin revelar ruta ni confirmar una fotografia',async()=>{
    const blocked=join(root,'blocked.txt');await fs.writeFile(blocked,'fixture');const unavailable=client(await serve({...config,images:{root:blocked,quota:256*1024*1024}}));await unavailable.login(business,'imgadmin');
    const result=await unavailable.request('/api/product-images','POST',source);assert.equal(result.status,503);assert.deepEqual(result.data,{error:{code:'IMAGE_STORAGE_UNAVAILABLE'}});
  });
});
