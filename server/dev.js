/**
 * Local launcher for the hosted server: `npm run serve:local`.
 *
 * app.js refuses to boot without SOURCE_URL (AGPL section 13), which is right
 * for a public deploy and the reason `npm run serve` dies on a dev box. Here the
 * server binds to loopback only, so nobody is served over a network and a local
 * placeholder is honest.
 *
 * It also finds a Chromium for the PDF export: Playwright looks only for the one
 * revision it was built against, and a cleaned cache leaves it missing while
 * other revisions sit next to it. Any installed headless shell renders fine
 * (the hosted suite passes 32/32 on a newer one).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright-core';

process.env.HOST ||= '127.0.0.1';
process.env.SOURCE_URL ||= 'http://127.0.0.1/local-only';

function findChromium() {
  if (fs.existsSync(chromium.executablePath())) return null; // the expected build is there
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ||
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.cache'), 'ms-playwright');
  if (!fs.existsSync(root)) return null;
  const exe = process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell';
  const dirs = fs.readdirSync(root).filter((d) => d.startsWith('chromium_headless_shell-'))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const d of dirs) {
    for (const sub of ['chrome-headless-shell-win64', 'chrome-headless-shell-linux64', 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell-mac-x64']) {
      const p = path.join(root, d, sub, exe);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

if (!process.env.CHROMIUM_PATH) {
  const found = findChromium();
  if (found) process.env.CHROMIUM_PATH = found;
}

console.log(`Lecture Studio (local) -> http://${process.env.HOST}:${process.env.PORT || 8080}/`);
if (process.env.CHROMIUM_PATH) console.log(`PDF export via ${process.env.CHROMIUM_PATH}`);

await import('./app.js');
