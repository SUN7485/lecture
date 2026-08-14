'use strict';

/**
 * Offline, app-bundled Tesseract adapter for the verified PPTX flow.
 *
 * This module deliberately accepts only an explicit bundle directory. It never
 * invokes a bare `tesseract` command, consults PATH, or shells out through
 * Python. The Electron main process can pass its app.asar.unpacked OCR folder
 * as `bundleRoot`; the development default is the repository's tools folder.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn: nodeSpawn } = require('node:child_process');

const REQUIRED_LANGUAGES = Object.freeze(['ara', 'eng']);
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_PSM = 3;
const DEFAULT_BUNDLE_ROOT = path.resolve(__dirname, '..', 'tools', 'pptx', 'ocr');
const INTEGRITY_MANIFEST_FILE = 'SHA256SUMS';
const NATIVE_ASSET_EXTENSIONS = new Set(['.exe', '.dll', '.traineddata']);

class TesseractOcrError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TesseractOcrError';
    this.code = code;
    this.details = details;
  }
}

function errorInfo(error, fallbackCode = 'BUNDLED_OCR_FAILED') {
  return {
    code: error?.code || fallbackCode,
    message: error?.message || String(error),
    details: error?.details
  };
}

function nonEmptyString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TesseractOcrError('BUNDLED_OCR_PATH_INVALID', `${name} must be a non-empty path.`, { name, value });
  }
  return value.trim();
}

function pathWithin(root, candidate, name) {
  const relative = path.relative(root, candidate);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    return candidate;
  }
  throw new TesseractOcrError(
    'BUNDLED_OCR_PATH_OUTSIDE_BUNDLE',
    `${name} must resolve inside the bundled OCR directory.`,
    { bundleRoot: root, [name]: candidate }
  );
}

/**
 * Resolve every executable/data path before a process is created. Absolute
 * executable paths are required at spawn time, preventing Node from doing a
 * PATH lookup even if a caller accidentally supplies a similarly named binary.
 */
function resolveBundledTesseractPaths(options = {}) {
  const bundleRoot = path.resolve(nonEmptyString(options.bundleRoot || DEFAULT_BUNDLE_ROOT, 'bundleRoot'));
  const executableCandidate = options.executablePath
    ? path.resolve(bundleRoot, nonEmptyString(options.executablePath, 'executablePath'))
    : path.join(bundleRoot, 'tesseract.exe');
  const tessdataCandidate = options.tessdataPath
    ? path.resolve(bundleRoot, nonEmptyString(options.tessdataPath, 'tessdataPath'))
    : path.join(bundleRoot, 'tessdata');
  const executablePath = pathWithin(bundleRoot, executableCandidate, 'executablePath');
  const tessdataPath = pathWithin(bundleRoot, tessdataCandidate, 'tessdataPath');

  return Object.freeze({
    bundleRoot,
    executablePath,
    tessdataPath,
    tsvConfigPath: path.join(tessdataPath, 'configs', 'tsv'),
    integrityManifestPath: path.join(bundleRoot, INTEGRITY_MANIFEST_FILE),
    languageData: Object.freeze({
      ara: path.join(tessdataPath, 'ara.traineddata'),
      eng: path.join(tessdataPath, 'eng.traineddata')
    })
  });
}

async function regularFile(filePath) {
  try {
    // A symlink could make a checked relative path escape the unpacked bundle.
    // Native payload entries must be concrete files next to the executable.
    return (await fs.lstat(filePath)).isFile();
  } catch (_) {
    return false;
  }
}

function normaliseManifestPath(value) {
  return String(value || '').replace(/\\/g, '/').toLocaleLowerCase();
}

function isNativeAsset(relativePath) {
  return NATIVE_ASSET_EXTENSIONS.has(path.extname(relativePath).toLocaleLowerCase());
}

function manifestError(message, details = {}) {
  return new TesseractOcrError('BUNDLED_OCR_INTEGRITY_MANIFEST_INVALID', message, details);
}

