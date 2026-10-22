/**
 * Serve the document's real fonts to the browser.
 *
 * WHY THIS EXISTS (measured 2026-08-15, in the running editor's own tab):
 * `web/editor.js` sets `font-family: "<the model's family>"` and trusts the
 * browser to find it. It cannot. These fonts are installed PER USER, in
 * %LOCALAPPDATA%\Microsoft\Windows\Fonts, and Chromium-based browsers do not
 * expose per-user installed fonts to pages. Rendering the same Arabic string at
 * 32px and measuring the result:
 *
 *     a deliberately fake family    186px   <- the fallback width
 *     "Diodrum Arabic"              242px   ok
 *     "Diodrum Arabic Bold"         186px   <- SAME as fake: not resolvable
 *     "Lyon Arabic Text LF"         204px   ok
 *     "Lyon Arabic Text LF Bold"    186px   <- SAME as fake: not resolvable
 *
 * So every BOLD run silently fell back to Segoe UI, which is why headings in the
 * editor did not match the source page. `document.fonts.check()` is no help — it
 * returned true for every one of them, the fake included. Only measuring
 * rendered width tells the truth.
 *
 * The fix is to stop asking the browser to find fonts and hand it the files.
 * Installed files are used rather than the PDF's embedded subsets on purpose:
 * subsets are indexed by glyph id for the PDF's own encoding and are not
 * guaranteed to map reconstructed Unicode text, whereas the installed originals
 * carry full cmap and shaping tables.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const FONT_DIRS = [
  path.join(process.env.WINDIR ?? "C:\\Windows", "Fonts"),
  path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "Windows", "Fonts"),
].filter((d) => d && fs.existsSync(d));

/**
 * Read a font's own family and subfamily out of its `name` table.
 *
 * NOT `new mupdf.Font(label, bytes).getName()` — that returns the LABEL you
 * passed in, so it reports the filename straight back and every match silently
 * fails. The name table is the only authority on what a face calls itself.
 *
 * @returns {{family:string, subfamily:string}|null}
 */
export function readFontNames(buf) {
  if (buf.length < 12) return null;
  const tag = buf.readUInt32BE(0);
  // 0x00010000 TrueType outlines, 'OTTO' CFF outlines, 'true' legacy Mac.
  if (tag !== 0x00010000 && tag !== 0x4f54544f && tag !== 0x74727565) return null;

  const numTables = buf.readUInt16BE(4);
  let nameOff = 0;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (rec + 16 > buf.length) return null;
    if (buf.toString("latin1", rec, rec + 4) === "name") {
      nameOff = buf.readUInt32BE(rec + 8);
      break;
    }
  }
  if (!nameOff || nameOff + 6 > buf.length) return null;
  const count = buf.readUInt16BE(nameOff + 2);
  const strOff = nameOff + buf.readUInt16BE(nameOff + 4);
  const picked = {};

  for (let i = 0; i < count; i++) {
    const r = nameOff + 6 + i * 12;
    if (r + 12 > buf.length) break;
    const platformId = buf.readUInt16BE(r);
    const nameId = buf.readUInt16BE(r + 6);
    const len = buf.readUInt16BE(r + 8);
    const off = buf.readUInt16BE(r + 10);
    // 1/2 = family/subfamily; 16/17 = typographic family/subfamily, which is the
    // truthful pair for families carrying more than four cuts.
    if (![1, 2, 16, 17].includes(nameId)) continue;
    const s = strOff + off;
    if (s + len > buf.length) continue;

    // Platform 3 (Windows) and 0 (Unicode) store UTF-16BE; platform 1 is
    // MacRoman. Node has no utf16be decoder, so byte-swap into utf16le - on a
    // COPY, because swap16() mutates in place and would corrupt every later
    // read of this same file buffer. Spaces are kept: "Diodrum Arabic" has one.
    const value = (platformId === 1
      ? buf.toString("latin1", s, s + len)
      : Buffer.from(buf.subarray(s, s + len)).swap16().toString("utf16le")
    ).replace(/\0/g, "").trim();

    if (value && picked[nameId] === undefined) picked[nameId] = value;
  }

  const family = picked[16] || picked[1];
  if (!family) return null;
  return { family, subfamily: picked[17] || picked[2] || "Regular" };
}

/**
 * A font's embedding permission, from its own `OS/2` table.
 *
 * fsType lives at offset 8 of OS/2 in EVERY version of the table (v0..v4),
 * so one fixed offset is correct for any font. This is the field PowerPoint
 * honours when it decides whether an embedded font may be EDITED by the
 * recipient: 0x0000 installable, 0x0008 editable, 0x0004 preview-&-print
 * (read-only embed), 0x0002 restricted. Diodrum Arabic and Lyon Arabic Text
 * LF are both 0x0004 — which is why decks naming them open read-only or
 * fall back to a CJK substitute on recipient machines.
 *
 * Returns null when there is no readable OS/2 table (.ttc collections are not
 * handled, same as everywhere else in this module).
 */
