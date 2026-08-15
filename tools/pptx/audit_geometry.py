# Geometry read-back audit.
#
# Re-opens the candidate PPTX with python-pptx and asserts that every shape the
# scene renderer emitted actually landed within tolerance of the browser-measured
# bounds it was told to use. This catches a whole failure class the pixel gate
# reports only as "something differs": a shape written to the wrong coordinates.
#
# stdin : {"pptxPath": "...", "sceneGraph": {...}, "tolerancePx": 0.75}
# stdout: {"ok": bool, "checked": n, "matched": n, "unmatched": [...],
#          "mismatches": [{"id","slideIndex","expected","actual","deltaPx"}]}
import json
import sys

from pptx import Presentation

EMU_PER_PX = 9525
DEFAULT_TOLERANCE_PX = 0.75


def numeric_bounds(bounds):
    """Normalise the scene's short and long bound spellings."""
    bounds = bounds or {}
    return {
        'x': float(bounds.get('x', 0)),
        'y': float(bounds.get('y', 0)),
        'w': float(bounds.get('w', bounds.get('width', 0))),
        'h': float(bounds.get('h', bounds.get('height', 0))),
    }


def indexed_node(node, **extra):
    """Keep the audit metadata next to a node without mutating its scene JSON."""
    return {**node, **extra}


def renderer_bounds(node):
    """Mirror the renderer's deliberate geometry transforms exactly.

    A CSS ``object-fit: contain`` image has a larger element box than its
    painted bitmap. ``scene_add_image`` preserves that visual letterboxing by
    centering a smaller picture, so comparing the picture to the raw element
    box would call correct output a 100+px placement regression.
    """
    bounds = numeric_bounds(node.get('bounds'))
    if node.get('renderAs') != 'image':
        return bounds
    crop = ((node.get('image') or {}).get('crop') or {})
    if crop.get('fit') != 'contain' or not crop.get('naturalW') or not crop.get('naturalH'):
        return bounds
    source_ratio = float(crop['naturalW']) / float(crop['naturalH'])
    target_ratio = bounds['w'] / bounds['h'] if bounds['h'] else source_ratio
    if source_ratio > target_ratio:
        h2 = bounds['w'] / source_ratio
        bounds['y'] += (bounds['h'] - h2) / 2
        bounds['h'] = h2
    else:
        w2 = bounds['h'] * source_ratio
        bounds['x'] += (bounds['w'] - w2) / 2
        bounds['w'] = w2
    return bounds


def node_index(scene, emitted_names=None):
    """Every renderer-emitted, named shape and its exact expected bounds.

    Text with browser-measured lines deliberately emits one PowerPoint textbox
    per line (``nodeId#lineN``), while a horizontal rule emits ``nodeId#rule``.
    Audit those concrete shapes rather than silently omitting text/line nodes.
    """
    wanted = {'shape', 'shape-text', 'text', 'image', 'table', 'bake', 'slide', 'list', 'line'}
    index = {}
    emitted_names = emitted_names or set()
    for slide_index, slide in enumerate(scene.get('slides') or []):
        for node in slide.get('nodes') or []:
            kind = node.get('renderAs')
            node_id = node.get('id')
            if kind not in wanted or not node_id:
                continue

            measured_lines = node.get('textLines') or []
            # The renderer validates browser line fragments before using them.
            # When that validation rejects a fragment stream it falls back to a
            # single node-named textbox, so choose the expected form from the
            # candidate's own emitted names instead of calling a valid fallback
            # an absent shape.
            has_emitted_lines = any(
                name.startswith(f'{node_id}#line') for name in emitted_names)
            if kind == 'text' and measured_lines and has_emitted_lines:
                # scene_add_text emits only measured line boxes in this path.
                for line_index, line in enumerate(measured_lines):
                    index[f'{node_id}#line{line_index}'] = indexed_node(
                        node, id=f'{node_id}#line{line_index}', bounds=line.get('bounds') or {},
                        renderAs='text-line', sourceNodeId=node_id, slideIndex=slide_index)
                continue

            if kind == 'line':
                # scene_add_line turns an <hr> into a rectangle centered inside
                # the measured node bounds, with a minimum 1px thickness.
                bounds = numeric_bounds(node.get('bounds'))
                edge = ((node.get('style') or {}).get('border') or {}).get('top') or {}
                thickness = max(float(edge.get('width') or 0), bounds['h'], 1)
                index[f'{node_id}#rule'] = indexed_node(
                    node, id=f'{node_id}#rule', renderAs='line-rule', sourceNodeId=node_id,
                    slideIndex=slide_index,
                    bounds={
                        'x': bounds['x'], 'y': bounds['y'] + (bounds['h'] - thickness) / 2,
                        'w': bounds['w'], 'h': thickness,
                    })
                continue

            # Shapes, pictures, tables, lists, bakes, roots, and the backing
            # shape of shape-text all retain their unsuffixed node id.
            index[node_id] = indexed_node(node, slideIndex=slide_index)
            if kind == 'shape-text' and measured_lines and has_emitted_lines:
                for line_index, line in enumerate(measured_lines):
                    index[f'{node_id}#line{line_index}'] = indexed_node(
                        node, id=f'{node_id}#line{line_index}', bounds=line.get('bounds') or {},
                        renderAs='shape-text-line', sourceNodeId=node_id, slideIndex=slide_index)
    return index


