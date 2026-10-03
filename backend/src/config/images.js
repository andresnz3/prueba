'use strict';
const { resolve, isAbsolute, relative, sep } = require('node:path');
const { homedir } = require('node:os');
const repository = resolve(__dirname, '../../..');
function readImageConfig(env = process.env, mode = env.NODE_ENV || 'development') {
  if (mode === 'production' && !env.IMAGE_STORAGE_DIR) throw new Error('Configuracion obligatoria: IMAGE_STORAGE_DIR');
  if (env.IMAGE_STORAGE_DIR && !isAbsolute(env.IMAGE_STORAGE_DIR)) throw new Error('Configuracion invalida: IMAGE_STORAGE_DIR');
  const root = resolve(env.IMAGE_STORAGE_DIR || resolve(homedir(), '.pos/product-images'));
  const inside = relative(repository, root);
  if (!inside || (inside !== '..' && !inside.startsWith('..' + sep) && !isAbsolute(inside))) throw new Error('IMAGE_STORAGE_DIR debe quedar fuera del repositorio publico');
  return { root, quota: 256 * 1024 * 1024 };
}
module.exports = { readImageConfig };
