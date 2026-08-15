"""Embed the data-URL theme fonts actually used by a measured PPTX scene.

PowerPoint's embedded-font schema is unusually order-sensitive.  Keep all
OOXML edits in this one module so the renderer never has to hand-build XML.
"""

from __future__ import annotations

import base64
import re
import zipfile
from pathlib import Path
from tempfile import NamedTemporaryFile

from lxml import etree

from fontprep import prepare


CONTENT_TYPES_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
PACKAGE_RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
PRESENTATION_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
DOCUMENT_RELS_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
FONT_REL_TYPE = DOCUMENT_RELS_NS + "/font"
FNTDATA_CONTENT_TYPE = "application/x-fontdata"
NS = {"ct": CONTENT_TYPES_NS, "pr": PACKAGE_RELS_NS, "p": PRESENTATION_NS, "r": DOCUMENT_RELS_NS}


def _q(namespace, local):
    return "{%s}%s" % (namespace, local)


def _normalise(value):
    return " ".join(str(value or "").strip().strip("'\"").split()).casefold()


def _font_weight(value):
    try:
        return int(float(str(value or "400").split()[0]))
    except Exception:
        return 400


def _font_slot(weight, style, intrinsic_weight=False):
    """Return the only legal embedded-font slot for a PowerPoint run face."""
    if intrinsic_weight:
        # Lyon's Office face name already identifies Bold/Semibold/etc. The
        # renderer deliberately does not set a synthetic bold flag for it, so
        # this physical face must sit in a regular slot under its own typeface.
        return "regular"
    bold = _font_weight(weight) >= 600
    italic = str(style or "").strip().lower() in ("italic", "oblique")
    if bold and italic:
        return "boldItalic"
    if bold:
        return "bold"
    if italic:
        return "italic"
    return "regular"


def _css_value(body, name):
    match = re.search(r"(?:^|;)\s*%s\s*:\s*([^;]+)" % re.escape(name), body, re.IGNORECASE)
    return match.group(1).strip() if match else ""


def extract_fonts_from_theme(theme_css):
    """Extract self-contained @font-face entries without fetching anything."""
    fonts = []
    for match in re.finditer(r"@font-face\s*\{(?P<body>[^}]*)\}", str(theme_css or ""), re.IGNORECASE | re.DOTALL):
        body = match.group("body")
        family = _css_value(body, "font-family").strip().strip("'\"")
        source = re.search(r"url\(\s*data:([^;,\s]+);base64,\s*([^)\s]+)\s*\)", body, re.IGNORECASE | re.DOTALL)
        if not family or not source:
            continue
        try:
            raw = base64.b64decode(re.sub(r"\s+", "", source.group(2)), validate=True)
        except Exception:
            continue
        fonts.append({
            "family": family,
            "weight": _font_weight(_css_value(body, "font-weight")),
            "style": (_css_value(body, "font-style") or "normal").strip().lower(),
            "unicodeRange": _css_value(body, "unicode-range"),
            "mime": source.group(1).strip().lower(),
            "bytes": raw,
        })
    return fonts


def _required_faces(required_fonts):
    """Normalise scene descriptors to the exact faces PowerPoint will request."""
    faces = []
    seen = set()
    for descriptor in required_fonts or []:
        if isinstance(descriptor, str):
            descriptor = {"family": descriptor}
        if not isinstance(descriptor, dict):
            continue
        typeface = (
            descriptor.get("powerPointFontFamily")
            or descriptor.get("family")
            or descriptor.get("resolvedFontFamily")
            or descriptor.get("fontFamily")
            or descriptor.get("browserFamily")
            or ""
        ).strip()
        if not typeface:
            continue
        weight = descriptor.get("weight", descriptor.get("fontWeight", 400))
        style = descriptor.get("style", descriptor.get("fontStyle", "normal"))
        intrinsic = descriptor.get("powerPointFaceHasIntrinsicWeight") is True
        slot = _font_slot(weight, style, intrinsic)
        key = (_normalise(typeface), slot)
        if key in seen:
            continue
        seen.add(key)
        aliases = {
            _normalise(value)
            for value in (
                typeface,
                descriptor.get("family"),
                descriptor.get("browserFamily"),
                descriptor.get("resolvedFontFamily"),
                descriptor.get("fontFamily"),
                descriptor.get("powerPointFontFamily"),
            )
            if _normalise(value)
        }
        faces.append({
            "typeface": typeface,
            "slot": slot,
            "aliases": aliases,
        })
    return faces