def main():
    payload = json.loads(sys.stdin.read())
    tolerance = float(payload.get('tolerancePx') or DEFAULT_TOLERANCE_PX)
    scene = payload.get('sceneGraph') or {}
    prs = Presentation(payload['pptxPath'])
    emitted_names = {
        shape.name for slide in prs.slides for shape in slide.shapes
        if getattr(shape, 'name', None)
    }
    nodes = node_index(scene, emitted_names)
    mismatches = []
    checked = 0
    seen = set()
    for slide in prs.slides:
        for shape in slide.shapes:
            node = nodes.get(shape.name)
            if node is None:
                continue
            seen.add(shape.name)
            checked += 1
            expected = renderer_bounds(node)
            actual = {
                'x': (shape.left or 0) / EMU_PER_PX,
                'y': (shape.top or 0) / EMU_PER_PX,
                'w': (shape.width or 0) / EMU_PER_PX,
                'h': (shape.height or 0) / EMU_PER_PX,
            }
            delta = {key: round(actual[key] - expected[key], 4) for key in expected}
            # PowerPoint owns table row heights: it enforces a per-row minimum
            # and sums them, so a table's final height is not something the
            # renderer can write. Position and width are still asserted.
            judged = [key for key in delta if not (node.get('renderAs') == 'table' and key == 'h')]
            worst = max(abs(delta[key]) for key in judged)
            if worst > tolerance:
                mismatches.append({
                    'id': shape.name,
                    'slideIndex': node.get('slideIndex'),
                    'renderAs': node.get('renderAs'),
                    'expected': expected,
                    'actual': {key: round(value, 3) for key, value in actual.items()},
                    'deltaPx': delta,
                    'worstPx': round(worst, 4),
                })

    unmatched = sorted(set(nodes) - seen)
    # A named scene node that does not appear in the candidate is a geometry
    # failure too: skipping it would let the audit claim a clean run while an
    # editable object had disappeared. Keep it in the same mismatch list so the
    # JavaScript gate records a concrete, slide-level failure.
    for node_id in unmatched:
        node = nodes[node_id]
        mismatches.append({
            'id': node_id,
            'slideIndex': node.get('slideIndex'),
            'code': 'SHAPE_GEOMETRY_UNMATCHED',
            'renderAs': node.get('renderAs'),
            'expected': renderer_bounds(node),
            'actual': None,
            'deltaPx': None,
            'worstPx': None,
            'message': 'The renderer did not emit a named shape for this scene node.',
        })

    result = {
        'ok': not mismatches,
        'checked': checked,
        'matched': len(seen),
        'tolerancePx': tolerance,
        'unmatched': unmatched[:20],
        'unmatchedCount': len(unmatched),
        'mismatches': mismatches[:50],
        'mismatchCount': len(mismatches),
    }
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
