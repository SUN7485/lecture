# syntax=docker/dockerfile:1
#
# Lecture Studio — hosted service image.
#
# Built for Oracle Cloud's always-free Ampere A1, which is ARM64. That single
# fact drives two choices below: the SYSTEM chromium (Playwright ships no
# supported arm64 Linux build; Debian does), and a base image with arm64
# variants. The same Dockerfile still builds on amd64.

# ---- deps -------------------------------------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# --omit=dev drops Electron (~250MB) and electron-builder, which this service
# never loads. It is also why pptxgenjs and playwright-core had to be moved
# into dependencies — the server requires both at runtime.
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

# ---- runtime ----------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    CHROMIUM_PATH=/usr/bin/chromium \
    PORT=8080 \
    HOST=0.0.0.0

# chromium  : renders the PDF export (see server/lib/render-pdf.js)
# tini      : chromium forks children; PID 1 must reap them or the container
#             slowly fills with zombies and eventually cannot fork at all
# fonts     : THE fidelity dependency. A reconstructed Arabic deck names
#             families like "Simplified Arabic" and falls back through
#             'Segoe UI' / 'Times New Roman' — none of which exist on Linux.
#             Without an Arabic-capable face installed, every Arabic glyph in
#             an exported PDF renders as a box. Noto covers Arabic; Liberation
#             provides metric-compatible stand-ins for Arial/Times.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      tini \
      fonts-noto-core \
      fonts-noto-ui-core \
      fonts-liberation \
      fonts-dejavu-core \
      ca-certificates \
 && fc-cache -f \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY engine ./engine
COPY server ./server
COPY web ./web
COPY LICENSE ./LICENSE

# Never run the browser or the app as root. Chromium is the largest piece of
# attack surface here and it parses our own generated HTML.
RUN useradd --system --create-home --uid 10001 app \
 && mkdir -p /tmp/ls && chown -R app:app /app /tmp/ls
USER app

EXPOSE 8080

# Liveness only — /healthz answers before rate limiting on purpose, so a busy
# process is never mistaken for a dead one and restarted mid-export.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/app.js"]
