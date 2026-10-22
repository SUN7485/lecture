'use strict';

// The fidelity contract of engine/apply-edits.js, stated as tests.
//
// The dangerous direction is NOT "an edit was missed" — that is visible. It is
// "an untouched object was rewritten", because rewriting collapses runs and
// discards the per-glyph facts the reconstruction spent all its effort
// recovering, and nothing on screen would show it.

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');

const MODULE = pathToFileURL(path.resolve(__dirname, '..', 'engine', 'apply-edits.js')).href;
const load = () => import(MODULE);

/** A two-page model exercising every shape the reconciler must handle. */
function fixture() {
  return {
    pages: [
      {
        index: 0,
        objects: [
          {
            id: 'p0_text_000', type: 'text', text: 'hello', bbox: { x: 10, y: 10, w: 100, h: 20 },
            alignment: 'left', paragraphDirection: 'ltr', charactersMissing: 3, lamAlefLost: true,
            runs: [
              { text: 'hel', fontFamily: 'Lyon', fontSizePt: 24, color: '413258', srcX: 10, srcW: 30 },
              { text: 'lo', fontFamily: 'Other', fontSizePt: 12, color: 'ff0000', srcX: 40, srcW: 20 }
            ]
          },
          {
            id: 'p0_table_001', type: 'text', text: 'A B', bbox: { x: 0, y: 50, w: 200, h: 40 },
            runs: [{ text: 'A B', fontFamily: 'Lyon', fontSizePt: 10 }],
            tableSourceText: 'A B',
            tableSegments: [
              { bbox: { x: 5, y: 55, w: 40, h: 10 }, runs: [{ text: 'A' }] },
              { bbox: { x: 60, y: 55, w: 40, h: 10 }, runs: [{ text: 'B' }] }
            ]
          },
          { id: 'p0_shape_002', type: 'shape', bbox: { x: 1, y: 2, w: 3, h: 4 }, fill: 'abcdef' },
          { id: 'p0_mask_003', type: 'image', isMask: true, bbox: { x: 0, y: 0, w: 5, h: 5 } }
        ]
      },
      { index: 1, objects: [{ id: 'p1_text_000', type: 'text', text: 'keep', bbox: { x: 0, y: 0, w: 10, h: 10 }, runs: [{ text: 'keep', fontFamily: 'Lyon' }] }] }
    ]
  };
}

/** Everything on the canvas, unchanged — what an untouched deck sends. */
const untouched = (m) =>
  m.pages.flatMap((p) =>
    p.objects
      .filter((o) => !(o.type === 'image' && o.isMask))
      .map((o) => (o.type === 'text' ? { id: o.id, text: o.text, bbox: { ...o.bbox } } : { id: o.id, bbox: { ...o.bbox } }))
  );

test('an untouched deck changes nothing at all', async () => {
  const { applyDeckEdits } = await load();
  const m = fixture();
  const before = JSON.stringify(m);
  const stats = applyDeckEdits(m, untouched(m));

  assert.deepEqual(stats, { textChanged: 0, moved: 0, deleted: 0, added: 0, unknown: 0 });
  assert.equal(JSON.stringify(m), before, 'an untouched deck was mutated');
});

test('sub-pixel layout noise is not an edit', async () => {
  const { applyDeckEdits } = await load();
  const m = fixture();
  const entries = untouched(m);
  for (const e of entries) e.bbox.x += 0.3; // below MOVE_EPSILON
  const stats = applyDeckEdits(m, entries);
  assert.equal(stats.moved, 0, 'rounding noise was treated as a move');
});

test('editing text collapses to one run, keeps the first run\'s styling, drops stale measurements', async () => {
  const { applyDeckEdits } = await load();
  const m = fixture();
  const entries = untouched(m);
  entries.find((e) => e.id === 'p0_text_000').text = 'goodbye';

  const stats = applyDeckEdits(m, entries);
  assert.equal(stats.textChanged, 1);

  const obj = m.pages[0].objects.find((o) => o.id === 'p0_text_000');
  assert.equal(obj.text, 'goodbye');
  assert.equal(obj.runs.length, 1, 'edited object should collapse to a single run');
  assert.equal(obj.runs[0].text, 'goodbye');
  assert.equal(obj.runs[0].fontFamily, 'Lyon', 'lost the first run\'s font');
  assert.equal(obj.runs[0].fontSizePt, 24, 'lost the first run\'s size');
  assert.equal(obj.runs[0].color, '413258', 'lost the first run\'s colour');
  // srcX/srcW measured the ORIGINAL glyphs; carrying them forward corrupts the
  // width-fidelity check that compares rendered width against them.
  assert.equal(obj.runs[0].srcW, undefined, 'stale source width survived an edit');
  assert.equal(obj.runs[0].srcX, undefined, 'stale source x survived an edit');
  // Diagnostics describe the extraction, not the human's corrected string.
  assert.equal(obj.charactersMissing, 0, 'stale charactersMissing survived an edit');
  assert.equal(obj.lamAlefLost, false, 'stale lamAlefLost survived an edit');
  assert.equal(obj.provenance.edited, true);
});

