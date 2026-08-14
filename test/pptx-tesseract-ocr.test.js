'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  parseTesseractTsv,
  preflightBundledTesseractOcr,
  resolveBundledTesseractPaths,
  runBundledTesseractOcr
} = require('../src/pptxTesseractOcr');

const TSV_HEADER = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';

function tsv(words) {
  const rows = words.map((word, index) => [
    5, 1, 1, 1, 1, index + 1,
    word.x, word.y, word.w, word.h, word.confidence ?? 95, word.text
  ].join('\t'));
  return `${TSV_HEADER}\n${rows.join('\n')}\n`;
}

function scriptedSpawn(plans, calls) {
  return (executablePath, args, options) => {
    const plan = plans.shift();
    assert.ok(plan, `unexpected Tesseract invocation: ${args.join(' ')}`);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { plan.killed = true; };
    calls.push({ executablePath, args, options, plan });
    if (!plan.hang) {
      queueMicrotask(() => {
        if (plan.error) {
          child.emit('error', plan.error);
          return;
        }
        if (plan.stdout) child.stdout.emit('data', Buffer.from(plan.stdout, 'utf8'));
        if (plan.stderr) child.stderr.emit('data', Buffer.from(plan.stderr, 'utf8'));
        child.emit('close', plan.code ?? 0, plan.signal ?? null);
      });
    }
    return child;
  };
}

async function writeIntegrityManifest(bundleRoot, relativePaths = [
  'tesseract.exe',
  'tessdata/ara.traineddata',
  'tessdata/eng.traineddata',
  'tessdata/configs/tsv'
]) {
  const lines = [];
  for (const relativePath of relativePaths) {
    const bytes = await fs.readFile(path.join(bundleRoot, ...relativePath.split('/')));
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    lines.push(`${sha256}  ${relativePath}`);
  }
  const manifestPath = path.join(bundleRoot, 'SHA256SUMS');
  await fs.writeFile(manifestPath, `${lines.join('\n')}\n`);
  return manifestPath;
}

async function bundleFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lve-tesseract-ocr-test-'));
  const bundleRoot = path.join(root, 'ocr');
  const tessdataPath = path.join(bundleRoot, 'tessdata');
  const tsvConfigPath = path.join(tessdataPath, 'configs', 'tsv');
  const sourcePath = path.join(root, 'source.png');
  const powerPointPath = path.join(root, 'powerpoint.png');
  await fs.mkdir(path.dirname(tsvConfigPath), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(bundleRoot, 'tesseract.exe'), 'fake executable'),
    fs.writeFile(path.join(tessdataPath, 'ara.traineddata'), 'ara model'),
    fs.writeFile(path.join(tessdataPath, 'eng.traineddata'), 'eng model'),
    fs.writeFile(tsvConfigPath, 'tesseract TSV renderer config'),
    fs.writeFile(sourcePath, 'source image'),
    fs.writeFile(powerPointPath, 'PowerPoint image')
  ]);
  const manifestPath = await writeIntegrityManifest(bundleRoot);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { bundleRoot, tessdataPath, tsvConfigPath, sourcePath, powerPointPath, manifestPath };
}

