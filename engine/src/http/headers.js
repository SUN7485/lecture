/** Safe Content-Disposition for Unicode deck names (RFC 5987 filename*). */
export function attachmentDisposition(fileName) {
  const name = String(fileName || "download.pptx");
  const ascii = name
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\\]/g, "_") || "download.pptx";
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
