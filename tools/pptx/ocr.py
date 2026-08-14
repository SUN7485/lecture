"""Optional vendored-Tesseract OCR adapter.

The verified desktop export path invokes ``ocr-winrt.ps1`` and preflights the
offline Windows Arabic + English OCR recognizers.  This helper is retained only
for future deployments that actually ship the Tesseract executable and both
language data files beside it; it is not a system-PATH fallback and is never
selected automatically.
"""

import json
import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent
BUNDLE = ROOT / 'ocr'
ENGINE = BUNDLE / ('tesseract.exe' if os.name == 'nt' else 'tesseract')
TESSDATA = BUNDLE / 'tessdata'


def fail(code, message, **details):
    payload = {'ok': False, 'error': {'code': code, 'message': message}}
    if details:
        payload['error']['details'] = details
    print(json.dumps(payload, ensure_ascii=False))
    return 1


def parse_tsv(value):
    lines = value.splitlines()
    if not lines:
        return []
    header = lines[0].split('\t')
    columns = {name: index for index, name in enumerate(header)}
    required = ('level', 'left', 'top', 'width', 'height', 'text')
    if any(name not in columns for name in required):
        raise ValueError('Tesseract did not return TSV word geometry.')
    tokens = []
    for line in lines[1:]:
        values = line.split('\t')
        if len(values) < len(header):
            continue
        text = values[columns['text']].strip()
        if not text or values[columns['level']] != '5':
            continue
        tokens.append({
            'text': text,
            'x': int(float(values[columns['left']] or 0)),
            'y': int(float(values[columns['top']] or 0)),
            'w': int(float(values[columns['width']] or 0)),
            'h': int(float(values[columns['height']] or 0)),
            'confidence': float(values[columns.get('conf', 0)] or -1)
        })
    return tokens


def recognize(image_path, languages):
    if not image_path or not Path(image_path).is_file():
        raise ValueError('OCR image is missing: %s' % image_path)
    command = [str(ENGINE), str(image_path), 'stdout', '--tessdata-dir', str(TESSDATA), '-l', languages, 'tsv']
    result = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=60000)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or 'Bundled Tesseract returned %s.' % result.returncode)
    tokens = parse_tsv(result.stdout)
    return {'tokens': tokens, 'text': ' '.join(token['text'] for token in tokens)}


def main():
    try:
        payload = json.loads(sys.stdin.read() or '{}')
    except Exception as exc:
        return fail('OCR_INPUT_INVALID', 'Could not parse OCR input.', error=str(exc))
    if not ENGINE.is_file():
        return fail('BUNDLED_OCR_ENGINE_MISSING', 'Bundled Arabic + English OCR engine is missing.', expectedPath=str(ENGINE))
    if not (TESSDATA / 'ara.traineddata').is_file() or not (TESSDATA / 'eng.traineddata').is_file():
        return fail('BUNDLED_OCR_LANGUAGE_DATA_MISSING', 'Bundled OCR language data for ara and eng is missing.', tessdata=str(TESSDATA))
    languages = '+'.join(payload.get('languages') or ['ara', 'eng'])
    try:
        source = recognize(payload.get('sourcePath'), languages)
        power_point = recognize(payload.get('powerPointPath'), languages)
    except subprocess.TimeoutExpired:
        return fail('OCR_TIMEOUT', 'Bundled OCR timed out while reading a slide.', timeoutMs=60000)
    except Exception as exc:
        return fail('OCR_FAILED', str(exc))
    print(json.dumps({'ok': True, 'source': source, 'powerPoint': power_point}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