test('strict preflight launches only the absolute bundled executable and verifies ara + eng data', async (t) => {
  const fixture = await bundleFixture(t);
  const calls = [];
  const report = await preflightBundledTesseractOcr({
    bundleRoot: fixture.bundleRoot,
    spawnImpl: scriptedSpawn([
      { stdout: 'tesseract 5.5.3\nleptonica-1.85.0\n' },
      { stdout: 'List of available languages in "tessdata" (2):\nara\neng\n' }
    ], calls)
  });

  assert.equal(report.ok, true);
  assert.deepEqual(report.requiredLanguages, ['ara', 'eng']);
  assert.deepEqual(report.availableLanguages, ['ara', 'eng']);
  assert.equal(report.tsvConfigPath, fixture.tsvConfigPath);
  assert.equal(report.integrity.manifestPath, fixture.manifestPath);
  assert.equal(report.integrity.verifiedNativeAssetCount, 3);
  assert.deepEqual(report.integrity.verifiedNativeAssets.map((asset) => asset.relativePath), [
    'tessdata/ara.traineddata', 'tessdata/eng.traineddata', 'tesseract.exe'
  ]);
  assert.equal(report.integrity.verifiedTsvConfig.relativePath, 'tessdata/configs/tsv');
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.executablePath, path.join(fixture.bundleRoot, 'tesseract.exe'));
    assert.equal(path.isAbsolute(call.executablePath), true);
    assert.equal(call.options.shell, false);
    assert.equal(call.options.windowsHide, true);
  }
  assert.deepEqual(calls[0].args, ['--version']);
  assert.deepEqual(calls[1].args, ['--list-langs', '--tessdata-dir', fixture.tessdataPath]);
});

test('preflight rejects missing language data before any child process is started', async (t) => {
  const fixture = await bundleFixture(t);
  await fs.rm(path.join(fixture.tessdataPath, 'ara.traineddata'));
  const calls = [];
  const report = await preflightBundledTesseractOcr({
    bundleRoot: fixture.bundleRoot,
    spawnImpl: scriptedSpawn([], calls)
  });

  assert.equal(report.ok, false);
  assert.equal(report.error.code, 'BUNDLED_OCR_LANGUAGE_DATA_MISSING');
  assert.deepEqual(report.error.details.missingLanguages, ['ara']);
  assert.equal(calls.length, 0);
});

test('preflight requires the pinned TSV renderer config and verifies it through SHA256SUMS before Tesseract starts', async (t) => {
  const missingFixture = await bundleFixture(t);
  const missingCalls = [];
  await fs.rm(missingFixture.tsvConfigPath);
  let report = await preflightBundledTesseractOcr({
    bundleRoot: missingFixture.bundleRoot,
    spawnImpl: scriptedSpawn([], missingCalls)
  });
  assert.equal(report.ok, false);
  assert.equal(report.error.code, 'BUNDLED_OCR_TSV_CONFIG_MISSING');
  assert.equal(report.error.details.tsvConfigPath, missingFixture.tsvConfigPath);
  assert.equal(missingCalls.length, 0);

  const unlistedFixture = await bundleFixture(t);
  const unlistedCalls = [];
  await writeIntegrityManifest(unlistedFixture.bundleRoot, [
    'tesseract.exe',
    'tessdata/ara.traineddata',
    'tessdata/eng.traineddata'
  ]);
  report = await preflightBundledTesseractOcr({
    bundleRoot: unlistedFixture.bundleRoot,
    spawnImpl: scriptedSpawn([], unlistedCalls)
  });
  assert.equal(report.ok, false);
  assert.equal(report.error.code, 'BUNDLED_OCR_TSV_CONFIG_UNLISTED');
  assert.equal(report.error.details.tsvConfigPath, unlistedFixture.tsvConfigPath);
  assert.equal(unlistedCalls.length, 0);

  const tamperedFixture = await bundleFixture(t);
  const tamperedCalls = [];
  await fs.appendFile(tamperedFixture.tsvConfigPath, 'tampered');
  report = await preflightBundledTesseractOcr({
    bundleRoot: tamperedFixture.bundleRoot,
    spawnImpl: scriptedSpawn([], tamperedCalls)
  });
  assert.equal(report.ok, false);
  assert.equal(report.error.code, 'BUNDLED_OCR_INTEGRITY_ASSET_MISMATCH');
  assert.equal(report.error.details.relativePath, 'tessdata/configs/tsv');
  assert.equal(tamperedCalls.length, 0);
});

