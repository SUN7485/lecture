/**
 * Does the extractor work on a PDF that CHROME did not make?
 *
 * Measured 2026-08-19: all 28 corpus decks report producer `Skia/PDF m126` and
 * page size 713.04 x 487.92 to two decimals. They are 28 prints of one HTML
 * template by one browser — which is why the HTML is available as ground truth.
 * So 98.49% delivered is a statement about ONE generator's glyph emission, and
 * nothing in the corpus can tell us whether any of it generalises.
 *
 * This makes a second producer out of parts already here. Our own PPTX is fed to
 * PowerPoint, PowerPoint saves it as PDF, and the extractor reads that back. The
 * comparison is exact and needs no ground truth: **we know precisely what text
 * went into the PPTX**, so anything different on the way out is the extractor
 * reacting to a new producer and to nothing else.
 *
 *   Skia PDF --extract--> model A --write--> PPTX --PowerPoint--> PDF
 *                                                                  |
 *                            model B <---------extract-------------+
 *
 *   model A == model B  =>  the extractor is producer-independent
 *   model A != model B  =>  the difference is exactly the overfit
 *
 * A caveat to state rather than hide: PowerPoint re-shapes the text with its own
 * engine, so a difference is not automatically an extractor fault — it can be a
 * writer fault the corpus cannot see either. Both are things worth knowing, and
 * the pairs are printed so they can be told apart by reading them.
 *
 *   node experiments/probe-producer-robustness.js [deck] [--keep]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import * as mupdf from "mupdf";
import { modelFromPdf } from "../src/model/normalize.js";
import { applyFixes, DEFAULT_REPAIRS } from "../web/doctor.js";
import { normalize } from "../src/truth/html-slides.js";
import { findPairs } from "../src/truth/corpus.js";

const DECK = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "Chp1-Lec4-2";
const KEEP = process.argv.includes("--keep");

/**
 * PowerPoint is a SINGLE-INSTANCE automation server: `New-Object` hands back the
 * user's own PowerPoint when they have one open, and quitting it closes whatever
 * they were reading. Attach when one exists and only ever quit an app we made —
 * the same rule `src/render/powerpoint.js` follows.
 */
const PS_TO_PDF = String.raw`
$ErrorActionPreference = 'Stop'
$pptx = $args[0]
$pdf  = $args[1]
$out  = [ordered]@{ ok = $false; error = $null }
$createdApp = $false
try {
  try { $app = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application') }
  catch { $app = New-Object -ComObject PowerPoint.Application; $createdApp = $true }
  $pres = $app.Presentations.Open($pptx, $true, $false, $false)   # readonly, no window
  # 32 = ppSaveAsPDF. ExportAsFixedFormat needs more arguments and gives no more.
  $pres.SaveAs($pdf, 32)
  $pres.Close(); $pres = $null
  if ($createdApp) { $app.Quit() }
  $out.ok = $true
} catch {
  $out.error = $_.Exception.Message
  try { if ($pres) { $pres.Close() } } catch {}
  try { if ($createdApp -and $app) { $app.Quit() } } catch {}
}
[System.IO.File]::WriteAllText($args[2], ($out | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
`;

const pair = findPairs().find((p) => p.name === DECK);
if (!pair) { console.error(`no deck named ${DECK}`); process.exit(2); }
const pptx = path.resolve("out", `${DECK}.pptx`);
if (!fs.existsSync(pptx)) { console.error(`${pptx} not built — run src/cli.js convert first`); process.exit(2); }

const work = path.resolve(".work", "producer");
fs.mkdirSync(work, { recursive: true });
const pdfOut = path.join(work, `${DECK}-powerpoint.pdf`);
fs.rmSync(pdfOut, { force: true });

const script = path.join(work, "_topdf.ps1");
const resultFile = path.join(work, "_topdf.json");
fs.writeFileSync(script, PS_TO_PDF, "utf8");
execFileSync("powershell.exe",
  ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, pptx, pdfOut, resultFile],
  { encoding: "utf8", timeout: 300000, windowsHide: true, cwd: work, maxBuffer: 32 * 1024 * 1024 });

