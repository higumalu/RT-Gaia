# rtgaia-plugin-sdk

The Python reference SDK for RT-Gaia plugins (contract v1). An RT-Gaia plugin is an out-of-process HTTP service with its own dependencies and hardware; RT-Gaia talks to it only through the [plugin contract](../../docs/plugin-contract.md), whose machine-readable files are in [`packages/rtgaia-plugin-api`](../rtgaia-plugin-api/). With this package you write one function, `run(ctx)`; the SDK provides the plugin endpoints, the client for RT-Gaia's callbacks, result files, and ImportBundle building and validation. It also ships `rtgaia-plugin-check`, a mock host for testing any plugin, whatever its language.

RT-Gaia validates incoming bundles with this package's validator (`rtgaia_plugin_sdk.contract`), so the checker and the real host apply the same rules.

For a step-by-step introduction, read the [plugin developer guide](../../docs/plugins.md). RT-Gaia is research software, not a medical device; it must not be used for clinical decision making, and plugins built with this SDK are research tools.

## Install

Requires Python 3.11 or later. The SDK is installed from the RT-Gaia source together with `rtgaia-geom`, the shared geometry package; neither is on PyPI.

```sh
# In a checkout, with uv: the whole workspace, including the SDK and rtgaia-plugin-check
uv sync --all-packages

# With pip, from a checkout
pip install ./packages/rtgaia-geom ./packages/rtgaia-plugin-sdk

# With pip, from the repository
pip install "rtgaia-geom @ git+<repository-url>@<tag-or-commit>#subdirectory=packages/rtgaia-geom" \
            "rtgaia-plugin-sdk @ git+<repository-url>@<tag-or-commit>#subdirectory=packages/rtgaia-plugin-sdk"
```

Dependencies: FastAPI, uvicorn, httpx, NumPy, SimpleITK (NIfTI input and output), and jsonschema.

## Quick start

```sh
# Terminal 1, at the repository root: run the minimal example plugin
RTGAIA_PLUGIN_ARTIFACTS=/tmp/hello-artifacts \
  uv run uvicorn --app-dir examples/plugin-hello-python plugin:app --port 8701

# Terminal 2: play the host against it; prints PASS or FAIL
uv run rtgaia-plugin-check http://127.0.0.1:8701 --params '{"hu_min": 0, "name": "Sphere"}'
```

A plugin is a manifest and a `run` function:

```python
from rtgaia_plugin_sdk import PluginApp, RunContext

MANIFEST = {...}  # see docs/plugin-contract.md; schema in packages/rtgaia-plugin-api/schemas


def run(ctx: RunContext) -> None:
    volume, grid = ctx.fetch_image()  # NumPy array indexed (k, j, i), and its Grid
    ctx.progress(10, "inference")
    labelmap = my_model(volume)  # must be on the same grid: RT-Gaia never resamples (B3)
    url = ctx.publish_nifti("seg.nii.gz", labelmap, grid)
    bundle = ctx.bundle()  # provenance.module_version is already "<id>@<version>"
    bundle.add_structure_labelmap(
        name="Parotid_L",
        color_rgb=(255, 200, 0),
        tg263_code="Parotid_L",
        frame_of_reference_uid=grid.frame_of_reference_uid,
        url=url,
        value=1,
    )
    outcome = ctx.submit(bundle)  # POST /results -> {"accepted": [...], "rejected": [...]}
    ctx.audit("my-plugin.run", {"accepted": len(outcome["accepted"])})


app = PluginApp(manifest=MANIFEST, run=run).app  # uvicorn my_plugin:app
```

## Reference

### PluginApp

`PluginApp(*, manifest, run, artifacts_dir=None, ui_dir=None, token=None, public_url=None)` validates the manifest against the schema (raising `ContractError` if it is malformed) and builds a FastAPI application, available as `.app`. `.module_version` is `"<id>@<version>"`.

