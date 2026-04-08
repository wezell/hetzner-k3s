# Build Caddy with the cname_router and caddy-storage-redis plugins.
# Uses --platform=$BUILDPLATFORM so xcaddy/go run natively (no QEMU).
# Cross-compilation happens via GOOS/GOARCH at go build time.
FROM --platform=$BUILDPLATFORM caddy:builder AS builder
ARG TARGETOS=linux
ARG TARGETARCH=amd64

COPY . /plugin

RUN GOOS=${TARGETOS} GOARCH=${TARGETARCH} xcaddy build \
    --with github.com/dotcms/caddy-cname-router=/plugin \
    --with github.com/pberkel/caddy-storage-redis

FROM caddy:latest
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
