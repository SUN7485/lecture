# Geometry read-back audit.
#
# Re-opens the candidate PPTX with python-pptx and asserts that every shape the
# scene renderer emitted actually landed within tolerance of the browser-measured
# bounds it was told to use. This catches a whole failure class the pixel gate
# reports only as "something differs": a shape written to the wrong coordinates.
#
# stdin : {"pptxPath": "...", "sceneGraph": {...}, "tolerancePx": 0.75}
# stdout: {"ok": bool, "checked": n, "matched": n, "unmatched": [...],
#          "mismatches": [{"id","expected","actual","deltaPx"}]}
import json
import sys

from pptx import Presentation

EMU_PER_PX = 9525
DEFAULT_TOLERANCE_PX = 0.75


def node_index(scene):
    """Every scene node the renderer emits a named shape for, by id."""
    wanted = {'shape', 'shape-text', 'image', 'table', 'bake', 'slide'}
    index = {}
    for slide in scene.get('slides') or []:
        for node in slide.get('nodes') or []:
            if node.get('renderAs') in wanted and node.get('id'):
                index[node['id']] = node
    return index


def main():
    payload = json.loads(sys.stdin.read())
    tolerance = float(payload.get('tolerancePx') or DEFAULT_TOLERANCE_PX)
    scene = payload.get('sceneGraph') or {}
    nodes = node_index(scene)

    prs = Presentation(payload['pptxPath'])
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
            bounds = node.get('bounds') or {}
            expected = {
                'x': float(bounds.get('x', 0)),
                'y': float(bounds.get('y', 0)),
                'w': float(bounds.get('w', 0)),
                'h': float(bounds.get('h', 0)),
            }
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
                    'renderAs': node.get('renderAs'),
                    'expected': expected,
                    'actual': {key: round(value, 3) for key, value in actual.items()},
                    'deltaPx': delta,
                    'worstPx': round(worst, 4),
                })

    result = {
        'ok': not mismatches,
        'checked': checked,
        'matched': len(seen),
        'tolerancePx': tolerance,
        'unmatched': sorted(set(nodes) - seen)[:20],
        'unmatchedCount': len(set(nodes) - seen),
        'mismatches': mismatches[:50],
        'mismatchCount': len(mismatches),
    }
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
