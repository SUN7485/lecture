import json
d = json.load(open('_plan_dump.json'))
slides = d['slides']
print(f'Total slides: {len(slides)}')
for i, s in enumerate(slides):
    content_types = [it.get('type') for it in s.get('content',[])]
    svg_count = sum(1 for it in s.get('content',[]) if '<svg' in (it.get('html','') or ''))
    fig_count = sum(1 for it in s.get('content',[]) if it.get('type')=='figure')
    print(f'  Slide {i+1}: content_types={content_types}, svg_html={svg_count}, figures={fig_count}')
    for it in s.get('content',[]):
        if it.get('type') == 'figure' and '<svg' in (it.get('html','') or ''):
            print(f'    FIG: kind={it.get("kind")} align={it.get("align")} html_len={len(it.get("html",""))}')
