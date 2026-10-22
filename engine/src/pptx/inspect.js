/**
 * PPTX forensics — reopen the generated package and check what is ACTUALLY in
 * it, rather than trusting the generator's own report.
 *
 * Checks that matter for this product:
 *  - slide dimensions match the source page exactly
 *  - paragraphs whose base direction is RTL carry rtl="1"
 *  - every run names a complex-script font (<a:cs>), not just <a:latin>
 *  - autofit is off (<a:noAutofit/>)
 *  - no picture covers most of a slide (a hidden full-page screenshot)
 *  - every typeface the slides name either travels with the deck or ships with
 *    Office — the corpus fonts are PER-USER installs, so a deck that only names
 *    them renders as .notdef boxes on any other machine
 *  - logical text in the XML equals the text we intended to write
 */
import * as fs from "node:fs";
import JSZip from "jszip";
import { textIsRtl } from "../extract/bidi.js";
// The DELIVERY oracle. Deliberately a different import from the line above:
// this gate must not be able to reach the extraction predicate.
import { hasStrongRtl } from "../model/direction.js";
// A font is only "embedded" for the READER if its own licence permits loading
// it into an editable document. fsType lives in the installed file, which is
// exactly where this gate runs.
import { getFontLicense } from "../fonts/license.js";

const EMU_PER_PT = 12700;

/**
 * Fonts that ship with Office/Windows/macOS, so leaving them unembedded costs
 * nothing. Kept here (a dependency-free leaf) because both the forensics and the
 * embedder have to agree on what "safe to leave out" means.
 */
export const UBIQUITOUS_FONTS = new Set(
  [
    "Calibri", "Calibri Light", "Cambria", "Cambria Math", "Arial", "Arial Black",
    "Times New Roman", "Courier New", "Georgia", "Tahoma", "Trebuchet MS", "Verdana",
    "Segoe UI", "Segoe UI Emoji", "Segoe UI Symbol", "Wingdings", "Webdings", "Symbol",
  ].map((f) => f.toLowerCase())
);
const RE_ARABIC = /[؀-ۿ]/;

const decode = (s) =>
  s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

