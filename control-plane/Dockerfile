# syntax=docker/dockerfile:1
# Multi-stage build for dotCMS Control Plane (Next.js 16 standalone)
# Build context: hetzner-k3s/ (parent directory)
#   docker build -f control-plane/Dockerfile -t dotcms/trial-control-plane:latest .

# ── Stage 1: install dependencies ────────────────────────────────────────────
FROM mirror.gcr.io/node:22-alpine AS deps
WORKDIR /app

COPY control-plane/package.json control-plane/package-lock.json ./
RUN npm ci --omit=dev

# ── Stage 2: build ───────────────────────────────────────────────────────────
FROM mirror.gcr.io/node:22-alpine AS builder
WORKDIR /app

COPY control-plane/package.json control-plane/package-lock.json ./
RUN npm ci

COPY control-plane/ .
RUN npm run build

# ── Stage 3: production image ─────────────────────────────────────────────────
FROM mirror.gcr.io/node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Install kubectl for the worker (Step 7: kubectl apply -k)
RUN apk add --no-cache curl && \
    KUBECTL_VERSION=$(curl -fsSL https://dl.k8s.io/release/stable.txt) && \
    curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl" -o /usr/local/bin/kubectl && \
    chmod +x /usr/local/bin/kubectl

RUN addgroup --system --gid 1001 nodejs && \
    adduser  --system --uid 1001 nextjs

# Standalone output
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static    ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public          ./public

# kustomize base — tenant overlays reference ../../dotcms-base relative to their dir
COPY --chown=nextjs:nodejs kustomize/dotcms-base /app/kustomize/dotcms-base
RUN mkdir -p /app/kustomize/tenants && chown nextjs:nodejs /app/kustomize/tenants

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