function manifestEntryPath(paths, filename, lineNumber) {
  if (!filename || path.isAbsolute(filename)) {
    throw manifestError(`SHA256SUMS has an invalid asset path on line ${lineNumber}.`, {
      manifestPath: paths.integrityManifestPath,
      filename,
      lineNumber
    });
  }
  const candidate = path.resolve(paths.bundleRoot, filename.replace(/[\\/]/g, path.sep));
  let absolutePath;
  try {
    absolutePath = pathWithin(paths.bundleRoot, candidate, 'manifestAssetPath');
  } catch (_) {
    throw manifestError(`SHA256SUMS asset path escapes the OCR bundle on line ${lineNumber}.`, {
      manifestPath: paths.integrityManifestPath,
      filename,
      lineNumber
    });
  }
  const relativePath = path.relative(paths.bundleRoot, absolutePath).replace(/\\/g, '/');
  if (!relativePath || relativePath === INTEGRITY_MANIFEST_FILE) {
    throw manifestError(`SHA256SUMS has an invalid asset path on line ${lineNumber}.`, {
      manifestPath: paths.integrityManifestPath,
      filename,
      lineNumber
    });
  }
  return { absolutePath, relativePath };
}

async function readIntegrityManifest(paths) {
  if (!(await regularFile(paths.integrityManifestPath))) {
    throw new TesseractOcrError(
      'BUNDLED_OCR_INTEGRITY_MANIFEST_MISSING',
      'Bundled Tesseract SHA256SUMS integrity manifest is missing.',
      { manifestPath: paths.integrityManifestPath }
    );
  }
  let raw;
  try {
    raw = await fs.readFile(paths.integrityManifestPath, 'utf8');
  } catch (cause) {
    throw manifestError('Bundled Tesseract SHA256SUMS integrity manifest cannot be read.', {
      manifestPath: paths.integrityManifestPath,
      cause: cause.message
    });
  }

  const entries = [];
  const seen = new Set();
  for (const [offset, rawLine] of raw.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    const lineNumber = offset + 1;
    const line = rawLine.trimEnd();
    if (!line || /^\s*#/.test(line)) continue;
    const match = /^([a-fA-F0-9]{64})[ \t]+\*?(.+)$/.exec(line);
    if (!match) {
      throw manifestError(`SHA256SUMS has an invalid checksum entry on line ${lineNumber}.`, {
        manifestPath: paths.integrityManifestPath,
        lineNumber,
        line: rawLine
      });
    }
    const { absolutePath, relativePath } = manifestEntryPath(paths, match[2], lineNumber);
    const key = normaliseManifestPath(relativePath);
    if (seen.has(key)) {
      throw manifestError(`SHA256SUMS lists '${relativePath}' more than once.`, {
        manifestPath: paths.integrityManifestPath,
        relativePath,
        lineNumber
      });
    }
    seen.add(key);
    entries.push({
      absolutePath,
      relativePath,
      sha256: match[1].toLocaleLowerCase(),
      lineNumber
    });
  }
  if (entries.length === 0) {
    throw manifestError('SHA256SUMS must contain at least one native payload asset.', {
      manifestPath: paths.integrityManifestPath
    });
  }
  return {
    entries,
    manifestPath: paths.integrityManifestPath,
    manifestSha256: crypto.createHash('sha256').update(raw, 'utf8').digest('hex')
  };
}

async function discoverNativeAssets(rootPath, relativePath = '') {
  let directoryEntries;
  try {
    directoryEntries = await fs.readdir(path.join(rootPath, relativePath), { withFileTypes: true });
  } catch (cause) {
    throw new TesseractOcrError(
      'BUNDLED_OCR_INTEGRITY_ASSET_INVALID',
      'Bundled Tesseract payload cannot be enumerated.',
      { bundleRoot: rootPath, relativePath, cause: cause.message }
    );
  }
  const assets = [];
  for (const entry of directoryEntries) {
    const childRelativePath = path.join(relativePath, entry.name);
    if (entry.isSymbolicLink()) {
      throw new TesseractOcrError(
        'BUNDLED_OCR_INTEGRITY_ASSET_INVALID',
        'Bundled Tesseract payload must not contain symbolic links.',
        { bundleRoot: rootPath, relativePath: childRelativePath.replace(/\\/g, '/') }
      );
    }
    if (entry.isDirectory()) {
      if (isNativeAsset(childRelativePath)) {
        throw new TesseractOcrError(
          'BUNDLED_OCR_INTEGRITY_ASSET_INVALID',
          'Bundled Tesseract native assets must be regular files.',
          { bundleRoot: rootPath, relativePath: childRelativePath.replace(/\\/g, '/') }
        );
      }
      assets.push(...await discoverNativeAssets(rootPath, childRelativePath));
      continue;
    }
    if (entry.isFile() && isNativeAsset(childRelativePath)) {
      assets.push(childRelativePath.replace(/\\/g, '/'));
    } else if (isNativeAsset(childRelativePath)) {
      throw new TesseractOcrError(
        'BUNDLED_OCR_INTEGRITY_ASSET_INVALID',
        'Bundled Tesseract native assets must be regular files.',
        { bundleRoot: rootPath, relativePath: childRelativePath.replace(/\\/g, '/') }
      );
    }
  }
  return assets;
}

async function sha256File(filePath) {
  try {
    return crypto.createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
  } catch (cause) {
    throw new TesseractOcrError(
      'BUNDLED_OCR_INTEGRITY_ASSET_INVALID',
      'Bundled Tesseract asset cannot be read for integrity verification.',
      { filePath, cause: cause.message }
    );
  }
}

async function verifyBundleIntegrity(paths) {
  const manifest = await readIntegrityManifest(paths);
  const manifestEntries = new Map(manifest.entries.map((entry) => [normaliseManifestPath(entry.relativePath), entry]));
  const tsvConfigRelativePath = path.relative(paths.bundleRoot, paths.tsvConfigPath).replace(/\\/g, '/');
  const tsvConfigManifestEntry = manifestEntries.get(normaliseManifestPath(tsvConfigRelativePath));
  if (!tsvConfigManifestEntry) {
    throw new TesseractOcrError(
      'BUNDLED_OCR_TSV_CONFIG_UNLISTED',
      'Bundled Tesseract TSV renderer config is missing from SHA256SUMS.',
      {
        manifestPath: manifest.manifestPath,
        tsvConfigPath: paths.tsvConfigPath,
        relativePath: tsvConfigRelativePath
      }
    );
  }
  const nativeAssets = await discoverNativeAssets(paths.bundleRoot);
  const unlistedNativeAssets = nativeAssets.filter((relativePath) => !manifestEntries.has(normaliseManifestPath(relativePath)));
  if (unlistedNativeAssets.length > 0) {
    throw new TesseractOcrError(
      'BUNDLED_OCR_INTEGRITY_ASSET_UNLISTED',
      'Bundled Tesseract contains native assets missing from SHA256SUMS.',
      { manifestPath: manifest.manifestPath, unlistedNativeAssets }
    );
  }

  const verifiedAssets = [];
  let verifiedTsvConfig;
  for (const entry of manifest.entries) {
    if (!(await regularFile(entry.absolutePath))) {
      throw new TesseractOcrError(
        'BUNDLED_OCR_INTEGRITY_ASSET_MISSING',
        `Bundled Tesseract asset '${entry.relativePath}' listed in SHA256SUMS is missing.`,
        { manifestPath: manifest.manifestPath, relativePath: entry.relativePath, lineNumber: entry.lineNumber }
      );
    }
    const actualSha256 = await sha256File(entry.absolutePath);
    if (actualSha256 !== entry.sha256) {
      throw new TesseractOcrError(
        'BUNDLED_OCR_INTEGRITY_ASSET_MISMATCH',
        `Bundled Tesseract asset '${entry.relativePath}' does not match SHA256SUMS.`,
        {
          manifestPath: manifest.manifestPath,
          relativePath: entry.relativePath,
          expectedSha256: entry.sha256,
          actualSha256,
          lineNumber: entry.lineNumber
        }
      );
    }
    if (isNativeAsset(entry.relativePath)) {
      verifiedAssets.push({ relativePath: entry.relativePath, sha256: actualSha256 });
    }
    if (normaliseManifestPath(entry.relativePath) === normaliseManifestPath(tsvConfigRelativePath)) {
      verifiedTsvConfig = { relativePath: entry.relativePath, sha256: actualSha256 };
    }
  }
  return {
    manifestPath: manifest.manifestPath,
    manifestSha256: manifest.manifestSha256,
    verifiedTsvConfig,
    verifiedNativeAssetCount: verifiedAssets.length,
    verifiedNativeAssets: verifiedAssets.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  };
}

async function assertBundleFiles(paths) {
  if (!(await regularFile(paths.executablePath))) {
    throw new TesseractOcrError(
      'BUNDLED_OCR_ENGINE_MISSING',
      'Bundled Tesseract executable is missing.',
      { executablePath: paths.executablePath }
    );
  }

  const missingLanguages = [];
  for (const language of REQUIRED_LANGUAGES) {
    if (!(await regularFile(paths.languageData[language]))) missingLanguages.push(language);
  }
  if (missingLanguages.length > 0) {
    throw new TesseractOcrError(
      'BUNDLED_OCR_LANGUAGE_DATA_MISSING',
      'Bundled OCR language data for Arabic and English is missing.',
      {
        tessdataPath: paths.tessdataPath,
        missingLanguages,
        expectedPaths: Object.fromEntries(missingLanguages.map((language) => [language, paths.languageData[language]]))
      }
    );
  }
  if (!(await regularFile(paths.tsvConfigPath))) {
    throw new TesseractOcrError(
      'BUNDLED_OCR_TSV_CONFIG_MISSING',
      'Bundled Tesseract TSV renderer config is missing.',
      { tsvConfigPath: paths.tsvConfigPath }
    );
  }
  return verifyBundleIntegrity(paths);
}

function normaliseLanguages(value) {
  const aliases = new Map([
    ['ara', 'ara'], ['ar', 'ara'], ['ar-sa', 'ara'],
    ['eng', 'eng'], ['en', 'eng'], ['en-us', 'eng']
  ]);
  const values = Array.isArray(value) && value.length > 0 ? value : REQUIRED_LANGUAGES;
  const resolved = values.map((language) => aliases.get(String(language || '').trim().toLowerCase()));
  if (resolved.some((language) => !language) || resolved.length !== REQUIRED_LANGUAGES.length ||
      REQUIRED_LANGUAGES.some((language) => !resolved.includes(language))) {
    throw new TesseractOcrError(
      'OCR_LANGUAGE_PAIR_REQUIRED',
      'Bundled Tesseract requires exactly Arabic and English language data.',
      { requestedLanguages: value, requiredLanguages: REQUIRED_LANGUAGES }
    );
  }
  return REQUIRED_LANGUAGES.slice();
}

function normaliseTimeout(value) {
  const timeoutMs = Number(value ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TesseractOcrError('OCR_TIMEOUT_INVALID', 'OCR timeout must be a positive number of milliseconds.', { timeoutMs: value });
  }
  return Math.floor(timeoutMs);
}

function normalisePsm(value) {
  const psm = Number(value ?? DEFAULT_PSM);
  if (!Number.isInteger(psm) || psm < 0 || psm > 13) {
    throw new TesseractOcrError('OCR_PSM_INVALID', 'Tesseract page segmentation mode must be an integer from 0 to 13.', { psm: value });
  }
  return psm;
}

function collectProcessOutput(executablePath, args, options = {}) {
  const spawnImpl = options.spawnImpl || nodeSpawn;
  const timeoutMs = normaliseTimeout(options.timeoutMs);
  return new Promise((resolve, reject) => {
    let child;
    try {
      // `executablePath` is already absolute and `shell: false` is explicit so
      // no system PATH lookup or command-shell interpretation can occur.
      child = spawnImpl(executablePath, args, {
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (cause) {
      reject(new TesseractOcrError(
        'BUNDLED_OCR_ENGINE_START_FAILED',
        `Could not start bundled Tesseract: ${cause.message}`,
        { executablePath, args, cause: cause.message }
      ));
      return;
    }

    if (!child || typeof child.on !== 'function' || !child.stdout || !child.stderr) {
      reject(new TesseractOcrError(
        'BUNDLED_OCR_ENGINE_START_FAILED',
        'Bundled Tesseract did not expose readable process streams.',
        { executablePath, args }
      ));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let timer;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback();
    };
    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch (_) { /* process may already be gone */ }
      finish(() => reject(new TesseractOcrError(
        'OCR_TIMEOUT',
        `Bundled Tesseract timed out after ${timeoutMs}ms.`,
        { executablePath, args, timeoutMs, stdout, stderr }
      )));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += Buffer.from(chunk).toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += Buffer.from(chunk).toString('utf8'); });
    child.on('error', (cause) => finish(() => reject(new TesseractOcrError(
      'BUNDLED_OCR_ENGINE_START_FAILED',
      `Could not start bundled Tesseract: ${cause.message}`,
      { executablePath, args, cause: cause.message, stdout, stderr }
    ))));
    child.on('close', (code, signal) => finish(() => {
      if (timedOut) return;
      if (code !== 0) {
        reject(new TesseractOcrError(
          'BUNDLED_OCR_ENGINE_FAILED',
          stderr.trim() || `Bundled Tesseract exited with code ${code}.`,
          { executablePath, args, code, signal, stdout, stderr }
        ));
        return;
      }
      resolve({ stdout, stderr, code, signal });
    }));
  });
}

function tsvColumns(header) {
  const columns = new Map();
  header.forEach((name, index) => columns.set(String(name || '').trim(), index));
  const required = ['level', 'left', 'top', 'width', 'height', 'text'];
  const missing = required.filter((name) => !columns.has(name));
  if (missing.length > 0) {
    throw new TesseractOcrError(
      'BUNDLED_OCR_TSV_INVALID',
      'Bundled Tesseract did not return TSV word geometry.',
      { missingColumns: missing, header }
    );
  }
  return columns;
}

function tsvInteger(value, field, lineNumber, allowNegative = false) {
  const number = Number(value);
  if (!Number.isInteger(number) || (!allowNegative && number < 0)) {
    throw new TesseractOcrError(
      'BUNDLED_OCR_TSV_INVALID',
      `Tesseract TSV has an invalid ${field} value on row ${lineNumber}.`,
      { field, value, lineNumber }
    );
  }
  return number;
}

function tsvNumber(value, field, lineNumber) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new TesseractOcrError(
      'BUNDLED_OCR_TSV_INVALID',
      `Tesseract TSV has an invalid ${field} value on row ${lineNumber}.`,
      { field, value, lineNumber }
    );
  }
  return number;
}