| Endpoint | Behavior |
|---|---|
| `GET /manifest` | Returns the manifest |
| `GET /health` | `{"status": "ok", "version": <manifest version>}` |
| `POST /run` | `422` if a top-level RunRequest field is missing; `429` with `Retry-After: 30` when `execution.concurrency` jobs are queued or running; otherwise `202` and `run(ctx)` starts in a background thread |
| `GET /jobs/{job_id}` | `status`, `percent`, `phase`, `error`; `404` for unknown jobs |
| `DELETE /jobs/{job_id}` | Sets the job's cancel flag; always `204` |
| `GET /jobs/{job_id}/result` | Poll mode: the merged bundle once done; `409` before |
| `GET /artifacts/{job_id}/{name}` | Result files written by `publish_*()` |
| `GET /ui/...` | Files from `ui_dir`, when given |

When `run` returns, the SDK marks the job `done` and posts `/done`. A cancellation marks it `failed` with `cancelled`; any other exception marks it `failed` with `"<ExceptionType>: <message>"`. With `"progress": "poll"`, `ctx.submit()` only collects bundles, and the SDK merges them into the result served at `/jobs/{job_id}/result` (an empty bundle when nothing was submitted).

### RunContext

| Member | Purpose |
|---|---|
| `job_id`, `params`, `request` | Job id, validated parameters, and the full RunRequest |
| `input_grid`, `parent_hash` | Grid and content hash of the input image |
| `fetch_image()` | `(array, Grid)` of the input image; the array is indexed `(k, j, i)` |
| `fetch_image_bytes()` | Raw NIfTI bytes and the response headers |
| `fetch_structure_mask(structure_id)` | `(array, Grid)` of an input structure |
| `progress(percent, phase=None)` | Reports progress (errors while reporting are ignored); raises when the job was cancelled |
| `check_cancelled()` | Raises when the job was cancelled |
| `publish_bytes(name, data)` | Writes `<artifacts>/<job_id>/<name>` and returns its URL |
| `publish_nifti(name, volume, grid)` | Writes a NIfTI file (gzip-compressed when `name` ends in `.gz`) and returns its URL |
| `bundle(source="model")` | A `BundleBuilder` with `module_version` and `parent_hash` filled in |
| `submit(bundle)` | Validates the bundle against the schema and posts it to `/results`; accepts a builder or a dict |
| `audit(kind, payload)` | Posts an audit event |
| `kv` | The `HostCallback` client (KV methods and `list_structures()`) |

### BundleBuilder

Every `add_*` method takes keyword arguments and returns the builder, so calls can be chained. `to_dict()` returns the bundle.

| Method | Adds |
|---|---|
| `add_structure_labelmap(name, color_rgb, frame_of_reference_uid, url, value, tg263_code=None, allow_empty=False)` | A structure from a label map |
| `add_image(series_id, label, modality, grid, url, encoding="nifti", window_level=None)` | An image volume; `window_level` is `(center, width)` |
| `add_dose(label, grid, url, encoding="nifti", summation=None)` | A dose volume in Gy |
| `add_frame_group(frame_of_reference_uid, series_id, transform_to_primary, kind="rigid")` | A new frame of reference for an image in the bundle |
| `add_measurement(kind, label, frame_of_reference_uid, points)` | A measurement; `points` are flat x, y, z triplets |
| `add_report(label, media_type, url)` | A document |

There are no builder methods for `json-mask`, `dicom-rtstruct`, and `dicom-seg` structures; add such members to the dict yourself.

### HostCallback

`HostCallback(base_url, token, *, timeout_s=120.0)` is the client for RT-Gaia's callbacks; `RunContext` creates one per job. Methods: `get_image_bytes()`, `list_structures()`, `get_structure_mask(structure_id, *, fmt="nifti")`, `progress(percent, phase=None)`, `results(bundle)`, `done(*, status="done", error=None)`, `kv_get(key)` (returns `None` for a missing key), `kv_put(key, value)`, `kv_delete(key)`, and `audit(kind, payload)`. Non-2xx responses raise `httpx.HTTPStatusError`.

### Other exports

