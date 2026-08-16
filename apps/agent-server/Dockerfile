# syntax=docker/dockerfile:1
#
# Build from the REPO ROOT (this is an npm-workspaces monorepo — the build
# context has to include every workspace package this server depends on):
#
#   docker build -f apps/agent-server/Dockerfile -t agent-server .
#
# Not build-tested against a real Docker daemon in the environment this was
# written in — review the two stages below before relying on it in CI.

########################################
# Stage 1: install + build every workspace package this server depends on,
# in explicit dependency order. `npm run build --workspaces` doesn't
# guarantee topological order, so each package is built one at a time,
# leaves first.
########################################
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
COPY packages ./packages
COPY agents ./agents
COPY apps ./apps

RUN npm ci

RUN npm run build --workspace=@agent-engine/core \
 && npm run build --workspace=@agent-engine/telemetry \
 && npm run build --workspace=@agent-engine/tool-common \
 && npm run build --workspace=@agent-engine/tool-karos-client \
 && npm run build --workspace=@agent-engine/tool-karos-gates \
 && npm run build --workspace=@agent-engine/tool-karos-ledger \
 && npm run build --workspace=@agent-engine/tool-karos-memory \
 && npm run build --workspace=@agent-engine/tool-karos-publish \
 && npm run build --workspace=@agent-engine/tool-karos-research \
 && npm run build --workspace=@agent-engine/tool-karos-topics \
 && npm run build --workspace=@agent-engine/tools \
 && npm run build --workspace=@agent-engine/workflow \
 && npm run build --workspace=@agent-engine/agent-x \
 && npm run build --workspace=@agent-engine/agent-linkedin \
 && npm run build --workspace=@agent-engine/agent-reddit \
 && npm run build --workspace=@agent-engine/agent-blog \
 && npm run build --workspace=@agent-engine/agent-newsletter \
 && npm run build --workspace=@agent-engine/campaign-orchestrator \
 && npm run build --workspace=@agent-engine/agent-server

########################################
# Stage 2: the runtime image — node_modules (workspace symlinks + real
# deps), each package's own dist/ + package.json, and the prompt markdown
# files FilePromptStore reads from disk (PROMPT_STORE_DRIVER=file, or as a
# Vertex/Firestore fallback store). No src/, no devDependencies-only tools,
# no test files.
########################################
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules

COPY --from=builder /app/packages/core/package.json ./packages/core/package.json
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/telemetry/package.json ./packages/telemetry/package.json
COPY --from=builder /app/packages/telemetry/dist ./packages/telemetry/dist
COPY --from=builder /app/packages/tools/common/package.json ./packages/tools/common/package.json
COPY --from=builder /app/packages/tools/common/dist ./packages/tools/common/dist
COPY --from=builder /app/packages/tools/karos-client/package.json ./packages/tools/karos-client/package.json
COPY --from=builder /app/packages/tools/karos-client/dist ./packages/tools/karos-client/dist
COPY --from=builder /app/packages/tools/karos-gates/package.json ./packages/tools/karos-gates/package.json
COPY --from=builder /app/packages/tools/karos-gates/dist ./packages/tools/karos-gates/dist
COPY --from=builder /app/packages/tools/karos-ledger/package.json ./packages/tools/karos-ledger/package.json
COPY --from=builder /app/packages/tools/karos-ledger/dist ./packages/tools/karos-ledger/dist
COPY --from=builder /app/packages/tools/karos-memory/package.json ./packages/tools/karos-memory/package.json
COPY --from=builder /app/packages/tools/karos-memory/dist ./packages/tools/karos-memory/dist
COPY --from=builder /app/packages/tools/karos-publish/package.json ./packages/tools/karos-publish/package.json
COPY --from=builder /app/packages/tools/karos-publish/dist ./packages/tools/karos-publish/dist
COPY --from=builder /app/packages/tools/karos-research/package.json ./packages/tools/karos-research/package.json
COPY --from=builder /app/packages/tools/karos-research/dist ./packages/tools/karos-research/dist
COPY --from=builder /app/packages/tools/karos-topics/package.json ./packages/tools/karos-topics/package.json
COPY --from=builder /app/packages/tools/karos-topics/dist ./packages/tools/karos-topics/dist
COPY --from=builder /app/packages/tools/package.json ./packages/tools/package.json
COPY --from=builder /app/packages/tools/dist ./packages/tools/dist
COPY --from=builder /app/packages/workflow/package.json ./packages/workflow/package.json
COPY --from=builder /app/packages/workflow/dist ./packages/workflow/dist

COPY --from=builder /app/agents/x-agent/package.json ./agents/x-agent/package.json
COPY --from=builder /app/agents/x-agent/dist ./agents/x-agent/dist
COPY --from=builder /app/agents/x-agent/prompts ./agents/x-agent/prompts
COPY --from=builder /app/agents/linkedin-agent/package.json ./agents/linkedin-agent/package.json
COPY --from=builder /app/agents/linkedin-agent/dist ./agents/linkedin-agent/dist
COPY --from=builder /app/agents/linkedin-agent/prompts ./agents/linkedin-agent/prompts
COPY --from=builder /app/agents/reddit-agent/package.json ./agents/reddit-agent/package.json
COPY --from=builder /app/agents/reddit-agent/dist ./agents/reddit-agent/dist
COPY --from=builder /app/agents/reddit-agent/prompts ./agents/reddit-agent/prompts
COPY --from=builder /app/agents/blog-agent/package.json ./agents/blog-agent/package.json
COPY --from=builder /app/agents/blog-agent/dist ./agents/blog-agent/dist
COPY --from=builder /app/agents/blog-agent/prompts ./agents/blog-agent/prompts
COPY --from=builder /app/agents/newsletter-agent/package.json ./agents/newsletter-agent/package.json
COPY --from=builder /app/agents/newsletter-agent/dist ./agents/newsletter-agent/dist
COPY --from=builder /app/agents/newsletter-agent/prompts ./agents/newsletter-agent/prompts
COPY --from=builder /app/agents/campaign-orchestrator/package.json ./agents/campaign-orchestrator/package.json
COPY --from=builder /app/agents/campaign-orchestrator/dist ./agents/campaign-orchestrator/dist
COPY --from=builder /app/agents/campaign-orchestrator/prompts ./agents/campaign-orchestrator/prompts

COPY --from=builder /app/apps/agent-server/package.json ./apps/agent-server/package.json
COPY --from=builder /app/apps/agent-server/dist ./apps/agent-server/dist

# Cloud Run sets PORT itself; the server also defaults to 8080 if it's ever unset.
ENV PORT=8080
EXPOSE 8080

# The official image's pre-existing, non-root "node" user (uid 1000) — no
# separate useradd step needed.
USER node

# Exec form: node is PID 1 and receives SIGTERM directly, no shell in
# between to swallow it — src/server.ts's graceful-drain handler depends on
# actually receiving that signal.
CMD ["node", "apps/agent-server/dist/server.js"]
