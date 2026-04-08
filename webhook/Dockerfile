# ---- build stage ----
# Use host platform so go mod download/build runs natively (no QEMU).
# TARGETOS/TARGETARCH are injected by buildx for cross-compilation.
FROM --platform=$BUILDPLATFORM mirror.gcr.io/library/golang:1.23-alpine AS builder
ARG TARGETOS=linux
ARG TARGETARCH=amd64

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

COPY main.go ./
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags="-s -w" -o /webhook .

# ---- runtime stage ----
FROM mirror.gcr.io/library/alpine:3.19

RUN addgroup -S webhook && adduser -S webhook -G webhook
USER webhook

COPY --from=builder /webhook /webhook

EXPOSE 8080
ENTRYPOINT ["/webhook"]