def _match_score(source, prepared, face):
    """Prefer actual internal face-name matches over an author-supplied alias."""
    exact = _normalise(face["typeface"])
    source_family = _normalise(source.get("family"))
    internal_family = _normalise(prepared.get("family"))
    if internal_family == exact:
        return 100
    if source_family == exact:
        return 90
    if source_family in face["aliases"]:
        return 80
    if internal_family in face["aliases"]:
        return 70
    return 0


def select_theme_fonts(theme_css, required_fonts):
    """Prepare only the theme bytes that can satisfy an actual PPTX run.

    A web-font ``unicode-range`` shard cannot make a whole PowerPoint face
    travel.  Rather than quietly claim it does, skip it and report the reason.
    """
    required = _required_faces(required_fonts)
    selected = {}
    skipped = []
    for source in extract_fonts_from_theme(theme_css):
        prepared = prepare(source["bytes"], source["mime"])
        for face in required:
            score = _match_score(source, prepared, face)
            if not score:
                continue
            target = (face["typeface"], face["slot"])
            if prepared.get("skipped_reason"):
                skipped.append({
                    "typeface": face["typeface"],
                    "slot": face["slot"],
                    "sourceFamily": source["family"],
                    "fsType": prepared.get("fsType", 0),
                    "reason": prepared["skipped_reason"],
                })
                continue
            if source.get("unicodeRange"):
                skipped.append({
                    "typeface": face["typeface"],
                    "slot": face["slot"],
                    "sourceFamily": source["family"],
                    "fsType": prepared.get("fsType", 0),
                    "reason": "unicode-range shard cannot embed a complete PowerPoint face",
                })
                continue
            previous = selected.get(target)
            if previous and previous["score"] >= score:
                continue
            selected[target] = {
                "typeface": face["typeface"],
                "slot": face["slot"],
                "bytes": prepared["ttf_bytes"],
                "sourceFamily": source["family"],
                "preparedFamily": prepared.get("family") or "",
                "preparedSubfamily": prepared.get("subfamily") or "",
                "fsType": prepared.get("fsType", 0),
                "score": score,
            }
    return list(selected.values()), skipped


def _next_relationship_id(root):
    used = {entry.get("Id") for entry in root.findall(_q(PACKAGE_RELS_NS, "Relationship"))}
    index = 1
    while "rId%d" % index in used:
        index += 1
    return "rId%d" % index


def _next_font_number(names):
    numbers = []
    for name in names:
        match = re.fullmatch(r"ppt/fonts/font(\d+)\.fntdata", name)
        if match:
            numbers.append(int(match.group(1)))
    return max(numbers, default=0) + 1


def _append_font_content_type(root):
    for entry in root.findall(_q(CONTENT_TYPES_NS, "Default")):
        if entry.get("Extension", "").lower() == "fntdata":
            return
    entry = etree.Element(_q(CONTENT_TYPES_NS, "Default"), Extension="fntdata", ContentType=FNTDATA_CONTENT_TYPE)
    # [Content_Types] is schema-ordered: all Defaults precede every Override.
    first_override = next((index for index, child in enumerate(root) if child.tag == _q(CONTENT_TYPES_NS, "Override")), len(root))
    root.insert(first_override, entry)