const res = JSON.parse(fs.readFileSync(resultFile, "utf8"));
if (!res.ok || !fs.existsSync(pdfOut)) {
  console.error(`PowerPoint could not save a PDF: ${res.error ?? "no file produced"}`);
  process.exit(1);
}

/** Prove the new PDF really is a different generator before comparing anything. */
const producerOf = (p) => {
  const d = mupdf.Document.openDocument(fs.readFileSync(p), "application/pdf");
  return d.getMetaData?.("info:Producer") ?? "(none)";
};
console.log(`deck ${DECK}`);
console.log(`  source PDF producer : ${producerOf(pair.pdf)}`);
console.log(`  round-trip producer : ${producerOf(pdfOut)}`);
console.log(`  round-trip size     : ${(fs.statSync(pdfOut).size / 1024).toFixed(0)} KB\n`);

/** The text we PUT IN: the model the writer wrote, per page. */
const modelText = (pdf) => {
  const m = modelFromPdf(pdf);
  for (const rule of DEFAULT_REPAIRS) applyFixes(m, rule);
  return m.pages.map((p) => p.objects.filter((o) => o.type === "text" && o.text).map((o) => normalize(o.text)).filter(Boolean));
};

const A = modelText(pair.pdf);
const B = modelText(pdfOut);

console.log(`pages   in ${A.length}   out ${B.length}${A.length !== B.length ? "   <- PAGE COUNT CHANGED" : ""}`);
console.log(`blocks  in ${A.flat().length}   out ${B.flat().length}\n`);

let survived = 0, lost = 0;
const losses = [];
const n = Math.min(A.length, B.length);
for (let i = 0; i < n; i++) {
  const outJoined = B[i].join(" ");
  for (const t of A[i]) {
    if (outJoined.includes(t)) survived++;
    else { lost++; if (losses.length < 400) losses.push({ page: i + 1, text: t }); }
  }
}
const total = survived + lost;
console.log(`Blocks that came back VERBATIM through a different producer:`);
console.log(`  ${survived} / ${total}   ${((survived / total) * 100).toFixed(2)}%\n`);

/**
 * Verbatim-per-block is the product's number and a terrible diagnosis: it counts
 * a re-segmentation and a scrambled word the same way. These two separate them.
 */
function lcs(a, b) {
  if (!a.length || !b.length) return 0;
  let prev = new Uint16Array(b.length + 1), cur = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    [prev, cur] = [cur, prev]; cur.fill(0);
  }
  return prev[b.length];
}
const bag = (s) => [...s.replace(/\s/g, "")].sort().join("");

let charIn = 0, charKept = 0, pagesSameBag = 0;
for (let i = 0; i < n; i++) {
  const inText = A[i].join(" "), outText = B[i].join(" ");
  charIn += inText.replace(/\s/g, "").length;
  charKept += lcs(inText.replace(/\s/g, ""), outText.replace(/\s/g, ""));
  if (bag(inText) === bag(outText)) pagesSameBag++;
}
console.log(`Where the damage IS, per page:`);
console.log(`  character recall (in order)   ${((charKept / charIn) * 100).toFixed(2)}%   ${charKept} / ${charIn}`);
console.log(`  pages with an IDENTICAL character bag  ${pagesSameBag} / ${n}`);
console.log(`  ^ high recall with low block-verbatim means ORDERING and SEGMENTATION,`);
console.log(`    not lost characters. Low recall means the glyphs themselves are wrong.\n`);

if (losses.length) {
  console.log(`--- ${Math.min(12, losses.length)} of ${lost} that did NOT survive ---`);
  for (const l of losses.slice(0, 12)) {
    const outJoined = B[l.page - 1].join(" ");
    // Show what the round trip produced near this text, so cause is readable.
    const head = l.text.slice(0, 14);
    const at = outJoined.indexOf(head.slice(0, 8));
    console.log(`p${l.page}`);
    console.log(`  in   ${l.text.slice(0, 95)}`);
    console.log(`  out  ${at >= 0 ? outJoined.slice(Math.max(0, at - 10), at + 95) : "(nothing resembling it on this page)"}`);
  }
}

if (!KEEP) fs.rmSync(pdfOut, { force: true });
console.log(`\n${KEEP ? `kept ${pdfOut}` : "round-trip PDF removed (--keep to inspect it)"}`);
