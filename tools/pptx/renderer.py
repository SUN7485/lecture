import json
import sys
import re
import os
import tempfile
import base64
import shutil
from lxml import etree

from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR, MSO_AUTO_SIZE
from pptx.enum.shapes import MSO_SHAPE

from rtl import set_rtl


# Slide dimensions: 950x650 px at 96 DPI
SLIDE_WIDTH_PX = 950
SLIDE_HEIGHT_PX = 650
SLIDE_WIDTH_IN = SLIDE_WIDTH_PX / 96
SLIDE_HEIGHT_IN = SLIDE_HEIGHT_PX / 96

# Margins (matching CSS: padding 45px 60px 110px 60px)
MARGIN_LEFT_PX = 60
MARGIN_TOP_PX = 45
MARGIN_BOTTOM_PX = 110
MARGIN_RIGHT_PX = 60

CONTENT_WIDTH_PX = SLIDE_WIDTH_PX - MARGIN_LEFT_PX - MARGIN_RIGHT_PX
CONTENT_HEIGHT_PX = SLIDE_HEIGHT_PX - MARGIN_TOP_PX - MARGIN_BOTTOM_PX


def px_to_emu(px):
    return Emu(int(px * 9525))


def hex_to_rgb(hex_str):
    hex_str = hex_str.lstrip('#')
    if len(hex_str) == 3:
        hex_str = ''.join([c * 2 for c in hex_str])
    r = int(hex_str[0:2], 16)
    g = int(hex_str[2:4], 16)
    b = int(hex_str[4:6], 16)
    return RGBColor(r, g, b)


GENERIC_FAMILIES = {'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy',
                    'system-ui', 'inherit', 'initial', 'unset', 'revert'}


def norm_family(name, default):
    """Normalise a CSS font-family name for use as a PPTX font name, ignoring
    generic/system families that say nothing useful to PowerPoint."""
    name = (name or '').strip().strip('"\'').strip()
    if not name or name.lower() in GENERIC_FAMILIES:
        return default
    return name[:60]


SCENE_SCHEMA_VERSION = 2
# DrawingML main namespace, for the raw lxml edits python-pptx does not wrap
# (gradient fills). python-pptx already depends on lxml.
A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main'


def scene_rgb(value, fallback='#000000'):
    """Return RGBColor for browser-resolved rgb()/rgba()/hex colors."""
    raw = (value or fallback).strip()
    if raw in ('transparent', 'rgba(0, 0, 0, 0)'):
        return None
    if raw.startswith('#'):
        try:
            return hex_to_rgb(raw)
        except Exception:
            return hex_to_rgb(fallback)
    m = re.match(r'rgba?\(\s*([\d.]+)[,\s]+\s*([\d.]+)[,\s]+\s*([\d.]+)', raw, re.I)
    if m:
        return RGBColor(int(float(m.group(1))), int(float(m.group(2))), int(float(m.group(3))))
    return hex_to_rgb(fallback)


def scene_hex6(value, fallback='#000000'):
    """RRGGBB string for the gradient stop colors the browser resolved."""
    color = scene_rgb(value, fallback)
    if color is None:
        color = scene_rgb(fallback, fallback)
    return str(color)


def scene_set_gradient(shape, gradient):
    """Replace a shape's solid fill with a native DrawingML gradient.

    The solid fill is created first so DrawingML's strict child order puts the
    fill element in a schema-valid position; the gradient then takes its place.
    """
    stops = gradient.get('stops') or []
    if len(stops) < 2:
        return
    shape.fill.solid()
    sp_pr = shape._element.spPr
    solid = sp_pr.find('{%s}solidFill' % A_NS)
    if solid is None:
        return
    grad = sp_pr.makeelement('{%s}gradFill' % A_NS, {})
    gs_lst = etree.SubElement(grad, '{%s}gsLst' % A_NS)
    for stop in stops:
        gs = etree.SubElement(gs_lst, '{%s}gs' % A_NS)
        gs.set('pos', str(int(round(float(stop.get('pos') or 0) * 100000))))
        clr = etree.SubElement(gs, '{%s}srgbClr' % A_NS)
        clr.set('val', scene_hex6(stop.get('color')))
    lin = etree.SubElement(grad, '{%s}lin' % A_NS)
    # CSS measures 0deg pointing up and turns clockwise; DrawingML measures
    # 0 pointing right and turns clockwise, in 60000ths of a degree.
    dml_deg = (float(gradient.get('cssAngle', 180)) - 90.0) % 360.0
    lin.set('ang', str(int(round(dml_deg * 60000))))
    lin.set('scaled', '1')
    solid.addnext(grad)
    sp_pr.remove(solid)


