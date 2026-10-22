/**
 * Ground truth from the source HTML.
 *
 * These lecture decks are one <div class="slide"> per PDF page, so the HTML
 * gives us the exact logical text the PDF was rendered from. That makes every
 * extraction claim measurable instead of eyeballed.
 *
 * This is a text oracle only. The production HTML ingestion path will use
 * Chromium (real layout, computed styles, per-line rects); nothing here is
 * meant to replace that.
 */
import * as fs from "node:fs";

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘",
  ldquo: "“", rdquo: "”", times: "×", divide: "÷", deg: "°",
};

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n] ?? ENTITIES[n.toLowerCase()] ?? m);
}

/** Strip elements that carry no visible text. */
function stripNonContent(html) {
  return html
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
}

/**
 * Extract each top-level <div class="...slide..."> with balanced nesting.
 * A regex cannot match nested divs, so we scan tags and track depth.
 */
export function extractSlides(html) {
  const clean = stripNonContent(html);
  const slides = [];
  const tagRe = /<(\/?)(\w+)([^>]*)>/g;
  let m, depth = 0, start = -1;

  while ((m = tagRe.exec(clean))) {
    const [full, closing, tag, attrs] = m;
    if (tag.toLowerCase() !== "div") continue;

    if (!closing) {
      if (start === -1 && /class\s*=\s*["'][^"']*\bslide\b/i.test(attrs)) {
        start = m.index + full.length;
        depth = 1;
      } else if (start !== -1) depth++;
    } else if (start !== -1) {
      depth--;
      if (depth === 0) {
        slides.push(clean.slice(start, m.index));
        start = -1;
      }
    }
  }
  return slides.map(toText);
}

/**
 * Put the numbers of an ordered list back into the text.
 *
 * `<ol><li>` markers are drawn by the browser from a CSS counter, so they are
 * nowhere in the markup — and they ARE painted into the PDF. Dropping them made
 * the oracle disagree with the page it is supposed to describe: 226 correctly
 * extracted blocks scored as misses purely for carrying the "1." the reader can
 * see, which is 27% of every remaining miss in the corpus.
 *
 * Only `<ol>`. These decks paint no bullet for `<ul>` — 0 of U+2022, U+25AA,
 * U+25CF, U+2023, U+00B7 and U+25E6 appear anywhere in the extracted text of a
 * deck full of unordered lists, while 21 lines begin with "N." — so inventing
 * one would be the mirror of the bug being fixed.
 */
function numberOrderedLists(html) {
  const stack = [];
  let out = "", last = 0;

  for (const m of html.matchAll(/<(\/?)(ol|ul|li)\b[^>]*>/gi)) {
    const [tag, closing, name] = [m[0], m[1], m[2].toLowerCase()];
    if (name === "li") {
      if (closing || stack[stack.length - 1]?.type !== "ol") continue;
      const top = stack[stack.length - 1];
      out += html.slice(last, m.index + tag.length) + `${++top.n}. `;
      last = m.index + tag.length;
      continue;
    }
    if (closing) stack.pop();
    else stack.push({ type: name, n: 0 });
  }
  return out + html.slice(last);
}

/** Visible text of one slide, with block-level tags becoming line breaks. */
function toText(fragment) {
  fragment = numberOrderedLists(fragment);
  // Block-level boundaries become line breaks; INLINE tags vanish entirely.
  // Replacing every tag with a space is wrong and inflates the diff: a browser
  // renders "<b>a</b><i>b</i>" as "ab", not "a b", so tag-as-space invents word
  // boundaries the source never had and makes correct extractions look broken.
  const withBreaks = fragment
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|li|h[1-6]|tr|td|th|section|header|footer|table|tbody|thead|ul|ol)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "");

  return decodeEntities(withBreaks)
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

export const loadSlides = (file) =>
  extractSlides(fs.readFileSync(file, "utf8"));

/**
 * Comparison normalisation. Deliberately conservative: it collapses whitespace
 * and unifies Unicode composition, and does NOT touch character identity,
 * digits, brackets or direction — those are exactly the failures we measure.
 */
export function normalize(s) {
  return s
    .normalize("NFC")
    .replace(/[​-‏‪-‮⁦-⁩]/g, "") // zero-width + bidi controls
    .replace(/\s+/g, " ")
    .trim();
}
