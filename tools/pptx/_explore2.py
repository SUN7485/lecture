import re, sys
s = open(r'D:\lectuer\2.html', encoding='utf-8').read()
# split slides by <section
parts = re.split(r'(<section[^>]*>)', s)
slides = []
current = ''
started = False
for p in parts:
    if p.startswith('<section'):
        started = True
        current = p
    elif started:
        current += p
        if '</section>' in p:
            slides.append(current)
            current = ''
            started = False
print('SLIDE COUNT', len(slides))
for i, x in enumerate(slides):
    svgs = re.findall(r'<svg[^>]*>', x)
    svg_total = len(re.findall(r'<svg', x))
    h1 = re.search(r'<h1[^>]*>(.*?)</h1>', x, re.S)
    print('SLIDE', i+1, 'svg_open=', len(svgs), 'svg_total=', svg_total, 'h1=', (h1.group(1)[:40] if h1 else None))
    if svg_total:
        # print a sample svg element
        m = re.search(r'(<svg.*?</svg>)', x, re.S)
        if m:
            txt = m.group(1)
            print('   SAMPLE-SVG[:200]:', txt[:200].replace('\n',' '))
