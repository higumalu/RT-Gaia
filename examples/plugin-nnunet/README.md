# plugin-nnunet

An auto-contouring plugin for RT-Gaia (plugin contract v1) built on nnU-Net-family models, with TotalSegmentator as the default engine. Its panel lets users choose the image to segment and the structures (ROIs) to compute, and lets administrators choose where inference runs.

RT-Gaia is research software. It is not a medical device, has not been cleared or approved by any regulatory authority, and must not be used for clinical decision making. Contours produced by this plugin are research outputs; review them like any other automatic contours, and use only de-identified data.

## Models and licenses

| Component | License |
|---|---|
| TotalSegmentator code | Apache-2.0 |
| TotalSegmentator `total` task, the task this plugin runs by default | Listed by the TotalSegmentator project as openly available for any usage under Apache-2.0 |
| Several other TotalSegmentator tasks, such as `tissue_types`, `heartchambers_highres`, and `appendicular_bones` | Require a license from the TotalSegmentator authors: free for non-commercial use, commercial licenses on request. `brain_aneurysm` is CC BY-NC 4.0 with no commercial license available. |
| nnU-Net (`nnunetv2`) | Apache-2.0 |
| Your own nnU-Net weights (`nnunet` engine) | Whatever applies to your training data and model |

Source: the TotalSegmentator README, section [Subtasks](https://github.com/wasserth/TotalSegmentator#subtasks). Licenses can change; check upstream before you deploy, and obtain a license before switching `RTGAIA_TOTALSEG_TASK` to a task that needs one.

The plugin lists its components in the manifest's `soup`, which RT-Gaia shows to administrators. For the `totalseg` engine, that list currently declares the `total` task weights as `CC-BY-NC-SA-4.0`, which is more restrictive than the upstream statement above, so the admin **Plugins** tab shows a research-use-only notice for this plugin. Keep the `soup` entries in [`engine.py`](engine.py) accurate for the task and weights you deploy; for the `nnunet` engine, set `RTGAIA_NNUNET_WEIGHTS_NAME`, `RTGAIA_NNUNET_WEIGHTS_VERSION`, and `RTGAIA_NNUNET_WEIGHTS_LICENSE` (the license defaults to `unknown`).

## Modes and engines

| Mode | Meaning |
|---|---|
| `local` | The engine runs inside the plugin's own process or container, typically next to RT-Gaia on a machine with a GPU. |
| `remote` | The plugin forwards the image to a remote inference service ([`server.py`](server.py)) and returns the label map it gets back. Administrators set the service's URL and port in the panel. |

| Engine (`RTGAIA_SEG_ENGINE`) | What runs |
|---|---|
| `totalseg` (default) | TotalSegmentator. Only the selected structures are computed (its `roi_subset` option), and its lower-resolution `fast` model is used unless `RTGAIA_TOTALSEG_FAST=0`. |
| `nnunet` | Your own trained model through `nnUNetv2_predict`. It always predicts every label; the plugin keeps the selected ones. |
| `fake` | HU thresholds producing `Fake_Body` (above 0 HU) and `Fake_Core` (above 100 HU). For contract tests; needs no weights. |

The engines in [`engine.py`](engine.py) resample their output to the input grid with nearest-neighbor interpolation when needed, because RT-Gaia accepts masks only on that grid. A replacement remote service must do the same; the plugin only checks that the returned label map has the input's dimensions.

## Run it locally

Contract test with the fake engine, from the repository root:

```sh
uv sync --all-packages
RTGAIA_SEG_ENGINE=fake RTGAIA_PLUGIN_ARTIFACTS=/tmp/nn-artifacts RTGAIA_PLUGIN_DATA=/tmp/nn-data \
  uv run uvicorn --app-dir examples/plugin-nnunet plugin:app --port 8702

# In a second terminal
uv run rtgaia-plugin-check http://127.0.0.1:8702 --params '{"structures": ["Fake_Core"]}'
```

Always set `RTGAIA_PLUGIN_DATA` and `RTGAIA_PLUGIN_ARTIFACTS`; their defaults, `./data` and `./artifacts`, are relative to the working directory.

Real TotalSegmentator inference needs the optional `inference` dependencies (PyTorch, TotalSegmentator, nnU-Net). The example keeps them in its own environment, outside the RT-Gaia workspace. A GPU is strongly recommended. On first use TotalSegmentator downloads its weights to `~/.totalsegmentator`, or to `TOTALSEG_HOME_DIR` when set.

```sh
cd examples/plugin-nnunet
uv sync -p 3.12 --extra inference
RTGAIA_SEG_ENGINE=totalseg RTGAIA_SEG_DEVICE=gpu \
RTGAIA_PLUGIN_ARTIFACTS=/tmp/nn-artifacts RTGAIA_PLUGIN_DATA=/tmp/nn-data \
  uv run uvicorn plugin:app --port 8702

# In a second terminal, at the repository root, with a de-identified CT in NIfTI format
uv run rtgaia-plugin-check http://127.0.0.1:8702 --image ct.nii.gz \
    --params '{"structures": ["liver", "spleen", "aorta"]}'
```

Remote mode, with the fake engine standing in for a GPU server:

```sh
# The inference service
RTGAIA_SEG_ENGINE=fake RTGAIA_SEG_REMOTE_TOKEN=secret \
  uv run uvicorn --app-dir examples/plugin-nnunet server:app --port 8710

# Switch the plugin to remote mode, as an administrator would in the panel
curl -X PATCH http://127.0.0.1:8702/settings \
     -H 'X-RTGaia-Actor: alice' -H 'X-RTGaia-Role: admin' -H 'Content-Type: application/json' \
     -d '{"mode": "remote", "remote_url": "http://127.0.0.1", "remote_port": 8710, "remote_token": "secret"}'
```

RT-Gaia adds the `X-RTGaia-Actor` and `X-RTGaia-Role` headers when it proxies a request; when you call the plugin directly, you set them yourself. The plugin's custom endpoints trust these headers and do not check the bearer token, so only RT-Gaia may be able to reach the plugin.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `RTGAIA_SEG_ENGINE` | `totalseg` | `totalseg`, `nnunet`, or `fake` |
| `RTGAIA_SEG_DEVICE` | `gpu` | TotalSegmentator: `gpu`, `cpu`, or `mps`. nnU-Net: `gpu` means `cuda`; other values are passed on unchanged. |
| `RTGAIA_TOTALSEG_TASK` | `total` | TotalSegmentator task |
| `RTGAIA_TOTALSEG_FAST` | `1` | `1` uses the fast model; `0` the full-resolution model |
| `NNUNET_RESULTS` | | nnU-Net results folder; required by the `nnunet` engine |
| `RTGAIA_NNUNET_DATASET`, `RTGAIA_NNUNET_CONFIG`, `RTGAIA_NNUNET_FOLDS` | `Dataset501_HN_OAR`, `3d_fullres`, `all` | Model to run with `nnUNetv2_predict` |
| `RTGAIA_NNUNET_LABELS_JSON` | | Label table as JSON (`{"1": {"name": ..., "color": [r, g, b], "tg263": ...}}`); by default read from the model's `dataset.json` |
| `RTGAIA_SEG_MODE` | `local` | Initial mode |
| `RTGAIA_SEG_REMOTE_URL`, `RTGAIA_SEG_REMOTE_PORT` | empty, `8710` | Initial remote service address |
| `RTGAIA_SEG_REMOTE_TOKEN` | empty | Initial token for the remote service; in `server.py`, the token it requires |
| `RTGAIA_PLUGIN_DATA` | `./data` | Directory for `settings.json` |
| `RTGAIA_PLUGIN_TOKEN`, `RTGAIA_PLUGIN_PUBLIC_URL`, `RTGAIA_PLUGIN_ARTIFACTS` | | SDK settings; see the [SDK reference](../../packages/rtgaia-plugin-sdk/README.md#configuration) |

Settings changed through the panel are saved in `RTGAIA_PLUGIN_DATA/settings.json` and take precedence over the environment at the next start. The file holds the remote token in plain text; protect the directory.

## Docker Compose

[`deploy/docker-compose.yml`](../../deploy/docker-compose.yml) builds two services from this directory with the [`Dockerfile`](Dockerfile):

| Service | Profile | Purpose |
|---|---|---|
| `plugin-nnunet` | `plugins` | The plugin, at `http://plugin-nnunet:8702` inside the Compose network. Reserves one NVIDIA GPU. |
| `seg-server` | `seg-server` | The remote inference service on port 8710 (`RTGAIA_SEG_SERVER_PORT`), for a separate GPU machine. Reserves one NVIDIA GPU. |

Before building:

1. Build the panel (see [Panel](#panel)); the image copies `ui/dist`.
2. Edit the first two requirement lines in [`requirements.txt`](requirements.txt). The SDK is not on PyPI, so the image installs `rtgaia-plugin-sdk` and `rtgaia-geom` from the RT-Gaia Git repository; point them at the repository and the tag or commit you deploy, or at your own package index.
3. Set `RTGAIA_PLUGIN_NNUNET_TOKEN` (the plugin's bearer token) and, for `seg-server`, `RTGAIA_SEG_REMOTE_TOKEN` in `deploy/.env`. Both default to `change-me`.

```sh
docker compose -f deploy/docker-compose.yml --profile plugins up -d --build
```

Then register the endpoint `http://plugin-nnunet:8702` with that token in the admin **Plugins** tab. The service sets `RTGAIA_PLUGIN_PUBLIC_URL` to the same address, so its result URLs pass RT-Gaia's origin check. Model weights are not part of the image. TotalSegmentator downloads them on first use into `/models/totalseg`, mounted from `deploy/volumes/models`, which needs internet access unless the weights are already there; your own nnU-Net models go under `/models/nnunet` (`NNUNET_RESULTS`).

## Panel

The panel in [`ui/`](ui/) appears in the right sidebar with four sections:

- The inference source: local or remote and, for remote, the service URL and port with a connection test. Only administrators can change it.
- The image series to segment, by default the active one. Results are attached to that series' frame of reference. If another image series shares that frame of reference and comes before it in the case, RT-Gaia expects masks on that series' grid, and results on a different grid are rejected (`B3`).
- The structures to compute: the labels from `GET /labels`, with color and TG-263 code, searchable by name or code. Selecting nothing means all.
- A run button with the job's progress and result.

The panel's text, like the manifest's label and description, is in Traditional Chinese. Build and check it with the viewer's toolchain:

```sh
cd apps/viewer
npm ci   # once
npx tsc -p ../../examples/plugin-nnunet/ui/tsconfig.json --noEmit
npx vite build --config ../../examples/plugin-nnunet/ui/vite.config.ts
node ../../examples/check-ui-bundle.mjs ../../examples/plugin-nnunet/ui/dist/index.js nnunet-oar 0.2.2
```

When `ui/dist` exists at startup, the plugin adds `ui` (with `"trust": "host-equivalent"`) to its manifest and serves the bundle at `/ui/index.js`. Without it, RT-Gaia shows a generated form with a single `structures` field. The panel's logic lives in `ui/src/model.ts` and is tested by `apps/viewer/tests/plugin-nnunet-ui-model.test.ts` (`cd apps/viewer && npx vitest run tests/plugin-nnunet-ui-model.test.ts`).

## Parameters and results

The only parameter is `params.structures`, a list of label names from `GET /labels`; an empty or missing list means all labels. Unknown names fail the job with an error that lists them. Every requested structure is returned. Structures the model did not find come back empty (marked `allow_empty`), so the user sees an empty structure instead of a missing one; with all labels requested, that can be many structures. Each run writes the audit event `plugin.nnunet.run` with the mode, engine, requested structures, and the numbers of accepted and rejected structures.

## Custom endpoints

RT-Gaia proxies these as `/api/v1/modules/nnunet-oar/<path>` and adds the user's identity headers. The proxy also enforces the manifest's `required_role` (`contourer`), and methods other than `GET` need at least `contourer`.

| Method | Path | Role checked by the plugin | Content |
|---|---|---|---|
| GET | `/labels` | viewer | `{"1": {"name", "color", "tg263"}, ...}` from the local engine, or from the remote service's `/labels` in remote mode |
| GET | `/settings` | viewer | `mode`, `remote_url`, `remote_port`, `remote_token_set`, `engine` |
| PATCH | `/settings` | admin | Any of `mode`, `remote_url`, `remote_port`, `remote_token`. The token can be written but is never returned. |
| POST | `/remote/health` | viewer | Tests the connection to the remote service |
| GET | `/engine/health` | viewer | State of the local engine (for TotalSegmentator: version, task, fast mode, device) |

`PATCH /settings` rejects unknown fields, a `mode` other than `local` or `remote`, ports outside 1–65535, and URLs that do not start with `http://` or `https://`.

## Remote inference service

Any implementation of this interface can replace [`server.py`](server.py):

| Method | Path | Content |
|---|---|---|
| GET | `/health` | `{"status": "ok", "engine": ...}` |
| GET | `/labels` | The label table, as in `GET /labels` above |
| POST | `/predict` | Multipart form with `image` (a `.nii.gz` file) and `structures` (a JSON array of names; empty means all). Returns a `.nii.gz` label map on the input grid. |

When `RTGAIA_SEG_REMOTE_TOKEN` is set, every request needs `Authorization: Bearer <token>`. The image leaves the plugin's host in remote mode, so use `https://` or a trusted network between the plugin and the service.

## Tests

```sh
uv run pytest packages/rtgaia-plugin-sdk -q
```

The SDK's end-to-end tests run this plugin with the fake engine: all labels, a subset, an unknown label, the role checks and validation of `/settings`, and forwarding to `server.py` in remote mode.
