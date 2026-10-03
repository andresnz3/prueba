'use strict';
const { randomBytes } = require('node:crypto');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve, dirname, basename } = require('node:path');
const sharp = require('sharp');
async function photo() { return sharp(randomBytes(256*256*3),{raw:{width:256,height:256,channels:3}}).png().toBuffer(); }
async function imageDirectory() { return mkdtemp(join(tmpdir(),'pos-images-test-')); }
async function removeImages(dir) {
  const target = resolve(dir);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('pos-images-test-')) throw new Error('Destino de limpieza inseguro');
  await rm(target,{recursive:true,force:true});
}
module.exports = { photo, imageDirectory, removeImages };