export function readFsType(buf) {
  if (buf.length < 12) return null;
  const tag = buf.readUInt32BE(0);
  if (tag !== 0x00010000 && tag !== 0x4f54544f && tag !== 0x74727565) return null;
  const numTables = buf.readUInt16BE(4);
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (rec + 16 > buf.length) return null;
    if (buf.toString("latin1", rec, rec + 4) === "OS/2") {
      const off = buf.readUInt32BE(rec + 8);
      if (!off || off + 10 > buf.length) return null;
      return buf.readUInt16BE(off + 8);
    }
  }
  return null;
}

/** Compare names ignoring case, spaces, hyphens and the like. */
function tableOffset(buf, want) {
  if (buf.length < 12) return 0;
  const tag = buf.readUInt32BE(0);
  if (tag !== 0x00010000 && tag !== 0x4f54544f && tag !== 0x74727565) return 0;
  const numTables = buf.readUInt16BE(4);
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (rec + 16 > buf.length) return 0;
    if (buf.toString("latin1", rec, rec + 4) === want) return buf.readUInt32BE(rec + 8);
  }
  return 0;
}

/** Compare names ignoring case, spaces, hyphens and the like. */
const key = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Weight words, longest-matching first so "semibold" beats "bold". */
const WEIGHTS = [
  ["extralight", 200], ["ultralight", 200], ["semibold", 600], ["demibold", 600],
  ["extrabold", 800], ["ultrabold", 800], ["black", 900], ["heavy", 900],
  ["medium", 500], ["light", 300], ["thin", 100], ["bold", 700],
  ["regular", 400], ["book", 400],
];

function weightOf(...names) {
  const k = key(names.join(" "));
  for (const [word, w] of WEIGHTS) if (k.includes(word)) return w;
  return 400;
}
const italicOf = (...names) => /italic|oblique/i.test(names.join(" "));

/**
 * Font file paths from the registry.
 *
 * A directory scan is not enough. MEASURED: this deck's headings want Cairo, and
 * Cairo on this machine is installed from
 * C:\Program Files (x86)\V-5-Techno\skins\config\font\Cairo-Regular.ttf - listed
 * in HKLM but present in neither font directory. Windows lets an installer
 * register a font from anywhere, so the registry is the authoritative list.
 */
function registryFontFiles() {
  const script = [
    "$out = @()",
    "foreach ($h in 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts','HKCU:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts') {",
    "  if (Test-Path $h) { (Get-ItemProperty -Path $h).PSObject.Properties |",
    "    Where-Object { $_.Name -notlike 'PS*' } | ForEach-Object { $out += [string]$_.Value } } }",
    "$out | Sort-Object -Unique | ConvertTo-Json -Compress",
  ].join("\n");

  let raw;
  try {
    raw = execFileSync("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { encoding: "utf8", timeout: 20000, windowsHide: true });
  } catch { return []; }

  let list;
  try { list = JSON.parse(raw || "[]"); } catch { return []; }
  if (!Array.isArray(list)) list = [list];

  const winFonts = path.join(process.env.WINDIR ?? "C:\\Windows", "Fonts");
  return list
    .filter((v) => typeof v === "string" && v)
    // A bare filename in the registry means %WINDIR%\Fonts.
    .map((v) => (path.isAbsolute(v) ? v : path.join(winFonts, v)));
}

let cache = null;

/**
 * Every font file whose name table we can read.
 * Parsing a few hundred files takes about half a second, so it is cached.
 */
export function availableFaces({ refresh = false } = {}) {
  if (cache && !refresh) return cache;
  const faces = [];
  for (const dir of FONT_DIRS) {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const fileName of entries) {
      if (!/\.(otf|ttf)$/i.test(fileName)) continue;
      const file = path.join(dir, fileName);
      let names = null;
      let buf = null;
      try {
        buf = fs.readFileSync(file);
        names = readFontNames(buf);
      } catch { /* unreadable or unsupported: simply not offered */ }
      if (!names) continue;
      faces.push({
        file,
        fileName,
        family: names.family,
        subfamily: names.subfamily,
        weight: weightOf(names.subfamily, names.family, fileName),
        italic: italicOf(names.subfamily, fileName),
        fsType: readFsType(buf),
      });
    }
  }
  // Then anything registered from outside those directories.
  const seenFiles = new Set(faces.map((f) => f.file.toLowerCase()));
  for (const file of registryFontFiles()) {
    if (!/\.(otf|ttf)$/i.test(file) || seenFiles.has(file.toLowerCase())) continue;
    let names = null;
    let buf = null;
    try {
      buf = fs.readFileSync(file);
      names = readFontNames(buf);
    } catch { continue; }
    if (!names) continue;
    seenFiles.add(file.toLowerCase());
    const fileName = path.basename(file);
    faces.push({
      file, fileName,
      family: names.family,
      subfamily: names.subfamily,
      weight: weightOf(names.subfamily, names.family, fileName),
      italic: italicOf(names.subfamily, fileName),
      fsType: readFsType(buf),
    });
  }

  cache = faces;
  return faces;
}

