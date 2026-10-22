'use strict';
// Bytes -> HTML text for a lecture file, whatever encoding it was saved in.
//
// WHY: reading every file as UTF-8 turned Arabic HTML saved by older Windows,
// Office or FrontPage (windows-1256 — the Arabic code page) into a wall of
// U+FFFD. Order of evidence: a byte-order mark, then the file's own
// <meta charset>, then — when UTF-8 decoding produces replacement characters —
// windows-1256 if it yields Arabic. Whatever was used, the result declares
// UTF-8, because Save writes UTF-8 and a stale "windows-1256" declaration would
// break the file on its next open.
//
// web/importer.js carries the same logic for the browser (DeckImporter.decodeHtml).

const META_RE = /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i;

function decodeHtmlBuffer(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let enc = null;
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) enc = 'utf-8';
  else if (bytes[0] === 0xFF && bytes[1] === 0xFE) enc = 'utf-16le';
  else if (bytes[0] === 0xFE && bytes[1] === 0xFF) enc = 'utf-16be';
  if (!enc) {
    const head = Buffer.from(bytes.subarray(0, 4096)).toString('latin1');
    const m = META_RE.exec(head);
    if (m) enc = m[1].toLowerCase();
  }
  let text = null, used = enc || 'utf-8';
  if (enc && enc !== 'utf-8' && enc !== 'utf8') {
    try { text = new TextDecoder(enc).decode(bytes); } catch (_) { text = null; used = 'utf-8'; }
  }
  if (text === null) {
    text = new TextDecoder('utf-8').decode(bytes);
    const bad = (text.match(/�/g) || []).length;
    if (bad > 3) {
      const ar = new TextDecoder('windows-1256').decode(bytes);
      if (/[؀-ۿ]{3,}/.test(ar) && (ar.match(/�/g) || []).length < bad) { text = ar; used = 'windows-1256'; }
    }
  }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  if (used !== 'utf-8' && used !== 'utf8') {
    text = text
      .replace(/<meta[^>]+http-equiv\s*=\s*["']?content-type["']?[^>]*>/ig, '<meta charset="utf-8">')
      .replace(/(<meta[^>]+charset\s*=\s*["']?\s*)[\w-]+/i, '$1utf-8');
  }
  return { html: text, encoding: used };
}

module.exports = { decodeHtmlBuffer };
