'use strict';

// A verified PPTX is committed by renaming the candidate into place. rename()
// cannot cross volumes (EXDEV on Windows when the app runs from D: and the
// user saves to C:), and before this test existed that turned minutes of
// verification into ATOMIC_REPLACE_FAILED with a perfect deck stranded in
// .fidelity/. The commit must still land, and must still never leave a
// half-written file at the destination.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { atomicCommitVerifiedPptx } = require('../src/pptxFidelity');

const ROOT = path.resolve(__dirname, '..');
const OK_REPORT = { ok: true };

function candidate(dir, bytes = 'PK\u0003\u0004 verified deck') {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `candidate-${process.pid}-${Date.now()}.pptx`);
  fs.writeFileSync(p, bytes);
  return p;
}

test('a rename that fails with EXDEV still commits the deck (copy, then same-volume rename)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lve-commit-'));
  const src = candidate(dir);
  const dest = path.join(dir, 'out', 'lecture.pptx');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, 'OLD DECK');

  // Simulate the cross-volume case on any machine: only the FIRST rename (the
  // candidate -> destination move) fails, exactly as Windows does across drives.
  const realRename = fs.promises.rename;
  let calls = 0;
  fs.promises.rename = async (from, to) => {
    calls += 1;
    if (calls === 1) { const e = new Error('EXDEV: cross-device link not permitted'); e.code = 'EXDEV'; throw e; }
    return realRename(from, to);
  };
  try {
    const out = await atomicCommitVerifiedPptx({ tempPptxPath: src, destinationPath: dest, report: OK_REPORT });
    assert.equal(out, path.resolve(dest));
  } finally {
    fs.promises.rename = realRename;
  }
  assert.equal(fs.readFileSync(dest, 'utf8'), 'PK\u0003\u0004 verified deck', 'destination does not hold the verified deck');
  assert.equal(fs.existsSync(src), false, 'the candidate was left behind after a successful commit');
  const litter = fs.readdirSync(path.dirname(dest)).filter((n) => n !== 'lecture.pptx');
  assert.deepEqual(litter, [], 'a temporary file was left next to the destination');
});

test('any other rename failure is still reported, and the destination is untouched', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lve-commit-'));
  const src = candidate(dir);
  const dest = path.join(dir, 'lecture.pptx');
  fs.writeFileSync(dest, 'OLD DECK');
  const realRename = fs.promises.rename;
  fs.promises.rename = async () => { const e = new Error('EPERM: locked'); e.code = 'EPERM'; throw e; };
  try {
    await assert.rejects(
      atomicCommitVerifiedPptx({ tempPptxPath: src, destinationPath: dest, report: OK_REPORT }),
      (e) => e.code === 'ATOMIC_REPLACE_FAILED'
    );
  } finally {
    fs.promises.rename = realRename;
  }
  assert.equal(fs.readFileSync(dest, 'utf8'), 'OLD DECK');
});

// The real thing, when this machine has two volumes (the project on one drive,
// the OS temp directory on another — true on the development box).
const crossVolume = path.parse(ROOT).root.toLowerCase() !== path.parse(os.tmpdir()).root.toLowerCase();
test('commits across real volumes', { skip: !crossVolume && 'project and temp dir share a volume' }, async () => {
  const src = candidate(path.join(ROOT, '.fidelity', 'commit-test'));
  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lve-commit-')), 'lecture.pptx');
  const out = await atomicCommitVerifiedPptx({ tempPptxPath: src, destinationPath: dest, report: OK_REPORT });
  assert.equal(out, path.resolve(dest));
  assert.ok(fs.readFileSync(dest, 'utf8').startsWith('PK'));
  assert.equal(fs.existsSync(src), false);
});