/**
 * Parse Tesseract's native TSV renderer output. Only level-5 (word) rows are
 * exposed; each carries the original layout identifiers and a pixel rectangle.
 */
function parseTesseractTsv(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TesseractOcrError('BUNDLED_OCR_TSV_INVALID', 'Bundled Tesseract returned an empty TSV response.');
  }
  const rows = value.replace(/^\uFEFF/, '').split(/\r?\n/);
  const header = (rows.shift() || '').split('\t');
  const columns = tsvColumns(header);
  const tokens = [];

  for (let offset = 0; offset < rows.length; offset += 1) {
    const lineNumber = offset + 2;
    const row = rows[offset];
    if (!row) continue;
    const fields = row.split('\t');
    if (fields.length < header.length) {
      throw new TesseractOcrError(
        'BUNDLED_OCR_TSV_INVALID',
        `Tesseract TSV row ${lineNumber} has fewer fields than its header.`,
        { lineNumber, expectedFields: header.length, actualFields: fields.length }
      );
    }
    const level = tsvInteger(fields[columns.get('level')], 'level', lineNumber);
    if (level !== 5) continue;

    const textIndex = columns.get('text');
    const text = fields.slice(textIndex).join('\t').trim();
    if (!text) continue;
    const token = {
      text,
      x: tsvInteger(fields[columns.get('left')], 'left', lineNumber),
      y: tsvInteger(fields[columns.get('top')], 'top', lineNumber),
      w: tsvInteger(fields[columns.get('width')], 'width', lineNumber),
      h: tsvInteger(fields[columns.get('height')], 'height', lineNumber),
      level
    };
    for (const [tsvName, resultName] of [
      ['page_num', 'pageNumber'],
      ['block_num', 'blockNumber'],
      ['par_num', 'paragraphNumber'],
      ['line_num', 'lineNumber'],
      ['word_num', 'wordNumber']
    ]) {
      if (columns.has(tsvName)) token[resultName] = tsvInteger(fields[columns.get(tsvName)], tsvName, lineNumber);
    }
    if (columns.has('conf')) token.confidence = tsvNumber(fields[columns.get('conf')], 'conf', lineNumber);
    tokens.push(token);
  }

  return tokens;
}