def _replace_presentation_font_list(root, grouped):
    existing = root.find(_q(PRESENTATION_NS, "embeddedFontLst"))
    if existing is not None:
        raise ValueError("candidate already contains an embeddedFontLst")
    notes_size = root.find(_q(PRESENTATION_NS, "notesSz"))
    if notes_size is None:
        raise ValueError("presentation.xml has no p:notesSz insertion anchor")

    root.set("embedTrueTypeFonts", "1")
    font_list = etree.Element(_q(PRESENTATION_NS, "embeddedFontLst"))
    for typeface, slots in grouped.items():
        embedded = etree.SubElement(font_list, _q(PRESENTATION_NS, "embeddedFont"))
        etree.SubElement(embedded, _q(PRESENTATION_NS, "font"), typeface=typeface)
        for slot in ("regular", "bold", "italic", "boldItalic"):
            part = slots.get(slot)
            if part:
                etree.SubElement(embedded, _q(PRESENTATION_NS, slot), **{_q(DOCUMENT_RELS_NS, "id"): part["rId"]})
    root.insert(root.index(notes_size) + 1, font_list)


def embed_fonts(pptx_path, fonts):
    """Write prepared TrueType bytes into ECMA-376 embedded-font parts."""
    if not fonts:
        return {"embedded": []}
    pptx_path = Path(pptx_path)
    temp_path = None
    embedded = []
    try:
        with zipfile.ZipFile(pptx_path, "r") as zin:
            names = zin.namelist()
            content_types = etree.fromstring(zin.read("[Content_Types].xml"))
            presentation_rels = etree.fromstring(zin.read("ppt/_rels/presentation.xml.rels"))
            presentation = etree.fromstring(zin.read("ppt/presentation.xml"))
            _append_font_content_type(content_types)

            next_font_number = _next_font_number(names)
            grouped = {}
            font_parts = {}
            for font in fonts:
                typeface = font["typeface"]
                slot = font["slot"]
                r_id = _next_relationship_id(presentation_rels)
                part_name = "ppt/fonts/font%d.fntdata" % next_font_number
                next_font_number += 1
                presentation_rels.append(etree.Element(
                    _q(PACKAGE_RELS_NS, "Relationship"),
                    Id=r_id,
                    Type=FONT_REL_TYPE,
                    Target="fonts/" + Path(part_name).name,
                ))
                grouped.setdefault(typeface, {})[slot] = {"rId": r_id, "part": part_name}
                font_parts[part_name] = font["bytes"]
                embedded.append({
                    "typeface": typeface,
                    "slot": slot,
                    "relationshipId": r_id,
                    "part": part_name,
                    "bytes": len(font["bytes"]),
                    "sourceFamily": font.get("sourceFamily") or "",
                    "preparedFamily": font.get("preparedFamily") or "",
                    "fsType": font.get("fsType", 0),
                })
            _replace_presentation_font_list(presentation, grouped)

            with NamedTemporaryFile(prefix="lve-font-embed-", suffix=".pptx", delete=False, dir=str(pptx_path.parent)) as temp_file:
                temp_path = Path(temp_file.name)
            with zipfile.ZipFile(temp_path, "w", zipfile.ZIP_DEFLATED) as zout:
                for name in names:
                    if name == "[Content_Types].xml":
                        zout.writestr(name, etree.tostring(content_types, xml_declaration=True, encoding="UTF-8", standalone=True))
                    elif name == "ppt/_rels/presentation.xml.rels":
                        zout.writestr(name, etree.tostring(presentation_rels, xml_declaration=True, encoding="UTF-8", standalone=True))
                    elif name == "ppt/presentation.xml":
                        zout.writestr(name, etree.tostring(presentation, xml_declaration=True, encoding="UTF-8", standalone=True))
                    else:
                        zout.writestr(name, zin.read(name))
                for name, data in font_parts.items():
                    zout.writestr(name, data)
        # Windows keeps the input package locked until the reader closes.
        # Replace only after leaving the ZipFile context above.
        temp_path.replace(pptx_path)
    finally:
        if temp_path is not None:
            try:
                temp_path.unlink(missing_ok=True)
            except Exception:
                pass
    return {"embedded": embedded}


def embed_theme_fonts(pptx_path, theme_css, required_fonts):
    """Select, prepare, embed, and describe only the deck's used font faces."""
    fonts, skipped = select_theme_fonts(theme_css, required_fonts)
    result = embed_fonts(pptx_path, fonts)
    result["skipped"] = skipped
    result["requested"] = [
        {"typeface": face["typeface"], "slot": face["slot"]}
        for face in _required_faces(required_fonts)
    ]
    return result