def is_scene_transparent(value):
    return not value or value == 'transparent' or bool(re.match(r'rgba\([^,]+,[^,]+,[^,]+,\s*0(?:\.0+)?\)', str(value), re.I))


def scene_box(node):
    box = node.get('bounds') or {}
    return (float(box.get('x', 0)), float(box.get('y', 0)),
            max(0.1, float(box.get('w', 1))), max(0.1, float(box.get('h', 1))))


def scene_set_fill(shape, raw):
    if is_scene_transparent(raw):
        shape.fill.background()
        return
    shape.fill.solid()
    shape.fill.fore_color.rgb = scene_rgb(raw, '#FFFFFF')


def scene_remove_text_body(shape):
    """Keep decorative shapes editable without emitting an empty text paragraph.

    python-pptx gives every AutoShape a p:txBody/a:p by default.  For a slide
    background, border bar, or divider that is not text-bearing, that becomes
    a spurious blank paragraph in the editable PPTX XML.  Remove only the text
    body; the p:sp remains a fully native, editable shape.
    """
    try:
        from pptx.oxml.ns import qn
        text_body = shape._element.find(qn('p:txBody'))
        if text_body is not None:
            shape._element.remove(text_body)
    except Exception:
        pass
    return shape


def scene_set_line(line, edge):
    width = float((edge or {}).get('width') or 0)
    style = (edge or {}).get('style') or 'none'
    if width <= 0 or style == 'none':
        line.fill.background()
        return
    line.color.rgb = scene_rgb((edge or {}).get('color'), '#000000')
    line.width = px_to_emu(width)
    # python-pptx exposes the common dash values. A CSS dashed/dotted edge is
    # still a native line, rather than a flattened bitmap approximation.
    try:
        from pptx.enum.dml import MSO_LINE_DASH_STYLE
        if style == 'dashed':
            line.dash_style = MSO_LINE_DASH_STYLE.DASH
        elif style == 'dotted':
            line.dash_style = MSO_LINE_DASH_STYLE.ROUND_DOT
    except Exception:
        pass


def scene_add_shadow(shape, shadow):
    """Attach one native a:outerShdw effect to a shape, if requested."""
    if not shadow:
        return
    try:
        from pptx.oxml.xmlchemy import OxmlElement
        from pptx.oxml.ns import qn
        import math
        x = float(shadow.get('x') or 0)
        y = float(shadow.get('y') or 0)
        blur = max(0, float(shadow.get('blur') or 0))
        distance = int(round(math.hypot(x, y) * 9525))
        angle = int(round((math.degrees(math.atan2(y, x)) % 360) * 60000))
        sp_pr = shape._element.spPr
        effect_list = sp_pr.find(qn('a:effectLst'))
        if effect_list is None:
            effect_list = OxmlElement('a:effectLst')
            sp_pr.append(effect_list)
        outer = OxmlElement('a:outerShdw')
        outer.set('blurRad', str(int(round(blur * 9525))))
        outer.set('dist', str(distance))
        outer.set('dir', str(angle))
        color = OxmlElement('a:srgbClr')
        rgb = scene_rgb(shadow.get('color'), '#000000')
        color.set('val', ''.join(f'{v:02X}' for v in rgb))
        # Browser CSS shadows on the fixture are intentionally subtle.
        alpha = OxmlElement('a:alpha')
        alpha.set('val', '25000')
        color.append(alpha)
        outer.append(color)
        effect_list.append(outer)
    except Exception:
        # The object remains editable even when an Office XML variant rejects
        # the optional shadow effect; fidelity verification will decide whether
        # that visual discrepancy is acceptable.
        return


def scene_alignment(value, direction):
    value = (value or '').lower()
    if value in ('center', 'centre'):
        return PP_ALIGN.CENTER
    if value == 'justify':
        return PP_ALIGN.JUSTIFY
    if value in ('left', 'start'):
        return PP_ALIGN.LEFT if direction != 'rtl' else PP_ALIGN.RIGHT
    if value in ('right', 'end'):
        return PP_ALIGN.RIGHT if direction != 'rtl' else PP_ALIGN.LEFT
    return PP_ALIGN.RIGHT if direction == 'rtl' else PP_ALIGN.LEFT


