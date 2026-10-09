# Contributing to RT-Gaia

Thank you for your interest in RT-Gaia. This guide explains how to set up a development environment,
run the same checks as CI, and prepare a change. Read [docs/architecture.md](docs/architecture.md) first:
it explains the design rules that reviews check against.

> RT-Gaia is research software. It is not a medical device, has not been cleared or approved by any
> regulatory authority, and must not be used for clinical decision making. Use only synthetic or
> de-identified data when you develop and test.

Report security vulnerabilities as described in [SECURITY.md](SECURITY.md), not in public issues. For a
larger change, open an issue first to discuss the approach.

A note on language: code comments, docstrings, test descriptions, log messages and the source strings of
the interface are largely in Traditional Chinese; identifiers are mostly English. The public
documentation is in English, and the interface is available in Traditional Chinese and English.

## Development setup

### Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Python | 3.11 or later | Managed with [uv](https://docs.astral.sh/uv/). CI uses 3.11, the oldest supported version. |
| Node.js | 22.15 or later | The frontend tests use the zstd support added to `node:zlib` in 22.15. |
| Rust | stable | With the `wasm32-unknown-unknown` target, rustfmt and clippy. |
| Docker | any recent version | Optional: local PostgreSQL (`scripts/dev-db.sh`) and the Compose smoke test. |
| Google Chrome | any recent version | Optional: the headless interface checks. |
| Xvfb and Mesa (Linux) | — | Optional: without a GL device, the VTK 3D-rendering tests are skipped. |

### Install and build

```sh
uv sync --all-packages                      # Python workspace and development tools
(cd apps/viewer && npm install)             # frontend dependencies (CI uses npm ci)
rustup target add wasm32-unknown-unknown
./scripts/build-kernel.sh                   # native kernel for Python, WebAssembly kernel for the viewer
```

`build-kernel.sh` runs the kernel's unit tests and copies the results to
`packages/rtgaia-geom/src/rtgaia_geom/_native/librtgaia_reslice.so` and
`apps/viewer/public/rtgaia_reslice.wasm`. The `.wasm` file is tracked in the repository: if you change the
kernel, commit the rebuilt file in the same change. CI always tests the kernel it builds itself.

### Run the development stack

```sh
./scripts/dev.sh                          # backend + frontend; opens on the library page, ./data is the library root
./scripts/dev.sh phantom:overlap_set      # load a synthetic phantom
./scripts/dev.sh dicom:/path/to/case      # load one de-identified DICOM case directory
WEB=build ./scripts/dev.sh                # production build (vite build + vite preview) instead of the dev server
```

Open <http://localhost:5173>. The script starts `rtgaia-testbe` (the server plus the test API) on the
first free port from 8080 and the Vite server on port 5173, which proxies `/api` to the backend. It stops
if the frontend port is already taken. `BE_PORT`, `FE_PORT` and `HOST` override the defaults; with
`WEB=build`, rerun the script after frontend changes.

The script binds to `0.0.0.0` by default. Without a database the backend has no authentication, and its
test endpoints accept file-system paths, so bind to localhost (`HOST=127.0.0.1 ./scripts/dev.sh`) unless
you are on a trusted network. Opened from another machine over plain HTTP, the page is not a secure
context, and browser features that require one are unavailable.

The phantom definitions are in `packages/rtgaia-testbe/src/rtgaia_testbe/phantoms/library.py`. To fill
the library with synthetic DICOM, write cases into `data/`:

```sh
uv run python -m rtgaia_testbe.fixtures.synth4d --out data/test_4d       # 4D and dynamic CT and MR cases
uv run python -m rtgaia_testbe.fixtures.synth_beams --out data/test_beams # RT plan with per-beam doses
```

To run the two halves separately:

```sh
uv run rtgaia-testbe --test-api --host 127.0.0.1 --port 8080 --library ./data
cd apps/viewer && RTGAIA_API=http://127.0.0.1:8080 npm run dev
```