export async function inspectPptx(file) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));

  const presXml = await zip.file("ppt/presentation.xml").async("string");
  const sz = presXml.match(/<p:sldSz[^>]*cx="(\d+)"[^>]*cy="(\d+)"/);
  const slideSizePt = sz ? { w: +sz[1] / EMU_PER_PT, h: +sz[2] / EMU_PER_PT } : null;

  const slideNames = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => (+a.match(/\d+/)[0]) - (+b.match(/\d+/)[0]));

  const media = Object.keys(zip.files).filter((n) => n.startsWith("ppt/media/"));

  // Which families TRAVEL with the deck. A deck that merely names a font is
  // correct only on a machine where that font is installed — the corpus fonts
  // are per-user installs, so "names it" and "renders it anywhere" are very
  // different claims and the forensics has to be able to tell them apart.
  const embeddedFonts = [
    ...(presXml.match(/<p:embeddedFontLst>[\s\S]*?<\/p:embeddedFontLst>/)?.[0] ?? "")
      .matchAll(/<p:font[^>]*typeface="([^"]*)"/g),
  ].map((m) => m[1]);

  const usedFonts = new Set();
  /** typeface -> the set of characters it actually sets. */
  const fontChars = new Map();
  const slides = [];

  for (const name of slideNames) {
    const xml = await zip.file(name).async("string");

    const paragraphs = xml.match(/<a:p>[\s\S]*?<\/a:p>/g) ?? [];
    const texts = (xml.match(/<a:t>([\s\S]*?)<\/a:t>/g) ?? []).map((t) =>
      decode(t.replace(/<\/?a:t>/g, ""))
    );

    // Judge the paragraph's TEXT, not its XML: attribute values and font names
    // sit in the markup too. An arithmetic expression is legitimately ltr even
    // when it carries an Arabic unit word, so it is not a missing-rtl defect.
    const paraText = (p) =>
      (p.match(/<a:t>([\s\S]*?)<\/a:t>/g) ?? []).map((t) => decode(t.replace(/<\/?a:t>/g, ""))).join("");
    const rtlWanted = paragraphs.filter((p) => textIsRtl(paraText(p)) && RE_ARABIC.test(paraText(p)));
    const rtlParas = rtlWanted.filter((p) => /<a:pPr[^>]*\brtl="1"/.test(p));

    // THE MIRROR, and the gate above is structurally blind to it. `rtlWanted`
    // requires Arabic, so a paragraph that carries rtl="1" with no Arabic in it
    // is not in the set and can never be counted wrong: the check sees a
    // MISSING direction and never an INVENTED one. That is the same shape as
    // EVO-019 — a gate that cannot fail in one direction is half a gate.
    //
    // MEASURED before the writer was narrowed: 102 such paragraphs over 30
    // decks / 14040 paragraphs — field-box segments of an Arabic line
    // (`=SUMIF(range ; criteria ; sum_range)`, `$F$2`, a lone `;`) inheriting
    // their parent's direction, and Latin islands the extractor read as RTL in
    // order to recover their bracket order.
    //
    // The predicate is "no Arabic anywhere", not `!textIsRtl(text)`, and the
    // difference is load-bearing: `textIsRtl` answers which base direction
    // RECONSTRUCTS a painted line, and its trailing-lone-closer clause is not
    // order-invariant, so it calls the finished string `وقياس الأزمنة).` LTR
    // while calling the visual stream it came from RTL. 59 such paragraphs are
    // correctly RTL today and would be false positives here. Absence of a
    // right-to-left character is a fact no reordering can change.
    //
    // STRONG RTL, not Arabic. `hasStrongRtl` covers the living RTL scripts, so a
    // Hebrew or Syriac paragraph is not reported as a false RTL the first time
    // this project meets one — an Arabic-only predicate would have been a hidden
    // failure waiting for a document nobody has run yet.
    const rtlNoRtlText = paragraphs.filter(
      (p) => /<a:pPr[^>]*\brtl="1"/.test(p) && paraText(p).trim() && !hasStrongRtl(paraText(p))
    );

    for (const m of xml.matchAll(/<a:(?:latin|cs|ea)[^>]*typeface="([^"]*)"/g)) usedFonts.add(m[1]);

    // WHICH CHARACTERS each typeface actually sets. A font that does not travel is
    // only a defect if the substitute cannot draw its text, and that question needs
    // the text — the font's NAME says nothing about it. Collected as a character
    // set so a 118-page deck costs a few dozen entries, not a few hundred thousand.
    for (const r of xml.match(/<a:r>[\s\S]*?<\/a:r>/g) ?? []) {
      const t = decode((r.match(/<a:t>([\s\S]*?)<\/a:t>/) ?? [, ""])[1]);
      if (!t) continue;
      for (const m of r.matchAll(/<a:(?:latin|cs|ea)[^>]*typeface="([^"]*)"/g)) {
        let set = fontChars.get(m[1]);
        if (!set) fontChars.set(m[1], (set = new Set()));
        for (const c of t) set.add(c);
      }
    }

    const runs = xml.match(/<a:rPr[^>]*>[\s\S]*?<\/a:rPr>|<a:rPr[^>]*\/>/g) ?? [];
    const arabicRuns = (xml.match(/<a:r>[\s\S]*?<\/a:r>/g) ?? []).filter((r) => RE_ARABIC.test(r));
    const runsWithCs = arabicRuns.filter((r) => /<a:cs\b/.test(r));

    // Pictures and their on-slide coverage.
    const pics = [];
    for (const pic of xml.match(/<p:pic>[\s\S]*?<\/p:pic>/g) ?? []) {
      const ext = pic.match(/<a:ext\s+cx="(\d+)"\s+cy="(\d+)"/);
      if (!ext) continue;
      const areaPt = (+ext[1] / EMU_PER_PT) * (+ext[2] / EMU_PER_PT);
      pics.push({ areaPt, coverage: slideSizePt ? areaPt / (slideSizePt.w * slideSizePt.h) : 0 });
    }

    slides.push({
      name,
      paragraphs: paragraphs.length,
      textboxes: (xml.match(/<p:sp>/g) ?? []).length,
      runs: runs.length,
      texts,
      rtlWanted: rtlWanted.length,
      rtlParas: rtlParas.length,
      rtlNoRtlText: rtlNoRtlText.length,
      arabicRuns: arabicRuns.length,
      runsWithCs: runsWithCs.length,
      noAutofit: (xml.match(/<a:noAutofit\/>/g) ?? []).length,
      normAutofit: (xml.match(/<a:normAutofit/g) ?? []).length,
      pictures: pics,
      maxCoverage: pics.length ? Math.max(...pics.map((p) => p.coverage)) : 0,
    });
  }

  return {
    file,
    slideSizePt,
    slideCount: slides.length,
    mediaCount: media.length,
    embeddedFonts,
    usedFonts: [...usedFonts],
    fontText: Object.fromEntries([...fontChars].map(([k, v]) => [k, [...v].join("")])),
    slides,
  };
}