def scene_run_font(run, run_style, fallback_style):
    style = dict(fallback_style or {})
    style.update(run_style or {})
    # Chromium may report an alias/fallback stack rather than the exact face
    # name desktop PowerPoint resolves.  The scene extractor can carry a
    # preflight-verified Office face separately; it must win for both normal
    # text frames and browser-measured per-line textboxes.
    family = norm_family(style.get('powerPointFontFamily') or style.get('fontFamily'), 'Arial')
    run.font.name = family
    size = float(style.get('fontSize') or 16) * 0.75
    run.font.size = Pt(max(1, size))
    weight = str(style.get('fontWeight') or '400').lower()
    if style.get('powerPointFaceHasIntrinsicWeight') is True:
        # The selected Office family name is already a physical Bold,
        # Semibold, or Black face (not a variable family). Asking PowerPoint
        # to bold it again synthesizes a heavier, wider glyph than Chromium's
        # bundled @font-face bytes.
        run.font.bold = False
    else:
        try:
            run.font.bold = weight == 'bold' or float(weight) >= 600
        except Exception:
            run.font.bold = weight == 'bold'
    run.font.italic = str(style.get('fontStyle') or '').lower() in ('italic', 'oblique')
    run.font.underline = str(style.get('textDecoration') or '').lower().find('underline') >= 0
    rgb = scene_rgb(style.get('color'), '#000000')
    if rgb is not None:
        run.font.color.rgb = rgb
    # PowerPoint resolves Arabic through the complex-script (`a:cs`) face, not
    # merely the Latin face python-pptx writes for ``run.font.name``. The old
    # code put ``latin``/``ea``/``cs`` in attributes on ``a:rPr``; those are
    # not DrawingML font records and Office could silently substitute Arabic
    # glyphs. Write the three actual child elements so native Office rendering
    # uses the same preflighted family for every script.
    try:
        rpr = run._r.get_or_add_rPr()
        # DrawingML character spacing is in hundredths of a point. Browser
        # letter-spacing is captured in CSS px (96 dpi), so preserve it rather
        # than relying on PowerPoint's default glyph spacing.
        try:
            letter_spacing = float(style.get('letterSpacing') or 0)
            if letter_spacing:
                rpr.set('spc', str(int(round(letter_spacing * 0.75 * 100))))
        except (TypeError, ValueError):
            pass
        from pptx.oxml.xmlchemy import OxmlElement
        from pptx.oxml.ns import qn
        for tag in ('a:latin', 'a:ea', 'a:cs'):
            face = rpr.find(qn(tag))
            if face is None:
                face = OxmlElement(tag)
                rpr.append(face)
            face.set('typeface', family)
    except Exception:
        pass


def scene_set_bullet(paragraph, ordered=False):
    try:
        from pptx.oxml.xmlchemy import OxmlElement
        ppr = paragraph._p.get_or_add_pPr()
        bullet = OxmlElement('a:buAutoNum' if ordered else 'a:buChar')
        if ordered:
            bullet.set('type', 'arabicPeriod')
        else:
            bullet.set('char', '•')
        ppr.append(bullet)
    except Exception:
        pass


def scene_write_runs(text_frame, runs, node_style, list_item=False, ordered=False, split_paragraphs=True):
    text_frame.clear()
    text_frame.word_wrap = True
    padding = (node_style or {}).get('padding') or {}
    text_frame.margin_left = px_to_emu(float(padding.get('left') or 0))
    text_frame.margin_right = px_to_emu(float(padding.get('right') or 0))
    text_frame.margin_top = px_to_emu(float(padding.get('top') or 0))
    text_frame.margin_bottom = px_to_emu(float(padding.get('bottom') or 0))
    vertical = (node_style or {}).get('verticalAlign') or ''
    if vertical in ('middle', 'center'):
        text_frame.vertical_anchor = MSO_ANCHOR.MIDDLE
    elif vertical in ('bottom', 'text-bottom'):
        text_frame.vertical_anchor = MSO_ANCHOR.BOTTOM
    else:
        text_frame.vertical_anchor = MSO_ANCHOR.TOP
    direction = (node_style or {}).get('direction') or 'ltr'
    align = scene_alignment((node_style or {}).get('textAlign'), direction)
    paragraphs = [text_frame.paragraphs[0]]
    current = paragraphs[0]
    current.alignment = align
    if direction == 'rtl':
        set_rtl(current)
    if list_item:
        scene_set_bullet(current, ordered)
    if not runs:
        runs = [{'text': '', 'style': {}}]
    for source_run in runs:
        source_text = str(source_run.get('text') or '')
        # A browser-measured text line must remain exactly one editable
        # PowerPoint paragraph.  Any unexpected newline is layout whitespace
        # inside that line, not permission to create a reflowing second line.
        parts = source_text.split('\n') if split_paragraphs else [source_text.replace('\r', ' ').replace('\n', ' ')]
        for part_index, text in enumerate(parts):
            if part_index:
                current = text_frame.add_paragraph()
                current.alignment = align
                if direction == 'rtl':
                    set_rtl(current)
                if list_item:
                    scene_set_bullet(current, ordered)
            run = current.add_run()
            run.text = text
            scene_run_font(run, source_run.get('style') or {}, node_style)
    try:
        line_height = float((node_style or {}).get('lineHeight') or 0)
        if line_height > 0:
            for paragraph in text_frame.paragraphs:
                paragraph.line_spacing = Pt(line_height * 0.75)
    except Exception:
        pass


