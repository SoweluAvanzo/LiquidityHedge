# syntax=docker/dockerfile:1
# LH Platform web app — hardened multi-stage image.
# Build context MUST be the repo root (the runtime needs product-design/legal
# for the master-terms hash):  docker build -f platform/apps/web/Dockerfile .

FROM node:22-alpine AS build
RUN npm i -g pnpm@11
WORKDIR /app

# Workspace manifests first (layer caching), then sources.
COPY platform/pnpm-workspace.yaml platform/package.json platform/pnpm-lock.yaml platform/tsconfig.base.json platform/
COPY platform/packages platform/packages
COPY platform/services platform/services
COPY platform/apps/web platform/apps/web
COPY product-design/legal product-design/legal

WORKDIR /app/platform
RUN pnpm install --frozen-lockfile

WORKDIR /app/platform/apps/web
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# ── Runtime: minimal, non-root, standalone server ────────────────────
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app

# Standalone bundle mirrors the pnpm workspace root (platform/).
COPY --from=build --chown=node:node /app/platform/apps/web/.next/standalone ./platform/
COPY --from=build --chown=node:node /app/platform/apps/web/.next/static ./platform/apps/web/.next/static
# Static assets (llms.txt, favicon). The build stage always has this
# directory, so the copy is safe even when it is otherwise empty.
COPY --from=build --chown=node:node /app/platform/apps/web/public ./platform/apps/web/public
# Legal corpus for the master-terms hash (ancestor walk from cwd).
COPY --from=build --chown=node:node /app/product-design/legal ./product-design/legal

WORKDIR /app/platform/apps/web
# Event-log persistence lives here — mounted as a volume in compose.
RUN mkdir -p .data && chown node:node .data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/ || exit 1
CMD ["node", "server.js"]
