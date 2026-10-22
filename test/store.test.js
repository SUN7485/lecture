'use strict';

// The model store is the only thing in this service that holds memory between
// requests, and the container has a hard limit. A cap whose unit does not match
// the resource it protects is not a cap.

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');

const load = () => import(pathToFileURL(path.resolve(__dirname, '..', 'server', 'lib', 'store.js')).href);

test('the size estimate is not smaller than real heap cost', async () => {
  const { ModelStore } = await load();
  const { modelFromPdf } = await import(
    pathToFileURL(path.resolve(__dirname, '..', 'engine', 'src', 'model', 'normalize.js')).href
  );
  const model = modelFromPdf(path.resolve(__dirname, 'fixtures', 'lecture.pdf'));

  // Measure what a copy actually costs on the heap.
  global.gc?.();
  const before = process.memoryUsage().heapUsed;
  const copies = [];
  for (let i = 0; i < 12; i++) copies.push(structuredClone(model));
  const actualPer = (process.memoryUsage().heapUsed - before) / 12;
  assert.ok(copies.length === 12);

  const estimate = ModelStore.sizeOf(model);
  // Measured before the factor existed: estimate 415KB vs 1113KB actual (2.68x
  // under). Admitting models on that basis would have overshot the heap ceiling
  // and OOM-killed the process under load.
  assert.ok(estimate >= actualPer * 0.9,
    `sizeOf under-counts heap: estimate ${Math.round(estimate / 1024)}KB vs actual ${Math.round(actualPer / 1024)}KB`);
});

test('both ceilings evict, and ownership is enforced', async () => {
  const { ModelStore } = await load();
  const mk = (n) => ({ pages: [{ objects: Array.from({ length: n }, () => ({ text: 'x'.repeat(40), runs: [{ text: 'y'.repeat(40) }] })) }] });

  // Sized so several fixtures fit and eviction is exercised. A single model
  // larger than the whole cap is refused outright (MODEL_TOO_LARGE), which is
  // a different, also-correct path.
  const byBytes = new ModelStore({ ttlMs: 60000, maxBytes: 2_000_000, maxEntries: 1000 });
  const ids = [];
  for (let i = 0; i < 12; i++) ids.push(byBytes.put(mk(200), `sid-${i}`));
  assert.ok(byBytes.bytes <= byBytes.maxBytes, 'byte ceiling exceeded');
  assert.equal(byBytes.get(ids[0], 'sid-0'), null, 'oldest was not evicted');
  assert.notEqual(byBytes.get(ids[11], 'sid-11'), null, 'newest was evicted');
  assert.equal(byBytes.get(ids[11], 'sid-0'), null, 'a foreign session was served another session\'s model');

  // The count ceiling exists because the byte figure is an estimate.
  const byCount = new ModelStore({ ttlMs: 60000, maxBytes: 1 << 30, maxEntries: 5 });
  for (let i = 0; i < 20; i++) byCount.put(mk(5), `s${i}`);
  assert.ok(byCount.entries.size <= 5, `count ceiling exceeded: ${byCount.entries.size}`);
});

test('an expired model is gone even if nothing swept', async () => {
  const { ModelStore } = await load();
  const s = new ModelStore({ ttlMs: 1, maxBytes: 1 << 20 });
  const id = s.put({ pages: [{ objects: [] }] }, 'sid');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.get(id, 'sid'), null, 'an expired model was served');
});