def scene_add_shape(slide, node, keep_text_body=False):
    x, y, w, h = scene_box(node)
    style = node.get('style') or {}
    radius = max(style.get('borderRadius') or [0])
    shape_type = MSO_SHAPE.ROUNDED_RECTANGLE if radius > 0 else MSO_SHAPE.RECTANGLE
    shape = slide.shapes.add_shape(shape_type, px_to_emu(x), px_to_emu(y), px_to_emu(w), px_to_emu(h))
    gradient = style.get('gradient')
    if gradient:
        scene_set_gradient(shape, gradient)
    else:
        scene_set_fill(shape, style.get('fill'))
    # PowerPoint's shape line is necessarily uniform. For unequal CSS edges,
    # leave the shape line off and emit native per-edge rectangles below;
    # otherwise a dominant right/left border would leak onto top/bottom.
    edges = (style.get('border') or {})
    signatures = {(edge.get('width'), edge.get('style'), edge.get('color')) for edge in edges.values()}
    if len(signatures) <= 1:
        dominant = max(edges.values(), key=lambda edge: float(edge.get('width') or 0), default={})
        scene_set_line(shape.line, dominant)
    else:
        shape.line.fill.background()
    shadows = style.get('shadow') or []
    if shadows:
        scene_add_shadow(shape, shadows[0])
    if not keep_text_body:
        scene_remove_text_body(shape)
    return shape


def scene_add_border_edges(slide, node):
    style = node.get('style') or {}
    edges = style.get('border') or {}
    x, y, w, h = scene_box(node)
    # A rectangle supports one uniform border. Overlay native skinny rectangles
    # when the browser resolved different colors/widths for individual sides.
    distinct = {(edge.get('width'), edge.get('style'), edge.get('color')) for edge in edges.values()}
    if len(distinct) <= 1:
        return
    positions = {
        'top': (x, y, w, lambda e: float(e.get('width') or 0)),
        'bottom': (x, y + h - float(edges.get('bottom', {}).get('width') or 0), w, lambda e: float(e.get('width') or 0)),
        'left': (x, y, lambda e: float(e.get('width') or 0), h),
        'right': (x + w - float(edges.get('right', {}).get('width') or 0), y, lambda e: float(e.get('width') or 0), h)
    }
    for side, edge in edges.items():
        if float(edge.get('width') or 0) <= 0 or edge.get('style') == 'none':
            continue
        px_x, px_y, px_w, px_h = positions[side]
        if callable(px_w): px_w = px_w(edge)
        if callable(px_h): px_h = px_h(edge)
        bar = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, px_to_emu(px_x), px_to_emu(px_y), px_to_emu(px_w), px_to_emu(px_h))
        scene_set_fill(bar, edge.get('color'))
        bar.line.fill.background()
        scene_remove_text_body(bar)