async function assertImageFile(imagePath, field) {
  const resolvedPath = path.resolve(nonEmptyString(imagePath, field));
  if (!(await regularFile(resolvedPath))) {
    throw new TesseractOcrError('OCR_IMAGE_MISSING', `OCR input '${field}' is missing.`, { field, path: resolvedPath });
  }
  return resolvedPath;
}

function recognitionArgs(imagePath, paths, psm) {
  return [
    imagePath,
    'stdout',
    '--tessdata-dir', paths.tessdataPath,
    '-l', REQUIRED_LANGUAGES.join('+'),
    '--oem', '1',
    '--psm', String(psm),
    'tsv'
  ];
}

async function recognizeImage(imagePath, paths, options = {}) {
  const args = recognitionArgs(imagePath, paths, normalisePsm(options.psm));
  const processResult = await collectProcessOutput(paths.executablePath, args, options);
  const tokens = parseTesseractTsv(processResult.stdout);
  return {
    text: tokens.map((token) => token.text).join(' '),
    tokens,
    words: tokens,
    image: { path: imagePath },
    engine: {
      executablePath: paths.executablePath,
      tessdataPath: paths.tessdataPath,
      psm: normalisePsm(options.psm),
      oem: 1
    },
    stderr: processResult.stderr
  };
}

