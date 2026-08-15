'use strict';

// The other half of the scene-v2 promise: a baked node's id must resolve to a
// real PNG cropped from the same Chromium that renders the fidelity reference.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');
const { ROOT, electronEnv } = require('./support/launch-electron');

const MAIN = path.join(ROOT, 'test', 'support', 'bake-capture-main.js');

test('a bake request becomes a 2x PNG crop at the node bounds', { timeout: 60000 }, async () => {
  // Match the regular Electron test launcher. In Codex's Windows workspace
  // sandbox, Electron's GPU child cannot use the default AppData profile and
  // crashes before this harness can load its file URL.
  const testUserData = path.join(ROOT, '.fidelity', 'electron-bake-capture-profile');
  require('node:fs').mkdirSync(testUserData, { recursive: true });
  const output = await new Promise((resolve, reject) => {
    const child = spawn(require('electron'), ['--no-sandbox', `--user-data-dir=${testUserData}`, MAIN], {
      cwd: ROOT,
      windowsHide: true,
      env: electronEnv(),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr || `Bake capture harness exited ${code}.`));
      else resolve(stdout);
    });
  });

  const result = JSON.parse(String(output).trim());
  assert.equal(result.requested, 1);
  assert.equal(result.captured, 1);
  assert.equal(result.fileExists, true, 'the capture must be written to the work directory');
  assert.equal(result.isPng, true);
  assert.equal(result.hasDataUrl, true, 'the scene payload carries the capture as a data URL');
  // The slide is transform-scaled to the 1900x1300 target (2x of 950x650), so
  // a 200x120 CSS node crops to a 400x240 bitmap.
  assert.equal(result.width, 400);
  assert.equal(result.height, 240);
});