test('an untouched object keeps its runs byte-for-byte while a sibling is edited', async () => {
  const { applyDeckEdits } = await load();
  const m = fixture();
  const keep = JSON.stringify(m.pages[1].objects[0].runs);
  const entries = untouched(m);
  entries.find((e) => e.id === 'p0_text_000').text = 'changed';

  applyDeckEdits(m, entries);
  assert.equal(JSON.stringify(m.pages[1].objects[0].runs), keep, 'an untouched object lost its runs');
});

test('editing a table object drops its cell geometry rather than keeping stale cells', async () => {
  const { applyDeckEdits } = await load();
  const m = fixture();
  const entries = untouched(m);
  entries.find((e) => e.id === 'p0_table_001').text = 'C D';

  applyDeckEdits(m, entries);
  const obj = m.pages[0].objects.find((o) => o.id === 'p0_table_001');
  assert.equal(obj.text, 'C D');
  assert.equal(obj.tableSegments, undefined, 'stale per-cell text would have been exported');
});

test('moving a table object carries its cells with it', async () => {
  const { applyDeckEdits } = await load();
  const m = fixture();
  const entries = untouched(m);
  const e = entries.find((x) => x.id === 'p0_table_001');
  e.bbox = { x: 100, y: 150, w: 200, h: 40 }; // +100, +100

  const stats = applyDeckEdits(m, entries);
  assert.equal(stats.moved, 1);
  const obj = m.pages[0].objects.find((o) => o.id === 'p0_table_001');
  assert.deepEqual(obj.tableSegments[0].bbox, { x: 105, y: 155, w: 40, h: 10 });
  assert.deepEqual(obj.tableSegments[1].bbox, { x: 160, y: 155, w: 40, h: 10 });
});

test('an object missing from the canvas is deleted, but a soft mask is not', async () => {
  const { applyDeckEdits } = await load();
  const m = fixture();
  const entries = untouched(m).filter((e) => e.id !== 'p0_shape_002');

  const stats = applyDeckEdits(m, entries);
  assert.equal(stats.deleted, 1);
  assert.equal(m.pages[0].objects.some((o) => o.id === 'p0_shape_002'), false);
  // A soft mask is the alpha channel of the thing painted next; it is never
  // rendered, so it never appears on the canvas and must not read as deleted.
  assert.equal(m.pages[0].objects.some((o) => o.id === 'p0_mask_003'), true,
    'a soft mask was deleted because it was never on the canvas');
});

test('an empty payload is a no-op, not a request to delete the deck', async () => {
  const { applyDeckEdits } = await load();
  const m = fixture();
  const count = m.pages.flatMap((p) => p.objects).length;
  const stats = applyDeckEdits(m, []);
  assert.deepEqual(stats, { textChanged: 0, moved: 0, deleted: 0, added: 0, unknown: 0 });
  assert.equal(m.pages.flatMap((p) => p.objects).length, count,
    'an empty payload wiped the deck — a client that fails to collect would destroy the export');
});

test('text the user added becomes a real object', async () => {
  const { applyDeckEdits } = await load();
  const m = fixture();
  const entries = untouched(m);
  entries.push({ isNew: true, page: 1, kind: 'text', text: 'added', bbox: { x: 5, y: 5, w: 50, h: 12 }, dir: 'rtl', fontSizePt: 18, color: '#112233' });

  const stats = applyDeckEdits(m, entries);
  assert.equal(stats.added, 1);
  const added = m.pages[1].objects.find((o) => o.text === 'added');
  assert.ok(added, 'the added text never reached the model');
  assert.equal(added.paragraphDirection, 'rtl');
  assert.equal(added.alignment, 'right');
  assert.equal(added.runs[0].fontSizePt, 18);
  assert.equal(added.runs[0].color, '112233', 'a leading # would be written into the PPTX');
});

test('an unknown id is counted, never invented', async () => {
  const { applyDeckEdits } = await load();
  const m = fixture();
  const entries = untouched(m);
  entries.push({ id: 'does_not_exist', text: 'x' });
  const stats = applyDeckEdits(m, entries);
  assert.equal(stats.unknown, 1);
});
