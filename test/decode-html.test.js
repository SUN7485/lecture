'use strict';

// Lecture HTML arrives in whatever encoding it was saved in. Read blindly as
// UTF-8, an Arabic file from older Windows/Office/FrontPage (windows-1256)
// opened as a wall of U+FFFD.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { decodeHtmlBuffer } = require('../src/decode-html');

const AR = 'محاضرة عربية قديمة';

function cp1256(text) {
  const dec = new TextDecoder('windows-1256');
  const map = new Map();
  for (let b = 0x80; b < 0x100; b++) map.set(dec.decode(Uint8Array.of(b)), b);
  return Buffer.from([...text].map((ch) => (ch.codePointAt(0) < 0x80 ? ch.codePointAt(0) : map.get(ch))));
}

test('windows-1256 declared in <meta http-equiv> decodes, and is re-declared UTF-8', () => {
  const src = `<html><head><meta http-equiv="Content-Type" content="text/html; charset=windows-1256"></head><body><p>${AR}</p></body></html>`;
  const { html, encoding } = decodeHtmlBuffer(cp1256(src));
  assert.equal(encoding, 'windows-1256');
  assert.ok(html.includes(AR), 'Arabic did not survive');
  assert.ok(!/windows-1256/i.test(html), 'the stale charset declaration would break the saved UTF-8 file');
  assert.match(html, /<meta charset="utf-8">/);
});

test('undeclared windows-1256 is recognised from the bytes', () => {
  const { html, encoding } = decodeHtmlBuffer(cp1256(`<html><body><p>${AR} ${AR}</p></body></html>`));
  assert.equal(encoding, 'windows-1256');
  assert.ok(html.includes(AR));
});

test('UTF-16 with a byte-order mark, and plain UTF-8, are untouched', () => {
  const src = `<html><body><p>${AR}</p></body></html>`;
  const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(src, 'utf16le')]);
  assert.ok(decodeHtmlBuffer(u16).html.includes(AR));
  const u8 = decodeHtmlBuffer(Buffer.from(src, 'utf8'));
  assert.equal(u8.encoding, 'utf-8');
  assert.equal(u8.html, src);
});