def scene_text_lines(node):
    """Return validated browser-measured lines, or None for legacy fallback.

    Expected shape (all coordinates are slide-relative CSS pixels):
      textLines: [{bounds:{x,y,w,h}, text?, runs?, style?, coordinateSpace?}]

    `coordinateSpace: "node"` (or `relative: true`) is also accepted for
    callers that intentionally store local line rectangles.  We reject the
    entire optional feature when one line is malformed or its assembled text
    does not describe the node text; partial line emission would silently lose
    editable content and is worse than the established whole-node fallback.
    """
    raw_lines = node.get('textLines')
    if not isinstance(raw_lines, list) or not raw_lines:
        return None
    node_style = node.get('style') or {}
    if not isinstance(node_style, dict):
        return None
    node_x, node_y, _, _ = scene_box(node)
    prepared = []

    def number(value):
        try:
            result = float(value)
            return result if result == result and abs(result) != float('inf') else None
        except (TypeError, ValueError):
            return None

    for raw_line in raw_lines:
        if not isinstance(raw_line, dict):
            return None
        box = raw_line.get('bounds') or raw_line.get('box') or raw_line.get('rect') or raw_line.get('geometry') or raw_line
        if not isinstance(box, dict):
            return None

        def first_number(*names):
            for name in names:
                if name in box:
                    value = number(box.get(name))
                    if value is not None:
                        return value
            return None

        x = first_number('x', 'left')
        y = first_number('y', 'top')
        w = first_number('w', 'width')
        h = first_number('h', 'height')
        if w is None and x is not None and number(box.get('right')) is not None:
            w = number(box.get('right')) - x
        if h is None and y is not None and number(box.get('bottom')) is not None:
            h = number(box.get('bottom')) - y
        if x is None or y is None or w is None or h is None or w <= 0 or h <= 0:
            return None
        coordinate_space = str(raw_line.get('coordinateSpace') or node.get('textLineCoordinateSpace') or '').lower()
        if raw_line.get('relative') or coordinate_space in ('node', 'local', 'element'):
            x += node_x
            y += node_y

        runs = raw_line.get('runs')
        if runs is None:
            if raw_line.get('text') is None:
                return None
            runs = [{'text': raw_line.get('text'), 'style': raw_line.get('style') or {}}]
        if not isinstance(runs, list):
            return None
        clean_runs = []
        for run in runs:
            if not isinstance(run, dict):
                return None
            text = str(run.get('text') or '').replace('\r', ' ').replace('\n', ' ')
            # Preserve a meaningful inline separator, but do not manufacture a
            # completely blank native text box for an empty measured line.
            if text:
                run_style = run.get('style') or {}
                if not isinstance(run_style, dict):
                    return None
                clean_runs.append({'text': text, 'style': run_style})
        if not ''.join(run.get('text') or '' for run in clean_runs).strip():
            continue
        line_style = raw_line.get('style') or {}
        if not isinstance(line_style, dict):
            return None
        style = dict(node_style)
        style.update(line_style)
        # Range/client-rect geometry describes the line itself, not the parent
        # element's padding box. Re-applying parent padding would offset every
        # measured textbox before PowerPoint gets a chance to render it.
        style['padding'] = {'top': 0, 'right': 0, 'bottom': 0, 'left': 0}
        style['verticalAlign'] = 'top'
        prepared.append({'bounds': (x, y, w, h), 'runs': clean_runs, 'style': style})

    if not prepared:
        return None

    expected = re.sub(r'\s+', ' ', str(node.get('text') or '')).strip()
    actual = re.sub(r'\s+', ' ', ' '.join(
        ''.join(run.get('text') or '' for run in line['runs']) for line in prepared
    )).strip()
    if expected and actual != expected:
        return None
    return prepared


def scene_add_measured_text_lines(slide, node, prepared_lines=None):
    """Emit one native, non-wrapping editable text box per browser line."""
    lines = prepared_lines if prepared_lines is not None else scene_text_lines(node)
    if not lines:
        return None
    shapes = []
    for line in lines:
        x, y, w, h = line['bounds']
        shape = slide.shapes.add_textbox(px_to_emu(x), px_to_emu(y), px_to_emu(w), px_to_emu(h))
        scene_write_runs(shape.text_frame, line['runs'], line['style'], split_paragraphs=False)
        # This is the key difference from whole-element fallback: PowerPoint
        # must never decide where to wrap a line Chromium already measured.
        shape.text_frame.word_wrap = False
        try:
            # `NONE` writes a noAutofit element.  Combined with wrap="none",
            # this prevents PowerPoint from deciding either a new line break or
            # a different font size for Chromium-measured line geometry.
            shape.text_frame.auto_size = MSO_AUTO_SIZE.NONE
        except Exception:
            pass
        shapes.append(shape)
    return shapes


