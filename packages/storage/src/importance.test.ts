import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  importanceMailOption, importanceOfRaw, normalizeImportance, storedImportance,
} from './importance.js';
import { parseRawMessage } from './mime/index.js';
import { parseDraftFields } from './draft.js';

const raw = (headers: string) => Buffer.from(`From: a@example.com\r\n${headers}Subject: x\r\n\r\nImportance: high\r\n`);

test('importance is read from Importance, X-Priority, Priority and X-MSMail-Priority', () => {
  assert.equal(importanceOfRaw(raw('Importance: High\r\n')), 'high');
  assert.equal(importanceOfRaw(raw('Importance: low\r\n')), 'low');
  assert.equal(importanceOfRaw(raw('X-Priority: 1 (Highest)\r\n')), 'high');
  assert.equal(importanceOfRaw(raw('X-Priority: 2\r\n')), 'high');
  assert.equal(importanceOfRaw(raw('X-Priority: 3\r\n')), 'normal');
  assert.equal(importanceOfRaw(raw('X-Priority: 5 (Lowest)\r\n')), 'low');
  assert.equal(importanceOfRaw(raw('Priority: urgent\r\n')), 'high');
  assert.equal(importanceOfRaw(raw('Priority: non-urgent\r\n')), 'low');
  assert.equal(importanceOfRaw(raw('X-MSMail-Priority: High\r\n')), 'high');
  // Importance wins over X-Priority; unknown values and the body are ignored
  assert.equal(importanceOfRaw(raw('Importance: normal\r\nX-Priority: 1\r\n')), 'normal');
  assert.equal(importanceOfRaw(raw('Importance: very\r\n')), 'normal');
  assert.equal(importanceOfRaw(raw('')), 'normal');
});

test('client and job values are normalised; normal is stored as null and writes no headers', () => {
  assert.equal(normalizeImportance('high'), 'high');
  assert.equal(normalizeImportance('low'), 'low');
  assert.equal(normalizeImportance('High\r\nBcc: x@y.z'), 'normal');
  assert.equal(normalizeImportance(undefined), 'normal');
  assert.equal(storedImportance('normal'), null);
  assert.equal(storedImportance('high'), 'high');
  assert.deepEqual(importanceMailOption('normal'), {});
  assert.deepEqual(importanceMailOption('low'), { priority: 'low' });
});

test('parseRawMessage and parseDraftFields carry the importance', async () => {
  assert.equal((await parseRawMessage(raw('X-Priority: 1\r\n'))).importance, 'high');
  assert.equal((await parseRawMessage(raw(''))).importance, null);
  assert.equal((await parseDraftFields(raw('Importance: Low\r\n'))).importance, 'low');
  assert.equal((await parseDraftFields(raw(''))).importance, 'normal');
});