/**
 * Best file for a requested family, or null.
 *
 * The model's family names come from `resolve.js`, which matches INSTALLED
 * families and therefore sometimes bakes the weight into the name (measured:
 * "Lyon Arabic Text LF Bold" is a family in its own right, while "Diodrum
 * Arabic" is a family plus a bold attribute - see KNOWN_ISSUES). Both spellings
 * must resolve, so the weight is read from the request when it names one and
 * taken from the caller otherwise.
 */
export function findFace(family, wantBold = false) {
  const faces = availableFaces();
  if (!family) return null;

  const requested = weightOf(family);
  const target = requested !== 400 ? requested : (wantBold ? 700 : 400);
  const bare = family.replace(/\b(regular|bold|black|heavy|light|medium|semibold|demibold|thin|book|italic|oblique)\b/gi, "");
  const want = key(family);
  const stripped = key(bare);

  const candidates = faces.filter((f) => {
    const n = key(f.family);
    if (n === want || n === stripped) return true;
    // "Diodrum Arabic" should still find a face whose family is "Diodrum".
    // key() reduces a non-Latin family name (Korean, Arabic, CJK) to "", and
    // startsWith("") is true for EVERY string - which matched a Korean face
    // against "Diodrum Arabic". Both sides must be substantial before a prefix
    // comparison means anything.
    if (n.length < 4 || stripped.length < 4) return false;
    return n.startsWith(stripped) || stripped.startsWith(n);
  });
  if (!candidates.length) return null;

  // An exact family match must always beat a prefix match, whatever the weights.
  const rank = (f) => (key(f.family) === want ? 0 : key(f.family) === stripped ? 1 : 2);
  candidates.sort((a, b) =>
    rank(a) - rank(b) ||
    Math.abs(a.weight - target) - Math.abs(b.weight - target) ||
    Number(a.italic) - Number(b.italic) ||
    a.family.length - b.family.length);
  return candidates[0];
}

/**
 * Resolve requested families into servable web faces.
 * @param {string[]} families family names exactly as the model spells them
 */
export function facesForFamilies(families) {
  const out = [];
  const seen = new Set();
  for (const family of new Set(families.filter(Boolean))) {
    for (const bold of [false, true]) {
      const face = findFace(family, bold);
      if (!face) continue;
      const weight = bold ? 700 : 400;
      // Do NOT register a light file under a bold row. Measured: Cairo ships
      // only a Regular on this machine, so the bold lookup returns w400 — and
      // registering that as @font-face weight 700 tells the browser it HAS a
      // bold cut, which switches off synthesis and renders headings thin. Leave
      // the row unregistered and the browser smears the regular one, which is
      // exactly what PowerPoint does with the same font. The editor is only a
      // preview of the export if it fakes the weight in the same places.
      if (bold && face.weight < 600) continue;
      const id = `${family}|${weight}`;
      if (seen.has(id)) continue;
      seen.add(id);
      // One @font-face per (family, weight). The same file may legitimately
      // serve both rows for a family that ships no separate bold cut.
      out.push({ family, weight, italic: face.italic, fileName: face.fileName, file: face.file, actualFamily: face.family });
    }
  }
  return out;
}

// Self-test: node src/fonts/webfonts.js ["Family" ...]
if (process.argv[1] && path.basename(process.argv[1]) === "webfonts.js") {
  const t0 = Date.now();
  const faces = availableFaces();
  console.log(`read ${faces.length} font files in ${Date.now() - t0} ms\n`);
  console.log("relevant faces, as their own name tables report them:");
  for (const f of faces.filter((x) => /diodrum|lyon/i.test(x.fileName + x.family))) {
    console.log(`  ${f.fileName.padEnd(24)} family=${JSON.stringify(f.family).padEnd(22)} sub=${JSON.stringify(f.subfamily).padEnd(12)} w${f.weight}`);
  }
  const asked = process.argv.slice(2);
  console.log("\nresolution:");
  for (const fam of asked.length ? asked : ["Diodrum Arabic", "Diodrum Arabic Bold", "Lyon Arabic Text LF", "Lyon Arabic Text LF Bold"]) {
    for (const bold of [false, true]) {
      const f = findFace(fam, bold);
      console.log(`  ${JSON.stringify(fam).padEnd(28)} bold=${String(bold).padEnd(5)} -> ${f ? `${f.fileName} (${f.family} ${f.subfamily}, w${f.weight})` : "NOT FOUND"}`);
    }
  }
}
