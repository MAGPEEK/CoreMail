import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_TEMPLATE_INPUT, MAX_TEMPLATE_BODY_BYTES, composeFromTemplate, filterTemplates, keepSelection, stepSelection,
  templateBodyTooLarge, templateChanged, templateFromDraft, templateInputOf, templateInsertPlan, templateNameProblem,
  type MailTemplate, type TemplateSummary,
} from './mailTemplates.ts';
import { initialBodyHtml } from './composeQuote.ts';
import { realtimePlan } from './realtimeEvents.ts';
import { translations } from '../i18n/translations.ts';

const summaries: TemplateSummary[] = [
  { id: 'a', name: 'Angebot', subject: 'Ihr Angebot', preview: 'Guten Tag, anbei das Angebot', updatedAt: '' },
  { id: 'b', name: 'Absage', subject: 'Bewerbung', preview: 'Leider müssen wir', updatedAt: '' },
  { id: 'c', name: 'Rechnung', subject: '', preview: 'Bitte überweisen', updatedAt: '' },
];

const tpl: MailTemplate = {
  id: 't1', name: 'Angebot', subject: 'Ihr Angebot', bodyHtml: '<p>Hallo</p>', bodyText: 'Hallo',
  to: ['Kunde <kunde@example.org>'], cc: ['chef@example.org'], bcc: ['archiv@example.org'], updatedAt: '',
};

test('filterTemplates: every word in name, subject or preview, case-insensitive', () => {
  assert.deepEqual(filterTemplates(summaries, '').map((t) => t.id), ['a', 'b', 'c']);
  assert.deepEqual(filterTemplates(summaries, 'ANGEBOT').map((t) => t.id), ['a']);
  assert.deepEqual(filterTemplates(summaries, 'bewerbung leider').map((t) => t.id), ['b']);
  assert.deepEqual(filterTemplates(summaries, 'überweisen').map((t) => t.id), ['c']);
  assert.deepEqual(filterTemplates(summaries, 'angebot leider'), []);
});

test('keepSelection / stepSelection: list keyboard and filtering', () => {
  assert.equal(keepSelection(summaries, 'b'), 'b');
  assert.equal(keepSelection(summaries, 'gone'), 'a');
  assert.equal(keepSelection([], 'a'), null);
  assert.equal(stepSelection(summaries, 'a', 'ArrowDown'), 'b');
  assert.equal(stepSelection(summaries, 'c', 'ArrowDown'), 'a');
  assert.equal(stepSelection(summaries, 'a', 'ArrowUp'), 'c');
  assert.equal(stepSelection(summaries, null, 'ArrowDown'), 'a');
  assert.equal(stepSelection(summaries, 'b', 'Home'), 'a');
  assert.equal(stepSelection(summaries, 'a', 'End'), 'c');
  assert.equal(stepSelection(summaries, 'a', 'x'), null);
  assert.equal(stepSelection([], null, 'ArrowDown'), null);
});

test('templateNameProblem / templateBodyTooLarge: the server limits', () => {
  assert.equal(templateNameProblem('   '), 'empty');
  assert.equal(templateNameProblem('x'.repeat(101)), 'tooLong');
  assert.equal(templateNameProblem(` ${'x'.repeat(100)} `), null);
  assert.equal(templateBodyTooLarge('a'.repeat(MAX_TEMPLATE_BODY_BYTES), ''), false);
  assert.equal(templateBodyTooLarge('ä'.repeat(MAX_TEMPLATE_BODY_BYTES / 2 + 1), ''), true, 'counted in UTF-8 bytes');
  assert.equal(templateBodyTooLarge('', 'b'.repeat(MAX_TEMPLATE_BODY_BYTES + 1)), true);
});

