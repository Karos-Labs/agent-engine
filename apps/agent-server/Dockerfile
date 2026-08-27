# syntax=docker/dockerfile:1
#
# Build from the REPO ROOT (this is an npm-workspaces monorepo — the build
# context has to include every workspace package this server depends on):
#
#   docker build -f apps/agent-server/Dockerfile -t agent-server .
#
# Two stages:
#   builder  installs every workspace's full deps (incl. devDependencies —
#            tsc/vitest are devDependencies), compiles every package in
#            dependency order, then prunes devDependencies back out of
#            node_modules before the runtime stage copies it.
#   runtime  node:22-slim (Debian bookworm, NOT alpine): `npx playwright
#            install --with-deps` only ships an apt-based dependency
#            installer for Debian/Ubuntu, and karos-landing's render-check
#            gate + karos-publish's renderCarousel both launch a real
#            Chromium (see their own "playwright": "1.53.0" dependency).
#            Also installs the Python 3 + opencv-python-headless + ffmpeg
#            runtime @agent-engine/tool-karos-video's adapters shell out to
#            (BRANDED_SHORTS_ENGINE_DIR still has to point at a real engine
#            checkout for those calls to do anything — unset, they degrade to
#            a per-call tooling_error, never a crash; see wiring/tools.ts).
#
# Runs BOTH Cloud Run targets from the same image — the HTTP server
# (default CMD, below) and the Pub/Sub pull consumer (deploy with
# `--command=node --args=apps/agent-server/dist/queue-consumer.js` — see
# ../../.github/workflows/deploy-prep.yml and cloudbuild.yaml's deploy-worker
# step) — deliberately two Cloud Run services from one image, not one
# process running both: a Pub/Sub subscribe() failure at startup must never
# take the HTTP health check down with it, and vice versa. Mirrors
# karosCMO/agent-service's own agent-service-api / agent-service-worker split.

########################################
# Stage 1: install + build every workspace package this server depends on.
########################################
FROM node:22-slim AS builder
WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
COPY scripts ./scripts
COPY packages ./packages
COPY agents ./agents
COPY apps ./apps

# Browsers aren't needed to compile TypeScript — skip playwright's postinstall
# download here; the runtime stage below installs the exact matching
# Chromium build against the pruned, production-only node_modules instead.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci

# Topological build (scripts/build-workspaces.mjs) — see its own doc comment:
# a hardcoded per-package build list (what this Dockerfile used to have)
# goes stale the moment a package is added, which is exactly what happened
# twice while this repo was being built out. `npm run build` now delegates to
# that script for every workspace, agent-server included.
RUN npm run build

# Strip devDependencies (typescript, vitest, tsx, supertest, ...) out of
# node_modules now that the build artifacts (dist/) they produced no longer
# need them — the runtime stage copies this pruned tree, not a second
# `npm ci --omit=dev` pass.
RUN npm prune --omit=dev

########################################
# Stage 2: the runtime image.
########################################
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# opencv-python-headless has no GUI/X11 deps, unlike full opencv-python —
# appropriate for a headless container. `--break-system-packages`: Debian
# bookworm's PEP 668 guard against pip clobbering the system Python install
# doesn't apply here — this container has no other Python consumer to
# conflict with.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      python3-pip \
      ffmpeg \
    && pip3 install --no-cache-dir --break-system-packages opencv-python-headless \
    && rm -rf /var/lib/apt/lists/*

# node_modules: pruned to production dependencies only (see builder stage).
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json /app/package-lock.json ./

# Installed against the exact pinned "playwright": "1.53.0" version already
# in node_modules — --with-deps additionally apt-get installs the OS-level
# libs (fonts, libnss3, ...) a bare `playwright install` alone would skip.
#
# PLAYWRIGHT_BROWSERS_PATH is the load-bearing line, not a tidiness choice.
# This RUN executes as root, so Playwright's default location is
# $HOME/.cache/ms-playwright = /root/.cache/ms-playwright. `USER node` below
# switches to uid 1000, whose HOME is /home/node — so at runtime Playwright
# looked in /home/node/.cache/ms-playwright and found nothing, and every
# render died with "Executable doesn't exist at
# /home/node/.cache/ms-playwright/chromium_headless_shell-1178/...". The
# browser was always installed; it was installed somewhere the runtime user
# never looks. Pinning both stages to one absolute, world-readable path is
# what makes the install and the lookup agree.
#
# This went unnoticed because no run had ever reached the render step: every
# Instagram run held at step 06 on "no viable image found" long before
# publish.renderCarousel was called (prep run pubsub-21077114299433051 is the
# first to get past it, and it failed here).
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright install --with-deps chromium && chmod -R a+rX /ms-playwright

# ── Source AFTER the browser install, deliberately ──────────────────────────
#
# This ordering is a build-time cost decision, not a style one. `npx playwright
# install --with-deps` is the single most expensive layer in this image (it
# apt-gets a font/lib set and downloads a browser), and it depends only on
# node_modules — the pinned playwright version lives there. Placed after the
# source COPYs, as it was, ANY source change invalidated it and every build
# paid for the browser again.
#
# Moving it above them means it now re-runs only when package-lock.json moves,
# which is what it actually depends on. Measured effect is in the PR that made
# the change; the reasoning is here because the next person to add a COPY will
# be tempted to put it above this line.
# Built workspace packages — whole packages/agents trees (dist/ + each
# package's own package.json + prompts/, still alongside their now-unused
# src/), not a hand-maintained per-package allowlist. The same staleness risk
# build-workspaces.mjs's doc comment warns about for a hardcoded build order
# applies just as much to a hardcoded COPY list: a new package silently
# missing from it is a runtime MODULE_NOT_FOUND, not a build-time error.
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/agents ./agents
COPY --from=builder /app/apps/agent-server/package.json ./apps/agent-server/package.json
COPY --from=builder /app/apps/agent-server/dist ./apps/agent-server/dist

# Cloud Run sets PORT itself; the server also defaults to 8080 if it's ever unset.
ENV PORT=8080
EXPOSE 8080

# The official image's pre-existing, non-root "node" user (uid 1000) — no
# separate useradd step needed.
USER node

# Exec form: node is PID 1 and receives SIGTERM directly, no shell in
# between to swallow it — both src/server.ts's and src/queue-consumer.ts's
# own graceful-shutdown handlers depend on actually receiving that signal.
# Default target is the HTTP server; the worker deployment overrides args
# (see cloudbuild.yaml) to run apps/agent-server/dist/queue-consumer.js
# instead — same image, same node_modules, different entrypoint.
CMD ["node", "apps/agent-server/dist/server.js"]
