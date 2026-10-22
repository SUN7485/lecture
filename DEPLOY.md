# Deploying Lecture Studio

**Date:** 2026-09-02

## Why Oracle Cloud and not Vercel

You asked for Vercel *or* Oracle. It has to be Oracle (or any plain VM). Vercel
is the wrong shape for this workload, for four concrete reasons:

| | |
|---|---|
| **It is a file processor, not a request handler** | Reconstruction is synchronous, CPU-bound and memory-hungry. It wants a machine, not a lambda. |
| **Bundle size** | MuPDF's WASM plus a headless Chromium blow past Vercel's compressed function limit. `@sparticuz/chromium` exists to fight this and is fragile. |
| **Duration** | A PDF export renders every slide through Chromium. Measured 21 pages ≈ 1 s, but a 118-page lecture is minutes — past Hobby's ceiling. |
| **Cold starts** | MuPDF's WASM costs ~800 ms to initialise. Serverless pays that on every cold invocation; a long-lived process pays it once. |

Oracle's **Always Free Ampere A1** gives 4 ARM cores and 24 GB RAM permanently,
with a real filesystem and no execution ceiling. That is a better machine than
most paid tiers, and it costs nothing.

**Everything in this stack is built for ARM64** — that is why the image installs
Debian's `chromium` rather than Playwright's bundled build, which has no
supported arm64 Linux binary.

## Before you deploy: the licence is not optional

This app links **MuPDF, which is AGPL-3.0-or-later**. Hosting it publicly is
exactly what AGPL section 13 covers: every user of the service must be offered
the complete corresponding source.

The code enforces this rather than trusting you to remember:

- `server/config.js` **refuses to start** without `SOURCE_URL`.
- `/source` redirects there, and the editor links it in the footer.
- `LICENSE` is the full AGPL-3.0 text.

So **the repository you deploy from must be public.** If you want it closed,
buy a commercial MuPDF licence from Artifex first — see `LICENSING.md`. There is
no third option that is legal.

## Deploy

### 1. Create the instance
Oracle Cloud → Compute → Instances → Create.
Shape **VM.Standard.A1.Flex**, 4 OCPU / 24 GB, image **Ubuntu 22.04 (aarch64)**.
Save the SSH key.

### 2. Prepare the host
```bash
ssh ubuntu@<public-ip>
curl -fsSL https://raw.githubusercontent.com/<you>/lecture-studio/main/deploy/oracle-setup.sh | bash
```
Installs Docker, adds swap, and opens the instance firewall.

> **The one thing that traps everyone.** Oracle's Ubuntu images ship an iptables
> ruleset that REJECTs everything except SSH, and it persists across reboots.
> Opening 80/443 in the VCN security list is necessary and **not sufficient** —
> traffic reaches the instance and dies there. The script opens the instance
> firewall; you must open the VCN too (step 3). Every "my Oracle VM won't serve
> traffic" thread is this one thing.

### 3. Open the VCN
Networking → Virtual Cloud Networks → your VCN → Security Lists → default →
Add Ingress Rules:

| Source | Protocol | Dest. port |
|---|---|---|
| `0.0.0.0/0` | TCP | 80 |
| `0.0.0.0/0` | TCP | 443 |

### 4. Point DNS
An **A record** for your domain at the instance's public IP. Do this *before*
starting the stack — Caddy requests a certificate on boot and needs the name to
already resolve.

### 5. Ship it
```bash
git clone <your-repo> lecture-studio && cd lecture-studio
cp .env.example .env && nano .env      # set DOMAIN and SOURCE_URL
docker compose up -d --build
```

### 6. Confirm
```bash
docker compose logs -f
curl -sf https://<your-domain>/healthz
curl -sf https://<your-domain>/readyz
```

## Operating it

```bash
docker compose logs -f app         # JSON lines: convert, export-pptx, export-pdf
docker compose restart app
git pull && docker compose up -d --build    # deploy
docker compose down                # stop
```

Every limit is an environment variable — see `server/config.js`. The defaults
suit one small VM.

## What the hosted build does NOT do

Stated plainly, because it is a real difference from the desktop app:

**PPTX fidelity verification does not run here.** On Windows the desktop app
renders every slide twice — once in Chromium, once in *real desktop PowerPoint*
via COM — and compares them. A Linux server has no PowerPoint, so the hosted
export uses the direct writer plus `refont.js` (portable fonts) and ships a
genuinely editable deck **without** the visual proof. If you need the verified
export, use the desktop app.

Everything else is the same engine, and the numbers match: 21 slides, 831
objects, 0 U+FFFD, exported PDF at the source's exact page geometry.

## Verified before writing this

Run locally against a real 21-page Arabic lecture:

```
node --test test/server-hosted.test.js     8/8 pass
```

- AGPL guard: server exits non-zero without `SOURCE_URL`
- CSRF: origin-less and cross-origin writes → 403
- Upload validation by magic number, not extension → 400
- Filesystem not addressable: no `/api/browse`; `..` and `%2e%2e` → 403/404
- Headers: CSP, `nosniff`, `DENY`; `no-store` HTML, `no-cache` + ETag assets (304)
- Convert 21p/831obj in 1402 ms · PPTX 109,590 B (21 slide parts) · PDF 323,298 B
- Session isolation: a foreign session asking for another's model → 410

**Verified under stress (2026-09-10):** 6 concurrent exports of one document
returned six byte-identical files (the shared model is not corrupted by
concurrency); 25 simultaneous exports degraded by *refusing* — 10 served,
11 rate-limited, 4 rejected as busy, no hangs and no 500s — and the pool
returned to idle with no leaked jobs. Killing a worker respawned it and the
service kept serving.

**Not verified:** the Docker image itself. There is no Docker on the machine it
was written on, so `Dockerfile` and `docker-compose.yml` are reviewed and
conventional but have never been built here. Expect to fix something on first
`docker compose up --build`; the most likely candidate is a font or chromium
package name on your Ubuntu release.

**Push to GitHub before you deploy** — `.github/workflows/ci.yml` builds the
image and boots it, so CI will tell you whether it works before an Oracle VM
does. That is the single cheapest way to close this gap, and you have to make
the repo public anyway for the AGPL source offer.

Graceful shutdown is also unverified: `kill -TERM` on Git Bash/Windows is a hard
kill, so the SIGTERM handler could not be exercised here. The handler is correct
by inspection and Linux will deliver the signal properly, but confirm it on the
VM with `docker compose stop` and look for the `shutdown` log line.