test('composeFromTemplate: a new mail with subject, An, Cc; Bcc and the body go with the template part', () => {
  const ctx = composeFromTemplate(tpl, '<p>Hallo</p>');
  assert.deepEqual(ctx, {
    mode: 'new', subject: 'Ihr Angebot', toAddrs: ['Kunde <kunde@example.org>'], ccAddrs: ['chef@example.org'],
    template: { bodyHtml: '<p>Hallo</p>', bcc: ['archiv@example.org'] },
  });
  ctx.toAddrs.push('x@example.org');
  assert.equal(tpl.to.length, 1, 'the template is not changed through the context');
});

test('initialBodyHtml: the template body replaces the empty first line, the signature follows', () => {
  const sig = '<div data-cm-signature="">S</div>';
  assert.equal(initialBodyHtml(sig, '', '<p>Hallo</p>'), `<p>Hallo</p>${sig}`);
  assert.equal(initialBodyHtml('', '', '<p>Hallo</p>'), '<p>Hallo</p>');
  assert.equal(initialBodyHtml(sig, ''), `<p></p>${sig}`, 'no template: unchanged');
});

test('templateInsertPlan: fills only empty fields, never replaces what was written', () => {
  assert.deepEqual(templateInsertPlan({ subject: '', to: [], cc: [], bcc: [] }, tpl), {
    subject: 'Ihr Angebot', to: ['Kunde <kunde@example.org>'], cc: ['chef@example.org'], bcc: ['archiv@example.org'],
  });
  assert.deepEqual(templateInsertPlan({ subject: 'Eigener Betreff', to: ['a@example.org'], cc: [], bcc: ['b@example.org'] }, tpl), {
    cc: ['chef@example.org'],
  });
  assert.deepEqual(templateInsertPlan({ subject: '   ', to: [], cc: [], bcc: [] }, { subject: '', to: [], cc: [], bcc: [] }), {});
  assert.equal(templateInsertPlan({ subject: '  ', to: [], cc: [], bcc: [] }, tpl).subject, 'Ihr Angebot', 'blank counts as empty');
});

test('templateFromDraft / templateInputOf / templateChanged', () => {
  const input = templateFromDraft('  Kurz ', { subject: 'S', to: ['a@example.org'], cc: [], bcc: [] }, { html: '<p>x</p>', text: 'x' });
  assert.deepEqual(input, { name: 'Kurz', subject: 'S', bodyHtml: '<p>x</p>', bodyText: 'x', to: ['a@example.org'], cc: [], bcc: [] });
  assert.equal(templateInputOf({ ...input, name: ' N ' }).name, 'N');
  assert.equal(templateChanged(input, { ...input }), false);
  assert.equal(templateChanged(input, { ...input, name: ' Kurz  ' }), false, 'surrounding spaces of the name do not count');
  assert.equal(templateChanged(input, { ...input, bodyText: 'other' }), false, 'the text follows the HTML');
  assert.equal(templateChanged(input, { ...input, bodyHtml: '<p>y</p>' }), true);
  assert.equal(templateChanged(input, { ...input, cc: ['c@example.org'] }), true);
  assert.equal(templateChanged(EMPTY_TEMPLATE_INPUT, { ...EMPTY_TEMPLATE_INPUT, subject: 'x' }), true);
});

test('realtime: a templates settings event refreshes the template list and every template', () => {
  const plan = realtimePlan('settings', { section: 'templates' });
  assert.deepEqual(plan.invalidate, [['mail-templates']]);
  assert.equal(plan.refreshPreferences, undefined);
});

test('texts: German and English for every template text', () => {
  const keys = Object.keys(translations.de).filter((k) => k.startsWith('tpl_') || k.startsWith('compose_template_'));
  assert.ok(keys.length > 20);
  for (const k of keys) assert.ok((translations.en as Record<string, string>)[k], k);
  assert.equal(translations.de.tpl_picker_title_new, 'Neue E-Mail aus Vorlage');
  assert.equal(translations.de.tpl_empty, 'Keine Vorlagen vorhanden');
  assert.equal(translations.de.compose_template_insert, 'Vorlage einfügen …');
});
