/**
 * File type helpers (9.4): block-list semantics shared with the inbound
 * attachment filter, MIME sniffing and the candidate extensions of a file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeExtension, normalizeExtensionList, fileExtension, sniffFileType, mimeTypeExtensions,
  candidateExtensions, matchExtensionList,
} from './file-types.js';

const bytes = (...b: number[]) => Uint8Array.from(b);
const text = (s: string) => new Uint8Array(Buffer.from(s, 'latin1'));

test('extensions: case, leading dots, trailing dots and spaces', () => {
  assert.equal(normalizeExtension(' .EXE '), 'exe');
  assert.equal(fileExtension('invoice.PDF.exe. '), 'exe');
  assert.equal(fileExtension('README'), '');
  assert.deepEqual(normalizeExtensionList(['EXE', '.exe', 'js', '', 'a/b', '..', 'x'.repeat(30)]), ['exe', 'js']);
});

test('sniffing: executables, archives, documents, markup', () => {
  assert.equal(sniffFileType(text('MZ\x90\x00'))?.format, 'windows-executable');
  assert.equal(sniffFileType(bytes(0x7f, 0x45, 0x4c, 0x46, 2))?.format, 'elf');
  assert.equal(sniffFileType(text('#!/bin/sh\necho'))?.format, 'script');
  assert.equal(sniffFileType(bytes(0x50, 0x4b, 0x03, 0x04, 0))?.format, 'zip');
  assert.equal(sniffFileType(bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1))?.format, 'ole');
  assert.equal(sniffFileType(text('%PDF-1.7'))?.format, 'pdf');
  assert.equal(sniffFileType(bytes(0xff, 0xd8, 0xff, 0xe0))?.format, 'jpeg');
  assert.equal(sniffFileType(text('﻿  <!DOCTYPE html><p>'.replace('﻿', 'ï»¿')))?.format, 'html');
  assert.equal(sniffFileType(text('<?xml version="1.0"?>\n<svg xmlns="x">'))?.format, 'svg');
  const iso = new Uint8Array(0x8001 + 5);
  iso.set(text('CD001'), 0x8001);
  assert.equal(sniffFileType(iso)?.format, 'iso');
});

test('sniffing: short, empty and unknown content is not guessed', () => {
  assert.equal(sniffFileType(new Uint8Array()), null);
  assert.equal(sniffFileType(text('M')), null);
  assert.equal(sniffFileType(text('Hello, plain text')), null);
  assert.equal(sniffFileType(text('<p>not a full document')), null);
});

test('declared MIME types (parameters and case ignored)', () => {
  assert.ok(mimeTypeExtensions('Application/X-MSDownload; name="a"').includes('exe'));
  assert.deepEqual(mimeTypeExtensions('application/octet-stream'), []);
  assert.deepEqual(mimeTypeExtensions(undefined), []);
});

test('candidates: a name that fits the content keeps its own extension', () => {
  const docx = candidateExtensions({ filename: 'report.docx', mimeType: 'application/octet-stream', head: bytes(0x50, 0x4b, 3, 4) });
  assert.deepEqual([...docx], ['docx']);
  const doc = candidateExtensions({ filename: 'old.doc', head: bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1) });
  assert.equal(matchExtensionList(doc, ['msi']), null);
});

test('candidates: disguised executables and archives match the block list', () => {
  const exe = candidateExtensions({ filename: 'invoice.pdf', mimeType: 'application/pdf', head: text('MZ\x90\x00') });
  assert.equal(matchExtensionList(exe, ['exe']), 'exe');
  const jar = candidateExtensions({ filename: 'photo.jpg', head: bytes(0x50, 0x4b, 3, 4) });
  assert.equal(matchExtensionList(jar, ['jar']), 'jar');
  const declared = candidateExtensions({ filename: 'notes.txt', mimeType: 'application/x-msdownload' });
  assert.equal(matchExtensionList(declared, ['.EXE']), 'exe');
  const html = candidateExtensions({ filename: 'scan.png', mimeType: 'image/png', head: text('<html><script>') });
  assert.equal(matchExtensionList(html, ['hta']), 'hta');
});

test('candidates: no name, no content → only the declared type', () => {
  assert.deepEqual([...candidateExtensions({ filename: '' })], []);
  assert.ok(candidateExtensions({ filename: '', mimeType: 'text/html' }).has('html'));
  assert.equal(matchExtensionList(candidateExtensions({ filename: 'a.exe. ' }), ['exe']), 'exe');
});