def scene_add_text(slide, node):
    measured_lines = scene_text_lines(node)
    if measured_lines:
        return scene_add_measured_text_lines(slide, node, measured_lines)
    x, y, w, h = scene_box(node)
    shape = slide.shapes.add_textbox(px_to_emu(x), px_to_emu(y), px_to_emu(w), px_to_emu(h))
    scene_write_runs(shape.text_frame, node.get('runs') or [], node.get('style') or {})
    return shape


def scene_local_image(source, base_dir, scratch):
    if not source:
        raise ValueError('image source is empty')
    if source.startswith('data:'):
        try:
            header, content = source.split(',', 1)
            ext = '.png'
            if 'jpeg' in header or 'jpg' in header: ext = '.jpg'
            elif 'gif' in header: ext = '.gif'
            elif 'webp' in header: ext = '.webp'
            file_path = os.path.join(scratch, 'image-%d%s' % (len(os.listdir(scratch)), ext))
            with open(file_path, 'wb') as output:
                output.write(base64.b64decode(content))
            return file_path
        except Exception as exc:
            raise ValueError('cannot decode image data URL: %s' % exc)
    if source.startswith('file:'):
        from urllib.parse import urlparse, unquote
        parsed = urlparse(source)
        source = unquote(parsed.path)
        if os.name == 'nt' and source.startswith('/'):
            source = source[1:]
    if not os.path.isabs(source) and base_dir:
        source = os.path.join(base_dir, source)
    if not os.path.exists(source):
        raise ValueError('image file is not available: %s' % source)
    return source


def scene_add_bake(slide, node, scene, scratch):
    """Place a baked element as a picture at its exact measured bounds.

    The image is captured by the same Chromium that renders the fidelity
    reference. A missing capture is a hard error: shipping a placeholder would
    make an unrenderable element indistinguishable from a real picture.
    """
    source = (scene.get('bakes') or {}).get(node.get('id'))
    if not source:
        raise ValueError(json.dumps({'stage': 'scene', 'errors': [{
            'nodeId': node.get('id'),
            'property': 'bake',
            'reason': 'no captured image was supplied for this baked element'
        }]}, ensure_ascii=False))
    path = scene_local_image(source, '', scratch)
    x, y, w, h = scene_box(node)
    return slide.shapes.add_picture(path, px_to_emu(x), px_to_emu(y), px_to_emu(w), px_to_emu(h))


def scene_add_image(slide, node, base_dir, scratch):
    image = node.get('image') or {}
    path = scene_local_image(image.get('src') or '', base_dir, scratch)
    x, y, w, h = scene_box(node)
    crop = image.get('crop') or {}
    fit = crop.get('fit') or 'fill'
    if fit == 'contain' and crop.get('naturalW') and crop.get('naturalH'):
        source_ratio = float(crop['naturalW']) / float(crop['naturalH'])
        target_ratio = w / h
        if source_ratio > target_ratio:
            h2 = w / source_ratio
            y += (h - h2) / 2
            h = h2
        else:
            w2 = h * source_ratio
            x += (w - w2) / 2
            w = w2
    picture = slide.shapes.add_picture(path, px_to_emu(x), px_to_emu(y), px_to_emu(w), px_to_emu(h))
    if fit == 'cover':
        # python-pptx accepts crop fractions (0.25 == 25%), even though the
        # underlying OOXML serializes them as Office percentages.
        for attr, name in (('crop_left', 'left'), ('crop_right', 'right'), ('crop_top', 'top'), ('crop_bottom', 'bottom')):
            try:
                setattr(picture, attr, float(crop.get(name) or 0))
            except Exception:
                pass
    return picture


def scene_add_line(slide, node):
    x, y, w, h = scene_box(node)
    style = node.get('style') or {}
    edge = (style.get('border') or {}).get('top') or {}
    thickness = max(float(edge.get('width') or 0), h, 1)
    line = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, px_to_emu(x), px_to_emu(y + (h - thickness) / 2), px_to_emu(w), px_to_emu(thickness))
    scene_set_fill(line, edge.get('color') or style.get('color') or '#000000')
    line.line.fill.background()
    scene_remove_text_body(line)
    return line


