import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stageLabelKey, detailLabelKey, valueLabelKey, detailEntries, stageTls, formatDuration, formatBytes, plainValue,
  overviewOf, hasFewerDetails, resultOf, KNOWN_STAGES, RESULT_TONE,
} from './messageTrace.ts';

const AT = '2026-11-20T10:00:00.000Z';

test('stage, detail and value label keys', () => {
  assert.equal(stageLabelKey('virus-scan'), 'mt_stage_virus_scan');
  assert.equal(stageLabelKey('queue-result'), 'mt_stage_queue_result');
  assert.equal(stageLabelKey('something-new'), 'mt_stage_other');
  assert.equal(detailLabelKey('clientIp'), 'mt_k_clientIp');
  assert.equal(valueLabelKey('verdict', 'user-junk'), 'mt_v_user_junk');
  assert.equal(valueLabelKey('spf', 'pass'), null, 'protocol results stay as they are');
  assert.equal(valueLabelKey('reason', 'Connection checks passed'), null, 'free text is not a word key');
  assert.equal(valueLabelKey('verdict', 3), null);
  assert.ok(KNOWN_STAGES.includes('mx'));
});

test('every known stage, result and value key exists in both languages', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../i18n/translations.ts', import.meta.url), 'utf8');
  const [de, en] = src.split('const en:');
  for (const s of KNOWN_STAGES) {
    const key = `${stageLabelKey(s)}:`;
    assert.ok(de!.includes(key) && en!.includes(key), key);
  }
  for (const r of ['ok', 'warn', 'fail', 'info']) assert.ok(de!.includes(`mt_result_${r}:`) && en!.includes(`mt_result_${r}:`));
});

test('detail entries are ordered, special keys hidden, rule ids only without names', () => {
  const conn = { stage: 'connection', at: AT, result: 'ok', detail: { sessionId: 'S1', tls: true, tlsVersion: 'TLSv1.3', clientIp: '192.0.2.1', helo: 'x' } };
  assert.deepEqual(detailEntries(conn).map(([k]) => k), ['clientIp', 'helo', 'sessionId']);
  const rules = { stage: 'transport-rules', at: AT, result: 'info', detail: { ruleIds: ['r1'], actions: ['subject'] } };
  assert.deepEqual(detailEntries(rules).map(([k]) => k), ['ruleIds', 'actions']);
  const named = { ...rules, detail: { ...rules.detail, ruleNames: ['Extern'] } };
  assert.deepEqual(detailEntries(named).map(([k]) => k).sort(), ['actions', 'ruleNames']);
});

test('TLS line of connection and remote stages', () => {
  assert.deepEqual(stageTls({ stage: 'connection', at: AT, result: 'ok', detail: { tls: true, tlsVersion: 'TLSv1.3', tlsCipher: 'TLS_AES_128_GCM_SHA256' } }),
    { encrypted: true, text: 'TLSv1.3 · TLS_AES_128_GCM_SHA256' });
  assert.deepEqual(stageTls({ stage: 'connection', at: AT, result: 'warn', detail: { tls: false } }), { encrypted: false, text: '' });
  assert.equal(stageTls({ stage: 'connection', at: AT, result: 'ok', detail: { clientIp: 'x' } }), null, 'unknown for callers without session data');
  assert.deepEqual(stageTls({ stage: 'remote', at: AT, result: 'ok', detail: { tls: 'starttls' } }), { encrypted: true, text: 'STARTTLS' });
  assert.deepEqual(stageTls({ stage: 'remote', at: AT, result: 'ok', detail: { tls: 'none' } }), { encrypted: false, text: '' });
  assert.equal(stageTls({ stage: 'spam', at: AT, result: 'ok' }), null);
});

test('durations, sizes and plain values', () => {
  assert.equal(formatDuration(0.2), '<1 ms');
  assert.equal(formatDuration(850), '850 ms');
  assert.equal(formatDuration(2300, 'de'), '2,3 s');
  assert.equal(formatDuration(2300, 'en'), '2.3 s');
  assert.equal(formatDuration(240_000), '4 min');
  assert.equal(formatDuration(7_500_000), '2 h 5 min');
  assert.equal(formatDuration(-3000, 'en'), '−3 s');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048, 'en'), '2 KB');
  assert.equal(formatBytes(-1), '');
  assert.equal(plainValue('records', ['10 a', '20 b']), '10 a, 20 b');
  assert.equal(plainValue('heldMs', 5000, 'en'), '5 s');
  assert.equal(plainValue('port', 2525), '2525');
  assert.equal(plainValue('score', 7.123, 'de'), '7,12');
});

test('overview facts from the metadata; older entries are recognised', () => {
  const o = overviewOf({ id: 'x', timestamp: AT, level: 'INFO', message: '', metadata: {
    sender: 'a@b.test', recipient: 'c@d.test, e@f.test', subject: 'Hi', size: '2048', status: 'DELIVERED',
    messageId: 'trk-1', headerMessageId: '<m@b.test>', attempt: '2',
  } });
  assert.deepEqual([o.messageId, o.recipients, o.size, o.attempt], ['<m@b.test>', ['c@d.test', 'e@f.test'], 2048, '2']);
  assert.equal(overviewOf({ id: 'y', timestamp: AT, level: 'INFO', message: '', metadata: null }).size, null);
  assert.equal(hasFewerDetails({ trace: null }), true);
  assert.equal(hasFewerDetails({ trace: { stages: [{ stage: 'spam', at: AT, result: 'ok' }] } }), false);
  assert.equal(resultOf('bogus'), 'info');
  assert.ok(RESULT_TONE.fail.includes('danger'));
});
