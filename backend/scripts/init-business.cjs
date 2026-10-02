'use strict';
const readline = require('node:readline/promises');
const { Writable } = require('node:stream');
const { readConfig } = require('../src/config/environment');
const { createDatabasePool } = require('../src/config/database');
const { bootstrap } = require('../src/services/bootstrap');
const v = require('../src/middleware/validation');
async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Ejecutar en una terminal interactiva');
  const config = readConfig();
  let muted = false;
  const output = new Writable({ write(chunk, encoding, callback) { if (!muted) process.stdout.write(chunk, encoding); callback(); } });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
  const ask = prompt => rl.question(prompt);
  async function secret(prompt) {
    process.stdout.write(prompt); muted = true;
    try { return await rl.question(''); } finally { muted = false; process.stdout.write('\n'); }
  }
  let pool;
  try {
    console.log('Se creara el primer negocio y su administrador. La base debe estar vacia de negocios.');
    const businessName = v.text(await ask('Nombre del negocio: '), 160);
    const username = v.username(await ask('Usuario administrador: '));
    const fullName = v.text(await ask('Nombre completo: '), 160);
    const password = v.password(await secret('Contrasena (minimo 12 caracteres, entrada oculta): '), true);
    if (password !== await secret('Repetir contrasena: ')) throw new Error('Las contrasenas no coinciden');
    if (await ask('Escriba CREAR para continuar: ') !== 'CREAR') throw new Error('Registro cancelado');
    pool = createDatabasePool(config.database);
    const result = await bootstrap(pool, { businessName, username, fullName, password }, config.database.database);
    console.log('Negocio creado. businessId=' + result.businessId + ', userId=' + result.userId + ', username=' + result.username);
  } finally { rl.close(); if (pool) await pool.end(); }
}
main().catch(() => { console.error('No se realizo el registro inicial. Revise entradas, permisos y que no existan negocios.'); process.exitCode = 1; });
