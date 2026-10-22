/**
 * Embed the deck's fonts into the .pptx so it renders on a machine that does
 * not have them.
 *
 * WHY THIS EXISTS: the corpus is set in Diodrum Arabic, Lyon Arabic Text LF and
 * Cairo, and on this machine all three are installed PER USER (HKCU +
 * %LOCALAPPDATA%\Microsoft\Windows\Fonts). A deck that merely NAMES them is
 * correct only inside this Windows profile. Anywhere else PowerPoint substitutes,
 * and because every textbox is wrap:false, the substituted (wider) text also
 * runs out of its box — the reported symptom was "boxes instead of Arabic, and
 * lines hanging off the slide".
 *
 * HOW: PowerPoint itself produces the font blobs. `.fntdata` is not a font file —
 * it is Microsoft's embedded-font container (a 4-byte length followed by an EOT
 * blob, MicroType-compressed, built from the TrueType embedding API). Diodrum and
 * Lyon are CFF/OTF, so authoring that container ourselves would mean CFF->TTF
 * conversion plus subsetting plus EOT packing. PowerPoint does all of it in one
 * SaveAs.
 *
 * WHAT WE DO NOT DO: ship PowerPoint's re-saved file as the export. A full SaveAs
 * round-trips OUR xml through PowerPoint's writer — measured on Chp1-Lec1-3 it
 * merges adjacent runs (1001 -> 1000) and rewrites every `rtl="1"` (949 -> 399,
 * moved from run level to paragraph level). Both proved benign here, but the
 * whole project rests on the output being the artifact we wrote and verified. So
 * PowerPoint's copy is used ONLY as a source of font blobs, which are grafted
 * into our own package. Our slide xml is never touched.
 *
 * LIMITS, stated because they are real:
 *  - Embedded fonts are honoured by PowerPoint on Windows and macOS. PowerPoint
 *    on the web, PowerPoint mobile and Google Slides ignore them.
 *  - PowerPoint subsets to the characters the deck uses. Presenting is safe;
 *    typing NEW letters on a machine without the font is not.
 *  - fsType is respected by PowerPoint, not by us: Diodrum and Lyon are
 *    fsType 4 (preview & print), which is what read-only embedding is for.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import JSZip from "jszip";
import { powerPointAvailable } from "../render/powerpoint.js";
// Shared with the forensics so the embedder and the gate cannot disagree about
// which fonts are safe to leave out. Embedding them is not free either — Segoe
// UI Emoji alone is 3.9 MB, four times the rest of the deck.
import { inspectPptx, UBIQUITOUS_FONTS as UBIQUITOUS } from "./inspect.js";
import { coveredByUbiquitous } from "../fonts/coverage.js";

const FONT_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/font";
const FNTDATA_CT = '<Default Extension="fntdata" ContentType="application/x-fontdata"/>';

/**
 * Ask PowerPoint to save a copy of `src` with fonts embedded.
 * ppSaveAsOpenXMLPresentation = 24; the third SaveAs argument is msoTrue.
 *
 * PowerPoint is a SINGLE-INSTANCE automation server: `New-Object -ComObject`
 * hands back the user's own running PowerPoint if they have one open. So this
 * must never Quit unconditionally — doing that closes whatever deck the user was
 * looking at, on every export. We attach when an instance exists, close only the
 * presentation we opened, and quit only an app we started ourselves.
 *
 * An attached instance can also be busy (a modal dialog, a deck mid-save), which
 * surfaces as an opaque HRESULT rather than anything readable, so the open is
 * retried once before giving up and the caller degrades to "not embedded".
 */