test('preflight requires a well-formed SHA256SUMS manifest before Tesseract starts', async (t) => {
  const fixture = await bundleFixture(t);
  const calls = [];
  await fs.rm(fixture.manifestPath);
  let report = await preflightBundledTesseractOcr({
    bundleRoot: fixture.bundleRoot,
    spawnImpl: scriptedSpawn([], calls)
  });
  assert.equal(report.ok, false);
  assert.equal(report.error.code, 'BUNDLED_OCR_INTEGRITY_MANIFEST_MISSING');
  assert.equal(report.error.details.manifestPath, fixture.manifestPath);
  assert.equal(calls.length, 0);

  await fs.writeFile(fixture.manifestPath, 'this is not a SHA-256 manifest\n');
  report = await preflightBundledTesseractOcr({
    bundleRoot: fixture.bundleRoot,
    spawnImpl: scriptedSpawn([], calls)
  });
  assert.equal(report.ok, false);
  assert.equal(report.error.code, 'BUNDLED_OCR_INTEGRITY_MANIFEST_INVALID');
  assert.equal(calls.length, 0);
});

test('preflight blocks unlisted, invalid, missing, and tampered native assets', async (t) => {
  const scenarios = [
    {
      name: 'unlisted',
      prepare: async (fixture) => fs.writeFile(path.join(fixture.bundleRoot, 'unexpected.dll'), 'unlisted native DLL'),
      code: 'BUNDLED_OCR_INTEGRITY_ASSET_UNLISTED',
      detail: 'unlistedNativeAssets'
    },
    {
      name: 'invalid',
      prepare: async (fixture) => fs.mkdir(path.join(fixture.bundleRoot, 'invalid.dll')),
      code: 'BUNDLED_OCR_INTEGRITY_ASSET_INVALID',
      detail: 'relativePath'
    },
    {
      name: 'listed but missing',
      prepare: async (fixture) => {
        const checksum = crypto.createHash('sha256').update('missing closure').digest('hex');
        await fs.appendFile(fixture.manifestPath, `${checksum}  libclosure.dll\n`);
      },
      code: 'BUNDLED_OCR_INTEGRITY_ASSET_MISSING',
      detail: 'relativePath'
    },
    {
      name: 'tampered',
      prepare: async (fixture) => fs.appendFile(path.join(fixture.bundleRoot, 'tesseract.exe'), 'tampered'),
      code: 'BUNDLED_OCR_INTEGRITY_ASSET_MISMATCH',
      detail: 'actualSha256'
    }
  ];

  for (const scenario of scenarios) {
    const fixture = await bundleFixture(t);
    const calls = [];
    await scenario.prepare(fixture);
    const report = await preflightBundledTesseractOcr({
      bundleRoot: fixture.bundleRoot,
      spawnImpl: scriptedSpawn([], calls)
    });
    assert.equal(report.ok, false, scenario.name);
    assert.equal(report.error.code, scenario.code, scenario.name);
    assert.ok(report.error.details[scenario.detail], scenario.name);
    assert.equal(calls.length, 0, scenario.name);
  }
});

test('preflight blocks an executable that cannot discover both required bundled language models', async (t) => {
  const fixture = await bundleFixture(t);
  const calls = [];
  const report = await preflightBundledTesseractOcr({
    bundleRoot: fixture.bundleRoot,
    spawnImpl: scriptedSpawn([
      { stdout: 'tesseract 5.5.3\n' },
      { stdout: 'List of available languages in "tessdata" (1):\neng\n' }
    ], calls)
  });

  assert.equal(report.ok, false);
  assert.equal(report.error.code, 'BUNDLED_OCR_LANGUAGE_UNAVAILABLE');
  assert.deepEqual(report.error.details.missingLanguages, ['ara']);
  assert.equal(calls.length, 2);
});

test('bundle paths cannot escape the explicit bundled OCR directory', async (t) => {
  const fixture = await bundleFixture(t);
  assert.throws(
    () => resolveBundledTesseractPaths({ bundleRoot: fixture.bundleRoot, executablePath: '../tesseract.exe' }),
    (error) => error?.code === 'BUNDLED_OCR_PATH_OUTSIDE_BUNDLE'
  );
  assert.throws(
    () => resolveBundledTesseractPaths({ bundleRoot: fixture.bundleRoot, tessdataPath: '../tessdata' }),
    (error) => error?.code === 'BUNDLED_OCR_PATH_OUTSIDE_BUNDLE'
  );
});

