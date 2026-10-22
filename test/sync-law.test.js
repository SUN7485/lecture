'use strict';

// CONTEXT.md declares a SYNC LAW: editor.js, theme.js and doctor.js exist as
// byte-identical pairs in src/ (Electron) and web/ (hosted). It has been true
// by human discipline. This makes it true by gate — a rule nothing enforces is
// a rule that breaks on the first busy afternoon, and these three files carry
// the editing, theming and doctor behaviour of BOTH shells.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const PAIRS = ['editor.js', 'theme.js', 'doctor.js'];

test('SYNC LAW: src/ and web/ copies are byte-identical', () => {
  const drift = [];
  for (const name of PAIRS) {
    const a = path.join(ROOT, 'src', name);
    const b = path.join(ROOT, 'web', name);
    assert.equal(fs.existsSync(a), true, `missing ${a}`);
    assert.equal(fs.existsSync(b), true, `missing ${b}`);
    const ba = fs.readFileSync(a);
    const bb = fs.readFileSync(b);
    if (!ba.equals(bb)) {
      drift.push(`${name}: src=${ba.length}B web=${bb.length}B`);
    }
  }
  assert.deepEqual(drift, [],
    'SYNC LAW broken (CONTEXT.md). Edit one, copy to the other:\n  ' + drift.join('\n  '));
});

test('the engine\'s own web editor is a separate lineage, not a silent third copy', () => {
  // engine/web/ came from the vendored pdf=ppt studio and is a DIFFERENT
  // implementation (measured: editor 1526 vs 3210 lines, doctor 1203 vs 1150).
  // That is allowed — it is the local studio's editor — but it must never be
  // mistaken for a copy that drifted, and it must not ship in the hosted image.
  const dockerignore = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8');
  assert.match(dockerignore, /^engine\/web\/$/m, 'engine/web/ would ship in the production image');
  assert.match(dockerignore, /^engine\/src\/server\.js$/m,
    'the local studio server (with /api/browse) would ship in the production image');
});
