'use strict';
const { test, expect } = require('@playwright/test');
const { randomUUID } = require('node:crypto');
const { createDatabasePool } = require('../backend/src/config/database');
const { readConfig } = require('../backend/src/config/environment');
const { verifyPassword } = require('../backend/src/services/passwords');
const password = 'Synthetic-user-password-123!';
const target = process.env.POS_TEST_BUSINESS_B;
async function panel(page) {
 await page.goto('/?mode=connected'); await page.locator('#loginUsername').fill('andres'); await page.locator('#loginPassword').fill('Browser-fixture-password-123!'); await page.locator('#loginForm button[type=submit]').click(); await expect(page.locator('#app')).toBeVisible();
 await page.locator('#navSystemAdminBtn').click(); await page.locator('#systemAdminUsersTab').click(); await page.locator('#systemAdminUserBusinessId').selectOption(target); await expect(page.locator('#systemAdminUserBusinessId')).toHaveValue(target); await expect(page.locator('#systemAdminUsersCapacity')).toContainText('usuarios activos');
}
async function fill(page, username, role = 'ADMIN') {
 await page.locator('#systemAdminUsername').fill(username); await page.locator('#systemAdminFullName').fill('yo2'); await page.locator('#systemAdminPassword').fill(password); await page.locator('#systemAdminRole').selectOption(role);
}
async function request(page, path, method = 'GET', body) {
 return page.evaluate(async ({path,method,body})=>{
  const client=new window.PosApiClient(window.POS_API_BASE_URL); const session=await client.me();
  const response=await fetch(window.POS_API_BASE_URL+path,{method,credentials:'include',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken},...(body?{body:JSON.stringify(body)}:{})});
  return {status:response.status,body:await response.json()};
 },{path,method,body});
}
function poolForTest() {
 const config=readConfig(),database=process.env.POS_INTEGRATION_DATABASE;
 if(!/^pos_auth_test_[a-f0-9]{24}$/.test(database||'')||database===config.database.database)throw Error('Unsafe database');
 return createDatabasePool({...config.database,database});
}
for(const role of ['ADMIN','VENDEDOR']) test('panel creates active '+role+', hashes password, logs in and isolates business',async({page,browser})=>{
 await panel(page);let businessTarget=target;if(role==='ADMIN'){businessTarget=await page.evaluate(async()=>{const api=new window.PosApiClient(window.POS_API_BASE_URL);await api.me();return(await api.createAdminBusiness('Admin-only '+crypto.randomUUID(),'CONECTADO_BASICO')).id;});await page.reload();await expect(page.locator('#app')).toBeVisible();await page.locator('#navSystemAdminBtn').click();await page.locator('#systemAdminUsersTab').click();await page.locator('#systemAdminUserBusinessId').selectOption(businessTarget);await expect(page.locator('#systemAdminUserBusinessId')).toHaveValue(String(businessTarget));await expect(page.locator('#systemAdminUsersCapacity')).toContainText('0 de 3 usuarios activos');}const username='user_'+randomUUID().slice(0,8);const pool=poolForTest();
 const tables=['sales','purchases','products','inventory_movements','cash_sessions','cash_movements'];
 try{
  const counts=async()=>{const values=[];for(const table of tables)values.push(Number((await pool.execute('SELECT COUNT(*) n FROM '+table))[0][0].n));return values;};
  const before=await counts();await fill(page,username,role);
  const pending=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/admin/businesses/'+businessTarget+'/users'));
  await page.locator('#systemAdminUserForm button').click();const response=await pending;expect(response.status()).toBe(201);const created=(await response.json()).user;
  expect(created).toMatchObject({username,fullName:'yo2',role,active:true,businessId:businessTarget});expect(created.password_hash).toBeUndefined();
  await expect(page.locator('#systemAdminUsersBody tr').filter({hasText:username})).toContainText(role==='ADMIN'?'Administrador':'Vendedor');await expect(page.locator('#systemAdminPassword')).toHaveValue('');
  const [rows]=await pool.execute('SELECT business_id,role,active,password_hash FROM users WHERE username=?',[username]);expect(rows).toHaveLength(1);expect(String(rows[0].business_id)).toBe(businessTarget);expect(rows[0].role).toBe(role);expect(Number(rows[0].active)).toBe(1);expect(rows[0].password_hash).toMatch(/^\$argon2id\$/);expect(await verifyPassword(rows[0].password_hash,password)).toBe(true);expect(rows[0].password_hash).not.toBe(password);
  const loginContext=await browser.newContext();try{
   const userPage=await loginContext.newPage();await userPage.goto('/?mode=connected');await userPage.locator('#loginUsername').fill(username);await userPage.locator('#loginPassword').fill(password);await userPage.locator('#loginForm button[type=submit]').click();await expect(userPage.locator('#app')).toBeVisible();
   const me=await request(userPage,'/auth/me');expect(me.body.user).toMatchObject({businessId:businessTarget,username,role,active:true});
   expect((await request(userPage,'/users')).status).toBe(role==='ADMIN'?200:403);
   expect((await request(userPage,'/admin/businesses')).status).toBe(403);
   expect((await request(userPage,'/admin/businesses/1/users','POST',{username:'blocked_'+randomUUID().slice(0,8),fullName:'Blocked',password,role:'ADMIN'})).status).toBe(403);
   if(role==='ADMIN'){const list=await request(userPage,'/users');expect(list.body.users.every(u=>u.businessId===businessTarget)).toBe(true);expect(list.body.users.some(u=>u.username==='andres')).toBe(false);}
  }finally{await loginContext.close();}
  for(const businessId of [businessTarget,'1']){
   const duplicate=await request(page,'/admin/businesses/'+businessId+'/users','POST',{username:username.toUpperCase(),fullName:'Duplicate',password,role});expect(duplicate.status).toBe(409);expect(duplicate.body.error.code).toBe('USERNAME_EXISTS');
  }
  await fill(page,username,role);await page.locator('#systemAdminUserForm button').click();await expect(page.locator('#systemAdminUsernameFieldError')).toContainText('ya existe');await expect(page.locator('#systemAdminUsername')).toHaveValue(username);await expect(page.locator('#systemAdminPassword')).toHaveValue('');
  expect(await counts()).toEqual(before);
 }finally{await pool.end();}
});
for(const role of ['ADMIN','VENDEDOR']) test('yo is rejected visibly without sending a creation for '+role,async({page})=>{
 await panel(page);await fill(page,'yo',role);expect(await page.locator('#systemAdminUsername').evaluate(node=>node.validity.patternMismatch)).toBe(true);const writes=[];page.on('request',r=>{if(r.method()==='POST'&&/\/admin\/businesses\/\d+\/users$/.test(r.url()))writes.push(r.url());});
 await page.locator('#systemAdminUserForm button').click();await expect(page.locator('#systemAdminUsernameFieldError')).toContainText('3 a 100');await expect(page.locator('#systemAdminUsername')).toHaveAttribute('aria-invalid','true');await expect(page.locator('#systemAdminUsername')).toBeFocused();await expect(page.locator('#systemAdminFullName')).toHaveValue('yo2');expect(writes).toEqual([]);await page.screenshot({path:test.info().outputPath('username-validation.png')});
 const invalid=await request(page,'/admin/businesses/'+target+'/users','POST',{username:'yo',fullName:'yo2',password,role});expect(invalid).toEqual({status:400,body:{error:{code:'INVALID_INPUT',field:'username'}}});
});
test('API validates fields and refuses missing session, CSRF, unknown business and injected authority',async({page,browser})=>{
 await panel(page);const path='/admin/businesses/'+target+'/users';const valid={username:'valid_'+randomUUID().slice(0,8),fullName:'Valid',password,role:'ADMIN'};
 for(const [field,value] of [['username','yo'],['fullName','   '],['password','short'],['password','x'.repeat(257)],['role','OWNER']]){
  const result=await request(page,path,'POST',{...valid,[field]:value});expect(result.status).toBe(400);expect(result.body.error).toMatchObject({code:'INVALID_INPUT',field});
 }
 expect((await request(page,path,'POST',{...valid,businessId:'1'})).status).toBe(400);
 expect((await request(page,'/admin/businesses/999999999/users','POST',valid)).body.error.code).toBe('BUSINESS_NOT_FOUND');
 const missingCsrf=await page.evaluate(async({path,body})=>{const r=await fetch(window.POS_API_BASE_URL+path,{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return r.status;},{path,body:valid});expect(missingCsrf).toBe(403);
 const anonymous=await browser.newContext();try{expect((await anonymous.request.post(process.env.POS_TEST_API+path,{data:valid})).status()).toBe(401);}finally{await anonymous.close();}
});
