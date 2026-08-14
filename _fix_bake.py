p = 'D:/lectuer/src/renderer.js'
s = open(p, encoding='utf-8', newline='').read()
crlf = '\r\n'
hook_lf = '  window.__debugBake = bakeSvgFiguresInPlan;\n'
hook_crlf = '  window.__debugBake = bakeSvgFiguresInPlan;\r\n'
assert hook_crlf in s or hook_lf in s, 'hook not found'
needle = hook_crlf if hook_crlf in s else hook_lf
s2 = s.replace(needle, '', 1)
open(p, 'w', encoding='utf-8', newline='').write(s2)
print('removed debug hook; remaining occurrences:', s.count('__debugBake'))



