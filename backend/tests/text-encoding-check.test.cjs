'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findIssues } = require('../../scripts/check-text-encoding.cjs');

test('encoding audit accepts Spanish UTF-8 and ordinary query strings', () => {
  const text = 'Información: áéíóú ñ Ñ ü ¿Qué tal? ¡Bien! /search?term=negocio&tab=1';
  assert.deepEqual(findIssues('fixture.txt', text), []);
});

test('encoding audit detects common mojibake and replacement characters', () => {
  const mojibake = String.fromCharCode(0x00c3, 0x00b3);
  const incompletePunctuation = String.fromCharCode(0x00e2, 0x20ac);
  const replacement = String.fromCharCode(0xfffd);
  const issues = findIssues('fixture.txt', 'importaci' + mojibake + 'n ' + incompletePunctuation + ' ' + replacement);
  assert.equal(issues.some(issue => issue.kind === 'UTF-8 interpretado como Latin-1'), true);
  assert.equal(issues.some(issue => issue.kind === 'secuencia de puntuación incompleta'), true);
  assert.equal(issues.some(issue => issue.kind === 'carácter de reemplazo Unicode'), true);
});

test('encoding audit detects common Spanish question-mark substitutions', () => {
  const damagedQuestion = String.fromCharCode(0x3f);
  const issues = findIssues('fixture.txt', 'informaci' + damagedQuestion + 'n C' + damagedQuestion + 'rgalo');
  assert.equal(issues.some(issue => issue.kind === 'acento español sustituido por ?'), true);
  assert.equal(issues.some(issue => issue.kind === 'palabra española truncada por ?'), true);
});