For plugin development, including running the example plugin services, see
[docs/plugins.md](docs/plugins.md).

### Local PostgreSQL

Persistence, accounts, the job table, the event bus and the audit trail need PostgreSQL.
`scripts/dev-db.sh` runs `postgres:16` in Docker on `127.0.0.1:5433` with two databases, `rtgaia`
(development) and `rtgaia_test` (tests), and prints their URLs:

```sh
./scripts/dev-db.sh            # create or start the container
./scripts/dev-db.sh stop       # stop it; data is kept
./scripts/dev-db.sh destroy    # delete the container and its data
```

To run the development stack with the database, pass the URLs to `dev.sh` rather than exporting them:

```sh
RTGAIA_DB_URL=postgresql+asyncpg://rtgaia:rtgaia@127.0.0.1:5433/rtgaia \
RTGAIA_PUBLIC_URL=http://127.0.0.1:8080 BE_PORT=8080 ./scripts/dev.sh
```

With a database, login is required, and `RTGAIA_PUBLIC_URL` must be set (it is the address plugins call
back to). The first page load asks you to create the first administrator. Alembic upgrades the schema
automatically. `scripts/db-backup.sh` writes a `pg_dump` of the development database to
`.rtgaia/db-backups/`; run it before migrations or other risky operations on a database you care about.

## Running the checks

CI (`.github/workflows/ci.yml`) runs on pushes to `main` and `dev` and on pull requests. The commands
below are the ones CI runs, from the repository root unless noted.

### Rust kernel

```sh
cargo fmt --manifest-path packages/rtgaia-reslice/Cargo.toml -- --check
cargo clippy --manifest-path packages/rtgaia-reslice/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path packages/rtgaia-reslice/Cargo.toml
./scripts/build-kernel.sh
```

### Python

```sh
uv run ruff check .
uv run python scripts/verify-ci-kernel-step.py                 # tests the workflow's kernel-placement step
uv run python packages/rtgaia-plugin-api/check_contract.py     # plugin contract schemas and OpenAPI
uv export --all-packages --frozen --no-dev --no-emit-workspace -o /tmp/requirements.txt
uvx pip-audit -r /tmp/requirements.txt --strict --progress-spinner off
RTGAIA_TEST_DB_URL=postgresql+asyncpg://rtgaia:rtgaia@127.0.0.1:5433/rtgaia_test uv run pytest
RTGAIA_PERF_SLACK=1.5 uv run python scripts/perf/ci_gate.py   # backend performance budgets
```

In CI, `RTGAIA_TEST_DB_URL` points at a PostgreSQL 16 service; the URL above is the test database of
`scripts/dev-db.sh`. CI runs pytest as `xvfb-run -a uv run pytest` with `LIBGL_ALWAYS_SOFTWARE=1` and Mesa
installed, so that the VTK rendering tests run on a software GL device; on a machine without a GL device
they are skipped. Test markers:

| Marker | Needs | Without it |
|---|---|---|
| `db` | `RTGAIA_TEST_DB_URL` | Skipped |
| `e2e` | Nothing extra; starts a real uvicorn server | Runs; exclude with `-m "not e2e"` |
| `kernel` | The native kernel (`./scripts/build-kernel.sh`) | Skipped |

> **Use a dedicated, disposable test database.** The `db` tests drop every table in the database named by
> `RTGAIA_TEST_DB_URL` and recreate it. They refuse a database whose name does not contain `test`, but
> never point them at a database with real data. Do not export `RTGAIA_DB_URL` in the shell where you run
> the tests: the test apps read it when no URL is passed explicitly.

### Test fixtures

The frontend tests assert against fixtures generated by the backend
(`apps/viewer/tests/fixtures/`, explained in its README). CI regenerates them and fails on a meaningful
difference from the committed files:

