import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SENSITIVITY_LEVELS, normalizeSensitivity, sensitivityHeaders, sensitivityOfHeader, sensitivityOfRaw, storedSensitivity,
} from './sensitivity.js';
import { parseRawMessage } from './mime/index.js';
import { parseDraftFields } from './draft.js';

const raw = (headers: string) => Buffer.from(`From: a@example.com\r\n${headers}Subject: x\r\n\r\nSensitivity: Private\r\n`);

test('sensitivity is read from the top-level Sensitivity header (case-insensitive), the body is ignored', () => {
  assert.equal(sensitivityOfRaw(raw('Sensitivity: Personal\r\n')), 'personal');
  assert.equal(sensitivityOfRaw(raw('Sensitivity: private\r\n')), 'private');
  assert.equal(sensitivityOfRaw(raw('Sensitivity: Company-Confidential\r\n')), 'confidential');
  assert.equal(sensitivityOfRaw(raw('sensitivity:   COMPANY-CONFIDENTIAL  \r\n')), 'confidential');
  assert.equal(sensitivityOfRaw(raw('Sensitivity: secret\r\n')), 'normal');
  assert.equal(sensitivityOfRaw(raw('')), 'normal', 'only the body mentions it');
  assert.equal(sensitivityOfHeader(null), 'normal');
  assert.equal(sensitivityOfHeader('Confidential'), 'confidential');
});

test('client and job values are normalised; normal is stored as null and writes no header', () => {
  assert.deepEqual(SENSITIVITY_LEVELS, ['normal', 'personal', 'private', 'confidential']);
  assert.equal(normalizeSensitivity('private'), 'private');
  assert.equal(normalizeSensitivity('Private'), 'normal', 'only the exact level names');
  assert.equal(normalizeSensitivity('private\r\nBcc: x@y.z'), 'normal');
  assert.equal(normalizeSensitivity(undefined), 'normal');
  assert.equal(storedSensitivity('normal'), null);
  assert.equal(storedSensitivity('confidential'), 'confidential');
  assert.deepEqual(sensitivityHeaders('normal'), {});
  assert.deepEqual(sensitivityHeaders('personal'), { Sensitivity: 'Personal' });
  assert.deepEqual(sensitivityHeaders('private'), { Sensitivity: 'Private' });
  assert.deepEqual(sensitivityHeaders('confidential'), { Sensitivity: 'Company-Confidential' });
});

test('parseRawMessage and parseDraftFields carry the sensitivity', async () => {
  assert.equal((await parseRawMessage(raw('Sensitivity: Private\r\n'))).sensitivity, 'private');
  assert.equal((await parseRawMessage(raw(''))).sensitivity, null);
  assert.equal((await parseDraftFields(raw('Sensitivity: Personal\r\n'))).sensitivity, 'personal');
  assert.equal((await parseDraftFields(raw(''))).sensitivity, 'normal');
});
