import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LONG_QUOTE_CHARS, QUOTE_ATTR, buildQuoteHtml, initialBodyHtml, isLongQuote, isReplyMode, quoteHeaderLines,
  quoteStartsFolded, quotedPart, subjectFor, textToParagraphsHtml,
} from './composeQuote.ts';
import { ownText } from './attachmentReminder.ts';

const LABELS = { from: 'Von', sent: 'Gesendet', to: 'An', cc: 'Cc', subject: 'Betreff' };
const fmtDate = (d: Date) => d.toISOString().slice(0, 16).replace('T', ' ');

test('subject: Re:/Fwd: prefixes, existing prefixes (also German AW:/WG:) are kept', () => {
  assert.equal(subjectFor('reply', 'Angebot'), 'Re: Angebot');
  assert.equal(subjectFor('replyAll', 'Angebot'), 'Re: Angebot');
  assert.equal(subjectFor('forward', 'Angebot'), 'Fwd: Angebot');
  assert.equal(subjectFor('new', 'Angebot'), 'Angebot');
  for (const s of ['Re: x', 'AW: x', 'WG: x', 'fwd: x', 'FW: x']) assert.equal(subjectFor('reply', s), s);
  assert.equal(subjectFor('reply', undefined), '');
  assert.ok(isReplyMode('replyAll') && !isReplyMode('forward') && !isReplyMode(undefined));
});

test('quote header: Von / Gesendet / An / Cc / Betreff, empty lines left out', () => {
  const lines = quoteHeaderLines({
    fromAddr: 'anna@example.test', fromName: 'Anna', date: '2026-11-18T09:15:00.000Z',
    toAddrs: ['me@example.test', 'b@example.test'], ccAddrs: [], subject: 'Angebot',
  }, LABELS, fmtDate);
  assert.deepEqual(lines, [
    ['Von', 'Anna <anna@example.test>'],
    ['Gesendet', '2026-11-18 09:15'],
    ['An', 'me@example.test; b@example.test'],
    ['Betreff', 'Angebot'],
  ]);
  assert.deepEqual(quoteHeaderLines({ fromAddr: 'a@example.test', date: 'not a date' }, LABELS, fmtDate), [['Von', 'a@example.test']]);
});

test('quote html: separator + header + body in one marked blockquote; values are escaped', () => {
  const html = buildQuoteHtml(
    { fromAddr: 'x@example.test', fromName: '<img src=x onerror=alert(1)>', subject: 'a & b <script>' },
    '<p>original</p>', LABELS, fmtDate,
  );
  assert.ok(html.startsWith(`<blockquote ${QUOTE_ATTR}=""><hr><p><strong>Von:</strong> `));
  assert.ok(html.endsWith('<p>original</p></blockquote>'));
  assert.ok(!html.includes('<img'), 'name escaped');
  assert.ok(!html.includes('<script>'), 'subject escaped');
  assert.ok(html.includes('a &amp; b &lt;script&gt;'));
  assert.ok(buildQuoteHtml({ fromAddr: 'x@example.test' }, '', LABELS, fmtDate).endsWith('<p></p></blockquote>'));
});

test('the forgotten-attachment check ignores the quoted original (incl. its header)', () => {
  const quote = buildQuoteHtml({ fromAddr: 'x@example.test', subject: 'Anhang anbei' }, '<p>siehe Anhang</p>', LABELS, fmtDate);
  const body = initialBodyHtml('', quote);
  assert.doesNotMatch(ownText(body), /Anhang|anbei/);
});

test('initial body: line to type in, signature block, then the quote', () => {
  assert.equal(initialBodyHtml('', ''), '');
  assert.equal(initialBodyHtml('<div data-cm-signature="">S</div>', ''), '<p></p><div data-cm-signature="">S</div>');
  assert.equal(initialBodyHtml('', '<blockquote>Q</blockquote>'), '<p></p><p></p><blockquote>Q</blockquote>');
  assert.equal(initialBodyHtml('<div>S</div>', '<blockquote>Q</blockquote>'), '<p></p><div>S</div><p></p><blockquote>Q</blockquote>');
});

test('long quotes: by text length or block count; only replies start folded', () => {
  const short = '<p>kurz</p>';
  const long = `<p>${'x'.repeat(LONG_QUOTE_CHARS + 1)}</p>`;
  const manyBlocks = '<p>a</p>'.repeat(13);
  assert.equal(isLongQuote(short), false);
  assert.ok(isLongQuote(long));
  assert.ok(isLongQuote(manyBlocks));
  assert.equal(isLongQuote(`<p>${'&nbsp;'.repeat(700)}</p>`), false, 'whitespace does not count');
  assert.ok(quoteStartsFolded('reply', long));
  assert.ok(quoteStartsFolded('replyAll', long));
  assert.equal(quoteStartsFolded('forward', long), false);
  assert.equal(quoteStartsFolded('reply', short), false);
  assert.equal(quoteStartsFolded('reply', ''), false);
});

test('quotedPart finds the marked quote of a saved body; text to paragraphs is escaped', () => {
  const quote = buildQuoteHtml({ fromAddr: 'x@example.test' }, '<p>alt</p>', LABELS, fmtDate);
  assert.equal(quotedPart(`<p>neu</p><blockquote>eigenes Zitat</blockquote>${quote}`), quote);
  assert.equal(quotedPart('<p>ohne</p><blockquote>x</blockquote>'), '');
  assert.equal(textToParagraphsHtml('a <b>\nzwei'), '<p>a &lt;b&gt;</p><p>zwei</p>');
});
