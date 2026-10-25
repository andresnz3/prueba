'use strict';

const { readdirSync, readFileSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
// Third-party minified assets are byte-verified by check:vendor. Their license
// and compatibility strings can contain question marks/replacement markers;
// scan authored text separately to avoid treating vendor data as UI copy.
const SKIP_DIRS = new Set(['.git', '.codex', '.aws', 'node_modules', 'dist', 'vendor', 'test-results', 'test-results-connected', 'playwright-report', 'coverage']);
const TEXT_EXTENSIONS = new Set([
  '.bat', '.cjs', '.conf', '.css', '.csv', '.html', '.ini', '.java', '.js', '.json', '.jsonc', '.jsx',
  '.md', '.mjs', '.ps1', '.py', '.sh', '.sql', '.svg', '.toml', '.ts', '.tsx', '.txt', '.xml', '.yaml', '.yml'
]);
const DAMAGED_PATTERNS = [
  ['secuencia de puntuación incompleta', /\u00e2\u20ac(?:$|[^\u0080-\u00bf\u0153\u2122\u009c])/u],
  ['UTF-8 interpretado como Latin-1', /\u00c3[\u0080-\u00bf]/u],
  ['secuencia Â de doble decodificación', /\u00c2[\u0080-\u00bf]/u],
  ['puntuación UTF-8 mal decodificada', /\u00e2\u20ac(?:[\u0080-\u00bf]|\u2122|\u0153|\u009c)/u],
  ['emoji UTF-8 mal decodificado', /\u00f0\u0178[\u0080-\u00bf]/u],
  ['carácter de reemplazo Unicode', /\ufffd/u],
  ['acento español sustituido por ?', /\b(?:administraci|actualizaci|aplicaci|autenticaci|comunicaci|configuraci|conciliaci|conexi|contrase|exportaci|gesti|importaci|informaci|migraci|operaci|protecci|revisi|selecci|sesi|transacci|validaci|versi|t)\?[a-z]*\b/iu],
  ['palabra española truncada por ?', /\b(?:c\?rg\w*|aqu\?|hist\?ric\w*|p\?gin\w*|direcci\?n)\b/iu]
];

function collectFiles(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collectFiles(path.join(directory, entry.name), files);
      continue;
    }
    if (TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) && !/^\.env(?:\.|$)/i.test(entry.name)) {
      files.push(path.join(directory, entry.name));
    }
  }
  return files;
}

function findIssues(file, text) {
  const issues = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const [kind, pattern] of DAMAGED_PATTERNS) {
      const match = pattern.exec(line);
      if (match) {
        const start = Math.max(0, match.index - 72);
        const end = Math.min(line.length, match.index + match[0].length + 96);
        issues.push({ file, line: index + 1, kind, sample: line.slice(start, end).replaceAll('\ufffd', '[U+FFFD]').trim() });
      }
    }
  });
  return issues;
}

function main() {
  let scanned = 0;
  const issues = [];
  for (const file of collectFiles(ROOT)) {
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(file));
    } catch {
      issues.push({ file, line: 0, kind: 'archivo de texto no válido como UTF-8', sample: '' });
      continue;
    }
    scanned++;
    issues.push(...findIssues(path.relative(ROOT, file), text));
  }
  if (issues.length) {
    for (const issue of issues) process.stderr.write(`${issue.file}:${issue.line}: ${issue.kind}\n`);
    process.stderr.write(`Codificación: ${issues.length} hallazgos en ${scanned} archivos de texto.\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`Codificación UTF-8: ${scanned} archivos revisados, sin texto sospechoso.\n`);
}

if (require.main === module) main();
module.exports = { collectFiles, findIssues };