const PS_EMBED = String.raw`
$ErrorActionPreference = 'Stop'
$src = $args[0]
$dst = $args[1]
$out = [ordered]@{ ok = $false; fonts = @(); attached = $false; error = $null }
$createdApp = $false
$stage = 'initialise'
try {
  $stage = 'remove old donor'
  if (Test-Path $dst) { Remove-Item $dst -Force }

  $pres = $null
  for ($try = 1; $try -le 3 -and -not $pres; $try++) {
    try {
      $stage = "connect to PowerPoint (attempt $try)"
      try {
        $app = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application')
        $out.attached = $true
        $createdApp = $false
      } catch {
        $app = New-Object -ComObject PowerPoint.Application
        $out.attached = $false
        $createdApp = $true
      }
      try { $app.DisplayAlerts = 1 } catch {}
      if (-not $app -or -not $app.Presentations) { throw 'PowerPoint is still closing' }

      $stage = "open presentation (attempt $try)"
      $pres = $app.Presentations.Open($src, $false, $false, $false)
      if (-not $pres) { throw 'PowerPoint returned no presentation' }
    }
    catch {
      if ($try -eq 3) { throw }
      try { if ($createdApp -and $app) { $app.Quit() } } catch {}
      $app = $null
      [GC]::Collect()
      [GC]::WaitForPendingFinalizers()
      Start-Sleep -Milliseconds 1800
    }
  }

  $stage = 'inspect fonts'
  $list = New-Object System.Collections.ArrayList
  for ($i = 1; $i -le $pres.Fonts.Count; $i++) {
    $f = $pres.Fonts.Item($i)
    [void]$list.Add([ordered]@{ name = $f.Name; embeddable = [bool]$f.Embeddable })
  }
  $out.fonts = $list
  $stage = 'save embedded donor'
  $pres.SaveAs($dst, 24, -1)
  $stage = 'close presentation'
  $pres.Close()
  $pres = $null
  $stage = 'close PowerPoint'
  if ($createdApp) { $app.Quit() }
  $out.ok = $true
}
catch {
  $out.error = "$stage - $($_.Exception.Message)"
  try { if ($pres) { $pres.Close() } } catch {}
  try { if ($createdApp -and $app) { $app.Quit() } } catch {}
}
$json = $out | ConvertTo-Json -Depth 4 -Compress
[System.IO.File]::WriteAllText($args[2], $json, (New-Object System.Text.UTF8Encoding($false)))
`;

/** Pull `ppt/fonts/*.fntdata` out of PowerPoint's copy, keyed by the rel id that points at it. */
async function harvest(donorPath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(donorPath));
  const presXml = await zip.file("ppt/presentation.xml").async("string");
  const lst = presXml.match(/<p:embeddedFontLst>([\s\S]*?)<\/p:embeddedFontLst>/);
  if (!lst) return { blocks: [], parts: new Map() };

  const relsXml = await zip.file("ppt/_rels/presentation.xml.rels").async("string");
  const target = new Map();
  for (const m of relsXml.matchAll(/<Relationship Id="([^"]+)"[^>]*Target="([^"]+\.fntdata)"/g)) {
    target.set(m[1], `ppt/${m[2].replace(/^\.?\//, "")}`);
  }

  const parts = new Map();
  for (const [rid, part] of target) parts.set(rid, await zip.file(part).async("nodebuffer"));

  // One <p:embeddedFont> block per family, each naming up to four style rels.
  const blocks = [...lst[1].matchAll(/<p:embeddedFont>[\s\S]*?<\/p:embeddedFont>/g)].map((m) => {
    const xml = m[0];
    return {
      xml,
      typeface: (xml.match(/<p:font[^>]*typeface="([^"]*)"/) ?? [])[1] ?? "",
      rids: [...xml.matchAll(/r:id="([^"]+)"/g)].map((r) => r[1]),
    };
  });
  return { blocks, parts };
}

/**
 * How the slides ASK for each typeface, counted from run properties.
 *
 * MEASURED DEFECT this exists for: our resolver bakes weight into family names
 * ("Lyon Arabic Text LF Bold" is a family; runs carry b=0), but PowerPoint's
 * embedder classifies the physical file by its real weight and registers it
 * under <p:bold> only. On any machine without the font installed, 774 runs
 * asking for the REGULAR slot of that family found nothing embedded and fell
 * back — on some machines to a CJK font. Invisible on the author's machine,
 * where the installed fonts hide the empty slot.
 */
