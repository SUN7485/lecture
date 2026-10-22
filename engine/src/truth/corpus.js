/**
 * Find every PDF that has ground truth beside it.
 *
 * The lectures live as `<root>/<chapter>/done/<name>.pdf` with a matching HTML
 * export. Two naming conventions are in use and both are load-bearing: chapter 1
 * uses `<name>-edited.html`, chapters 2-4 use `<name>.html`. Hardcoding either
 * one silently reduces the corpus to a quarter of itself, which is how a metric
 * ends up describing six files while claiming to describe the collection.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const DEFAULT_ROOT = "C:\\Users\\mosun\\Downloads\\final lecs";

/** @returns {Array<{name:string, chapter:string, pdf:string, html:string}>} */
export function findPairs(root = DEFAULT_ROOT) {
  if (!fs.existsSync(root)) return [];
  const out = [];

  for (const chapter of fs.readdirSync(root, { withFileTypes: true })) {
    if (!chapter.isDirectory()) continue;
    const done = path.join(root, chapter.name, "done");
    if (!fs.existsSync(done)) continue;

    for (const file of fs.readdirSync(done)) {
      if (!file.toLowerCase().endsWith(".pdf")) continue;
      const name = file.slice(0, -4);
      const html = [`${name}-edited.html`, `${name}.html`]
        .map((h) => path.join(done, h))
        .find((h) => fs.existsSync(h));
      // A PDF with no truth beside it cannot be scored. Skipping it silently
      // would inflate every percentage, so callers are told what was dropped.
      if (!html) continue;
      out.push({ name, chapter: chapter.name, pdf: path.join(done, file), html });
    }
  }
  return out.sort((a, b) => a.chapter.localeCompare(b.chapter) || a.name.localeCompare(b.name));
}

/**
 * Map each PDF page to the HTML slide that is actually its ground truth.
 *
 * Scoring paired page N against slide N assumes the two sequences never diverge.
 * They do: `Chp3-Lec19` has 29 pages against 28 slides because page 7 is a table
 * of contents with no slide behind it, and `Chp2-Lec10` is off by one the same
 * way. Every page after the extra one was then compared with a DIFFERENT slide's
 * text, so 262 of that deck's 264 misses were filed as "no confident match" and
 * it scored 27.1% while extracting correctly. Two decks of 28 mis-scored is
 * enough to move the corpus number.
 *
 * Anchors are taken from three places in the page, not one, so a page that has a
 * real character defect still finds its slide instead of being written off as
 * having no truth — that mistake would silently inflate the score by excluding
 * exactly the pages that score worst.
 *
 * @returns {number[]} slide index per page, or -1 where the page has no truth
 */
/**
 * Share of a page's distinctive words that appear on a slide. Short words are
 * dropped because Arabic function words match everything.
 */
function wordOverlap(page, slide) {
  const a = new Set(page.split(/\s+/).filter((w) => w.length > 3));
  if (!a.size) return 0;
  const b = new Set(slide.split(/\s+/).filter((w) => w.length > 3));
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / a.size;
}

/**
 * Below this a page really is a different page. The two genuine no-truth pages
 * in the corpus (table-of-contents pages absent from the HTML) score 19% and
 * 29%; every wrongly-rejected page scored 89% or above. Nothing lands between.
 */
const MIN_OVERLAP = 0.5;

export function alignPagesToSlides(pageTexts, slideTexts, { lookahead = 3 } = {}) {
  const out = [];
  let next = 0;

  for (const page of pageTexts) {
    const text = page ?? "";
    const anchors = [text.slice(0, 26), text.slice(Math.floor(text.length / 3), Math.floor(text.length / 3) + 26), text.slice(-26)]
      .map((a) => a.trim())
      .filter((a) => a.length >= 12);

    let found = -1;
    for (let s = next; s <= Math.min(next + lookahead, slideTexts.length - 1) && found < 0; s++) {
      if (anchors.some((a) => slideTexts[s].includes(a))) found = s;
    }

    // Anchors are substrings, so a page whose text is damaged near all three
    // sample points matches nothing and looks like it has no truth at all.
    // MEASURED: 9 of 11 pages this rejected had 89-97% word overlap with their
    // real slide — and they were the WORST-extracted pages in the corpus, so
    // dropping them inflated the score from 88.14% to something unearned.
    // Word overlap does not care where the damage is.
    if (found < 0) {
      let best = -1, bestScore = 0;
      for (let s = next; s <= Math.min(next + lookahead, slideTexts.length - 1); s++) {
        const score = wordOverlap(text, slideTexts[s]);
        if (score > bestScore) { bestScore = score; best = s; }
      }
      if (bestScore >= MIN_OVERLAP) found = best;
    }

    out.push(found);
    // An unmatched page does NOT consume a slide — that is the whole point.
    if (found >= 0) next = found + 1;
  }
  return out;
}

/**
 * The truth text for each page, or null where the page has no slide behind it.
 *
 * Exists because every harness in `experiments/` was re-implementing the pairing
 * and several of them got it wrong the same way — `slides[p]` — which is how
 * `Chp3-Lec19` came to be recorded as the worst deck in the corpus at 27.1% when
 * it is the best at 96.8%. Call this instead of indexing `slides`.
 *
 * @param {string[]} pageTexts   normalized text of each PDF page, in order
 * @param {string[]} slides      raw slide texts from loadSlides()
 * @param {(s:string)=>string} normalize
 */
export function truthForPages(pageTexts, slides, normalize) {
  const slideText = slides.map((s) => normalize(s.replace(/\n/g, " ")));
  return alignPagesToSlides(pageTexts, slideText).map((si) => (si < 0 ? null : slideText[si]));
}

/** PDFs in the tree that have no HTML beside them — reported, never ignored. */
export function findUnpaired(root = DEFAULT_ROOT) {
  if (!fs.existsSync(root)) return [];
  const paired = new Set(findPairs(root).map((p) => p.pdf));
  const out = [];
  for (const chapter of fs.readdirSync(root, { withFileTypes: true })) {
    if (!chapter.isDirectory()) continue;
    const done = path.join(root, chapter.name, "done");
    if (!fs.existsSync(done)) continue;
    for (const file of fs.readdirSync(done)) {
      if (file.toLowerCase().endsWith(".pdf") && !paired.has(path.join(done, file))) {
        out.push(path.join(done, file));
      }
    }
  }
  return out;
}
