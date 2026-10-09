# RT-Gaia images.
# One runtime image runs the API (default) or the job worker (`command: rtgaia-worker`); the `web` stage is nginx with the built frontend.
#
# Four stages: Rust kernel (wasm + .so) → frontend build → Python (uv) runtime → nginx web.
#
# The runtime stage must COPY *all* workspace members (`members` in pyproject): `rtgaia-core` depends on `rtgaia-plugin-sdk`,
# and the SDK wheel force-includes `packages/rtgaia-plugin-api/schemas` and `openapi.yaml`. With any member missing,
# `uv sync --frozen` fails with `Distribution not found`.

FROM rust:1.83-bookworm AS kernel
RUN rustup target add wasm32-unknown-unknown
WORKDIR /src
COPY packages/rtgaia-reslice packages/rtgaia-reslice
COPY scripts/build-kernel.sh scripts/build-kernel.sh
RUN mkdir -p apps/viewer/public packages/rtgaia-geom/src/rtgaia_geom/_native && ./scripts/build-kernel.sh

FROM node:22-bookworm AS frontend
WORKDIR /src/apps/viewer
COPY apps/viewer/package.json apps/viewer/package-lock.json ./
RUN npm ci
COPY apps/viewer ./
COPY --from=kernel /src/apps/viewer/public/rtgaia_reslice.wasm public/rtgaia_reslice.wasm
RUN npx vite build

FROM python:3.12-slim-bookworm AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libegl1 libxrender1 libgomp1 && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
COPY packages/rtgaia-geom packages/rtgaia-geom
COPY packages/rtgaia-core packages/rtgaia-core
COPY packages/rtgaia-server packages/rtgaia-server
COPY packages/rtgaia-testbe packages/rtgaia-testbe
COPY packages/rtgaia-plugin-sdk packages/rtgaia-plugin-sdk
COPY packages/rtgaia-plugin-api packages/rtgaia-plugin-api
COPY --from=kernel /src/packages/rtgaia-geom/src/rtgaia_geom/_native/librtgaia_reslice.so packages/rtgaia-geom/src/rtgaia_geom/_native/
COPY --from=frontend /src/apps/viewer/dist /app/static
RUN uv sync --all-packages --no-dev --frozen
ENV PATH="/app/.venv/bin:$PATH" RTGAIA_LIBRARY_ROOT=/data/library RTGAIA_DATA_DIR=/data/rtgaia RTGAIA_HOST=0.0.0.0
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --retries=12 CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=3).status == 200 else 1)"]
# The production image runs `rtgaia-server` (no `--test-api`; /api/v1/_test is never mounted); development uses `rtgaia-testbe`
CMD ["rtgaia-server", "--host", "0.0.0.0", "--port", "8080", "--library", "/data/library", "--data-dir", "/data/rtgaia"]

# ── web: nginx with the built frontend ──
FROM nginx:1.27-alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=frontend /src/apps/viewer/dist /usr/share/nginx/html
