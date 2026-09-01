ARG BUN_VERSION=1.3.9
ARG CLOUDFLARED_VERSION=2026.8.3

FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION} AS builder

WORKDIR /app

COPY package.json bun.lock ./
COPY patches/ patches/
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ src/

ARG TARGETARCH
RUN case "$TARGETARCH" in \
      amd64) target=bun-linux-x64 ;; \
      arm64) target=bun-linux-arm64 ;; \
      *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && bun build --compile --target="$target" --outfile=/fileslop src/index.ts

FROM cloudflare/cloudflared:${CLOUDFLARED_VERSION} AS cloudflared

FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 fileslop \
    && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin fileslop \
    && mkdir /storage \
    && chown fileslop:fileslop /storage

COPY --from=builder /fileslop /usr/local/bin/fileslop
COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/cloudflared

ENV STORAGE_ROOT=/storage

USER 10001:10001
EXPOSE 3000

# fileslop runs as PID 1 and directly supervises cloudflared, so it needs no init process.
ENTRYPOINT ["/usr/local/bin/fileslop"]
