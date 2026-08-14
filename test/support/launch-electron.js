'use strict';

// Every script that drives the real app launches through here.
//
// WHY: a leaked `ELECTRON_RUN_AS_NODE=1` (agent shells set it) makes
// node_modules/electron/dist/electron.exe boot as plain Node instead of
// Electron — no window, no `window.__editor`, and the failure reads as
// "the Electron binary is broken". That misdiagnosis cost this project a week
// in August 2026; from a clean shell the same binary prints v31.7.7.
// The fix is two lines that must never be copy-pasted again: strip the
// variable from every child env, then assert what actually booted.
const path = require('node:path');
const { _electron } = require('../../node_modules/playwright-core');

const ROOT = path.resolve(__dirname, '..', '..');

/**
 * Child environment for any Electron process. `extraEnv` is applied before the
 * strip on purpose: no caller can re-introduce the variable by accident.
 */
function electronEnv(extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/**
 * Launch the editor and hand back its first window.
 * `open` sets LVE_OPEN (auto-open a deck), `exportPath` sets LVE_EXPORT_PATH
 * (skip the save dialog) — both are existing main.js test hooks.
 */
async function launchLve({ open, exportPath, extraEnv } = {}) {
  const env = electronEnv(extraEnv);
  if (open) env.LVE_OPEN = open;
  if (exportPath) env.LVE_EXPORT_PATH = exportPath;

  const app = await _electron.launch({
    executablePath: require('electron'),
    args: ['.'],
    cwd: ROOT,
    env
  });

  // `process.versions.electron` is NOT the discriminator: it still reads
  // "31.7.7" under ELECTRON_RUN_AS_NODE (verified 2026-08-14 on this machine),
  // so asserting it would be a gate that can never fail. `process.type` is
  // 'browser' only in a real Electron main process, and undefined in Node mode.
  const booted = await app.evaluate(() => ({
    type: process.type || null,
    electron: process.versions.electron || null
  }));
  if (booted.type !== 'browser') {
    await app.close().catch(() => {});
    throw new Error('Electron booted as plain Node — ELECTRON_RUN_AS_NODE leaked into the environment; clear it and retry.');
  }

  return { app, page: await app.firstWindow() };
}

module.exports = { ROOT, electronEnv, launchLve };
