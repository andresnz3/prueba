const { test, expect } = require('@playwright/test');
const { randomBytes } = require('node:crypto');
const { photo } = require('../backend/tests/helpers/image-fixtures.cjs');
const business=process.env.POS_TEST_BUSINESS;
const errors=new WeakMap();
test.beforeEach(async({page})=>{const list=[];errors.set(page,list);page.on('pageerror',error=>list.push(error.message));});
test.afterEach(async({page})=>expect(errors.get(page)).toEqual([]));
async function login(page,connected=true){await page.goto(connected?'/?mode=connected':'/');await expect(page.locator('#loginForm button')).toBeEnabled();if(connected)await page.locator('#loginBusinessId').fill(business);await page.locator('#loginUsername').fill(connected?'browseradmin':'andres');await page.locator('#loginPassword').fill(connected?'Browser-fixture-password-123!':'4321');await page.locator('#loginForm button').click();await expect(page.locator('#app')).toBeVisible();await page.locator('#navInventoryBtn').click();await expect(page.locator('#inventoryView')).toBeVisible();}
async function form(page){const barcode='PIC-'+randomBytes(5).toString('hex');await page.locator('#addNewProductBtn').click();for(const[id,value]of Object.entries({prodBarcode:barcode,prodName:barcode,prodCost:'10',prodStock:'2'}))await page.locator('#'+id).fill(value);return barcode;}
async function closeAlert(page){await expect(page.locator('#customAlertModal')).toBeVisible();await page.locator('#customAlertModal .close-modal-btn').click();}
async function save(page){await page.locator('#productForm button[type=submit]').click();await expect(page.locator('#customAlertMessage')).toContainText('MySQL');await closeAlert(page);}
const file=buffer=>({name:'fotografia.png',mimeType:'image/png',buffer});
test('fotografia mayor que TEXT se carga binaria y persiste al crear editar y recargar',async({page})=>{
  const source=await photo();expect(source.toString('base64').length).toBeGreaterThan(65000);const writes=[];
  page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/products')writes.push(request.postDataJSON());});
  await login(page);const barcode=await form(page);await page.locator('#prodImageInput').setInputFiles(file(source));
  expect(await page.evaluate(()=>window.PosRuntime.productImage())).toMatch(/^blob:/);
  await save(page);expect(writes).toHaveLength(1);expect(writes[0].image).toMatch(/^\/api\/product-images\/[1-9]\d*\/[a-f0-9]{32}\.jpg$/);expect(JSON.stringify(writes[0]).length).toBeLessThan(16384);
  let row=page.locator('#inventoryTableBody tr').filter({hasText:barcode});await expect.poll(()=>row.locator('img').evaluate(img=>img.complete&&img.naturalWidth>0)).toBe(true);
  const original=await row.locator('img').getAttribute('src');await row.getByRole('button',{name:'Editar',exact:true}).click();await page.locator('#prodName').fill(barcode+' Editado');await save(page);await expect(row.locator('img')).toHaveAttribute('src',original);
  await row.getByRole('button',{name:'Editar',exact:true}).click();await page.locator('#prodImageInput').setInputFiles(file(source));await save(page);const replaced=await row.locator('img').getAttribute('src');expect(replaced).not.toBe(original);
  await page.reload();await expect(page.locator('#app')).toBeVisible();await page.locator('#navInventoryBtn').click();row=page.locator('#inventoryTableBody tr').filter({hasText:barcode});await expect(row.locator('img')).toHaveAttribute('src',replaced);await expect.poll(()=>row.locator('img').evaluate(img=>img.complete&&img.naturalWidth>0)).toBe(true);
});
test('tamano y formato rechazados en frontend muestran errores especificos y se pueden corregir',async({page})=>{
  let uploads=0;page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/product-images')uploads++;});await login(page);await form(page);
  await page.locator('#prodImageInput').setInputFiles(file(Buffer.alloc(8*1024*1024+1)));await expect(page.locator('#customAlertMessage')).toContainText('8 MiB');await closeAlert(page);
  await page.locator('#prodImageInput').setInputFiles({name:'foto.svg',mimeType:'image/svg+xml',buffer:Buffer.from('<svg/>')});await expect(page.locator('#customAlertMessage')).toContainText('Formato');await closeAlert(page);expect(uploads).toBe(0);
  await page.locator('#prodImageInput').setInputFiles(file(await photo()));await save(page);expect(uploads).toBe(1);
});
test('fotografia corrupta se rechaza en backend sin crear producto y sin mensaje generico',async({page})=>{
  await login(page);const barcode=await form(page);const source=await photo();await page.locator('#prodImageInput').setInputFiles(file(source.subarray(0,12)));await page.locator('#productForm button[type=submit]').click();await expect(page.locator('#customAlertMessage')).toContainText('no es una imagen valida');await expect(page.locator('#productModal')).toBeVisible();await expect(page.locator('#inventoryTableBody tr').filter({hasText:barcode})).toHaveCount(0);
});
test('error de conexion durante carga no guarda Base64 ni producto en Dexie',async({page})=>{
  await login(page);await form(page);await page.locator('#prodImageInput').setInputFiles(file(await photo()));await page.route('**/api/product-images',route=>route.abort('failed'));await page.locator('#productForm button[type=submit]').click();await expect(page.locator('#customAlertMessage')).toContainText('conectar');expect(await page.evaluate(()=>localDB.products.count())).toBe(0);
});
test('modo local conserva fotografia Base64 en Dexie sin llamar a la API',async({page})=>{
  const requests=[];page.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/api/'))requests.push(request.url());});await login(page,false);const barcode=await form(page);await page.locator('#prodImageInput').setInputFiles(file(await photo()));await expect.poll(()=>page.evaluate(()=>window.PosRuntime.productImage())).toMatch(/^data:image\/png;base64,/);await page.locator('#productForm button[type=submit]').click();await expect(page.locator('#customAlertMessage')).toContainText('exitosamente');await closeAlert(page);await page.reload();await expect(page.locator('#loginScreen')).toBeVisible();await page.locator('#loginUsername').fill('andres');await page.locator('#loginPassword').fill('4321');await page.locator('#loginForm button').click();await expect(page.locator('#app')).toBeVisible();expect(await page.evaluate(async code=>(await localDB.products.where('barcode').equals(code).first()).image,barcode)).toMatch(/^data:image\/png;base64,/);expect(requests).toEqual([]);
});
