'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');

async function hashFile(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function collect(root, current = root, items = []) {
  const entries = await fs.readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) {
    const filename = path.join(current, entry.name);
    const stat = await fs.lstat(filename);
    if (stat.isSymbolicLink()) throw new Error('Image storage contains a symbolic link; backup was refused');
    if (stat.isDirectory()) await collect(root, filename, items);
    else if (stat.isFile()) {
      const relative = path.relative(root, filename).split(path.sep).join('/');
      items.push({ path: relative, bytes: stat.size, sha256: await hashFile(filename) });
    } else throw new Error('Image storage contains an unsupported filesystem entry');
  }
  return items;
}

async function main() {
  const configured = process.env.IMAGE_STORAGE_DIR;
  if (typeof configured !== 'string' || !path.isAbsolute(configured)) throw new Error('IMAGE_STORAGE_DIR must be absolute');
  const root = await fs.realpath(configured);
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Image storage root is not a regular directory');
  const files = await collect(root);
  const canonical = JSON.stringify(files);
  const result = {
    fileCount: files.length,
    totalBytes: files.reduce((total, item) => total + item.bytes, 0),
    sha256: createHash('sha256').update(canonical).digest('hex')
  };
  process.stdout.write(JSON.stringify(result) + '\n');
}

main().catch(error => {
  console.error(error?.message || 'Image manifest failed');
  process.exitCode = 1;
});