async function slideVariantAsks(zip) {
  const asks = new Map(); // typeface -> { regular: n, bold: n }
  for (const name of Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))) {
    const s = await zip.file(name).async("string");
    for (const m of s.matchAll(/<a:rPr\b[^>]*>[\s\S]*?<\/a:rPr>|<a:rPr\b[^>]*\/>/g)) {
      const block = m[0];
      const faces = [...block.matchAll(/<a:(?:latin|cs|ea)\s+typeface="([^"]+)"/g)].map((x) => x[1]);
      if (!faces.length) continue;
      const bold = /\bb="1"/.test(block);
      for (const tf of new Set(faces)) {
        const e = asks.get(tf) ?? { regular: 0, bold: 0 };
        e[bold ? "bold" : "regular"]++;
        asks.set(tf, e);
      }
    }
  }
  return asks;
}

/** Graft the harvested blobs into our own package, leaving every slide part untouched. */
async function graft(pptxPath, { blocks, parts }) {
  const zip = await JSZip.loadAsync(fs.readFileSync(pptxPath));
  const presPath = "ppt/presentation.xml";
  const relsPath = "ppt/_rels/presentation.xml.rels";
  let presXml = await zip.file(presPath).async("string");
  let relsXml = await zip.file(relsPath).async("string");
  let typesXml = await zip.file("[Content_Types].xml").async("string");

  if (presXml.includes("<p:embeddedFontLst>")) return { embedded: [], skipped: [], alreadyEmbedded: true };

  const usedIds = [...relsXml.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]));
  let nextRid = Math.max(0, ...usedIds) + 1;
  let nextPart = 1;

  const kept = [];
  const skipped = [];
  const newRels = [];
  let lstXml = "";

  const asks = await slideVariantAsks(zip);
  // rid -> part path, so a missing variant slot can be aliased to the SAME
  // physical blob through its own relationship (two slots, one file).
  const ridPart = new Map();

  for (const block of blocks) {
    if (UBIQUITOUS.has(block.typeface.toLowerCase())) {
      skipped.push(block.typeface);
      continue;
    }
    let xml = block.xml;
    let bytes = 0;
    for (const oldRid of block.rids) {
      const blob = parts.get(oldRid);
      if (!blob) continue;
      const rid = `rId${nextRid++}`;
      const part = `ppt/fonts/font${nextPart++}.fntdata`;
      zip.file(part, blob);
      newRels.push(`<Relationship Id="${rid}" Type="${FONT_REL}" Target="${part.replace("ppt/", "")}"/>`);
      ridPart.set(rid, part);
      // Replace this exact rel id only — the styles inside one block share a prefix.
      xml = xml.replace(new RegExp(`r:id="${oldRid}"`, "g"), `r:id="${rid}"`);
      bytes += blob.length;
    }

    // VARIANT INTEGRITY GATE. Every slot the slides ask for must exist in the
    // embedded list. A face registered bold-only while runs ask regular renders
    // from the package on the author's machine and falls back everywhere else.
    const want = asks.get(block.typeface);
    if (want) {
      for (const [slot, tag] of [["regular", "p:regular"], ["bold", "p:bold"]]) {
        if (!want[slot] || new RegExp(`<${tag}[\\s/>]`).test(xml)) continue;
        const anyRid = [...xml.matchAll(/r:id="(rId\d+)"/g)].map((r) => r[1])[0];
        const part = anyRid && ridPart.get(anyRid);
        if (!part) continue;
        const aliasRid = `rId${nextRid++}`;
        newRels.push(`<Relationship Id="${aliasRid}" Type="${FONT_REL}" Target="${part.replace("ppt/", "")}"/>`);
        // CT_EmbeddedFontListEntry order: font, regular, bold, italic, boldItalic.
        // Insert regular right after <p:font .../>; bold goes before italic/regular.
        const fontTag = xml.match(/<p:font\b[^>]*\/>/);
        if (tag === "p:regular" && fontTag) {
          xml = xml.replace(fontTag[0], `${fontTag[0]}<p:regular r:id="${aliasRid}"/>`);
        } else {
          const anchor = xml.match(/<p:(?:italic|regular)\b[\s/S]/);
          xml = anchor
            ? xml.replace(anchor[0], `<p:bold r:id="${aliasRid}"/>${anchor[0]}`)
            : xml.replace(/<\/p:embeddedFont>$/, `<p:bold r:id="${aliasRid}"/></p:embeddedFont>`);
        }
        // The alias reuses a blob already counted in `bytes` above — add nothing.
        ridPart.set(aliasRid, part);
        console.warn(`  font-variant-alias: ${block.typeface}: ${slot} slot was empty; aliased to ${part}`);
      }
    }

    lstXml += xml;
    kept.push({ typeface: block.typeface, styles: block.rids.length, bytes });
  }

  if (!lstXml) return { embedded: [], skipped, alreadyEmbedded: false };

  // CT_Presentation orders embeddedFontLst after notesSz and before defaultTextStyle.
  const anchor = presXml.match(/<p:notesSz[^>]*\/>/);
  if (!anchor) throw new Error("presentation.xml has no <p:notesSz/> to anchor embeddedFontLst to");
  presXml = presXml.replace(anchor[0], `${anchor[0]}<p:embeddedFontLst>${lstXml}</p:embeddedFontLst>`);

  relsXml = relsXml.replace("</Relationships>", `${newRels.join("")}</Relationships>`);
  if (!typesXml.includes('Extension="fntdata"')) {
    typesXml = typesXml.replace("<Override", `${FNTDATA_CT}<Override`);
  }

  zip.file(presPath, presXml);
  zip.file(relsPath, relsXml);
  zip.file("[Content_Types].xml", typesXml);

  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  fs.writeFileSync(pptxPath, buf);
  return { embedded: kept, skipped, alreadyEmbedded: false };
}