```sh
uv run python scripts/check-fixture-sync.py --self-test
uv run python scripts/emit-geometry-fixture.py
uv run python scripts/emit-chaos-fixtures.py
uv run python scripts/check-fixture-sync.py
```

If you change geometry code, phantom definitions, the kernel, the wire framing or the fault-injection
modes, run the two `emit-*` scripts (after `./scripts/build-kernel.sh`) and commit the regenerated
fixtures with your change. The sync check compares the files on disk with the last commit.

### Frontend

Run in `apps/viewer`:

```sh
npm ci
npx tsc -b --noEmit                         # same as npm run typecheck
npx eslint src tests --max-warnings=0       # same as npm run lint
npm audit --audit-level=moderate
npm test                                    # unit, boundary, fixture and chaos tests; offline, no Python needed
RTGAIA_PERF_SLACK=1.5 npm run test:perf     # frontend performance budgets; needs public/rtgaia_reslice.wasm
npm run test:e2e                            # starts rtgaia-testbe with uv; needs the Python environment
```

CI runs `npm run test:e2e` under `xvfb-run -a` with `LIBGL_ALWAYS_SOFTWARE=1`. Before installing
dependencies, CI also fails if compiled `.js` files are tracked under `apps/viewer/src`,
`apps/viewer/tests` or as `apps/viewer/vite.config.js`: Vite resolves `.js` before `.ts`, so a stray
compiled file would silently replace its TypeScript source. These paths are git-ignored.

The plugin UI examples are built with the viewer's toolchain, also from `apps/viewer`:

```sh
npx tsc -p ../../examples/plugin-hello-ui/tsconfig.json --noEmit
npx vite build --config ../../examples/plugin-hello-ui/vite.config.ts
node ../../examples/check-ui-bundle.mjs ../../examples/plugin-hello-ui/dist/index.js hello-threshold 0.1.1
npx tsc -p ../../examples/plugin-nnunet/ui/tsconfig.json --noEmit
npx vite build --config ../../examples/plugin-nnunet/ui/vite.config.ts
node ../../examples/check-ui-bundle.mjs ../../examples/plugin-nnunet/ui/dist/index.js nnunet-oar 0.2.2
```

### Interface checks

Headless Chrome scripts check the layout of the library page and the viewer across window sizes, both
languages, two densities and 200% zoom, and emulate touch input on phones and tablets. CI runs them
against a measurement stack loaded with one synthetic 4D case:

```sh
uv run python -m rtgaia_testbe.fixtures.synth4d --out data/test_4d --only ct1
scripts/perf/stack.sh start
node scripts/verify-ui-matrix.mjs --out-dir .rtgaia/ui-matrix
node scripts/verify-touch.mjs --out-dir .rtgaia/ui-matrix
node scripts/verify-phone-data.mjs --out-dir .rtgaia/ui-matrix
node scripts/verify-phone-viewer.mjs --out-dir .rtgaia/ui-matrix
scripts/perf/stack.sh stop
```

`stack.sh start` runs the backend without authentication or a database, with `data/` as the library
root, and the Vite server, on fixed local ports; the scripts' default `--url` points at that stack. The
scripts start `google-chrome` (set `CHROME` to use another binary) and save screenshots to `--out-dir`.
Some of them create, edit and approve structures, so run them only against this disposable stack. See
[scripts/perf/README.md](scripts/perf/README.md) for the other measurement scripts. The remaining
`scripts/verify-*` scripts check individual features; each one describes its arguments in its header.

### Deployment smoke test

CI builds the Compose images on a fresh checkout and checks the running stack:

```sh
cp deploy/.env.example deploy/.env    # set RTGAIA_SECRET, POSTGRES_PASSWORD, RTGAIA_HTTP_PORT, RTGAIA_PUBLIC_URL
docker compose --env-file deploy/.env -f deploy/docker-compose.yml build
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d
scripts/compose-smoke.sh http://localhost:8088    # the RTGAIA_PUBLIC_URL from deploy/.env
docker compose --env-file deploy/.env -f deploy/docker-compose.yml down -v
```