/**
 * Performs a real executable launch plus `--list-langs`, so stale files and
 * missing native DLL dependencies are rejected before an export begins.
 */
async function preflightBundledTesseractOcr(options = {}) {
  const provider = 'Bundled Tesseract';
  try {
    const paths = resolveBundledTesseractPaths(options);
    const integrity = await assertBundleFiles(paths);
    const version = await collectProcessOutput(paths.executablePath, ['--version'], options);
    const languages = await collectProcessOutput(
      paths.executablePath,
      ['--list-langs', '--tessdata-dir', paths.tessdataPath],
      options
    );
    const availableLanguages = languages.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !/^List of available languages\b/i.test(line));
    const missingLanguages = REQUIRED_LANGUAGES.filter((language) => !availableLanguages.includes(language));
    if (missingLanguages.length > 0) {
      throw new TesseractOcrError(
        'BUNDLED_OCR_LANGUAGE_UNAVAILABLE',
        'Bundled Tesseract cannot load the required Arabic and English language data.',
        { availableLanguages, missingLanguages, tessdataPath: paths.tessdataPath }
      );
    }
    return {
      ok: true,
      provider,
      executablePath: paths.executablePath,
      tessdataPath: paths.tessdataPath,
      tsvConfigPath: paths.tsvConfigPath,
      requiredLanguages: REQUIRED_LANGUAGES.slice(),
      availableLanguages,
      version: (version.stdout || version.stderr).trim(),
      integrity
    };
  } catch (error) {
    return { ok: false, provider, error: errorInfo(error, 'BUNDLED_OCR_PREFLIGHT_FAILED') };
  }
}

