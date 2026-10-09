# RT-Gaia administration guide

This guide is for administrators and hospital IT staff who install, configure and operate RT-Gaia.
It covers installation from source and with Docker Compose, configuration, accounts, DICOM
networking, storage, backups, upgrades, plugins, security and monitoring.

> **Regulatory status.** RT-Gaia is research software. It is not a medical device, has not been
> cleared or approved by any regulatory authority, and must not be used for clinical decision
> making. Use only de-identified data for testing and demonstrations.

Related documents: [User guide](user-guide.md) · [Architecture](architecture.md) ·
[Plugins](plugins.md) · [DICOM Conformance Statement](dicom-conformance.md) ·
[Security policy](../SECURITY.md)

## Contents

1. [Components](#components)
2. [System requirements](#system-requirements)
3. [Installing from source](#installing-from-source)
4. [Deploying with Docker Compose](#deploying-with-docker-compose)
5. [Configuration reference](#configuration-reference)
6. [Accounts and roles](#accounts-and-roles)
7. [Audit log](#audit-log)
8. [DICOM networking](#dicom-networking)
9. [Storage](#storage)
10. [Backup and restore](#backup-and-restore)
11. [Upgrading](#upgrading)
12. [Plugins](#plugins)
13. [Resource limits](#resource-limits)
14. [Network and security](#network-and-security)
15. [Patient data](#patient-data)
16. [Monitoring](#monitoring)
17. [Troubleshooting](#troubleshooting)

## Components

| Component | Command or image | Role |
|---|---|---|
| API server | `rtgaia-server` | The backend: HTTP API under `/api/v1`, WebSocket push, server-side 3D rendering, and periodic tasks (trash purge, disk capacity check, integrity check, plugin health checks, audit retry). By default it also runs queued jobs and, when enabled, the DICOM receiver. |
| Job worker | `rtgaia-worker` | Optional separate process that runs queued jobs: RTSTRUCT export, imports of received DICOM, C-STORE sends, C-MOVE/C-GET retrievals and plugin dispatch. Requires PostgreSQL. |
| DICOM receiver | `rtgaia-scp` | Optional separate process for the Storage SCP. Requires PostgreSQL. By default the API process runs the receiver itself. |
| Database | PostgreSQL 16 | Catalog, accounts, cases and structure versions, jobs, audit log, DICOM nodes, settings, plugin registrations. |
| Web server | nginx (`web` image) | Serves the built frontend, proxies `/api/` (including WebSocket), `/healthz` and `/readyz` to the API, and sets the cross-origin isolation headers. |
| Plugins | separate HTTP services | Optional out-of-process services registered by an administrator. See [Plugins](#plugins). |

```text
Browser ── HTTP(S) ──▶ web (nginx) ── /api/, WebSocket ──▶ api (rtgaia-server, port 8080)

api ◀──▶ PostgreSQL 16 ◀──▶ worker (rtgaia-worker)                (job queue, events)
api or worker ── run requests ──▶ plugins (HTTP services) ── callbacks ──▶ api
api or worker ── C-ECHO, C-FIND, C-MOVE, C-GET, C-STORE ──▶ PACS / TPS
PACS / TPS ── C-STORE ──▶ receiver (Storage SCP, port 11112; inside the api or rtgaia-scp)
```

Run exactly one API process. The API keeps interactive state in memory (open cases, push
connections, 3D scenes, unsaved plugin and dose-operation results), so several API processes
behind a load balancer are not supported. You can run more than one job worker; they share the
job queue in PostgreSQL.

### Operating modes

| Mode | Use | Behavior |
|---|---|---|
| With a database (`RTGAIA_DB_URL` set) | Any shared or persistent installation | Sign-in is required by default. Catalog, cases, structure versions, jobs, audit log, DICOM nodes and settings are stored in PostgreSQL. |
| Without a database | Single-user development and evaluation | No sign-in: every request is treated as an administrator unless a client sends other identity headers. The catalog lives in memory with a JSON cache; cases, nodes and settings are lost when the process stops. Deleted structures are removed immediately (no trash or archive). |

Never run the mode without a database on a network that other people can reach.

## System requirements

### Server

| Item | Requirement |
|---|---|
| Operating system | Linux. The container images are based on Debian 12 (bookworm). |
| Container deployment | Docker Engine with the Compose plugin (`docker compose`). |
| Database | PostgreSQL 16 (the version used by the compose file and the test suite). |
| Python | 3.11 or later, managed with [uv](https://docs.astral.sh/uv/). The container image uses Python 3.12. |
| Build tools (source installs) | Node.js 22.15 or later with npm, and a stable Rust toolchain with the `wasm32-unknown-unknown` target. |
| Off-screen rendering libraries | The runtime image installs `libgl1`, `libegl1`, `libxrender1` and `libgomp1` for VTK. Install the equivalent packages on a source installation. |
| GPU | Not required. See below. |
| Disk | Space for the DICOM library, the structure and export store, and the caches (by default up to 20 GiB for the voxel cache and 2 GiB for the mesh cache). |

**GPU use.** Two-dimensional views are rendered in the browser on the CPU. The 3D view is rendered
on the server with VTK through an off-screen (EGL) window: VTK uses GPU ray casting when an OpenGL
device is available to the API process and CPU ray casting otherwise. If VTK cannot render at all
(for example, no OpenGL device in a container), the 3D view falls back to a server-side maximum
intensity projection (MIP). The `api` service in the compose file does not reserve a GPU. Plugins
are separate services with their own requirements; the example nnU-Net plugin service in the compose
file reserves one NVIDIA GPU.

### Browser

RT-Gaia runs in a current web browser with WebAssembly support; no GPU and no browser plug-ins are
required. The automated UI checks of the project run in Chrome. Serve RT-Gaia over HTTPS (see
[Network and security](#network-and-security)).

## Installing from source

### Prerequisites

| Tool | Version | Used for |
|---|---|---|
| Python with uv | 3.11+ | Backend packages and the `rtgaia-*` commands |
| Node.js with npm | 22.15+ | Building the frontend |
| Rust (stable) | with `wasm32-unknown-unknown` (`rustup target add wasm32-unknown-unknown`) | The reslice kernel (native library and WebAssembly) |
| PostgreSQL | 16 | Persistence, accounts, jobs, audit log |

### Build

```sh
git clone <repository-url> rt-gaia
cd rt-gaia
uv sync --all-packages              # Python packages and the rtgaia-server, rtgaia-worker, rtgaia-scp commands
(cd apps/viewer && npm ci)          # frontend dependencies
./scripts/build-kernel.sh           # Rust reslice kernel: native library and WebAssembly module
(cd apps/viewer && npm run build)   # production frontend in apps/viewer/dist
```

`scripts/build-kernel.sh` runs the kernel tests, copies the native library to
`packages/rtgaia-geom/src/rtgaia_geom/_native/` and the WebAssembly module to
`apps/viewer/public/`. Build the kernel before the frontend so that the bundle includes the
WebAssembly module. If the API cannot find the native library, it reports
`CPU reslice kernel not found`; set `RTGAIA_RESLICE_LIB` to the library path if you keep it
elsewhere.

### Development environment

```sh
./scripts/dev-db.sh       # optional: PostgreSQL 16 in Docker, prints the URLs to export
./scripts/dev.sh          # API on a free port from 8080 and the frontend on http://localhost:5173
```

`scripts/dev-db.sh` starts a `postgres:16` container bound to `127.0.0.1:5433` with two databases,
`rtgaia` and `rtgaia_test`, and prints the matching `RTGAIA_DB_URL` and `RTGAIA_TEST_DB_URL`.
`./scripts/dev-db.sh stop` stops it and `./scripts/dev-db.sh destroy` deletes it with its data.

`scripts/dev.sh` is for development only:

- It runs `rtgaia-testbe --test-api`, which mounts test endpoints under `/api/v1/_test/`. These
  endpoints bypass ownership checks, sign-off locks and the audit log.
- It binds to all network interfaces by default. Use `HOST=127.0.0.1 ./scripts/dev.sh` to bind to
  the local machine only.
- Without `RTGAIA_DB_URL` there is no sign-in.
- `./scripts/dev.sh dicom:/path/to/case` loads one DICOM case directory at startup;
  `WEB=build ./scripts/dev.sh` serves a production build of the frontend instead of the Vite
  development server, which is much faster over slow remote connections.

Do not use `scripts/dev.sh` with real patient data or on a network that others can reach.

### Production installation without containers

1. Create a PostgreSQL 16 database and a database user for RT-Gaia.
2. Choose a library root (DICOM files) and a data directory. Keep the data directory outside the
   library root, or give it a name that starts with a dot: the library scan indexes every
   directory whose name does not start with a dot.
3. Create a dedicated, unprivileged operating system account and run all RT-Gaia processes under
   it.
4. Set the environment for the API (see [Configuration reference](#configuration-reference)):

   ```sh
   export RTGAIA_DB_URL='postgresql+asyncpg://rtgaia:<password>@db.example.org:5432/rtgaia'
   export RTGAIA_SECRET='<long random string>'
   export RTGAIA_PUBLIC_URL='https://rtgaia.example.org'
   ```

5. Start the API. Its defaults are `--host 127.0.0.1` and `--port 8080`:

   ```sh
   uv run rtgaia-server --host 127.0.0.1 --port 8080 \
     --library /srv/rtgaia/library --data-dir /srv/rtgaia/data
   ```

6. Optional: run jobs in a separate process. Set `RTGAIA_INPROCESS_WORKER=0` for the API and start
   the worker with the same environment (see [Environment for every process](#environment-for-every-process)):

   ```sh
   uv run rtgaia-worker --library /srv/rtgaia/library --data-dir /srv/rtgaia/data
   ```

7. Serve `apps/viewer/dist` with a web server that also proxies `/api/` (with WebSocket upgrade),
   `/healthz` and `/readyz` to the API. Use `deploy/nginx.conf` as a template: change
   `proxy_pass http://api:8080` to your API address and `root` to the location of the built
   frontend. RT-Gaia must be served at the root path of its host name; it cannot be served under
   a path prefix.
8. Supervise the processes with your service manager.

The `rtgaia-server` options `--latency`, `--chaos`, `--load` and `--data` are development aids;
do not use them in production.

## Deploying with Docker Compose

The `deploy/` directory contains a multi-stage `Dockerfile`, `docker-compose.yml`, `nginx.conf`
and `.env.example`.

### Images

| Stage | Base | Content |
|---|---|---|
| `kernel` | `rust:1.83-bookworm` | Builds the reslice kernel (native library and WebAssembly) with `scripts/build-kernel.sh`. |
| `frontend` | `node:22-bookworm` | `npm ci` and `vite build` of `apps/viewer`. |
| `runtime` | `python:3.12-slim-bookworm` | Python packages (`uv sync --all-packages --no-dev --frozen`), the native kernel and the rendering libraries. Default command: `rtgaia-server --host 0.0.0.0 --port 8080 --library /data/library --data-dir /data/rtgaia`. Used by the `api` and `worker` services. |
| `web` | `nginx:1.27-alpine` | The built frontend and `deploy/nginx.conf`. |

### Services

| Service | Profile | Description |
|---|---|---|
| `postgres` | default | `postgres:16`, database `rtgaia`, user `rtgaia`. |
| `api` | default | `rtgaia-server`. Runs with `RTGAIA_INPROCESS_WORKER=0`; port 8080 is reachable only inside the compose network. Health check: `/readyz`. |
| `worker` | default | `rtgaia-worker`. Health check: the heartbeat file must have been touched within the last 90 seconds. |
| `web` | default | nginx; publishes `${RTGAIA_HTTP_PORT:-80}` on the host. Starts after `api` is healthy. |
| `plugin-nnunet` | `plugins` | Example nnU-Net auto-contouring plugin. Reserves one NVIDIA GPU. |
| `seg-server` | `seg-server` | Remote inference service for the example plugin, for a separate GPU machine. Publishes `${RTGAIA_SEG_SERVER_PORT:-8710}`. |

### Environment for every process

The `api` and `worker` services must see the same values for the settings that both of them use.
The compose file passes `RTGAIA_SECRET`, `RTGAIA_PUBLIC_URL` and `RTGAIA_PHI_KEY` to both:

- When the worker imports received DICOM, it stores a keyed hash of each patient name. The key is
  `RTGAIA_PHI_KEY`, or is derived from `RTGAIA_SECRET`; with a different key the worker's hashes
  would not match those written by the API.
- The worker dispatches plugin jobs and builds the plugin callback address from
  `RTGAIA_PUBLIC_URL`.

If you set `RTGAIA_UID_ROOT`, `RTGAIA_IMPLEMENTATION_CLASS_UID` or `RTGAIA_EXPORT_PROFILE`, set them
for both services too: RTSTRUCT export jobs run in the worker, and RT Dose files are built in the
API.

Keep such site-specific changes in a separate override file so that the shipped compose file stays
unchanged across upgrades. Create `deploy/docker-compose.site.yml`, for example:

```yaml
services:
  api:
    environment:
      RTGAIA_UID_ROOT: ${RTGAIA_UID_ROOT}
  worker:
    environment:
      RTGAIA_UID_ROOT: ${RTGAIA_UID_ROOT}
```

The examples in this guide use a shell function that loads both files. Define it in your shell and
run it from the repository root:

```sh
rtgaia_compose() { docker compose --env-file deploy/.env -f deploy/docker-compose.yml -f deploy/docker-compose.site.yml "$@"; }
```

### Deploy

1. Create the environment file and restrict its permissions:

   ```sh
   cp deploy/.env.example deploy/.env
   chmod 600 deploy/.env
   ```

2. Edit `deploy/.env`:

   | Variable | Set to |
   |---|---|
   | `RTGAIA_SECRET` | A long random string, for example the output of `openssl rand -hex 32`. Required. |
   | `POSTGRES_PASSWORD` | A strong password. The PostgreSQL image applies it only when it initializes an empty data directory. |
   | `RTGAIA_PUBLIC_URL` | The URL users type in the browser, for example `https://rtgaia.example.org`. Required. Plugins call back to this address, and API requests must use its host name (see [Host name validation](#host-name-validation)). |
   | `RTGAIA_HTTP_PORT` | The host port for the `web` service (default `80`). |
   | `RTGAIA_ALLOWED_HOSTS` | Optional. See [Host name validation](#host-name-validation). |

3. Create `deploy/docker-compose.site.yml` as shown above (it may be empty: `services: {}`).
4. Build and start:

   ```sh
   rtgaia_compose up -d --build
   rtgaia_compose ps            # wait until api and worker are healthy
   ```

5. Open `RTGAIA_PUBLIC_URL` in a browser right away and create the first administrator (see
   [First administrator](#first-administrator)). Until you do, anyone who can reach the page can
   claim the administrator account.
6. Check readiness: `curl -fsS https://rtgaia.example.org/readyz`.

<!-- screenshot: admin-first-administrator — the "Create the first administrator" form on a fresh deployment -->

### Data volumes

| Host path (under `deploy/`) | Container path | Content |
|---|---|---|
| `volumes/library` | `/data/library` | DICOM library root (`api`, `worker`) |
| `volumes/rtgaia` | `/data/rtgaia` | Data directory: structure and export store, caches, staging (`api`, `worker`) |
| `volumes/pg` | `/var/lib/postgresql/data` | PostgreSQL data (`postgres`) |
| `volumes/plugin-nnunet`, `volumes/models` | `/data`, `/models` | Example plugin data and model weights |

See [Storage](#storage) for the layout inside the library root and the data directory.

### Receiving DICOM

The compose file does not publish the DICOM receiver port, and the receiver is off by default. To
receive DICOM:

1. Add the port to `deploy/docker-compose.site.yml`:

   ```yaml
   services:
     api:
       ports:
         - "11112:11112"
   ```

2. Apply the change with `rtgaia_compose up -d`.
3. In RT-Gaia, open **Service settings**, select **Receiver (SCP) on**, check that
   **Receiver port** matches the published port, and select **Save**.
4. Register every sending system as a DICOM node with the receive role (see
   [DICOM networking](#dicom-networking)).
5. Allow the port in your firewall only from the PACS and TPS addresses that need it.

### Running the receiver as a separate container

To keep receiving DICOM while the API restarts, run `rtgaia-scp` as its own service and tell the
API not to start a receiver. Add to `deploy/docker-compose.site.yml`:

```yaml
services:
  api:
    environment:
      RTGAIA_SCP_OWNER: "0"
  scp:
    build:
      context: ..
      dockerfile: deploy/Dockerfile
      target: runtime
    command: ["rtgaia-scp", "--library", "/data/library", "--data-dir", "/data/rtgaia"]
    environment:
      RTGAIA_DB_URL: postgresql+asyncpg://rtgaia:${POSTGRES_PASSWORD:-rtgaia}@postgres:5432/rtgaia
    volumes:
      - ./volumes/library:/data/library
      - ./volumes/rtgaia:/data/rtgaia
    ports:
      - "11112:11112"
    depends_on:
      postgres:
        condition: service_healthy
    healthcheck:
      disable: true   # the image's default health check probes the HTTP API, which this process does not serve
    restart: unless-stopped
```

`rtgaia-scp` reads the receiver settings from the database and starts listening when it starts,
even if **Receiver (SCP) on** is cleared; it applies changes to **Service settings**, including
that switch, when an administrator saves them. It stages received instances in the shared data
directory, and the worker imports them. **Receiver status** in **Service settings** reports only a
receiver inside the API process, so in this setup it states that the API does not run one.

### Plugins profile

```sh
rtgaia_compose --profile plugins up -d --build
```

Before you build the plugin image:

- Build the plugin's UI bundle; the image copies `examples/plugin-nnunet/ui/dist`. See
  `examples/plugin-nnunet/README.md`.
- The image installs `rtgaia-plugin-sdk` and `rtgaia-geom` from the RT-Gaia Git repository
  (`examples/plugin-nnunet/requirements.txt`), so the build needs network access to it.
- Change the bearer token: set `RTGAIA_PLUGIN_NNUNET_TOKEN` in `deploy/.env` (default
  `change-me`).
- The service reserves one NVIDIA GPU, which requires the NVIDIA Container Toolkit.
- The default engine uses TotalSegmentator weights, which are licensed CC BY-NC-SA 4.0
  (non-commercial). Check that this license fits your use.
- The plugin calls back to `RTGAIA_PUBLIC_URL`. That address must be reachable from inside the
  plugin container; `http://localhost` is not.

Then register the plugin in RT-Gaia with the endpoint `http://plugin-nnunet:8702` and the token
(see [Plugins](#plugins)).

### Smoke test

`scripts/compose-smoke.sh <url>` checks a deployment: `/healthz`, `/readyz`, the index page, the
JavaScript and WebAssembly MIME types, the web app manifest, COOP/COEP and cache headers, gzip,
sign-in, two API calls, the WebSocket upgrade and the rejection of a forged `Host` header.

The script is meant for a fresh, disposable deployment. If no account exists yet, it creates the
first administrator, `smoke-admin`, with a password that is written in the script. On a
deployment that already has accounts it fails at the sign-in step. Do not run it against your
production instance; if you did, disable `smoke-admin` or reset its password immediately.

### Web server notes

`deploy/nginx.conf`:

- accepts request bodies up to 4 GiB (`client_max_body_size 4g`), matching the default import limit;
- proxies `/api/` with WebSocket upgrade and a one-hour read timeout, and forwards `Host`,
  `X-Forwarded-For` and `X-Forwarded-Proto`;
- adds `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`
  to every response;
- serves hashed assets under `/assets/` with a one-year immutable cache and returns 404 for
  missing assets; `index.html` and unhashed files are revalidated on every request;
- compresses text assets and WebAssembly with gzip.

If you place another reverse proxy in front of it, make sure that proxy allows WebSocket upgrades
on `/api/`, long-lived connections and large request bodies.

## Configuration reference

RT-Gaia is configured with environment variables, command-line options and, for DICOM settings,
the database:

- Command-line options of `rtgaia-server`, `rtgaia-worker` and `rtgaia-scp` (`--library`,
  `--data-dir`, `--db-url`, `--public-url`, `--show-patient-names`, `--host`, `--port`) take
  precedence over the corresponding environment variables.
- DICOM settings use the environment variables only as defaults. Values that an administrator
  saves in **Service settings** are stored in the database and take precedence.
- All other variables are read from the environment. Restart the process after you change them.
  **Service settings** › **Process settings** shows the effective values of the main ones.

The **Read by** column shows which processes use a variable: API (`rtgaia-server`), worker
(`rtgaia-worker`), receiver (`rtgaia-scp`). Set shared variables to the same value everywhere.

### Core

| Variable | Default | Read by | Description |
|---|---|---|---|
| `RTGAIA_DB_URL` | not set | all | PostgreSQL URL, `postgresql+asyncpg://user:password@host:port/database`. Enables sign-in, persistence, jobs and the audit log. Required for the worker and the receiver. |
| `RTGAIA_LIBRARY_ROOT` | `./data` if it exists | all | DICOM library root (`--library`). Without it, the library features are unavailable. |
| `RTGAIA_DATA_DIR` | see [Storage layout](#storage-layout) | all | Data directory for the structure and export store, caches and staging (`--data-dir`). |
| `RTGAIA_AUTH` | `required` with a database, `off` without | API | `required` or `off`. `required` needs `RTGAIA_DB_URL` and `RTGAIA_PUBLIC_URL`. With `off` there is no sign-in and requests act as an administrator. |
| `RTGAIA_SECRET` | random at each start | API, worker | Key for signing session tokens; also the source of the patient-name hash key when `RTGAIA_PHI_KEY` is not set. When unset, all users are signed out at every restart. |
| `RTGAIA_PHI_KEY` | derived from `RTGAIA_SECRET` | API, worker | Key for the keyed hash of patient names. Without this variable and without `RTGAIA_SECRET`, a built-in development key is used. Keep it stable. |
| `RTGAIA_PUBLIC_URL` | not set | API, worker | External base URL, `http(s)://host[:port]` without a path (`--public-url`). Required when `RTGAIA_AUTH=required`; the API refuses to start without it. Used for plugin callbacks and as the source of the allowed host names. |
| `RTGAIA_ALLOWED_HOSTS` | host of `RTGAIA_PUBLIC_URL`, `localhost`, `127.0.0.1` | API | Comma-separated host names accepted on `/api/v1/*`. When set, it replaces the default list, so include the host of `RTGAIA_PUBLIC_URL`. |
| `RTGAIA_LIBRARY_SHOW_NAMES` | off | API | `1`, `true` or `yes`: the library page shows patient names (`--show-patient-names`). See [Patient data](#patient-data). |
| `RTGAIA_INPROCESS_WORKER` | `1` | API | `0`, `false` or `no`: the API does not run jobs; run `rtgaia-worker`. |
| `RTGAIA_WORKER_HEARTBEAT_FILE` | not set | worker | File that the worker loop touches about every 5 seconds, for container health checks. |
| `FORWARDED_ALLOW_IPS` | `127.0.0.1` | API | Read by the uvicorn server: addresses whose `X-Forwarded-For` and `X-Forwarded-Proto` headers are trusted. See [HTTPS](#https). |

### Accounts

| Variable | Default | Read by | Description |
|---|---|---|---|
| `RTGAIA_PASSWORD_MIN_LENGTH` | `12` (minimum `8`) | API | Minimum password length. Applies to new passwords. |
| `RTGAIA_LOGIN_MAX_FAILURES` | `5` | API | Consecutive failed sign-ins that lock an account. |
| `RTGAIA_LOGIN_LOCKOUT_MINUTES` | `15` | API | Lockout duration. |
| `RTGAIA_PASSWORD_WORKERS` | `2` | API | Password hashing and verification operations that run at the same time. |

### DICOM

| Variable | Default | Read by | Description |
|---|---|---|---|
| `RTGAIA_AE_TITLE` | `RTGAIA` | all | Default for **Our AE title** (truncated to 16 characters). `rtgaia-scp --ae-title` overrides it for that process. |
| `RTGAIA_SCP` | off | API | `1`, `true` or `yes`: default for **Receiver (SCP) on**. |
| `RTGAIA_SCP_PORT` | `11112` | API, receiver | Default for **Receiver port**. Setting this variable also turns the receiver on by default. |
| `RTGAIA_SCP_HOST` | `0.0.0.0` | API, receiver | Default for **Bind address**. |
| `RTGAIA_SCP_OWNER` | `1` | API | `0`, `false` or `no`: this API process never starts a receiver; use `rtgaia-scp`. |
| `RTGAIA_UID_ROOT` | `1.2.826.0.1.3680043.8.498.` (pydicom) | API, worker | Prefix of the UIDs that RT-Gaia generates for the objects it creates. `2.25` produces UUID-derived UIDs. Digits and dots only, no leading zeros in a component, at most 40 characters; the API refuses to start with an invalid value. |
| `RTGAIA_IMPLEMENTATION_CLASS_UID` | `1.2.826.0.1.3680043.8.498.1` (pydicom) | API, worker | Implementation Class UID written into the file meta information of created files. |
| `RTGAIA_EXPORT_PROFILE` | `varian` | API, worker | Default RTSTRUCT export profile: `varian` or `generic`. See the [DICOM Conformance Statement](dicom-conformance.md). |

### Storage and retention

| Variable | Default | Read by | Description |
|---|---|---|---|
| `RTGAIA_CACHE_MAX_GB` | `20` | API, worker | Size limit of the voxel cache in GiB; the least recently read entries are deleted first. |
| `RTGAIA_MESH_CACHE` | on | API | `0`, `false` or `no` disables the on-disk cache of 3D surface meshes. |
| `RTGAIA_MESH_CACHE_BYTES` | `2147483648` | API | Size limit of the mesh cache in bytes. |
| `RTGAIA_MESH_MAX_TRIANGLES` | `200000` | API | Meshes with more triangles are decimated to this number. |
| `RTGAIA_MESH_DOWNSAMPLE_NAMES` | `BODY,Couch,External` | API | Structures that are downsampled by 2 before meshing. Very large structures are always downsampled. |
| `RTGAIA_TRASH_DAYS` | `14` | API | Days that deleted items stay in the trash before they are purged. |
| `RTGAIA_DISK_WARN_PERCENT` | `90` (range 50–99) | API | Disk usage that triggers the capacity warning. |
| `RTGAIA_INTEGRITY_BATCH` | `500` | API | Files checked per integrity check run. |

### Limits and performance

| Variable | Default | Read by | Description |
|---|---|---|---|
| `RTGAIA_IMPORT_BODY_MAX_BYTES` | 4 GiB | API | Largest single upload (file or zip archive). |
| `RTGAIA_ZIP_TOTAL_MAX_BYTES` | 8 GiB | API | Largest total uncompressed size of a zip archive. |
| `RTGAIA_ZIP_MEMBERS_MAX` | `50000` | API | Most files in a zip archive. |
| `RTGAIA_ZIP_RATIO_MAX` | `200` | API | Highest uncompressed-to-compressed ratio of a zip archive. |
| `RTGAIA_PLUGIN_ARTIFACT_MAX_BYTES` | 2 GiB | API | Largest single file downloaded from a plugin. |
| `RTGAIA_RENDER_PIXEL_BUDGET` | `64000000` | API | Largest output of a reslice (width × height) or 3D render (width × height × layers). |
| `RTGAIA_CPU_WORKERS` | smaller of 4 and the CPU count | API | CPU-bound requests (reslicing, 3D rendering, DVH and dose computations) that run at the same time; others wait. |

Invalid or non-positive limit values fall back to the defaults.

### Rendering

| Variable | Default | Read by | Description |
|---|---|---|---|
| `RTGAIA_DISABLE_VTK` | not set | API | Any value other than empty or `0` disables VTK; the 3D view uses the MIP fallback. |
| `RTGAIA_VTK_PROBE_TIMEOUT_S` | `120` | API | Time limit for the start-up check that tests whether VTK can render. |
| `RTGAIA_RESLICE_LIB` | not set | API, worker | Path of the native reslice library, if it is not in the default location. |

### Plugin settings

| Variable | Default | Read by | Description |
|---|---|---|---|
| `RTGAIA_PLUGIN_REGISTRATION_TOKEN` | not set | API | When set, plugins can register themselves with this bearer token. |
| `RTGAIA_PLUGIN_HEALTH_SECONDS` | `30` | API | Interval of plugin health checks. |
| `RTGAIA_PLUGIN_KV_MAX_MB` | `16` | API | Size limit, in MiB, of each key-value namespace of a plugin; a single value is limited to 1 MiB. |
| `RTGAIA_TRANSIENT_MAX_GB` | `2` | API | Total size of plugin results accepted for one user in one case. |

### Background task intervals

These intervals are mainly for testing. `0` disables the task.

| Variable | Default | Task |
|---|---|---|
| `RTGAIA_RETENTION_TICK_SECONDS` | `3600` | Purge of expired trash items |
| `RTGAIA_STORAGE_TICK_SECONDS` | `300` | Disk capacity check |
| `RTGAIA_INTEGRITY_TICK_SECONDS` | `86400` | Integrity check (first run at most 10 minutes after start) |
| `RTGAIA_PLUGIN_TICK_SECONDS` | `5` | Plugin health checks, polling and job time-outs |
| `RTGAIA_AUDIT_FLUSH_SECONDS` | `5` | Retry of audit events that could not be written |

### Compose variables

| Variable | Default | Description |
|---|---|---|
| `POSTGRES_PASSWORD` | `rtgaia` | Database password. Change it. |
| `RTGAIA_HTTP_PORT` | `80` | Host port of the `web` service. |
| `RTGAIA_PLUGIN_NNUNET_TOKEN` | `change-me` | Bearer token of the example plugin. Change it. |
| `RTGAIA_SEG_ENGINE`, `RTGAIA_SEG_DEVICE`, `RTGAIA_SEG_MODE` | `totalseg`, `gpu`, `local` | Example plugin engine, device and mode. |
| `RTGAIA_SEG_REMOTE_TOKEN` | `change-me` | Bearer token of the example remote inference service. Change it. |
| `RTGAIA_SEG_SERVER_PORT` | `8710` | Host port of the `seg-server` service. |

Variables used by plugin services themselves (`RTGAIA_PLUGIN_TOKEN`, `RTGAIA_PLUGIN_PUBLIC_URL`,
`RTGAIA_PLUGIN_ARTIFACTS`, and `RTGAIA_PLUGIN_DATA` in the example plugin) are described in
[Plugins](plugins.md).

### Development and test only

| Variable | Used by | Description |
|---|---|---|
| `RTGAIA_TEST_API` | `rtgaia-testbe` | Mounts the test endpoints (`--test-api`). `rtgaia-server` ignores it. Never use in production. |
| `RTGAIA_TEST_DB_URL` | test suite | Database for database tests; those tests are skipped when it is unset. Use a separate database whose name contains `test`. |
| `RTGAIA_API` | Vite server | Backend address for the development proxy (set by `scripts/dev.sh`). |
| `RTGAIA_HOST` | Vite server | Bind address of the development and preview servers (default `0.0.0.0`). It does not affect the API, which uses `--host`. |
| `RTGAIA_NO_WATCH`, `RTGAIA_WATCH` | Vite server | `RTGAIA_NO_WATCH=1` switches file watching to polling; `RTGAIA_WATCH=off` disables it. |
| `RTGAIA_PG_CONTAINER`, `RTGAIA_PG_PORT`, `RTGAIA_PG_IMAGE` | `scripts/dev-db.sh` | Container name (`rt-gaia-pg`), host port (`5433`) and image (`postgres:16`). |
| `RTGAIA_BACKUP_DB` | `scripts/db-backup.sh` | Database name (`rtgaia`). |
| `RTGAIA_PHANTOM_CACHE`, `RTGAIA_MESH_DEBUG` | development | Cache location for synthetic test data; mesh debugging output. |
| `RTGAIA_TESTBE_LATENCY`, `RTGAIA_TESTBE_CHAOS`, `RTGAIA_TESTBE_LOAD`, `RTGAIA_TESTBE_DATA` | server commands | Set internally from the `--latency`, `--chaos`, `--load` and `--data` options. Do not set them yourself. |
| `HOST`, `FE_PORT`, `BE_PORT`, `WEB` | `scripts/dev.sh` | Bind address (default `0.0.0.0`), frontend port (default `5173`), backend port (default: the first free port from `8080`), and `WEB=build` for a production build of the frontend. |

## Accounts and roles

Accounts exist only when RT-Gaia runs with a database and `RTGAIA_AUTH=required` (the default with
a database). Accounts are local to RT-Gaia; directory services are not supported.

### First administrator

When the database has no accounts, the sign-in page shows **Create the first administrator**.
Enter a **Username**, a **Display name**, a **Password** that meets the password policy and the
same password in **Confirm password**. The account is created with the `admin` role and signed in.
The page accepts only one such request; once an account exists, further attempts are refused.

You can also create the first administrator from the command line, for example on a headless
server:

```sh
curl -fsS -X POST https://rtgaia.example.org/api/v1/auth/bootstrap \
  -H 'content-type: application/json' \
  -d '{"username": "admin", "password": "<password>", "display_name": "Administrator"}'
```

### Roles

Roles are ordered; each role includes the permissions of the roles before it.

| Role (UI label) | Can |
|---|---|
| `viewer` (**Viewer**) | Read the library, cases, structures, doses and plans that they are allowed to see; open cases; 3D rendering; DVH and DVH export; temporary dose computations, which are private to the user. |
| `contourer` (**Contourer**) | Everything a viewer can, plus: create and edit structures in their own working structure sets, measurements, registrations, imports (upload, server directory, DICOM retrieval), RTSTRUCT export, saving dose results as RT Dose, querying, retrieving from and sending to DICOM nodes, running plugins whose minimum role allows it. |
| `approver` (**Approver**) | Everything a contourer can, plus approve, reject and reopen structures. RT-Gaia does not enforce a four-eyes rule: an approver can approve structures they edited. |
| `admin` (**Admin**) | Everything, plus: accounts, **Service settings**, DICOM node configuration, plugin registration, **Archive**, integrity check, removing data from the library and restoring or purging removed library data, and editing other users' working structure sets. |

Object-level rules apply on top of roles:

- The contours of approved structures cannot be edited by anyone until an approver reopens them.
- Imported structure sets are read-only; users edit copies in their own working set. Other users'
  working sets are read-only for everyone except administrators.
- Unsaved plugin results and dose-operation results are visible only to the user who created
  them, administrators included.
- Import batches, deleted items in the trash and plugin jobs can be managed only by the user who
  created them and by administrators.

### Managing accounts

Open the RT-Gaia menu in the top-left corner (**Switch page**) and choose **Users**.

- **Add user**: enter **Username**, **Display name**, **Password** and **Role**. **Must change
  password at first sign-in** is selected by default. Usernames are stored in lower case.
- **Create accounts in bulk (CSV)**: one account per line as `username,display_name,role,password`
  (a header line is allowed). An empty role means `contourer`; an empty password generates a
  temporary password. Every account created this way must change its password at first sign-in.
  Up to 500 lines per request; a failing line does not affect the others.
- **Reset password**: set a new password, or leave the field empty to generate a temporary one.
  The user's existing sessions end immediately and the user must change the password at the next
  sign-in.
- **Unlock** appears for locked accounts.
- **Disable** and **Enable**: a disabled account cannot sign in and its sessions end. Accounts
  cannot be deleted.
- Change a role in the **Role** column.

Temporary passwords appear only once, in the confirmation panel. Copy them and hand them over
through a secure channel. The page does not let you change your own role or disable your own
account.

<!-- screenshot: admin-users — the Users page with the Add user form, the CSV panel and the account table -->

### Password policy and lockout

- At least `RTGAIA_PASSWORD_MIN_LENGTH` characters (default 12).
- Must not contain the username (for usernames of three or more characters), must not consist of
  a single repeated character, and must not be a common password.
- When users change their own password, the new one must differ from the current one.
- After `RTGAIA_LOGIN_MAX_FAILURES` consecutive failures (default 5) the account is locked for
  `RTGAIA_LOGIN_LOCKOUT_MINUTES` (default 15). An administrator can **Unlock** it earlier.
- A changed policy applies to passwords set afterwards; existing passwords keep working.

Passwords are hashed with Argon2id. Unknown usernames and wrong passwords produce the same
response; locked and disabled accounts are reported as such.

### Sessions

- Signing in sets an HttpOnly session cookie, valid for 12 hours. The token is signed with
  `RTGAIA_SECRET`; set the variable so that sessions survive restarts.
- Users change their own password with **Change password**. Changing or resetting a password ends
  all other sessions of that account.
- Accounts with a temporary password can only change their password until they do so.
- Disabling an account, changing its role or resetting its password takes effect immediately, also
  for open WebSocket connections.
- **Sign out** removes the cookie from the browser. Tokens are not stored on the server, so a
  copied token stays valid until it expires unless the password is changed or the account is
  disabled.

## Audit log

RT-Gaia records one audit event for every successful request that changes data under `/api/v1/`,
plus events from background tasks (trash purge, capacity warnings, integrity problems) and from
plugins. Each event has the time, the user, the action (HTTP method and route), the status, the
object type and ID, the case, the client address and details (route parameters and, for some
actions, extra information such as DVH export options).

Not recorded:

- read-only requests, such as viewing images or downloading library data as a zip archive;
- requests that fail;
- sign-in and sign-out (the **Users** page shows each account's last sign-in);
- DICOM associations that the receiver accepts or rejects (received data appears as import jobs;
  rejected associations are counted in **Receiver status**).

The `audit_event` table is append-only: a database trigger rejects `UPDATE` and `DELETE`. Database
owners can still change the schema, so protect the database credentials.

If the audit event cannot be written, RT-Gaia stores it in a retry table and writes it later (every
5 seconds by default). If both writes fail, the request returns `503 AUDIT_UNAVAILABLE`: the change
has been made but could not be audited; notify an administrator.

Administrators view events on the **Audit** page, newest first, filtered by user name and case
ID. The page also shows whether audit events are waiting to be written. Other records complement
the audit log: the structure version history and review events in each case, the **Export log**
(every RTSTRUCT and RT Dose download, save to library and send to a DICOM node) and the job list.

<!-- screenshot: admin-audit — the Audit page with filters and the audit status indicator -->

## DICOM networking

Without a database, DICOM nodes and settings are kept in memory only. See the
[DICOM Conformance Statement](dicom-conformance.md) for SOP classes, transfer syntaxes and status
handling.

### Service settings

**Service settings** (administrators only) contains:

- **Receiver status**: whether the receiver in the API process is listening, received instances,
  rejected associations, the last batch and the last rejected caller. **Restart receiver** restarts
  it.
- **DIMSE settings**:

  | Setting | Default | Range | Notes |
  |---|---|---|---|
  | **Our AE title** | `RTGAIA` | 1–16 ASCII characters, no spaces | Used as the receiver's AE title and as the calling AE title. |
  | **Receiver (SCP) on** | off | | |
  | **Receiver port** | `11112` | 1–65535 | |
  | **Bind address** | `0.0.0.0` | | `0.0.0.0` listens on all interfaces. |
  | **Accept unregistered sources** | off with a database | | Off: only AE titles of nodes with the receive role can connect. Keep it off in production. |
  | **Unsupported SOP class** | **Accept and flag (the sender's transfer does not fail)** | | Or **Reject the instance (reply SOP Class not supported)**. |
  | **Batch idle timeout (s)** | `5` | 3–60 | An association with no new instance for this long ends the import batch. |
  | **ACSE timeout (s)** | `15` | 1–3600 | Associations that RT-Gaia initiates. |
  | **DIMSE timeout (s)** | `60` | 1–3600 | Associations that RT-Gaia initiates. |
  | **Network timeout (s)** | `60` | 1–3600 | Both directions. |
  | **TCP connect timeout (s)** | `5` | 1–60 | Associations that RT-Gaia initiates. |

  Each field shows in its tooltip whether its value comes from the environment or was saved on the
  page. Changing **Our AE title**, **Receiver (SCP) on**, **Receiver port**, **Bind address** or
  **Network timeout (s)** restarts the receiver and interrupts transfers in progress. If you change
  the AE title or port, update the configuration of every PACS and TPS that sends to RT-Gaia.
- **Process settings**: read-only values from the environment.
- **Storage** and **Integrity check**: see [Storage](#storage).

<!-- screenshot: admin-service-settings — the Service settings page with receiver status and DIMSE settings -->

### DICOM nodes

**DICOM nodes** lists the remote systems. Select **+ Add node** and enter:

- **Name** and **AE Title** (up to 16 ASCII characters).
- Roles, at least one:
  - **Can send (us → it: ECHO / query / pull / C-STORE)** (the send role): RT-Gaia connects to the
    node. Requires **Host / IP** and **Port**.
  - **Can receive (it → us: allowed to C-STORE into our SCP)** (the receive role): the node may
    connect to RT-Gaia's receiver. Optionally enter **Only accept from this IP** to also check the
    caller's address.
- **Supported services**: which of ECHO, FIND, MOVE, GET and STORE the node supports. After saving,
  open the node with **Edit**, use **Detect with C-ECHO** to fill them in from an association
  negotiation and a test query, and **Save**.
- **Advanced: AE Title overrides, PDU, Transfer Syntax**:
  - **C-MOVE destination AE title**: the AE title under which the node knows RT-Gaia (default:
    **Our AE title**).
  - **Our calling AE title**: the calling AE title for this node (default: **Our AE title**).
  - **Maximum PDU (bytes)**: empty for the default (16382) or 4096–4194304.
  - **Transfer Syntax**: the uncompressed transfer syntaxes to propose, for example
    **Implicit VR Little Endian only (older systems)**.

Use **ECHO** in the node list to test a connection. A powered-off host or a firewall that drops
packets fails after **TCP connect timeout (s)**.

<!-- screenshot: admin-dicom-nodes — the DICOM nodes list and the node editor with roles and advanced settings -->

### Retrieving data

Users with the contourer role or higher pull data from the library page: **Import…** ›
**Pull from a node (C-FIND → C-MOVE / C-GET)**. The list offers nodes with the send role,
except nodes marked as not supporting FIND. RT-Gaia uses C-GET when the node is marked as
supporting GET, and C-MOVE otherwise. For C-MOVE:

- the remote system must know RT-Gaia's AE title (or the node's **C-MOVE destination AE title**),
  IP address and receiver port;
- the receiver must be on and reachable;
- the remote system must be registered with the receive role (unless
  **Accept unregistered sources** is on), because it opens a new association to send the data.

Received instances go through the same import pipeline as uploads.

### DICOM services in the Plugins menu

Every node with the send role also appears in the viewer's **Plugins** menu. Choosing it
sends the image series of the current case to the node and waits up to 30 minutes for RT objects
(RTSTRUCT, RTDOSE or REG) of the same study to arrive at the receiver; the user is notified when
they arrive. This works with any system that returns its results by C-STORE, such as an
auto-contouring server, provided that the system can send to RT-Gaia's receiver (see
[Retrieving data](#retrieving-data)).

## Storage

### Storage layout

| Location | Default | Content | If lost |
|---|---|---|---|
| Library root | `RTGAIA_LIBRARY_ROOT` | DICOM files that you place there, in any directory structure | Data loss |
| `<library>/blobs/` | | Imported DICOM files, named by their SHA-256 digest | Data loss |
| `<library>/.staging/` | | Uploads in progress | In-progress uploads |
| `<library>/.rtgaia/trash/` | | Data removed from the library, kept for the trash period | Restore option |
| `<data>/blobs/` | `<library>/.rtgaia/blobs/` | Structure mask versions (`masks/`), created export files (`exports/`), plugin result files (`plugin-results/`); zstd-compressed | Data loss |
| `<data>/staging/` | `<library>/.rtgaia/staging/` | DICOM received by the receiver (`scp/`) and by C-GET, and temporary job files | Files not yet imported |
| `<data>/cache/` | `<library>/.cache/`; mesh cache in `<library>/.rtgaia/cache/` | Voxel cache (`volumes/`), mesh cache (`mesh/`), library index cache (`library/`) | Nothing; rebuilt on demand |
| PostgreSQL | | Catalog, accounts, cases, structure metadata and version chain, review events, jobs, audit log, nodes, settings, plugins, export log, integrity records | Data loss |

`<data>` is `RTGAIA_DATA_DIR`. Without it, RT-Gaia uses hidden directories inside the library
root as shown. The library scan skips every directory and file whose name starts with a dot.

Structure versions reference mask files in `<data>/blobs/` by content hash. The database and the
two directories form one data set: back them up together.

### Library root and imports

- **Upload**: users drag files, folders or zip archives onto the library page. Files without the
  DICOM preamble (`DICM`) are rejected in the browser and on the server.
- **Directory on the server** (in **Import…**): copies DICOM files from a directory that the API
  process can read; the source directory is not changed. Any user with the contourer role or
  higher can use it, so limit what the API process can read.
- **DICOM**: received and retrieved instances (see [DICOM networking](#dicom-networking)).
- **Files you copy into the library root yourself**: select **More** › **Rescan** on the library
  page to index them.

Every import validates each file (DICOM, SOP Instance UID, supported modality), de-duplicates by
SOP Instance UID and SHA-256, and stores accepted files under `<library>/blobs/`. A file whose SOP
Instance UID already exists with different content is rejected, never overwritten. The import
accepts objects whose Modality is CT, MR, PT, NM, US, CBCT, RTSTRUCT, RTDOSE, RTPLAN or REG.
Compressed images are stored as received; series in a transfer syntax that RT-Gaia cannot decode
(for example JPEG Lossless or JPEG-LS) are listed in the import result and cannot be opened in the
viewer.

Administrators remove a patient, study or series with **Remove from library**. The files move to
`<library>/.rtgaia/trash/` and can be restored from the **Trash** page during the trash period.

### Caches

The voxel cache keeps decoded image and dose volumes and is limited by `RTGAIA_CACHE_MAX_GB`
(default 20 GiB). The mesh cache keeps 3D surface meshes and is limited by
`RTGAIA_MESH_CACHE_BYTES` (default 2 GiB). You can delete either at any time; the next load is
slower.

### Trash and archive

| What | Where it goes | Purged | Who can restore or purge |
|---|---|---|---|
| Deleted structure that was not approved | **Trash** | Automatically after `RTGAIA_TRASH_DAYS` (default 14) | The user who deleted it, or an administrator |
| Deleted structure that was approved | **Archive** | Never automatically | Administrators (**Restore**, **Delete permanently**, notes) |
| Data removed from the library | **Trash** (**DICOM removed from the library**) | Automatically after `RTGAIA_TRASH_DAYS` | Administrators |

Purging a structure removes its versions and the mask files that no other version uses; review
events and audit events are kept. The trash for structures and the archive require a database.

### Capacity warning

Every 5 minutes RT-Gaia measures the disks that hold the library root, the blob store and the
cache (each disk is listed once). When usage reaches `RTGAIA_DISK_WARN_PERCENT` (default 90), all
signed-in users see a warning, **Service settings** › **Storage** shows the details, and an audit
event records the crossing (and, later, the recovery). RT-Gaia never deletes data to free space.

### Integrity check

Once a day, RT-Gaia recomputes the SHA-256 digest of a batch of library files (500 by default),
oldest check first. Imported files are checked against their content-addressed names; other files
are checked against the digest recorded the first time RT-Gaia saw them. Missing or changed files
are listed under **Service settings** › **Integrity check** and recorded as an audit event.
Administrators can run a batch at once (**Run one batch (500)**, where the number is the batch
size), **Verify everything**, or **Reset baseline** for files that changed legitimately (this is
audited).

### Staging leftovers

RT-Gaia does not clean up all staging files automatically. Instances that the import pipeline does
not accept (unsupported modality, duplicates, conflicting content) stay in the staging directory
of their receiver batch, and files of finished send jobs stay under `<data>/staging/`. Check the
import job results, then delete old staging directories when no transfer is in progress.

The receiver confirms each instance once it is written to `staging/scp/<batch>/`, so every batch
there must reach the import queue. When an association ends, the receiver queues an import job for
the batch and writes `<batch>.queued` next to the batch directory. If the queue cannot be written,
for example while PostgreSQL is restarting, the batch is logged, counted as `unqueued_batches` and
`handoff_failures` in `GET /api/v1/dimse/status`, and retried every 30 seconds. When the receiver
starts, it queues every batch directory that has no `.queued` marker, such as batches left by a
process that stopped before handing them over.

## Backup and restore

Back up these three items together:

1. the PostgreSQL database;
2. the library root (including `blobs/` and `.rtgaia/trash/`);
3. the data directory, except `cache/` (and `staging/` if no transfer is in progress).

Also keep `deploy/.env` (or your environment configuration) in a safe place: without the same
`RTGAIA_SECRET` (or `RTGAIA_PHI_KEY`), patient-name hashes no longer match, and without the same
`RTGAIA_UID_ROOT` new objects get UIDs under a different root.

For a consistent backup, stop the API, the worker and any separate receiver, dump the database,
copy the directories and start the services again. If you back up while RT-Gaia is running, dump
the database first and copy the directories afterwards.

With Docker Compose:

```sh
rtgaia_compose stop api worker
rtgaia_compose exec -T postgres pg_dump -U rtgaia -d rtgaia -Fc > rtgaia-$(date +%Y%m%d).dump
rtgaia_compose exec -T postgres pg_restore --list < rtgaia-$(date +%Y%m%d).dump > /dev/null   # check the dump
tar -C deploy/volumes -cf rtgaia-files-$(date +%Y%m%d).tar --exclude=rtgaia/cache library rtgaia
rtgaia_compose start api worker
```

`scripts/db-backup.sh [label]` does the same database dump for the development container from
`scripts/dev-db.sh`: it writes a custom-format dump to `.rtgaia/db-backups/` in the repository,
checks that it can be read and lists existing dumps with `--list`. Set `RTGAIA_PG_CONTAINER` to use
it with another PostgreSQL container.

To restore:

1. Stop the API, the worker and any separate receiver.
2. Restore the directories to the same paths. The database stores the paths of library files; if
   the library root moved, select **More** › **Rescan** on the library page after the restore.
3. Restore the database (this replaces its contents):

   ```sh
   rtgaia_compose exec -T postgres pg_restore -U rtgaia -d rtgaia --clean --if-exists < rtgaia-20260101.dump
   ```

4. Start the services and check `/readyz`.

Backups contain patient data, password hashes and plugin tokens. Protect them like the live
system.

## Upgrading

1. Read the [changelog](../CHANGELOG.md).
2. Back up (see [Backup and restore](#backup-and-restore)).
3. Update the source tree to the new version.
4. Rebuild and restart. With Docker Compose, start the API before the worker so that one process
   applies the database migrations:

   ```sh
   rtgaia_compose build
   rtgaia_compose stop worker
   rtgaia_compose up -d api web
   rtgaia_compose up -d worker
   ```

   From source, run `uv sync --all-packages`, `./scripts/build-kernel.sh` and the frontend build,
   then restart the API, the worker and the receiver.

Database migrations run automatically when a process first connects to the database. There is no
separate migration step.

A restart drops the API's in-memory sessions; users may have to reopen their cases. Edits are
saved as they are made, but unsaved plugin results and dose-operation results exist only in the
API's memory and are lost. With `RTGAIA_SECRET` set, users stay signed in.

To roll back, restore the backup taken before the upgrade and run the previous version.

## Plugins

Plugins are separate HTTP services that add functions such as auto-contouring. RT-Gaia treats a
registered plugin as a trusted extension:

- The plugin receives the case's input image and any structures that the user selects.
- Results come back as files that RT-Gaia validates and places in the requesting user's private
  plugin results set, which is not saved until the user saves it.
- A plugin's UI bundle, if it has one, runs in the user's browser with the same privileges as
  RT-Gaia itself. It is not sandboxed.

Register only plugins that you have reviewed. Writing plugins is described in
[Plugins](plugins.md) and [Plugin contract](plugin-contract.md).

### Registering a plugin

On the **Plugins** page, enter the plugin's **endpoint** (for example
`http://plugin-nnunet:8702`) and its **bearer token**, and select **Register**. RT-Gaia fetches
the plugin's manifest and checks:

- the manifest schema and `api_version` `1`;
- the licenses: MIT, BSD-2-Clause, BSD-3-Clause and Apache-2.0 are accepted. To accept another
  license, enter it in **Allowed licenses**; the override is recorded in the audit log;
- the UI bundle: RT-Gaia uses a plugin's UI bundle only if the manifest declares
  `ui.trust: host-equivalent`. It then downloads the bundle and records its SHA-256 digest;
  registration fails if the bundle cannot be downloaded. Plugins without a usable bundle get a
  form generated from their parameter schema.

The table shows each plugin's version, status, endpoint, **Minimum role** (from the manifest) and
whether it has a UI. **Recheck** runs a health check, **Disable**/**Enable** switch it off and
on, and **Remove** deletes the registration (jobs in progress fail; existing results stay). A
plugin that fails three health checks in a row is shown as **Unreachable**.

Running a plugin requires the contourer role or higher, and at least the plugin's minimum role.

### Health checks and versions

RT-Gaia checks each plugin's health every `RTGAIA_PLUGIN_HEALTH_SECONDS` (default 30). After three
consecutive failures the plugin is marked **Unreachable** until a check succeeds again. When the
reported version changes, RT-Gaia fetches the manifest again, checks it, records the new UI
digest and asks open browser pages to reload.

### UI bundle digest

RT-Gaia serves a plugin's UI bundle only through its own proxy, and only the file named in the
manifest. The server compares every download with the recorded digest, and the browser checks the
digest again before it loads the bundle. If the bundle changes without a version change, RT-Gaia
quarantines the plugin and records an audit event. To accept the new bundle after reviewing it,
register the plugin again with the same endpoint and token.

### Self-registration

If `RTGAIA_PLUGIN_REGISTRATION_TOKEN` is set, a plugin can register itself with
`POST /api/v1/plugins/register`, using that token as a bearer token and sending its endpoint and
token. Self-registration cannot accept additional licenses. Leave the variable unset unless you
need it.

### Artifact origins

Plugins can return result files as URLs. RT-Gaia downloads them only from approved origins: the
plugin's own endpoint, origins declared in the manifest, and origins that an administrator adds
with the API (there is no page for this):

```sh
TOKEN=$(curl -fsS -X POST https://rtgaia.example.org/api/v1/auth/login \
  -H 'content-type: application/json' -d '{"username": "admin", "password": "<password>"}' \
  | python3 -c 'import json, sys; print(json.load(sys.stdin)["token"])')
curl -fsS -X PATCH https://rtgaia.example.org/api/v1/plugins/<plugin-id> \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"artifact_origins": ["https://storage.example.org"]}'
```

Only `http` and `https` URLs (and inline `data:` URLs) are allowed, redirects are not followed,
paths must not contain `..`, and host names that resolve to link-local, multicast, reserved or
unspecified addresses are refused.
Private network addresses are allowed when the origin is approved. Downloads stop at
`RTGAIA_PLUGIN_ARTIFACT_MAX_BYTES` and at the user's remaining plugin result quota
(`RTGAIA_TRANSIENT_MAX_GB`).

### Plugin results

Unsaved plugin results live in the API's memory. They are deleted 30 minutes after the user's last
connection to the case closes, and when the API restarts.

## Resource limits

| Limit | Default | Setting |
|---|---|---|
| Upload size per request | 4 GiB | `RTGAIA_IMPORT_BODY_MAX_BYTES`; also `client_max_body_size` in `nginx.conf` |
| Zip archive: total uncompressed size, files, compression ratio | 8 GiB, 50 000, 200:1 | `RTGAIA_ZIP_TOTAL_MAX_BYTES`, `RTGAIA_ZIP_MEMBERS_MAX`, `RTGAIA_ZIP_RATIO_MAX` |
| Reslice and 3D render output | 64 000 000 pixels | `RTGAIA_RENDER_PIXEL_BUDGET` (`422 RENDER_BUDGET`) |
| Concurrent CPU-bound requests | smaller of 4 and the CPU count | `RTGAIA_CPU_WORKERS` |
| Concurrent password hash operations | 2 | `RTGAIA_PASSWORD_WORKERS` |
| Plugin result file | 2 GiB | `RTGAIA_PLUGIN_ARTIFACT_MAX_BYTES` |
| Plugin results per user and case | 2 GiB | `RTGAIA_TRANSIENT_MAX_GB` |
| Plugin key-value storage | 16 MiB per plugin namespace, 1 MiB per value | `RTGAIA_PLUGIN_KV_MAX_MB` |
| Dose-operation results | 20 per user and case | fixed |
| C-FIND results | 500 per query; RT-Gaia then cancels the query | fixed |
| Bulk account creation | 500 lines | fixed |
| User preferences | 64 KiB per value, 256 KiB in total | fixed |

Zip limits are checked against the archive directory before any file is extracted, and again while
extracting. Upload size is checked while the request is received.

## Network and security

See also the [Security policy](../SECURITY.md).

### HTTPS

Serve RT-Gaia over HTTPS. Over plain HTTP, passwords and session cookies travel unencrypted, and
the page is not a secure context in the browser unless it is opened as `localhost`:

- the Web Crypto API is unavailable; RT-Gaia then verifies plugin UI bundles with its own SHA-256
  implementation;
- the Clipboard API is unavailable; RT-Gaia falls back to an older copy method;
- `SharedArrayBuffer` is unavailable. The current CPU renderer is single-threaded and does not need
  it; RT-Gaia still sends the COOP and COEP headers.

The compose `web` service listens on plain HTTP (port 80). Terminate TLS in that nginx (add a
`listen 443 ssl` server with your certificate) or in a reverse proxy in front of it, and set
`RTGAIA_PUBLIC_URL` to the `https://` address.

The API marks the session cookie `Secure` only when the request reaches it as HTTPS. Behind
proxies this needs two things: the proxy that talks to the API must send
`X-Forwarded-Proto: https`, and the API must trust that proxy. The bundled nginx forwards its own
scheme, so terminate TLS there or change its `X-Forwarded-Proto` header. The API's server
(uvicorn) trusts forwarded headers only from the addresses in `FORWARDED_ALLOW_IPS` (default
`127.0.0.1`); in the compose deployment, set `FORWARDED_ALLOW_IPS: "*"` for the `api` service,
which is safe only while the API port is not published. Trusting the proxy also makes the audit
log record the client's address instead of the proxy's.

### Host name validation

The API rejects requests to `/api/v1/*` whose `Host` header is not in the allowed list with
`400 BAD_HOST`. The list is `RTGAIA_ALLOWED_HOSTS` if set, otherwise the host of
`RTGAIA_PUBLIC_URL` plus `localhost` and `127.0.0.1`. Ports are ignored in the comparison. The API
never learns its public address from incoming requests. `/healthz` and `/readyz` are not checked.

### Exposure

| Port | Service | Expose to |
|---|---|---|
| 80 or 443 | `web` | Users |
| 8080 | API | The web server only (not published by the compose file) |
| 11112 | DICOM receiver | The PACS and TPS that send to RT-Gaia (not published by default) |
| 5432 | PostgreSQL | RT-Gaia processes only (not published by the compose file) |

Additional points:

- DICOM traffic is not encrypted (TLS is not supported for DICOM). Keep the receiver on a trusted
  network segment, keep **Accept unregistered sources** off, and use
  **Only accept from this IP** where possible.
- `/healthz` and `/readyz` need no sign-in and return internal details (database counts, memory
  use, the kernel library path). Restrict them at the reverse proxy if they should not be public.
- Never expose `RTGAIA_AUTH=off`, the mode without a database, or `scripts/dev.sh` to other users.
  The production command `rtgaia-server` never mounts the test endpoints.
- **Directory on the server** imports read any directory that the API process can read. Run
  RT-Gaia under an unprivileged account and limit its file system access. The RT-Gaia containers
  run as `root` inside the container but see only their mounted volumes.
- Change every default secret: `POSTGRES_PASSWORD`, `RTGAIA_SECRET` and the example plugin tokens.

## Patient data

RT-Gaia stores and displays patient data. Use only de-identified data for testing and
demonstrations.

| Where | What |
|---|---|
| Library root and `<library>/blobs/` | The original DICOM files, unchanged, with all patient attributes. Imported files are stored under digest-based names, so their paths contain no patient data; files you place in the library root keep their paths. |
| Database | Patient IDs, study and series metadata (dates, descriptions, UIDs), library file paths, a keyed hash of each patient name, structure names and history, audit events and export records (which contain patient IDs and user names). |
| `<data>/blobs/` | Structure masks; exported RTSTRUCT and RT Dose files, which contain patient identity if the user turned de-identification off. |
| Server logs | Request URLs, which can contain patient IDs and UIDs. |

**Patient names.** RT-Gaia does not store patient names in clear text in the database or in its
caches. It stores an HMAC-SHA-256 hash (truncated to 128 bits) that only lets it tell whether two
names are the same. The key is `RTGAIA_PHI_KEY`, or is derived from `RTGAIA_SECRET`; without either,
a built-in development key is used, which offers no protection. Library search matches patient IDs,
not names. The library page hides names; with `RTGAIA_LIBRARY_SHOW_NAMES=1` the API reads each
displayed name from the patient's DICOM file when the page asks for it and keeps it only in memory.

**Exports.** RTSTRUCT exports and RT Dose files are de-identified by default. This replaces the
patient name, ID, birth date and sex with placeholder values; UIDs that link the object to the
original study, the exporting user's name and the structure names remain. Saving an export to the
library always uses the real patient identity. DVH exports are de-identified by default. See the
[DICOM Conformance Statement](dicom-conformance.md) for details.

## Monitoring

### Health endpoints

`GET /healthz` always returns `200` with diagnostic information. Use `/readyz` for health checks
and load balancers.

| Field | Content |
|---|---|
| `ok` | Always `true` |
| `geom_version` | Version of the geometry package |
| `reslice_kernel` | Whether the native reslice kernel loaded, with its path or the reason it did not |
| `catalog_db` | Whether a database is configured, whether it answers, and row counts |
| `auth` | Authentication mode |
| `memory` | Cases and sessions in memory, resident memory of the process (`rss_bytes`) |
| `sessions` | Open sessions |
| `audit_lag` | Audit events waiting to be written (`pending`), the age of the oldest (`oldest_age_s`) and events that failed ten retries (`gave_up`); `null` without a database |
| `storage` | Whether disk usage is above the threshold (`warn`), the highest usage and the threshold; `null` before the first check |
| `worker` | For the in-process worker: `alive`, `stale` (idle but not polling for more than 60 seconds), `last_tick_age_s`, `busy_job`, completed `jobs`, `errors`, `last_error`. `{"inprocess": false}` when jobs run in `rtgaia-worker` |
| `chaos` | Fault-injection settings used in testing; all off in production |

`GET /readyz` returns `200` with `{"ready": true, ...}` when the API can serve requests, and `503`
when the database is configured but does not answer, when the in-process worker has stopped or
is stale, or when the event bus listener has been disconnected for more than 30 seconds. The bus
listener receives job progress and results from other processes over a PostgreSQL `LISTEN`
connection; `checks.bus` shows whether it is `listening`, for how long it has been down
(`down_seconds`), how often it reconnected and the last error. After reconnecting it delivers the
messages published while it was down.

The standalone worker has no HTTP endpoint; with `RTGAIA_WORKER_HEARTBEAT_FILE` set it touches
that file while its loop runs. The heartbeat is not updated while a job runs, so a long transfer can
make the worker look unhealthy for a while. If the worker loop ends unexpectedly, the process exits
with a non-zero code so that the service manager restarts it. Jobs whose worker stops are queued
again after 2 minutes, up to three attempts.

### API endpoints for operators

All of these require sign-in; the role needed is shown.

| Endpoint | Role | Content |
|---|---|---|
| `GET /api/v1/jobs?kind=&case_id=&limit=` | viewer | Recent jobs (`export`, `import`, `send`, `retrieve`, plugin jobs) with status, phase, progress, attempts and errors |
| `GET /api/v1/jobs/{job_id}` | viewer | One job |
| `GET /api/v1/audit?user=&case_id=&limit=` | viewer | Audit events (the UI shows them to administrators) |
| `GET /api/v1/audit/status` | viewer | Audit events waiting to be written |
| `GET /api/v1/storage/status` | viewer | Disk usage per disk (paths only for administrators) |
| `GET /api/v1/storage/integrity` | admin | Integrity check summary and problems |
| `GET /api/v1/dimse/status` | viewer | AE title, receiver port and receiver status |
| `GET /api/v1/plugins` | viewer | Registered plugins and their status (details for administrators) |
| `GET /api/v1/export-records` | viewer | Export log |

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| The API does not start and mentions `RTGAIA_PUBLIC_URL` | Sign-in is required but `RTGAIA_PUBLIC_URL` is not set, or it is not of the form `http(s)://host[:port]`. Set it. |
| The API does not start and mentions `RTGAIA_AUTH=required` | `RTGAIA_AUTH=required` needs `RTGAIA_DB_URL`. |
| The API does not start and mentions the DICOM UID settings | `RTGAIA_UID_ROOT` or `RTGAIA_IMPLEMENTATION_CLASS_UID` is not a valid UID (or the root is longer than 40 characters). |
| API calls fail with `400 BAD_HOST` | Users reach RT-Gaia under a host name that is not allowed. Set `RTGAIA_PUBLIC_URL` to the address users type, or list every name in `RTGAIA_ALLOWED_HOSTS` (including the host of `RTGAIA_PUBLIC_URL`). |
| Everyone is signed out after a restart | `RTGAIA_SECRET` is not set. |
| `CPU reslice kernel not found` | Run `./scripts/build-kernel.sh` or set `RTGAIA_RESLICE_LIB`. |
| The 3D view shows only a maximum intensity projection | VTK cannot render in the API process (no OpenGL device), or `RTGAIA_DISABLE_VTK` is set. |
| `503 AUDIT_UNAVAILABLE` | The database could not store the audit event or its retry entry. The change was made. Check the database. |
| `413 IMPORT_TOO_LARGE`, or nginx returns `413` | The upload exceeds `RTGAIA_IMPORT_BODY_MAX_BYTES` or `client_max_body_size`. |
| A zip archive is rejected | It exceeds the zip limits or looks like a zip bomb; the reason is in the import result. |
| A series is listed but cannot be opened, with a message about the compression format | The images use a transfer syntax that RT-Gaia cannot decode, such as JPEG Lossless or JPEG-LS. Export them uncompressed from the source system. |
| A user is locked out | **Users** › **Unlock**, or wait for the lockout period. |
| A user can only change their password | The account has a temporary password. Change it with **Change password**. |
| Remote systems cannot send to RT-Gaia; **Receiver status** shows rejected callers | Register the caller's AE title as a node with the receive role (and the right **Only accept from this IP**), or check that the port is published and allowed in the firewall. |
| A C-MOVE retrieval finishes without data | The remote system does not know RT-Gaia's AE title, address or port, the receiver is off, or the remote system is not registered with the receive role. RT-Gaia reports zero completed sub-operations in this case. |
| **ECHO** fails after a few seconds | The host is off or a firewall drops the connection (TCP connect timeout), or the AE title, host or port is wrong. |
| Plugins never return results | The plugin cannot reach `RTGAIA_PUBLIC_URL`, or the worker does not have `RTGAIA_PUBLIC_URL` (see [Environment for every process](#environment-for-every-process)). |
| A plugin is quarantined | Its UI bundle changed without a version change. Review it, then register the plugin again. |
| Users see a storage warning | A disk is above `RTGAIA_DISK_WARN_PERCENT`. See **Service settings** › **Storage**. |
| The worker container is unhealthy | Check its log; the heartbeat is also stale while a long job runs. |