/** Human summary plus pass/fail gates. */
export function summarize(report, expected = {}) {
  const s = report.slides;
  const sum = (k) => s.reduce((n, x) => n + x[k], 0);

  const rtlWanted = sum("rtlWanted"), rtlParas = sum("rtlParas");
  const rtlNoRtlText = sum("rtlNoRtlText");
  const arabicRuns = sum("arabicRuns"), runsWithCs = sum("runsWithCs");
  const worstCoverage = Math.max(0, ...s.map((x) => x.maxCoverage));

  // A typeface is safe to leave out only if it ships with Office everywhere.
  // Theme references (+mn-lt and friends) resolve inside the deck, so they are
  // not a portability question.
  // BEING LISTED IN `<p:embeddedFontLst>` IS OUR ATTEMPT, NOT THE READER'S
  // OUTCOME, and reading it as the outcome is what hid this project's worst
  // delivered bug. MEASURED: Diodrum Arabic and Lyon Arabic Text LF are fsType 4
  // — "preview & print" — which forbids loading the face into an EDITABLE
  // document. PowerPoint honours that and simply does not load them; its own
  // SaveAs strips every one of our font parts. So the four families setting
  // 7017 of 7712 runs were listed as embedded, excluded from the portability
  // check on that basis, and shipped to a reader who could not render one of
  // them. The gate's report said `0 orphan fonts` on every single build.
  //
  // A font travels only if it is embedded AND permitted to load. Anything else
  // rejoins the portability question, where it is judged on the characters it
  // sets like any other font that does not travel.
  const listed = report.embeddedFonts ?? [];
  const restrictedEmbeds = listed.filter((t) => getFontLicense(t).editable !== true);
  const embedded = new Set(listed.filter((t) => !restrictedEmbeds.includes(t)));
  const orphanFonts = (report.usedFonts ?? []).filter(
    (t) => !t.startsWith("+") && !embedded.has(t) && !UBIQUITOUS_FONTS.has(t.toLowerCase())
  );

  // A font that does not travel splits into two very different outcomes, and the
  // deciding evidence is the TEXT it sets — never its name. `expected.fontPortability`
  // maps a family to `{covered, by, missing}` from `src/fonts/coverage.js`, which
  // reads real `cmap` tables:
  //
  //   covered      some face that ships everywhere draws every character, so the
  //                reader sees the right glyphs in another shape  -> WARNING
  //   not covered  nothing can draw them, so the reader sees tofu -> HARD FAIL
  //
  // MEASURED, and the reason this is not an allowlist of font names: Unit Five names
  // MS PGothic on 12 runs, all of them `①②③④`. It is NOT licence-restricted —
  // fsType 0x0008, and PowerPoint reports `embeddable=true` — PowerPoint simply
  // declines to embed it, exactly as it declines Calibri and Times New Roman. Real
  // PowerPoint renders those numerals correctly through fallback, no tofu, and
  // `coveredByUbiquitous` says the same thing deterministically (Calibri covers
  // U+2460..2463). Refusing a 118-page deck over that is EVO-019's permanently-red
  // gate; passing it silently is worse. It warns.
  //
  // ABSENT EVIDENCE STAYS A HARD FAIL. A gate must never get quieter merely because
  // nobody measured, so a caller that supplies no portability map sees exactly the
  // old behaviour.
  const portability = expected.fontPortability ?? {};
  const damagingFonts = orphanFonts.filter((t) => portability[t]?.covered !== true);
  const nonPortableFonts = orphanFonts.filter((t) => portability[t]?.covered === true);
  // The message states only what is KNOWN from the package: this font does not
  // travel, and these characters survive substitution. WHY it did not travel —
  // PowerPoint declining it, a licence, our own pipeline losing it — is not
  // visible from here, and an earlier draft asserted "PowerPoint declines to embed
  // it" for every case, which is false for a font that is simply not installed.
  // `embedFonts().fontVerdicts` is where that cause lives, on the convert path.
  const warnings = nonPortableFonts.map((t) => {
    const chars = (report.fontText?.[t] ?? "").slice(0, 24);
    return `NON-PORTABLE FONT: ${t} does not travel with this deck. Its ` +
      `${[...chars].length} character(s) ${JSON.stringify(chars)} are drawn by ` +
      `${portability[t].by}, which ships everywhere, so the reader sees the right ` +
      `glyphs in a substituted face.`;
  });

  const gates = [
    ["slide size matches source",
      !expected.slideSizePt ||
      (Math.abs(report.slideSizePt.w - expected.slideSizePt.w) < 0.5 &&
       Math.abs(report.slideSizePt.h - expected.slideSizePt.h) < 0.5)],
    // "Arabic implies RTL" was the old form of this gate and it is not true: a
    // reference entry and a formula line both carry Arabic and are laid out
    // left to right. It now asks the same question the extractor answered.
    //
    // THREE STATES, NOT TWO, and `null` is the third. These two gates read
    // `rtlWanted > 0 && rtlParas === rtlWanted`, where the `> 0` is deliberate
    // and right: without it a deck whose RTL machinery is switched off entirely
    // passes by vacuous truth, which is EVO-019's decorative gate. But it also
    // FAILED every document that simply has no Arabic in it — measured on a
    // PowerPoint-produced deck whose 18 slides carry 0 Arabic runs, where
    // `ship.js` printed DO NOT SEND against 0 of 0 and named two checks that had
    // nothing to look at. The corpus cannot show this: all 28 decks are Arabic,
    // so `rtlWanted` is never 0 there.
    //
    // `null` means "this document gives this gate nothing to judge". It must be
    // PRINTED as its own thing, never folded into either answer — the moment it
    // renders as a pass, the vacuous-truth hole the `> 0` was guarding is back.
    // Limitation worth knowing: this reads the delivered package, so a deck that
    // lost its Arabic upstream also reports 0 here. Coverage and the character
    // gates are what catch that; this one is not evidence about it either way.
    ["every RTL paragraph is marked RTL", rtlWanted === 0 ? null : rtlParas === rtlWanted],
    // The other direction. Unlike the gate above this one needs no n/a state:
    // "how many paragraphs were marked RTL with no right-to-left character"
    // is answerable on every document, including one with no Arabic at all,
    // where the honest answer is 0 and not "nothing to judge".
    ["no paragraph is marked RTL without RTL text", rtlNoRtlText === 0],
    ["all Arabic runs name a complex-script font", arabicRuns === 0 ? null : runsWithCs === arabicRuns],
    ["autofit disabled everywhere", sum("normAutofit") === 0],
    // The question is "did we give up and rasterise the page", never "is there a
    // big picture". A source page that IS a full-bleed illustration is a correct
    // conversion, so the bar is the SOURCE's own worst image coverage, and only
    // a raster the source did not have can fail this.
    ["no raster the source did not have",
      worstCoverage < 0.9 || worstCoverage <= (expected.sourceMaxCoverage ?? 0) + 0.01],
    // Having emitted the picture is the only proof the writer still handles
    // images: they reached the model, satisfied the coverage ledger, and
    // exported as nothing at all for the life of this project until 2026-08-16.
    ["every image reaches the package", report.mediaCount >= (expected.imagesIntended ?? 0)],
    ["every font travels with the deck", damagingFonts.length === 0],
    // A font we EMBEDDED but are not licensed to embed for editing does not
    // reach the reader, and until 2026-08-24 it was counted as though it did.
    // This is stated as its own gate rather than folded into the one above so
    // the report distinguishes "we never shipped this font" from "we shipped it
    // and the reader's PowerPoint is required to refuse it".
    ["no embedded font is licence-restricted", restrictedEmbeds.length === 0],
  ];

  return {
    lines: [
      `slides            : ${report.slideCount}`,
      `slide size (pt)   : ${report.slideSizePt.w.toFixed(2)} x ${report.slideSizePt.h.toFixed(2)}`,
      `text boxes        : ${sum("textboxes")}`,
      `paragraphs        : ${sum("paragraphs")}`,
      `RTL paragraphs    : ${rtlWanted}  (rtl="1": ${rtlParas})   marked RTL with no RTL text: ${rtlNoRtlText}`,
      `Arabic runs       : ${arabicRuns}  (with <a:cs>: ${runsWithCs})`,
      `images in package : ${report.mediaCount}   worst slide coverage: ${(worstCoverage * 100).toFixed(1)}%`,
      `embedded fonts    : ${embedded.size ? [...embedded].join(", ") : "NONE"}`,
      `not travelling    : ${orphanFonts.length ? orphanFonts.join(", ") : "none"}`,
      `  of those, damaging: ${damagingFonts.length ? damagingFonts.join(", ") : "none"}`,
    ],
    gates,
    warnings,
    // `null` is "not applicable" and does not block; only an explicit false does.
    pass: gates.every(([, ok]) => ok !== false),
  };
}
