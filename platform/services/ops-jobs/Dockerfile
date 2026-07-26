# syntax=docker/dockerfile:1
# One-shot regime updater (invoke via host cron / compose profile "jobs").
# Build context = repo root:  docker build -f platform/services/ops-jobs/Dockerfile .

FROM node:22-alpine
RUN npm i -g pnpm@11
WORKDIR /app/platform

COPY platform/pnpm-workspace.yaml platform/package.json platform/pnpm-lock.yaml platform/tsconfig.base.json ./
COPY platform/packages ./packages
COPY platform/services ./services
RUN pnpm install --frozen-lockfile --filter @lh/ops-jobs...

USER node
WORKDIR /app/platform/services/ops-jobs
CMD ["pnpm", "regime-once"]