/**
 * OCR the source and PowerPoint PNGs with exactly the bundled ara+eng engine.
 * It intentionally throws typed errors for the fidelity service to attach to
 * the exact slide report rather than attempting a system or Python fallback.
 */
async function runBundledTesseractOcr(options = {}) {
  const paths = resolveBundledTesseractPaths(options);
  const integrity = await assertBundleFiles(paths);
  const languages = normaliseLanguages(options.languages);
  const [sourcePath, powerPointPath] = await Promise.all([
    assertImageFile(options.sourcePath, 'sourcePath'),
    assertImageFile(options.powerPointPath, 'powerPointPath')
  ]);
  const source = await recognizeImage(sourcePath, paths, options);
  const powerPoint = await recognizeImage(powerPointPath, paths, options);
  return {
    ok: true,
    provider: 'Bundled Tesseract',
    languages,
    source,
    powerPoint,
    integrity,
    engine: {
      executablePath: paths.executablePath,
      tessdataPath: paths.tessdataPath,
      tsvConfigPath: paths.tsvConfigPath,
      psm: normalisePsm(options.psm),
      oem: 1
    }
  };
}

function createBundledTesseractOcr(options = {}) {
  const baseOptions = { ...options };
  return Object.freeze({
    preflight: (callOptions = {}) => preflightBundledTesseractOcr({ ...baseOptions, ...callOptions }),
    recognize: (input = {}) => runBundledTesseractOcr({ ...baseOptions, ...input })
  });
}

module.exports = {
  DEFAULT_BUNDLE_ROOT,
  DEFAULT_PSM,
  DEFAULT_TIMEOUT_MS,
  REQUIRED_LANGUAGES,
  TesseractOcrError,
  createBundledTesseractOcr,
  parseTesseractTsv,
  preflightBundledTesseractOcr,
  resolveBundledTesseractPaths,
  runBundledTesseractOcr
};