CI uses `RTGAIA_HTTP_PORT=8088` and `RTGAIA_PUBLIC_URL=http://localhost:8088`. The smoke test checks the
static files and their MIME types, COOP and COEP headers, login, the API, the WebSocket and the rejection
of a forged `Host` header. It creates the first administrator, so run it only against a new, empty
deployment.

### Where tests live

| Location | Covers |
|---|---|
| `packages/rtgaia-geom/tests/` | The geometry contract, the wire codec and the native kernel binding |
| `packages/rtgaia-testbe/tests/` | The backend (`rtgaia-core`, `rtgaia-server`) through the in-process driver (`from rtgaia_testbe import Session`, pytest fixture `driver`), plus database and end-to-end tests |
| `packages/rtgaia-plugin-sdk/tests/` | The plugin SDK, the contract and the example plugins |
| `packages/rtgaia-reslice/src/` | Rust unit tests, next to the code |
| `apps/viewer/tests/` | Frontend tests in Node without a DOM; `e2e/` and `perf/` hold the end-to-end and performance suites. Keep logic in plain modules (for example a module's `model.ts`) so that it can be tested here. |

## Code organization

Follow the layering described in [docs/architecture.md](docs/architecture.md); tests enforce most of it.

- **Backend logic goes in `rtgaia-core`**, which has no SQL. Persistence is a protocol in
  `rtgaia_core/ports.py` with an in-memory implementation in core and a SQL implementation in
  `rtgaia_server/db/`. Test-only endpoints and synthetic phantoms belong in `rtgaia-testbe`; the
  production app (`rtgaia_server.app.create_app`) must never mount them.
- **Geometry is one contract.** A change to grids, frame groups, view references or payloads goes into
  `packages/rtgaia-geom` and `apps/viewer/src/core/geometry` together (and into the Rust kernel if it is
  affected), followed by regenerated fixtures. Coordinates are LPS millimeters; do not add a separate
  geometry for a new kind of content.
- **Binary data** uses the frame format in `rtgaia_geom/codec.py`. WebSocket messages carry metadata
  only; voxels go over HTTP.
- **Frontend:** `core/` must not import React; `react/` must not import rendering libraries or the
  renderer and kernel implementations; overlay DOM and canvas nodes are created by `core/`. New features
  are modules registered with `registerModule()`, and their panels use `ViewerApi`. `core/geometry` uses
  float64 math and must not import `gl-matrix`.
- **Authorization and audit:** every new route gets a minimum role from `required_role_for` in
  `rtgaia_core/auth.py` (reads need viewer, writes need contourer); change it there if your route needs a
  different role, and add object-level checks in the route. Successful writes under `/api/v1/` are
  audited automatically; a route can add detail through `request.state.audit_detail`.

## Interface text and translations

- The source language of the interface is Traditional Chinese. Wrap every user-visible string in
  `t('<source text>')`, or `msg('<source text>')` for module-level constants that are translated when
  displayed.
- Add the English text to `apps/viewer/src/core/i18n/en.ts`, keyed by the source string and with the same
  `{placeholders}`. For a word with several meanings, pass `{ ctx }` to `t()` and use the key
  `'<ctx>|<source text>'`.
- `apps/viewer/tests/i18n.test.ts` fails if a `t()` or `msg()` string has no English entry, if
  placeholders differ, or if a file under `src/` has Chinese text outside `t()` or `msg()` (comments do
  not count; files listed in `tests/i18n-pending.json` are exempt, and the list may only shrink).
- Messages the server returns (errors, operation names, settings) are written in Traditional Chinese
  and translated at the API boundary: into English unless the request prefers Traditional Chinese
  (`Accept-Language`). Add English entries for new ones to
  `packages/rtgaia-core/src/rtgaia_core/i18n_en.py`; `packages/rtgaia-testbe/tests/test_i18n_backend.py`
  enforces coverage for `rtgaia-core`, `rtgaia-server` and `rtgaia-geom`. Python tests run with
  Traditional Chinese as the default, so they can assert the source text.
- Command-line help, startup output and log messages are for administrators and are written in English;
  they are not translated.
- The plugin SDK (`packages/rtgaia-plugin-sdk`) and the example plugins are written in English, including
  their messages; plugin UI bundles translate their own text with `registerMessages`.
- Do not translate DICOM content (patient data, structure names, series descriptions) or user input.

## Database migrations

1. Change the SQLAlchemy models in `packages/rtgaia-server/src/rtgaia_server/db/models.py`.
2. Add a migration as `packages/rtgaia-server/migrations/versions/NNNN_short_name.py`, numbered after the
   latest one, with `revision = "NNNN_short_name"` and `down_revision` set to the previous revision.
   Implement both `upgrade()` and `downgrade()`; migrate existing rows when needed.
3. Run the `db` tests: they downgrade the test database to an empty schema and upgrade it to the latest
   revision.

The server applies pending migrations when it first connects to the database. To apply them by hand:
`cd packages/rtgaia-server && uv run alembic -x url=<database URL> upgrade head`.

## Coding style

Match the surrounding code.

- **Python:** ruff (rule sets E, F, I, UP and B; line length 120; target Python 3.11) must pass. The code
  is not formatted with `ruff format`, so do not reformat code you are not otherwise changing.
- **TypeScript:** the compiler runs in strict mode with `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`; ESLint uses type-checked rules and allows no warnings. There is no
  Prettier configuration.
- **Rust:** rustfmt and clippy with warnings treated as errors.
- Explain non-obvious decisions in comments next to the code they concern.

## Commits and pull requests

- Development happens on the `dev` branch. Base your work on `dev` and open pull requests against it.
- Keep pull requests small and focused on one change. Separate refactoring from behavior changes.
- Add or update tests for every behavior change; a bug fix should come with a test that fails without it.
- Make sure CI passes.
- Update the documentation in `docs/` when behavior, configuration or the API changes, and describe
  user-visible changes in the pull request.
- Write commit messages that say what changed and why.
- Do not commit build output or local data. The exceptions are the tracked fixtures, the prebuilt
  `.wasm` and the lock files (`uv.lock`, `apps/viewer/package-lock.json`,
  `packages/rtgaia-reslice/Cargo.lock`). Never commit secrets such as `deploy/.env`.
- New dependencies must have a permissive license (for example MIT, BSD or Apache-2.0); GPL and AGPL
  components are not accepted. After changing dependencies, regenerate
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) with `uv run python scripts/third-party-notices.py`.

## Test data and patient data

- Use synthetic or de-identified data only. Never commit patient data: not in fixtures, screenshots,
  logs, issues or pull request descriptions.
- `data/`, `*.dcm` and `.rtgaia/` are git-ignored. The real-case directory
  `packages/rtgaia-testbe/src/rtgaia_testbe/fixtures/dicom/` is git-ignored too, and
  `packages/rtgaia-testbe/src/rtgaia_testbe/fixtures/README.md` lists what to record for each
  de-identified case placed there.
- CI uses synthetic data only: phantoms, the DICOM generators in `rtgaia_testbe.fixtures`, and
  `packages/rtgaia-testbe/tests/synth_dicom.py`. Prefer extending these over adding files.
- When you use a public dataset, follow its license and attribution terms.

## License

RT-Gaia is released under the [MIT License](LICENSE). By submitting a contribution, you agree that it is
licensed under the same license.

## Code of conduct

Be respectful and constructive in issues, pull requests and reviews. Harassment, personal attacks and
discriminatory language are not acceptable. Maintainers may edit or remove comments and contributions
that do not follow this, and may block participants who repeatedly ignore it.