def scene_add_list(slide, node):
    x, y, w, h = scene_box(node)
    shape = slide.shapes.add_textbox(px_to_emu(x), px_to_emu(y), px_to_emu(w), px_to_emu(h))
    list_data = node.get('list') or {}
    items = list_data.get('items') or []
    style = node.get('style') or {}
    tf = shape.text_frame
    tf.clear()
    tf.word_wrap = True
    for index, item in enumerate(items):
        paragraph = tf.paragraphs[0] if index == 0 else tf.add_paragraph()
        item_style = item.get('style') or style
        paragraph.alignment = scene_alignment(item_style.get('textAlign'), item_style.get('direction'))
        if item_style.get('direction') == 'rtl':
            set_rtl(paragraph)
        scene_set_bullet(paragraph, bool(list_data.get('ordered')))
        for run_info in item.get('runs') or [{'text': item.get('text') or '', 'style': {}}]:
            run = paragraph.add_run()
            run.text = run_info.get('text') or ''
            scene_run_font(run, run_info.get('style') or {}, item_style)
    return shape


def scene_set_cell_border(cell, side, edge):
    if float((edge or {}).get('width') or 0) <= 0 or (edge or {}).get('style') == 'none':
        return
    try:
        from pptx.oxml.xmlchemy import OxmlElement
        tc_pr = cell._tc.get_or_add_tcPr()
        line = OxmlElement('a:ln' + side)
        line.set('w', str(int(float(edge.get('width') or 1) * 9525)))
        solid = OxmlElement('a:solidFill')
        rgb = OxmlElement('a:srgbClr')
        rgb_color = scene_rgb(edge.get('color'), '#000000')
        rgb.set('val', ''.join(f'{v:02X}' for v in rgb_color))
        solid.append(rgb)
        line.append(solid)
        dash = OxmlElement('a:prstDash')
        dash.set('val', 'dash' if edge.get('style') == 'dashed' else 'solid')
        line.append(dash)
        tc_pr.append(line)
    except Exception:
        pass


def scene_add_table(slide, node):
    table_data = node.get('table') or {}
    rows = table_data.get('rows') or []
    if not rows:
        return None
    num_rows = len(rows)
    num_cols = max([sum(int(cell.get('colSpan') or 1) for cell in row.get('cells') or []) for row in rows] or [1])
    x, y, w, h = scene_box(node)
    shape = slide.shapes.add_table(num_rows, num_cols, px_to_emu(x), px_to_emu(y), px_to_emu(w), px_to_emu(h))
    table = shape.table
    widths = [0.0] * num_cols
    for row in rows:
        col = 0
        for info in row.get('cells') or []:
            span = int(info.get('colSpan') or 1)
            cell_w = float((info.get('bounds') or {}).get('w') or 0) / span
            for offset in range(span):
                if col + offset < num_cols: widths[col + offset] = max(widths[col + offset], cell_w)
            col += span
    if sum(widths) > 0:
        scale = w / sum(widths)
        for index, width in enumerate(widths): table.columns[index].width = px_to_emu(width * scale)
    for r_index, row in enumerate(rows):
        row_height = float((row.get('bounds') or {}).get('h') or 0)
        if row_height > 0: table.rows[r_index].height = px_to_emu(row_height)
        col = 0
        for info in row.get('cells') or []:
            span = int(info.get('colSpan') or 1)
            if col >= num_cols: break
            cell = table.cell(r_index, col)
            if span > 1 and col + span <= num_cols:
                cell = cell.merge(table.cell(r_index, col + span - 1))
            cell_style = info.get('style') or node.get('style') or {}
            scene_set_fill(cell, cell_style.get('fill'))
            for side, xml_side in (('top', 'T'), ('right', 'R'), ('bottom', 'B'), ('left', 'L')):
                scene_set_cell_border(cell, xml_side, (cell_style.get('border') or {}).get(side) or {})
            scene_write_runs(cell.text_frame, info.get('runs') or [{'text': info.get('text') or '', 'style': {}}], cell_style)
            col += span
    return shape


def validate_scene_graph(scene):
    if not isinstance(scene, dict) or scene.get('format') != 'lve.scene-graph':
        return [{'property': 'format', 'reason': 'a versioned lve.scene-graph is required for editable export'}]
    if scene.get('schemaVersion') != SCENE_SCHEMA_VERSION:
        return [{'property': 'schemaVersion', 'reason': 'unsupported scene graph version'}]
    # Scene v2 degrades every unmappable element to a bake picture, so
    # `node.unsupported` is advisory. Only malformed geometry — something the
    # renderer genuinely cannot place — may stop an export.
    return list(scene.get('errors') or [])


