/** What each variant actually contains, read out of the package. */
import * as fs from "node:fs";
import * as path from "node:path";
import JSZip from "jszip";

const dec = (s) => s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, "&");

export async function measure(file) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const names = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  const out = { file: path.basename(file), paras: [], pPrRtl: 0, rtlEl1: 0, rtlEl0: 0, rPrAttr: 0, runs: 0 };
  for (const n of names) {
    const xml = await zip.file(n).async("string");
    out.rtlEl1 += (xml.match(/<a:rtl val="1"\/>/g) ?? []).length;
    out.rtlEl0 += (xml.match(/<a:rtl val="0"\/>/g) ?? []).length;
    out.rPrAttr += (xml.match(/<a:rPr[^>]*\brtl="/g) ?? []).length;
    for (const p of xml.match(/<a:p>[\s\S]*?<\/a:p>/g) ?? []) {
      const runs = p.match(/<a:r>[\s\S]*?<\/a:r>/g) ?? [];
      if (!runs.length) continue;
      out.runs += runs.length;
      const rtl = /<a:pPr[^>]*\brtl="1"/.test(p);
      if (rtl) out.pPrRtl++;
      out.paras.push({
        rtl,
        text: runs.map((r) => dec((r.match(/<a:t>([\s\S]*?)<\/a:t>/) ?? [, ""])[1])).join(""),
        runs: runs.map((r) => ({
          t: dec((r.match(/<a:t>([\s\S]*?)<\/a:t>/) ?? [, ""])[1]),
          rtlEl: (r.match(/<a:rtl val="([01])"\/>/) ?? [, null])[1],
          lang: (r.match(/lang="([^"]+)"/) ?? [, null])[1],
        })),
      });
    }
  }
  return out;
}

if (process.argv[1] && process.argv[1].endsWith("measure.js")) {
  const dir = path.resolve(".work/rtl-lab");
  const files = process.argv.slice(2).length ? process.argv.slice(2)
    : fs.readdirSync(dir).filter((f) => f.endsWith(".pptx")).sort().map((f) => path.join(dir, f));
  const rows = [];
  for (const f of files) rows.push(await measure(f));
  console.log("\nfile                          paras  pPr rtl=1  runs  a:rtl=1  a:rtl=0  rPr@rtl");
  for (const r of rows)
    console.log(`${r.file.padEnd(30)}${String(r.paras.length).padStart(5)}${String(r.pPrRtl).padStart(10)}` +
      `${String(r.runs).padStart(6)}${String(r.rtlEl1).padStart(9)}${String(r.rtlEl0).padStart(9)}${String(r.rPrAttr).padStart(9)}`);

  const base = rows[0];
  console.log("\ntext round trip vs " + base.file);
  for (const r of rows.slice(1)) {
    const diffs = [];
    for (let i = 0; i < Math.max(base.paras.length, r.paras.length); i++) {
      const a = base.paras[i], b = r.paras[i];
      if (!a || !b) { diffs.push(`[${i}] paragraph count differs`); continue; }
      if (a.text !== b.text) diffs.push(`[${i}] TEXT ${JSON.stringify(a.text)} -> ${JSON.stringify(b.text)}`);
      else if (a.rtl !== b.rtl) diffs.push(`[${i}] pPr rtl ${a.rtl} -> ${b.rtl}  ${JSON.stringify(a.text.slice(0, 34))}`);
      else if (a.runs.length !== b.runs.length) diffs.push(`[${i}] runs ${a.runs.length} -> ${b.runs.length}  ${JSON.stringify(a.text.slice(0, 34))}`);
    }
    console.log(`  ${r.file.padEnd(30)} ${diffs.length ? "" : "identical"}`);
    for (const d of diffs) console.log(`      ${d}`);
  }
}
