/**
 * Image bytes, held beside the model rather than inside it.
 *
 * The model is JSON: it is built here, sent to the browser, edited, and posted
 * back before the writer ever sees it. Megabytes of pixels cannot make that
 * round trip, and a model that carried them would double in size every time the
 * user pressed a key. So an image object carries a REF, the bytes live on disk,
 * and the editor and the writer both resolve the same ref to the same file.
 *
 * The ref is the content hash, which buys deduplication for nothing: a logo
 * repeated on twenty pages is one file here and one media part in the package.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CACHE = path.join(ROOT, ".cache", "images");

const EXT = { png: ".png", jpeg: ".jpg" };
const REF = /^[0-9a-f]{40}\.(png|jpg)$/;

/** Content type for a ref, for anything serving these bytes over HTTP. */
export const mimeForRef = (ref) => (ref.endsWith(".png") ? "image/png" : "image/jpeg");

/**
 * Store decoded bytes and return the ref that names them.
 * @returns {string|null} `<sha1>.<ext>`, or null if there was nothing to store.
 */
export function cacheImage(bytes, format) {
  if (!bytes?.length || !EXT[format]) return null;
  const ref = createHash("sha1").update(bytes).digest("hex") + EXT[format];
  const file = path.join(CACHE, ref);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(CACHE, { recursive: true });
    fs.writeFileSync(file, bytes);
  }
  return ref;
}

/**
 * Resolve a ref to a file on disk, or null.
 *
 * The shape is checked before the path is built, never after: this ref arrives
 * from a request in the server's case, and joining request text onto a path is
 * a directory traversal waiting to happen on a server that browses the user's
 * own disk.
 */
export function imageFile(ref) {
  if (typeof ref !== "string" || !REF.test(ref)) return null;
  const file = path.join(CACHE, ref);
  return fs.existsSync(file) ? file : null;
}
