# Custom CNPG-compatible PostgreSQL 18 image with pgvector + pgvectorscale.
# Extends the official CNPG image to retain barman-cloud and instance manager.
ARG PG_VERSION=18
ARG PGVECTOR_VERSION=0.8.2
ARG PGVECTORSCALE_VERSION=0.9.0

FROM ghcr.io/cloudnative-pg/postgresql:${PG_VERSION}

ARG PG_VERSION
ARG PGVECTOR_VERSION
ARG PGVECTORSCALE_VERSION

USER root

RUN apt-get update \
    # postgresql-server-dev-18 comes from the PGDG repo already configured in image
    && apt-get install -y --no-install-recommends \
        build-essential \
        git \
        wget \
        unzip \
        zstd \
        binutils \
        "postgresql-server-dev-${PG_VERSION}" \
    \
    # ── pgvector ────────────────────────────────────────────────────────────
    && git clone --depth 1 --branch "v${PGVECTOR_VERSION}" \
        https://github.com/pgvector/pgvector.git /tmp/pgvector \
    && cd /tmp/pgvector \
    && make PG_CONFIG=/usr/bin/pg_config \
    && make install PG_CONFIG=/usr/bin/pg_config \
    && rm -rf /tmp/pgvector \
    \
    # ── pgvectorscale ────────────────────────────────────────────────────────
    # Release zips contain arch-specific .deb files
    && ARCH="$(dpkg --print-architecture)" \
    && wget -q -O /tmp/pgvscale.zip \
        "https://github.com/timescale/pgvectorscale/releases/download/${PGVECTORSCALE_VERSION}/pgvectorscale-${PGVECTORSCALE_VERSION}-pg${PG_VERSION}-${ARCH}.zip" \
    && unzip -j /tmp/pgvscale.zip "pgvectorscale-postgresql-${PG_VERSION}_*.deb" -d /tmp/pgvscale/ \
    # dpkg on Debian Bullseye doesn't support zst-compressed debs — extract manually
    && cd /tmp/pgvscale \
    && ar x pgvectorscale-postgresql-${PG_VERSION}_*.deb \
    && zstd -d data.tar.zst -o data.tar \
    && tar -x -C / -f data.tar \
    && cd / && rm -rf /tmp/pgvscale.zip /tmp/pgvscale \
    \
    # ── Cleanup ─────────────────────────────────────────────────────────────
    && apt-get purge -y build-essential git wget unzip zstd binutils "postgresql-server-dev-${PG_VERSION}" \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# CNPG runs as uid 26 (postgres)
USER 26
