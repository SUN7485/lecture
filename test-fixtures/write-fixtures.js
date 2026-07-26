// Writes two tiny Arabic RTL deck fixtures reproducing the EVO-013 bug family.
// Backticks are built from \x60 so this file never contains a literal fence.
const fs = require('fs');
const BT = '\x60\x60\x60';
const CSS = ':root{--purple:#413258;--gold:#C5A059;--cyan:#1AD9C7;}\n' +
  'body{margin:0;background:#eee}\n' +
  '.slide{width:950px;height:650px;background:#fff;margin:20px auto;border-right:18px solid var(--purple);padding:40px;box-sizing:border-box}\n' +
  'h1{color:var(--gold);border-bottom:3px solid var(--cyan);padding-bottom:8px}';
const SLIDES = '<div class="slide"><h1>الشريحة الأولى</h1><p>نص تجريبي للفحص.</p></div>\n' +
  '<div class="slide"><h1>الشريحة الثانية</h1><p>نص تجريبي آخر.</p></div>';
const docStart = (withHeadStyle) => '<!DOCTYPE html>\n<html lang="ar" dir="rtl">\n<head><meta charset="UTF-8"><title>Fixture</title>' +
  (withHeadStyle ? '\n<style>\n' + CSS + '\n</style>' : '') + '</head>\n<body>\n';
// A: markdown-fenced (quirks trigger) — the 029a loader guard must strip this.
fs.writeFileSync('test-fixtures/fenced-quirks.html',
  BT + 'html\n' + docStart(true) + SLIDES + '\n</body></html>\n' + BT + '\n', 'utf8');
// B: clean DOCTYPE but the stylesheet is authored inside <body> — 029b doctor-rule target.
fs.writeFileSync('test-fixtures/style-in-body.html',
  docStart(false) + '<style>\n' + CSS + '\n</style>\n' + SLIDES + '\n</body></html>\n', 'utf8');
console.log('fixtures written');