test('TSV parser preserves Arabic/English word rectangles and Tesseract layout identifiers', () => {
  const tokens = parseTesseractTsv(`\uFEFF${TSV_HEADER}\n` +
    '1\t1\t0\t0\t0\t0\t0\t0\t1900\t1300\t-1\t\n' +
    '5\t1\t2\t3\t4\t5\t20\t30\t40\t50\t96.25\tمرحبا\n' +
    '5\t1\t2\t3\t4\t6\t90\t30\t80\t50\t91.5\tEnglish\n');

  assert.deepEqual(tokens, [
    {
      text: 'مرحبا', x: 20, y: 30, w: 40, h: 50, level: 5,
      pageNumber: 1, blockNumber: 2, paragraphNumber: 3, lineNumber: 4, wordNumber: 5, confidence: 96.25
    },
    {
      text: 'English', x: 90, y: 30, w: 80, h: 50, level: 5,
      pageNumber: 1, blockNumber: 2, paragraphNumber: 3, lineNumber: 4, wordNumber: 6, confidence: 91.5
    }
  ]);
  assert.throws(
    () => parseTesseractTsv('level\tleft\ttop\ttext\n5\t1\t2\tbroken\n'),
    (error) => error?.code === 'BUNDLED_OCR_TSV_INVALID'
  );
});

test('OCR uses the single bundled ara+eng executable for source and PowerPoint PNGs and returns TSV boxes', async (t) => {
  const fixture = await bundleFixture(t);
  const calls = [];
  const result = await runBundledTesseractOcr({
    ...fixture,
    languages: ['eng', 'ara'],
    psm: 3,
    spawnImpl: scriptedSpawn([
      { stdout: tsv([{ text: 'مرحبا', x: 20, y: 30, w: 40, h: 50 }]) },
      { stdout: tsv([{ text: 'مرحبا', x: 22, y: 31, w: 40, h: 50 }]) }
    ], calls)
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.languages, ['ara', 'eng']);
  assert.equal(result.integrity.verifiedNativeAssetCount, 3);
  assert.equal(result.source.text, 'مرحبا');
  assert.equal(result.powerPoint.text, 'مرحبا');
  assert.deepEqual(result.source.tokens[0], {
    text: 'مرحبا', x: 20, y: 30, w: 40, h: 50, level: 5,
    pageNumber: 1, blockNumber: 1, paragraphNumber: 1, lineNumber: 1, wordNumber: 1, confidence: 95
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, [
    fixture.sourcePath, 'stdout', '--tessdata-dir', fixture.tessdataPath,
    '-l', 'ara+eng', '--oem', '1', '--psm', '3', 'tsv'
  ]);
  assert.deepEqual(calls[1].args, [
    fixture.powerPointPath, 'stdout', '--tessdata-dir', fixture.tessdataPath,
    '-l', 'ara+eng', '--oem', '1', '--psm', '3', 'tsv'
  ]);
  for (const call of calls) {
    assert.equal(call.executablePath, path.join(fixture.bundleRoot, 'tesseract.exe'));
    assert.equal(path.isAbsolute(call.executablePath), true);
    assert.equal(call.options.shell, false);
  }
});

test('a hung bundled OCR process is killed and reported as an OCR timeout', async (t) => {
  const fixture = await bundleFixture(t);
  const calls = [];
  await assert.rejects(
    runBundledTesseractOcr({
      ...fixture,
      timeoutMs: 10,
      spawnImpl: scriptedSpawn([{ hang: true }], calls)
    }),
    (error) => error?.code === 'OCR_TIMEOUT'
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].plan.killed, true);
});
