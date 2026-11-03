'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readFrontendCsp() {
  const root = path.resolve(__dirname, '../..');
  const nginx = fs.readFileSync(path.join(root, 'docker/nginx/default.conf'), 'utf8');
  const match = nginx.match(/map\s+\$host\s+\$pos_content_security_policy\s*\{\s*default\s+"([^"]+)"\s*;\s*\}/s);
  if (!match) throw new Error('No se encontró la política CSP de Nginx');
  return match[1];
}

module.exports = { readFrontendCsp };