def render_scene_graph(scene, suggested_name, base_dir=''):
    errors = validate_scene_graph(scene)
    if errors:
        raise ValueError(json.dumps({'stage': 'scene', 'errors': errors}, ensure_ascii=False))
    page_size = scene.get('pageSize') or {}
    width_px = float(page_size.get('widthPx') or 950)
    height_px = float(page_size.get('heightPx') or 650)
    prs = Presentation()
    prs.slide_width = Inches(width_px / 96)
    prs.slide_height = Inches(height_px / 96)
    blank = prs.slide_layouts[6]
    scratch = tempfile.mkdtemp(prefix='lve-scene-images-')
    out_path = None
    try:
        for slide_data in scene.get('slides') or []:
            slide = prs.slides.add_slide(blank)
            nodes = list(slide_data.get('nodes') or [])
            root = next((node for node in nodes if node.get('renderAs') == 'slide'), None)
            if root:
                # Slide root is a native background/shape, not a screenshot.
                root_shape = scene_add_shape(slide, root)
                scene_add_border_edges(slide, root)
                # Canvas shadows deliberately sit outside the slide in HTML and
                # therefore do not belong in an exported slide canvas.
                try:
                    root_shape._element.spPr.remove(root_shape._element.spPr.find('{http://schemas.openxmlformats.org/drawingml/2006/main}effectLst'))
                except Exception:
                    pass
            def z_value(node):
                value = node.get('zIndex')
                try: return float(value) if value is not None else 0.0
                except Exception: return 0.0
            for node in sorted([node for node in nodes if node is not root], key=lambda node: (z_value(node), node.get('order') or 0)):
                kind = node.get('renderAs')
                if kind == 'shape':
                    scene_add_shape(slide, node); scene_add_border_edges(slide, node)
                elif kind == 'shape-text':
                    # Keep the native fill/border/shadow shape below the text
                    # lines, then use measured editable text boxes when the
                    # browser supplied reliable per-line geometry.  A regular
                    # shape text frame remains the exact legacy fallback.
                    measured_lines = scene_text_lines(node)
                    shape = scene_add_shape(slide, node, keep_text_body=not bool(measured_lines)); scene_add_border_edges(slide, node)
                    if measured_lines:
                        scene_add_measured_text_lines(slide, node, measured_lines)
                    else:
                        scene_write_runs(shape.text_frame, node.get('runs') or [], node.get('style') or {})
                elif kind == 'text':
                    scene_add_text(slide, node)
                elif kind == 'bake':
                    scene_add_bake(slide, node, scene, scratch)
                elif kind == 'image':
                    scene_add_image(slide, node, base_dir, scratch)
                elif kind == 'table':
                    scene_add_table(slide, node)
                elif kind == 'list':
                    scene_add_list(slide, node)
                elif kind == 'line':
                    scene_add_line(slide, node)
            if slide_data.get('notes'):
                try: slide.notes_slide.notes_text_frame.text = slide_data['notes']
                except Exception: pass
        fd, out_path = tempfile.mkstemp(suffix='.pptx')
        os.close(fd)
        prs.save(out_path)
        os.makedirs(os.path.dirname(os.path.abspath(suggested_name)), exist_ok=True)
        shutil.copy2(out_path, suggested_name)
        return suggested_name
    finally:
        if out_path and os.path.exists(out_path):
            try: os.unlink(out_path)
            except Exception: pass
        shutil.rmtree(scratch, ignore_errors=True)


def main():
    try:
        payload = json.loads(sys.stdin.read())
    except Exception as e:
        print(json.dumps({'ok': False, 'error': f'JSON parse: {e}'}))
        return
    
    # Editable export has exactly one contract. The old shallow plan and the
    # screenshot path are deliberately not accepted: callers must send the
    # measured versioned scene graph or receive a structured pre-render error.
    scene_graph = payload.get('sceneGraph') or payload.get('slidePlan') or {}
    suggested_name = payload.get('suggestedName', 'lecture.pptx')
    base_dir = payload.get('baseDir', '')
    try:
        output_path = render_scene_graph(scene_graph, suggested_name, base_dir)
        print(json.dumps({'ok': True, 'path': output_path, 'count': len(scene_graph.get('slides') or [])}, ensure_ascii=False))
    except Exception as e:
        detail = str(e)
        result = {'ok': False, 'stage': 'scene-render', 'error': detail}
        try:
            parsed = json.loads(detail)
            if isinstance(parsed, dict):
                result.update(parsed)
        except Exception:
            pass
        print(json.dumps(result, ensure_ascii=False))
    return


if __name__ == '__main__':
    main()
