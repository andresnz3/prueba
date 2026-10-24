'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { newUser } = require('../src/middleware/validation');
const valid = { username: 'yo2', fullName: 'yo2', password: 'Synthetic-password-123!', role: 'VENDEDOR' };
for (const role of ['ADMIN', 'VENDEDOR']) test('system user validates role ' + role, () => {
 assert.deepEqual(newUser({ ...valid, fullName: '  Valid Name  ', role }), { ...valid, fullName: 'Valid Name', role });
});
for (const [field, value] of [['username','yo'],['username','bad space'],['username','a'.repeat(101)],['fullName','   '],['fullName','a'.repeat(161)],['password','short'],['password','x'.repeat(257)],['password','\u00e9'.repeat(129)],['role','OWNER']]) test('system user rejects '+field+' ('+String(value).length+') with field metadata',()=>{
 assert.throws(()=>newUser({...valid,[field]:value}),e=>e.publicStatus===400&&e.publicCode==='INVALID_INPUT'&&e.field===field);
});
test('system user requires fields and rejects injected business authority',()=>{
 assert.throws(()=>newUser({ ...valid, password:undefined }),e=>e.field==='password');
 assert.throws(()=>newUser({ ...valid, businessId:'2' }),e=>e.publicCode==='INVALID_INPUT');
 assert.throws(()=>newUser({ ...valid, active:false }),e=>e.publicCode==='INVALID_INPUT');
});
