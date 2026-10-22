import { findFace, readFsType } from "./webfonts.js";

const EDITABLE_SAFE_MAP = Object.freeze({
  "Diodrum Arabic": "Cairo",
  "Lyon Arabic Text LF": "Cairo",
  "Lyon Arabic Text LF Bold": "Cairo",
});

export { EDITABLE_SAFE_MAP };

/**
 * May this font be embedded into a document the reader can EDIT?
 *
 * Per OpenType 1.9.1, OS/2 §fsType, `fsType` is not one enum — it is a
 * permissions SUB-FIELD plus independent restriction bits:
 *
 *   bits 0-3  0x000F  usage permissions, valid values 0, 2, 4 or 8
 *                     0 installable · 2 restricted · 4 preview & print · 8 editable
 *   bit  8    0x0100  no subsetting
 *   bit  9    0x0200  bitmap embedding only
 *
 * Comparing the whole uint16 for equality — which this did until 2026-08-25 —
 * silently reclassifies any font that also sets bit 8 or bit 9 as restricted.
 * No font installed here sets either, so it was latent; a foreign document is
 * exactly where this project keeps finding that kind of hole.
 *
 * The two restriction bits are refusals for US specifically, and the reason is
 * our embedder: PowerPoint's SaveAs is what produces the blobs, and it SUBSETS
 * (see src/pptx/embed.js). So a font that forbids subsetting is one we cannot
 * embed by the only means we have. Bitmap-only is refused because everything in
 * this corpus is outline data, and the spec says a font with no bitmaps and bit
 * 9 set "is considered unembeddable".
 *
 * Spec wording for 4, quoted because it is the whole reason this module exists:
 * "the font may be embedded, and may be temporarily loaded on other systems for
 * purposes of viewing or printing the document. Documents containing Preview &
 * Print fonts must be opened 'read-only'; no edits may be applied."
 *
 * KNOWN LIMIT: for OS/2 versions 0-2 the bits were NOT required to be mutually
 * exclusive and the least-restrictive one wins; versions 3+ require exactly one.
 * `readFsType` does not report the table version, so a version 0-2 font setting
 * both 4 and 8 is read here as neither and refused. Conservative, and it costs a
 * substitution rather than an unreadable deck.
 */
export function isEditableEmbeddable(fsType) {
  if (fsType === null || fsType === undefined) return true;
  if (fsType & 0x0200) return false;   // bitmap-only: we have outlines to embed
  if (fsType & 0x0100) return false;   // no subsetting, and our embedder subsets
  const permissions = fsType & 0x000F;
  return permissions === 0x0000 || permissions === 0x0008;
}

const licenseCache = new Map();

export function getFontLicense(family) {
  if (licenseCache.has(family)) return licenseCache.get(family);

  const face = findFace(family);
  let fsType = null;
  let editable = true;
  let substitute = null;

  if (face) {
    fsType = face.fsType ?? null;
    editable = isEditableEmbeddable(fsType);
    if (!editable) {
      substitute = EDITABLE_SAFE_MAP[family] || EDITABLE_SAFE_MAP[face.family] || null;
    }
  }

  const result = { fsType, editable, substitute };
  licenseCache.set(family, result);
  return result;
}