| Name | Purpose |
|---|---|
| `require_role(request, role)` | Guard for custom endpoints: returns the actor, or raises `403 PL-ROLE` unless `X-RTGaia-Role` is at least `role`. Trusts the identity headers RT-Gaia adds when proxying; it does not check the bearer token. |
| `actor_from_request(request)` | `(actor, role)` from those headers, `(None, None)` when absent |
| `validate_manifest(manifest, *, allow_licenses=())` | Schema, license allow-list, and `api_version` check; raises `ContractError` |
| `validate_bundle_structure(bundle)` | ImportBundle schema check; raises `ContractError` |
| `check_bundle_semantics(bundle, *, expected_module_version, known_frame_of_reference_uids, mask_grids, quota_bytes, fetch, max_decoded_bytes=None)` | Rules B1–B8; returns `(accepted, rejected)` |
| `ContractError`, `BundleRejection` | Error with `code`, `message`, `pointer`; a rejected member with `kind`, `index`, `code`, `reason` |
| `load_schema(name)` | The packaged `manifest` or `import-bundle` schema |
| `grid_from_json`, `grid_to_json`, `grids_equal` | Grid conversion and comparison (`grids_equal` returns `None` or the reason they differ) |
| `read_nifti(path, *, frame_of_reference_uid)`, `write_nifti(volume, grid, path)` | NIfTI input and output through SimpleITK (LPS geometry) |

## Configuration

| Environment variable | Default | Purpose |
|---|---|---|
| `RTGAIA_PLUGIN_TOKEN` | Unset | Bearer token RT-Gaia must send. When unset nothing is checked; use that only for local development. |
| `RTGAIA_PLUGIN_PUBLIC_URL` | Unset | Base of the artifact URLs, as RT-Gaia reaches the plugin, for example `http://plugin-nnunet:8702` inside a Compose network. Unset: the base URL of RT-Gaia's `/run` request. |
| `RTGAIA_PLUGIN_ARTIFACTS` | `./artifacts` | Directory for result files |

The token is checked on the contract endpoints only; `/artifacts/` and `/ui/` are served without it. Keep the plugin on a network that only RT-Gaia can reach. Job state lives in memory, and artifacts are never deleted by the SDK.

## rtgaia-plugin-check

```sh
rtgaia-plugin-check <endpoint> [--token TOKEN] [--params JSON] [--image CT.nii.gz] \
                    [--public-host HOST] [--timeout SECONDS]
```

The checker validates the manifest and `/health`, runs one job on a synthetic CT (or on `--image`) with a mock callback server, validates every bundle with B1–B8, and checks a declared UI bundle. It exits with 0 and prints `PASS` when every step passes. Details and limits are in [Testing with rtgaia-plugin-check](../../docs/plugins.md#testing-with-rtgaia-plugin-check).

## Common failures

| Message | Cause |
|---|---|
| `B3`, label map grid differs from the MaskGrid | The model resampled and the output was not resampled back. Write the NIfTI with the input `grid`. |
| `B8`, value missing (`empty_mask`) | The label has no voxels. If an empty result is valid, pass `allow_empty=True`. |
| `B1`, `module_version` differs from the registered one | The bundle was not created with `ctx.bundle()`, or the manifest `id` or `version` does not match the bundle. |
| `PL-LICENSE` | `licenses` holds a license outside the allow-list (MIT, BSD-2-Clause, BSD-3-Clause, Apache-2.0). Model-weight licenses go in `soup` with `kind: "model-weights"`. |
| UI bundle imports other packages | The build bundled React or another package. Mark the four externals as in `examples/plugin-hello-ui/vite.config.ts`. |
| No `/done` or `/progress` arrives | The plugin cannot reach `callback.base_url`. Check the host name in it; with the checker, use `--public-host`. |

More cases are in the guide's [troubleshooting table](../../docs/plugins.md#troubleshooting).

## Examples

| Directory | Content |
|---|---|
| [`examples/plugin-hello-python`](../../examples/plugin-hello-python/) | HU threshold to one structure; the template to start from |
| [`examples/plugin-nnunet`](../../examples/plugin-nnunet/) | nnU-Net-family adapter; `RTGAIA_SEG_ENGINE=fake` runs the contract test without model weights |
| [`examples/plugin-hello-ui`](../../examples/plugin-hello-ui/) | UI bundle with a right-sidebar panel and an overlay painter |

## Tests

```sh
uv run pytest packages/rtgaia-plugin-sdk          # contract unit tests and end-to-end runs of the examples
uv run pytest packages/rtgaia-plugin-sdk -m "not e2e"   # skip the tests that start real servers
uv run ruff check packages/rtgaia-plugin-sdk examples
```

The end-to-end tests start the example plugins with uvicorn and run the checker against them, including a negative case that must fail with `B3`.
