import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import * as mupdf from "mupdf";
import { VENDOR_ORDER } from "./criteria.js";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

function pageCount(pdf) {
  const doc = mupdf.Document.openDocument(fs.readFileSync(pdf), "application/pdf");
  try { return doc.countPages(); } finally { doc.destroy?.(); }
}

function aspose(input, output, { evaluation = false } = {}) {
  const license = process.env.ASPOSE_PDF_LICENSE || "";
  const pages = pageCount(input);
  if (!license && (!evaluation || pages > 4)) {
    throw new Error(
      `Aspose requires ASPOSE_PDF_LICENSE for ${pages} pages; unlicensed evaluation is explicitly limited to a <=4-page smoke test`);
  }
  const project = path.join(HERE, "aspose-runner", "AsposeRunner.csproj");
  execFileSync("dotnet", ["run", "--project", project, "--configuration", "Release", "--", input, output,
    ...(evaluation ? ["--evaluation-ok"] : [])], {
    encoding: "utf8", timeout: 1800000, windowsHide: true,
    env: { ...process.env, ASPOSE_PDF_LICENSE: license }, maxBuffer: 64 * 1024 * 1024,
  });
}

function external(name, envName, input, output) {
  const executable = process.env[envName];
  if (!executable || !fs.existsSync(executable)) {
    throw new Error(`${name} local SDK adapter is unavailable; set ${envName} to an installed converter executable`);
  }
  execFileSync(executable, [input, output], {
    encoding: "utf8", timeout: 1800000, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  });
}

const ENGINES = {
  aspose,
  apryse: (input, output) => external("Apryse", "APRYSE_PDF_TO_PPTX", input, output),
  foxit: (input, output) => external("Foxit", "FOXIT_PDF_TO_PPTX", input, output),
};

export function convertWithVendor(name, input, output, options = {}) {
  if (!VENDOR_ORDER.includes(name)) throw new Error(`unknown vendor ${name}; expected ${VENDOR_ORDER.join(", ")}`);
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  ENGINES[name](path.resolve(input), path.resolve(output), options);
  if (!fs.existsSync(output) || fs.statSync(output).size === 0) throw new Error(`${name} produced no PPTX bytes`);
  return output;
}

