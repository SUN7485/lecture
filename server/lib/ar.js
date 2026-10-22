/**
 * Arabic counted nouns for messages the server sends to the (Arabic) editor.
 * 1 and 2 have their own forms, 3-10 take the plural, 11-99 the singular
 * (by the last two digits past 100) — the same rule as web/app.js arCount.
 */
const NOUNS = {
  page: ['صفحة واحدة', 'صفحتان', 'صفحات', 'صفحة'],
  slide: ['شريحة واحدة', 'شريحتان', 'شرائح', 'شريحة'],
  object: ['عنصر واحد', 'عنصران', 'عناصر', 'عنصرًا']
};

export function arCount(n, noun) {
  const f = NOUNS[noun];
  if (n === 1) return f[0];
  if (n === 2) return f[1];
  const r = n % 100;
  return n + ' ' + (r >= 3 && r <= 10 ? f[2] : f[3]);
}
