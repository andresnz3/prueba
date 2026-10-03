'use strict';
const fs = require('node:fs/promises');
const { join } = require('node:path');
const { randomBytes } = require('node:crypto');
const sharp = require('sharp');
const { httpError } = require('../middleware/errors');
const MAX_SOURCE = 8 * 1024 * 1024, MAX_OUTPUT = 512 * 1024, MAX_PIXELS = 40000000;
const referencePattern = /^\/api\/product-images\/([1-9]\d{0,19})\/([a-f0-9]{32}\.jpg)$/;
function parseReference(value, business) {
  const match = typeof value === 'string' && referencePattern.exec(value);
  if (!match || match[1] !== String(business)) throw httpError(400, 'IMAGE_REFERENCE_INVALID');
  return match[2];
}
function sniff(buffer) {
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'jpeg';
  if (buffer.length >= 8 && buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png';
  if (buffer.length >= 12 && buffer.toString('ascii',0,4) === 'RIFF' && buffer.toString('ascii',8,12) === 'WEBP') return 'webp';
  throw httpError(415, 'IMAGE_FORMAT_INVALID');
}
let conversions = 0;
async function normalize(buffer, mime) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw httpError(400, 'IMAGE_INVALID');
  if (buffer.length > MAX_SOURCE) throw httpError(413, 'IMAGE_TOO_LARGE');
  const format = sniff(buffer);
  if (mime !== 'image/' + format) throw httpError(415, 'IMAGE_FORMAT_INVALID');
  if (conversions >= 2) throw httpError(429,'IMAGE_BUSY');
  conversions++;
  try {
    const pipeline = sharp(buffer, { limitInputPixels: MAX_PIXELS, failOn: 'warning' });
    const info = await pipeline.metadata();
    if (info.format !== format || (info.pages || 1) !== 1) throw httpError(415, 'IMAGE_FORMAT_INVALID');
    if (!info.width || !info.height || info.width * info.height > MAX_PIXELS) throw httpError(400, 'IMAGE_DIMENSIONS_LIMIT');
    let output = await pipeline.rotate().resize(1024,1024,{ fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 82 }).toBuffer();
    if (output.length > MAX_OUTPUT) output = await sharp(output).resize(800,800,{ fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 65 }).toBuffer();
    if (output.length > MAX_OUTPUT) throw httpError(413, 'IMAGE_TOO_LARGE');
    return output;
  } catch (error) {
    if (error.publicCode) throw error;
    if (/pixel limit/i.test(error.message)) throw httpError(400, 'IMAGE_DIMENSIONS_LIMIT');
    throw httpError(400, 'IMAGE_INVALID');
  } finally { conversions--; }
}
function createImageStore(config) {
  function directory(business) {
    if (!/^[1-9]\d{0,19}$/.test(String(business))) throw httpError(400, 'IMAGE_REFERENCE_INVALID');
    return join(config.root, String(business));
  }
  async function storage(work) {
    try { return await work(); } catch (error) { if (error.publicCode) throw error; throw httpError(503, 'IMAGE_STORAGE_UNAVAILABLE'); }
  }
  async function save(business, buffer) {
    return storage(async () => {
      const dir = directory(business);
      await fs.mkdir(dir,{recursive:true,mode:0o700});
      let size = 0;
      for (const file of await fs.readdir(dir)) if (/^[a-f0-9]{32}\.jpg$/.test(file)) size += (await fs.stat(join(dir,file))).size;
      if (size + buffer.length > config.quota) throw httpError(409,'IMAGE_QUOTA_EXCEEDED');
      const name = randomBytes(16).toString('hex') + '.jpg';
      await fs.writeFile(join(dir,name),buffer,{flag:'wx',mode:0o600});
      return '/api/product-images/' + business + '/' + name;
    });
  }
  async function assertOwned(business, reference) {
    if (reference === null) return;
    const name = parseReference(reference,business);
    return storage(async () => {
      let info;
      try { info = await fs.stat(join(directory(business),name)); } catch (error) { if (error.code === 'ENOENT') throw httpError(400,'IMAGE_REFERENCE_INVALID'); throw error; }
      if (!info.isFile() || info.size > MAX_OUTPUT) throw httpError(400,'IMAGE_REFERENCE_INVALID');
    });
  }
  async function read(business, reference) {
    const name = parseReference(reference,business);
    return storage(async () => {
      await assertOwned(business,reference);
      return fs.readFile(join(directory(business),name));
    });
  }
  async function remove(business, reference) {
    const name = parseReference(reference,business);
    return storage(() => fs.unlink(join(directory(business),name)));
  }
  return { save, assertOwned, read, remove };
}
module.exports = { createImageStore, normalize, parseReference, MAX_SOURCE, MAX_OUTPUT, MAX_PIXELS };
