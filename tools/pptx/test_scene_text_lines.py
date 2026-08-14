"""Focused native-text smoke coverage for browser-measured scene text lines.

Run with:
    py tools/pptx/test_scene_text_lines.py
"""

import os
import re
import sys
import tempfile
import unittest
import zipfile


sys.path.insert(0, os.path.dirname(__file__))
import renderer  # noqa: E402


def text_style(**changes):
    style = {
        'fill': 'rgba(0, 0, 0, 0)',
        'border': {},
        'borderRadius': [0, 0, 0, 0],
        'padding': {'top': 0, 'right': 0, 'bottom': 0, 'left': 0},
        'direction': 'ltr',
        'textAlign': 'left',
        'verticalAlign': 'top',
        'fontFamily': 'Arial',
        'fontSize': 20,
        'fontWeight': '400',
        'fontStyle': 'normal',
        'color': 'rgb(0, 0, 0)',
        'lineHeight': 24,
    }
    style.update(changes)
    return style


def scene_for(node):
    root_style = text_style()
    return {
        'format': 'lve.scene-graph',
        'schemaVersion': 1,
        'pageSize': {'widthPx': 950, 'heightPx': 650},
        'errors': [],
        'slides': [{
            'index': 1,
            'nodes': [
                {
                    'id': 's0:root', 'renderAs': 'slide',
                    'bounds': {'x': 0, 'y': 0, 'w': 950, 'h': 650},
                    'style': root_style,
                },
                node,
            ],
        }],
    }


def slide_xml(scene):
    with tempfile.TemporaryDirectory(prefix='lve-scene-text-lines-') as directory:
        output = os.path.join(directory, 'scene.pptx')
        renderer.render_scene_graph(scene, output)
        with zipfile.ZipFile(output) as archive:
            return archive.read('ppt/slides/slide1.xml').decode('utf-8')


class SceneTextLinesTest(unittest.TestCase):
    def test_measured_lines_are_editable_nonwrapping_textboxes(self):
        style = text_style(fill='rgb(240, 240, 240)')
        node = {
            'id': 's0:card', 'renderAs': 'shape-text',
            'bounds': {'x': 60, 'y': 60, 'w': 480, 'h': 150},
            'text': 'Bold one plain two',
            'runs': [
                {'text': 'Bold one ', 'style': text_style(fontWeight='700', fontFamily='Chromium Alias', powerPointFontFamily='Office Verified Face', powerPointFaceHasIntrinsicWeight=True, letterSpacing=0.4)},
                {'text': 'plain two', 'style': text_style()},
            ],
            'style': style,
            'textLines': [
                {
                    'bounds': {'left': 80, 'top': 82, 'width': 130, 'height': 28},
                    # A verified Office face must override Chromium's alias,
                    # including in the measured-line run path.
                    'runs': [{'text': 'Bold one', 'style': text_style(fontWeight='700', fontFamily='Chromium Alias', powerPointFontFamily='Office Verified Face', powerPointFaceHasIntrinsicWeight=True, letterSpacing=0.4)}],
                },
                {
                    # DOMRect-compatible x/y/right/bottom geometry is accepted.
                    'rect': {'x': 290, 'y': 138, 'right': 385, 'bottom': 166},
                    'runs': [{'text': 'plain two', 'style': text_style()}],
                },
            ],
        }

        xml = slide_xml(scene_for(node))
        paragraphs = re.findall(r'<a:p(?:\s[^>]*)?>(.*?)</a:p>', xml, flags=re.S)
        self.assertEqual(re.findall(r'<a:t>(.*?)</a:t>', xml), ['Bold one', 'plain two'])
        self.assertEqual(len(re.findall(r'<p:txBody\b', xml)), 2)
        self.assertEqual(len(paragraphs), 2)
        self.assertEqual(sum(1 for paragraph in paragraphs if '<a:t>' not in paragraph), 0)
        self.assertEqual(len(re.findall(r'<a:bodyPr[^>]*wrap="none"', xml)), 2)
        self.assertEqual(len(re.findall(r'<a:noAutofit\s*/>', xml)), 2)
        self.assertIn('Office Verified Face', xml)
        self.assertNotIn('Chromium Alias', xml)
        self.assertIn('<a:ea typeface="Office Verified Face"/>', xml)
        self.assertIn('<a:cs typeface="Office Verified Face"/>', xml)
        self.assertIn('spc="30"', xml)
        self.assertNotIn('b="1"', xml, 'a named physical Bold face must not be synthetically bolded')

    def test_invalid_or_incomplete_lines_use_whole_node_fallback(self):
        style = text_style()
        node = {
            'id': 's0:text', 'renderAs': 'text',
            'bounds': {'x': 100, 'y': 100, 'w': 300, 'h': 80},
            'text': 'Fallback retains all text',
            'runs': [
                {'text': 'Fallback ', 'style': style},
                {'text': 'retains all text', 'style': style},
            ],
            'style': style,
            # The assembled line text does not equal node.text, so the renderer
            # must never emit a partial line-only representation.
            'textLines': [{'bounds': {'x': 100, 'y': 100, 'w': 100, 'h': 24}, 'text': 'missing content'}],
        }

        self.assertIsNone(renderer.scene_text_lines(node))
        xml = slide_xml(scene_for(node))
        self.assertEqual(re.findall(r'<a:t>(.*?)</a:t>', xml), ['Fallback ', 'retains all text'])
        self.assertEqual(len(re.findall(r'<p:txBody\b', xml)), 1)
        self.assertEqual(len(re.findall(r'<a:bodyPr[^>]*wrap="none"', xml)), 0)


if __name__ == '__main__':
    unittest.main()