/**
 * Embed every non-ubiquitous font the deck uses, in place.
 *
 * Never throws on a missing PowerPoint — a deck without embedded fonts is still
 * a valid deck, and the caller reports the downgrade rather than failing the
 * conversion.
 *
 * @returns {Promise<{ok:boolean, reason?:string, embedded:Array, skipped:Array,
 *                    bytesBefore:number, bytesAfter:number}>}
 */
export async function embedFonts(pptxPath, { timeoutMs = 180000 } = {}) {
  const abs = path.resolve(pptxPath);
  const bytesBefore = fs.statSync(abs).size;
  const nothing = { ok: false, embedded: [], skipped: [], bytesBefore, bytesAfter: bytesBefore };

  if (!powerPointAvailable()) return { ...nothing, reason: "powerpoint-unavailable" };

  // EMBED ALL CHARACTERS, not "only the used subset".
  //
  // MEASURED FAILURE with subsets: `saveSubsetFonts="1"` (pptxgenjs's default)
  // made PowerPoint embed only the glyph forms shaped on THIS machine. The
  // recipient's Arabic shaper requested different contextual forms, found them
  // missing from the embedded Regular subset, and drew .notdef boxes — while the
  // Bold face happened to be covered and rendered fine. Microsoft's own guidance
  // for decks shared with others is "Embed all characters". Flipping the flag on
  // OUR package before the donor SaveAs is what makes PowerPoint honour it; the
  // cost is larger .fntdata parts, which portability buys gladly.
  {
    const zip = await JSZip.loadAsync(fs.readFileSync(abs));
    let presXml = await zip.file("ppt/presentation.xml").async("string");
    if (/saveSubsetFonts="1"/.test(presXml)) {
      presXml = presXml.replace(/saveSubsetFonts="1"/g, 'saveSubsetFonts="0"');
      zip.file("ppt/presentation.xml", presXml);
      const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
      fs.writeFileSync(abs, buf);
    }
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-embed-"));
  try {
    const script = path.join(scratch, "_embed.ps1");
    const donor = path.join(scratch, "donor.pptx");
    const resultFile = path.join(scratch, "_embed.json");
    fs.writeFileSync(script, PS_EMBED, "utf8");

    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, abs, donor, resultFile],
      { encoding: "utf8", timeout: timeoutMs, windowsHide: true, cwd: scratch, maxBuffer: 32 * 1024 * 1024 }
    );

    if (!fs.existsSync(resultFile)) return { ...nothing, reason: "powerpoint-produced-no-result" };
    const res = JSON.parse(fs.readFileSync(resultFile, "utf8"));
    if (!res.ok || !fs.existsSync(donor)) {
      // An attached instance that refuses to open anything is the user's own
      // PowerPoint being busy — a modal dialog, Protected View, a slide show.
      // The raw HRESULT tells them nothing and the fix is one action, so say it.
      const reason =
        res.attached && /0x80048240|HRESULT/i.test(res.error ?? "")
          ? "powerpoint-busy — close the presentation open in PowerPoint (or dismiss its dialog) and export again"
          : res.error ?? "powerpoint-save-failed";
      return { ...nothing, reason };
    }

    const harvested = await harvest(donor);
    if (!harvested.blocks.length) return { ...nothing, reason: "powerpoint-embedded-nothing" };

    const grafted = await graft(abs, harvested);
    // PowerPoint's OWN verdict per font, threaded out rather than re-derived
    // (EVO-033). `$pres.Fonts` carries an `Embeddable` flag, and it is the only
    // authority on why a font did not travel: a font absent from the embedded
    // list AND reported embeddable is our bug, while one reported NOT embeddable
    // is a property of the font that no amount of work here can change. Without
    // this the two are indistinguishable at the gate, and the shipping verdict
    // cannot say which it is looking at.
    return { ok: true, ...grafted, bytesBefore, bytesAfter: fs.statSync(abs).size, fontVerdicts: res.fonts ?? [] };
  } catch (err) {
    return { ...nothing, reason: err.message };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Embed fonts and then reopen the package to prove the blobs are really there.
 * `embedFonts` deliberately returns a result instead of throwing because it is
 * also useful as a diagnostic primitive; delivery callers need the stricter
 * contract implemented here.
 */
export async function embedFontsOrFail(
  pptxPath,
  { allowSkip = false, timeoutMs = 180000, displayPath = pptxPath, embedder = embedFonts } = {}
) {
  if (allowSkip) {
    const bytes = fs.statSync(pptxPath).size;
    return { ok: false, reason: "disabled", embedded: [], skipped: [], bytesBefore: bytes, bytesAfter: bytes };
  }

  const result = await embedder(pptxPath, { timeoutMs });
  const report = await inspectPptx(pptxPath);
  const required = [...new Map(
    (report.usedFonts ?? [])
      .filter((face) => face && !face.startsWith("+") && !UBIQUITOUS.has(face.toLowerCase()))
      .map((face) => [face.toLowerCase(), face])
  ).values()];
  const embedded = new Set((report.embeddedFonts ?? []).map((face) => face.toLowerCase()));

  // "NOTHING WAS EMBEDDED" IS TWO DIFFERENT SITUATIONS, and throwing on both
  // refuses documents that are perfectly fine. This gate exists for the measured
  // failure where the embedder DIED and the deck shipped silently fontless
  // (KNOWN_ISSUES: 7.5 MB, 118 slides, `embeddedFonts: []`, invisible because the
  // crash ate the report line). It fired on a very different case:
  //
  //   a 33-page Microsoft Word document whose only non-ubiquitous face is
  //   `Microsoft Ya Hei` — a CHINESE font Word had applied to 40 characters of
  //   plain English ("Suitable Apcons:Prdwymkg...") through its East Asian theme
  //   slot. The embedder ran perfectly (`ok: true`, no reason), and PowerPoint
  //   declined to embed it exactly as it declines Times New Roman and Symbol.
  //   Delivery threw, and NO FILE WAS PRODUCED AT ALL.
  //
  // Two signals separate them, and both are now available. The embedder's own
  // `ok` says whether it RAN — on a 288-page LaTeX document it comes back
  // "PowerPoint could not open the file", which is a real failure and still
  // throws. And `coveredByUbiquitous` says whether the reader can still read the
  // text, from real cmap tables rather than from font names.
  //
  // PARTIAL EMBEDDING SHIPS THE SAME BROKEN DECK (measured 2026-08-24): on
  // UnitFive-FINAL3 PowerPoint embedded Cairo, Diodrum and Lyon Arabic but
  // refused MS PGothic and Times New Roman PSMT — both of which set text no
  // ubiquitous font can draw. Because `embedded.size` was 6 and not 0, this
  // gate never fired, the deck shipped, and on a laptop without those fonts
  // the Arabic rendered substituted and ran out of its box. The question this
  // gate answers is not "did anything embed" but "does every face that sets
  // un-substitutable text travel with the package".
  if (required.length) {
    const missing = required.filter((face) => !embedded.has(face.toLowerCase()));
    const damaging = missing.filter(
      (face) => coveredByUbiquitous(report.fontText?.[face] ?? "").covered !== true
    );
    if (missing.length === required.length && !result.ok) {
      throw new Error(
        `${displayPath}: 0 of ${required.length} fonts embedded (${required.join(", ")})` +
        ` — the embedder did not run; embedder reported: ${result.reason}`
      );
    }
    if (damaging.length) {
      throw new Error(
        `${displayPath}: ${missing.length} of ${required.length} required fonts did not travel (${missing.join(", ")})` +
        ` — ${damaging.length} of them set text no ubiquitous font can draw (${damaging.join(", ")})` +
        `, so the deck will not render off this machine`
      );
    }
    if (missing.length === required.length) {
      // Ran fine, embedded nothing, and every character survives substitution.
      return { ...result, ok: true, reason: "nothing-embeddable", nonPortable: required };
    }
    if (missing.length) {
      // Everything damaging travelled; what stayed behind degrades gracefully
      // under substitution, so deliver — but say so rather than claim full success.
      return { ...result, ok: true, reason: "partially-unembeddable", nonPortable: missing };
    }
  }

  if (!required.length && !result.ok) return { ...result, ok: true, reason: "not-required" };
  if (!result.ok && embedded.size) {
    return {
      ...result,
      ok: true,
      reason: "already-embedded",
      embedded: (report.embeddedFonts ?? []).map((typeface) => ({ typeface, styles: 0, bytes: 0 })),
    };
  }
  return result;
}

/**
 * Build and embed beside the destination, then publish with one rename.
 * A failed writer, PowerPoint run, assertion or rename can leave neither a
 * half-written deck nor a silently unembedded one at the requested path.
 */
export async function deliverPptxAtomically(pptxPath, write, options = {}) {
  const finalPath = path.resolve(pptxPath);
  // PptxGenJS appends `.pptx` to an unfamiliar final extension, so `x.pptx.partial`
  // actually becomes `x.pptx.partial.pptx` behind our back. Keep the sibling
  // marker while retaining the real package extension.
  const partialPath = finalPath.toLowerCase().endsWith(".pptx")
    ? `${finalPath.slice(0, -5)}.partial.pptx`
    : `${finalPath}.partial.pptx`;
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  fs.rmSync(partialPath, { force: true });

  try {
    const stats = await write(partialPath);
    const fonts = await embedFontsOrFail(partialPath, { ...options, displayPath: finalPath });
    fs.renameSync(partialPath, finalPath);
    return { stats, fonts };
  } catch (err) {
    fs.rmSync(partialPath, { force: true });
    throw err;
  }
}
