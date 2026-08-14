'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');
// This one boots a bespoke Electron main script rather than the app, so it
// cannot use launchLve — but the env law is shared, not re-implemented.
const { ROOT, electronEnv } = require('./support/launch-electron');

const MAIN = path.join(ROOT, 'test', 'support', 'visual-compare-main.js');

test('visual comparison writes a heatmap instead of failing in Electron nativeImage encoding', { timeout: 30000 }, async () => {
  const executable = require('electron');
  const env = electronEnv();
  const output = await new Promise((resolve, reject) => {
    const child = spawn(executable, [MAIN], {
      cwd: ROOT,
      windowsHide: true,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr || `Electron visual smoke exited ${code}.`));
      else resolve(stdout);
    });
  });
  const result = JSON.parse(String(output).trim());
  assert.equal(result.heatmapExists, true);
  assert.equal(result.mismatchPixels, 1);
  assert.ok(result.errors.includes('PIXEL_MISMATCH_ABOVE_THRESHOLD'));
});
