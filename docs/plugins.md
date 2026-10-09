# Plugin developer guide

A plugin adds a capability to RT-Gaia, typically an AI model or an algorithm that produces structures, without changing RT-Gaia's code. This guide shows how to build, test, and register one. The exact rules are in the [plugin contract](plugin-contract.md).

RT-Gaia is research software. It is not a medical device, has not been cleared or approved by any regulatory authority, and must not be used for clinical decision making. Plugins, including the nnU-Net example, are research tools: check the licenses of the models and weights they use, and test only with de-identified data.

## How plugins work

A plugin is an HTTP service. It runs in its own process or container, in any language, with its own dependencies and GPU. RT-Gaia never loads plugin code into its server; the two sides talk only over HTTP.

1. An administrator registers the plugin's endpoint URL and bearer token. RT-Gaia fetches and validates the plugin's manifest and health-checks the plugin from then on.
2. A user opens the plugin from the **Plugins** menu in the viewer and runs it. RT-Gaia creates a job and sends `POST /run` to the plugin with download URLs for the inputs and a token for calling back.
3. The plugin downloads the image as NIfTI, does its work, reports progress, and returns an ImportBundle: a JSON document that points to result files, such as a label map on the input grid.
4. RT-Gaia validates the bundle and puts accepted structures into the user's **Plugin results (unsaved)** set. Only that user sees them; they can edit them, then **Save** them into their structure set or **Discard** them.

What you provide:

| Part | Required | Purpose |
|---|---|---|
| `GET /manifest` | Yes | Identity, version, licenses, inputs, parameter schema, capabilities |
| `GET /health` | Yes | Liveness and the current version |
| `POST /run`, `GET` and `DELETE /jobs/{job_id}` | Yes | Start, follow, and cancel jobs |
| `GET /jobs/{job_id}/result` | Poll mode only | The result bundle, if the host should pull it |
| Result files | Yes | Files RT-Gaia downloads; usually served by the plugin itself |
| UI bundle at `/ui/index.js` | No | Your own panel in the viewer. Without it, RT-Gaia generates a form from your parameter schema. |
| Custom endpoints | No | Whatever your own panel needs, reached through the RT-Gaia proxy |

## Quick start with the Python SDK

The Python SDK, `rtgaia-plugin-sdk`, implements the endpoints, the callback client, result files, and bundle validation. You write one function, `run(ctx)`. The SDK's reference is in [its README](../packages/rtgaia-plugin-sdk/README.md).

### Install

The SDK needs Python 3.11 or later. It is installed from the RT-Gaia source (it is not on PyPI) together with `rtgaia-geom`, the shared geometry package.

From a checkout, with uv. This installs the whole workspace, including the SDK and the `rtgaia-plugin-check` command:

```sh
uv sync --all-packages
```

Into your own environment with pip, from a checkout or straight from the repository:

```sh
pip install ./packages/rtgaia-geom ./packages/rtgaia-plugin-sdk

pip install "rtgaia-geom @ git+<repository-url>@<tag-or-commit>#subdirectory=packages/rtgaia-geom" \
            "rtgaia-plugin-sdk @ git+<repository-url>@<tag-or-commit>#subdirectory=packages/rtgaia-plugin-sdk"
```

### Run the example and the contract check

```sh
# Terminal 1, at the repository root: start the example plugin
RTGAIA_PLUGIN_ARTIFACTS=/tmp/hello-artifacts \
  uv run uvicorn --app-dir examples/plugin-hello-python plugin:app --port 8701

# Terminal 2: play the host against it
uv run rtgaia-plugin-check http://127.0.0.1:8701 --params '{"hu_min": 0, "name": "Sphere"}'
```

The checker sends a synthetic CT, receives the plugin's label map, validates it the way RT-Gaia does, and ends with `PASS` or `FAIL`.

### Write your plugin

```python
import numpy as np
from rtgaia_plugin_sdk import PluginApp, RunContext

MANIFEST = {
    "id": "my-threshold",
    "version": "0.1.0",
    "api_version": "1",
    "label": "My threshold",
    "licenses": ["MIT"],
    "soup": [],
    "required_role": "contourer",
    "capabilities": ["read-image", "write-transient"],
    "inputs": {
        "image": {"required": True, "format": "nifti", "modalities": ["CT"]},
        "params_schema": {
            "type": "object",
            "properties": {"hu_min": {"type": "number", "default": 0, "title": "Lower HU limit"}},
        },
    },
    "outputs": {"kinds": ["structures"], "encodings": ["labelmap"]},
    "execution": {"timeout_s": 300, "progress": "callback", "concurrency": 1},
}


def run(ctx: RunContext) -> None:
    volume, grid = ctx.fetch_image()  # NumPy array indexed (k, j, i), and its grid
    ctx.progress(20, "threshold")
    labelmap = (volume > float(ctx.params.get("hu_min", 0))).astype(np.uint8)
    url = ctx.publish_nifti("seg.nii.gz", labelmap, grid)  # same grid as the input
    bundle = ctx.bundle().add_structure_labelmap(
        name="Threshold",
        color_rgb=(255, 200, 0),
        frame_of_reference_uid=grid.frame_of_reference_uid,
        url=url,
        value=1,
    )
    outcome = ctx.submit(bundle)  # {"accepted": [...], "rejected": [...]}


app = PluginApp(manifest=MANIFEST, run=run).app
```

Save it as `my_plugin.py`, start it with `uvicorn my_plugin:app --port 8701`, and run `rtgaia-plugin-check http://127.0.0.1:8701`.

- `PluginApp` validates the manifest when it is created, so a malformed manifest fails at startup.
- `POST /run` answers `202` and runs `run(ctx)` in a background thread. When `run` returns, the SDK reports `done`; when it raises, the SDK reports `failed` with the exception text.
- Write results on the input grid. RT-Gaia never resamples; a label map on any other grid is rejected with `B3`.
- `ctx.publish_nifti()` writes the file into the artifacts directory and returns the URL RT-Gaia downloads it from. The plugin serves those files itself under `/artifacts/`.
- `ctx.bundle()` starts an ImportBundle with `provenance` already filled in. `ctx.submit()` sends it to RT-Gaia and returns which members were accepted or rejected, with a code (`B1`–`B8`) for each rejection.

### The run context

| Member | Purpose |
|---|---|
| `ctx.params` | Parameters, already validated by RT-Gaia against `params_schema` |
| `ctx.request` | The full RunRequest (inputs, `actor`, `case`, `timeout_s`) |
| `ctx.job_id`, `ctx.input_grid`, `ctx.parent_hash` | Job id, input grid, and input content hash |
| `ctx.fetch_image()` | Input image as `(array, Grid)`; `fetch_image_bytes()` returns the raw NIfTI and headers |
| `ctx.fetch_structure_mask(structure_id)` | An input structure as `(array, Grid)`, 0 and 1 on the MaskGrid (needs `read-masks`) |
| `ctx.progress(percent, phase)` | Report progress; raises if the job was cancelled |
| `ctx.check_cancelled()` | Raise if the job was cancelled; call it in long loops |
| `ctx.publish_nifti(name, volume, grid)`, `ctx.publish_bytes(name, data)` | Write a result file and return its URL |
| `ctx.bundle(source="model")` | A new `BundleBuilder` |
| `ctx.submit(bundle)` | Validate the bundle's structure and deliver it (accepts a `BundleBuilder` or a plain dict) |
| `ctx.audit(kind, payload)` | Write an audit event (needs `audit`) |
| `ctx.kv` | Callback client: `kv_get`, `kv_put`, `kv_delete` (need `kv`), and `list_structures()` (needs `read-structures`) |

`BundleBuilder` has `add_structure_labelmap`, `add_image`, `add_dose`, `add_frame_group`, `add_measurement`, and `add_report`. For `json-mask`, `dicom-rtstruct`, or `dicom-seg` structures, build the member as a dict (see the [contract](plugin-contract.md#structures)) and submit a plain dict.

### Cancellation and poll mode

The user who started a job, or an administrator, can cancel it through RT-Gaia's API (`DELETE /api/v1/plugins/<id>/jobs/<job_id>`; the generated panel has no cancel button). RT-Gaia then calls `DELETE /jobs/{job_id}` on the plugin, the SDK marks the job cancelled, and the next `ctx.progress()` or `ctx.check_cancelled()` call stops `run` with the error `cancelled`. Long computations that report no progress cannot be interrupted, so check for cancellation between steps.

With `"progress": "poll"` in `execution`, RT-Gaia polls `GET /jobs/{job_id}` instead of waiting for callbacks. `ctx.submit()` then only collects bundles; the SDK merges them into one result that RT-Gaia pulls from `GET /jobs/{job_id}/result` when the job is done.

### SDK configuration

| Environment variable | `PluginApp` argument | Default | Purpose |
|---|---|---|---|
| `RTGAIA_PLUGIN_TOKEN` | `token` | Unset | Bearer token RT-Gaia must send. Unset means no check, which is only for local development. |
| `RTGAIA_PLUGIN_PUBLIC_URL` | `public_url` | Unset | Base URL in artifact URLs. Unset: the URL RT-Gaia used to call `/run`. |
| `RTGAIA_PLUGIN_ARTIFACTS` | `artifacts_dir` | `./artifacts` | Where result files are written and served from |
| | `ui_dir` | None | Directory served at `/ui/` (for a UI bundle) |

The SDK keeps job state in memory, so a restarted plugin forgets its jobs (RT-Gaia then fails them at their deadline). It never deletes artifacts; clean the directory yourself. It serves `/artifacts/` and `/ui/` without checking the token, so keep the plugin on a network that only RT-Gaia can reach.

### Custom endpoints

Add routes to `app` for whatever your panel needs. RT-Gaia exposes them to users as `/api/v1/modules/<id>/<path>` and adds the user's name and role in headers. Guard them with `require_role`:

```python
from fastapi import Request
from rtgaia_plugin_sdk import require_role

@app.patch("/settings")
async def update_settings(request: Request) -> dict:
    actor = require_role(request, "admin")  # 403 unless proxied by RT-Gaia for an admin
    ...
```

`require_role` trusts the `X-RTGaia-Actor` and `X-RTGaia-Role` headers, which only RT-Gaia should be able to send. It does not check the bearer token; if other clients can reach the plugin, check the token in your routes too.

## Writing a plugin in another language

Implement the endpoints in [`openapi.yaml`](../packages/rtgaia-plugin-api/openapi.yaml) (`x-side: plugin`) and validate your documents against the [JSON schemas](../packages/rtgaia-plugin-api/schemas/). A conforming plugin:

1. Serves `GET /manifest` and `GET /health`, both with the same `version`, and checks `Authorization: Bearer <token>` on every request when a token is configured.
2. Answers `POST /run` within seconds with `202 {"job_id": "..."}` and does the work in the background. At its concurrency limit it answers `429` with `Retry-After`; RT-Gaia does not retry, so the user's job fails.
3. Calls back with the job's token from the RunRequest:

```sh
curl -H "Authorization: Bearer $TOKEN" "$BASE_URL/inputs/image" -o ct.nii.gz
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"percent": 50, "phase": "inference"}' "$BASE_URL/progress"
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d @bundle.json "$BASE_URL/results"
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"status": "done"}' "$BASE_URL/done"
```

4. Serves the result files from its own origin, or from an origin it lists in `artifact_origins`, without redirects.
5. Implements `GET /jobs/{job_id}` and an idempotent `DELETE /jobs/{job_id}`, plus `GET /jobs/{job_id}/result` in poll mode.

Use a NIfTI library that keeps the physical geometry. ITK and SimpleITK work in LPS coordinates like RT-Gaia; libraries that work in RAS, such as nibabel, need the conversion. Then test the plugin with `rtgaia-plugin-check` from a Python environment with the SDK installed.

## Geometry rules

- Coordinates are LPS millimeters. A grid maps voxel indices to positions as `origin + direction · (spacing ⊙ ijk)`, where column c of the row-major `direction` matrix is the direction of index axis c.
- Structure masks must lie exactly on the MaskGrid of their frame of reference (size equal; spacing and origin within 0.001 mm; direction within 1e-6). For the series that defines that grid, normally the primary image, the MaskGrid is the input grid from the RunRequest. If your model resamples internally, resample the output back with nearest-neighbor interpolation before you publish it.
- Every result carries its frame of reference UID. Copy it from the input.
- Images and doses may use their own grids, but the NIfTI header must match the `grid` you declare.

## Adding a UI bundle

Without a UI bundle, RT-Gaia shows a generated panel: a form built from `params_schema`, a **Run** button, progress, and a result summary. That panel always runs on the primary image series and sends no input structures. Write a UI bundle when you need more, for example letting the user pick an image or choose labels from a list.

1. **Write the entry module.** Import only `react`, `react-dom`, `react/jsx-runtime`, and `@rtgaia/sdk`, and export an entry object whose `id` and `version` equal the manifest's:

```tsx
import { registerModule, type PluginUiEntry, type ViewerPanelProps } from '@rtgaia/sdk';

const ID = 'my-threshold';

function Panel({ api }: ViewerPanelProps): React.JSX.Element {
  return <p>{api.state.structures.length} structures in this case</p>;
}

const entry: PluginUiEntry = {
  id: ID,
  version: '0.1.0',
  sdkVersion: '^0.1.0',
  register() {
    registerModule({
      id: ID,
      version: '0.1.0',
      panels: [{ id: `${ID}.panel`, slot: 'right-sidebar', order: 500, title: 'My threshold',
                 component: Panel, visibleWhen: (s) => s.modes.includes(`plugin:${ID}`) }],
    });
  },
};
export default entry;
```

2. **Build one ES module** with Vite in library mode and the four imports marked external, as in [`examples/plugin-hello-ui/vite.config.ts`](../examples/plugin-hello-ui/vite.config.ts). `@rtgaia/sdk` is not an npm package: type-check and build against `apps/viewer/src/sdk/index.ts` in a checkout, as the examples do. RT-Gaia serves only the one file, so inline styles and assets.
3. **Check the bundle**: `node examples/check-ui-bundle.mjs <path>/dist/index.js <id> <version>`.
4. **Serve it** at `/ui/index.js` (in the SDK: `PluginApp(..., ui_dir="dist")`) and declare it in the manifest:

```json
"ui": { "bundle": "/ui/index.js", "sdk_version": "^0.1.0", "trust": "host-equivalent", "panels": ["my-threshold.panel"] }
```

5. **Bump `version`** in the manifest and the entry whenever the bundle changes. RT-Gaia pins the bundle's SHA-256 digest at registration and on each version change; a changed bundle with an unchanged version puts the plugin in quarantine.

Your panel receives `api`: `api.state` (a read-only snapshot of the viewer), `api.commands`, `api.overlay` for drawing on the images, and `api.http` for JSON calls to RT-Gaia. Typical calls from a plugin panel:

| Call | Purpose |
|---|---|
| `api.http.postJson('/plugins/<id>/run', { params, image_series_id, study_id })` | Start a job |
| `api.http.getJson('/jobs/<job_id>')` | Follow it until `done` or `failed` |
| `api.commands.refreshStructureSets()` and `api.commands.refreshStructures()` | Refresh the structure list when the job is done |
| `api.http.getJson('/modules/<id>/<path>')` | Call your custom endpoints through RT-Gaia |

**Localization.** The viewer's interface is available in Traditional Chinese and English. Write your panel's text in one language and use it as the key, register translations for the other with `registerMessages`, and display text with `t` (SDK `0.1.1` and later; declare `sdkVersion: '^0.1.1'`):

```tsx
import { registerMessages, t } from '@rtgaia/sdk';

registerMessages('en', { '執行推論': 'Run', '要推論的 ROI（{n}）': 'Structures to compute ({n})' });
// in the panel
<button>{t('執行推論')}</button>
<legend>{t('要推論的 ROI（{n}）', { n: 3 })}</legend>
```

`t` returns the key itself when no translation is registered for the current language. The viewer also passes panel titles and the manifest's `label` and `description` through `t`, so registering those strings localizes the Plugins menu and the administration page too. [`examples/plugin-nnunet/ui/src/en.ts`](../examples/plugin-nnunet/ui/src/en.ts) is a complete example.

A UI bundle is trusted code. It runs inside the viewer page with the signed-in user's privileges, with the same origin, the same cookies, and access to every API that user can call. RT-Gaia does not sandbox it. That is why the manifest must declare `"trust": "host-equivalent"`, why an administrator must register the plugin, and why the bundle is pinned by digest (and re-pinned, with an audit entry, when the plugin reports a new version). Do not load code from elsewhere at runtime. See [UI bundles](plugin-contract.md#ui-bundles) and [Security and trust](plugin-contract.md#security-and-trust) in the contract.

## Testing with rtgaia-plugin-check

`rtgaia-plugin-check <endpoint>` plays RT-Gaia against a running plugin:

1. Fetches `/manifest` and validates it (schema, license allow-list, `api_version`).
2. Calls `/health` and compares its `version` with the manifest.
3. Starts a mock callback server and sends `POST /run` with a synthetic CT: 64 × 64 × 48 voxels of 1 × 1 × 2 mm, air at −1000 HU, and a 20 mm radius sphere at +200 HU.
4. Waits for `/done` (callback mode) or polls `/jobs/{job_id}` (poll mode), collecting progress and bundles.
5. Validates every bundle with the same validator as RT-Gaia (schema and B1–B8, with the input grid as the MaskGrid).
6. If the manifest declares `ui`: requires `trust: host-equivalent`, downloads the bundle, and checks its imports, that React is not bundled, and that the manifest's `id` and `version` appear in it as string literals.

| Option | Purpose |
|---|---|
| `--token TOKEN` | Bearer token to send, as RT-Gaia would |
| `--params JSON` | `inputs.params` for the run |
| `--image FILE` | Use this NIfTI (`.nii` or `.nii.gz`, cast to 16-bit integers) instead of the synthetic CT |
| `--public-host HOST` | Host name the plugin uses to reach the checker, for example `host.docker.internal` for a plugin in a container |
| `--timeout SECONDS` | How long to wait for the job (default 600) |

The checker prints one line per step and one per accepted or rejected member, then `PASS` (exit status 0) or `FAIL` (1). In callback mode it expects at least one progress report, and in every mode at least one delivered member. Step labels and rejection reasons are printed in English; the codes are stable.

In tests, call it from Python: `rtgaia_plugin_sdk.check.run_check(endpoint, ...)` takes the same options as keyword arguments (`token`, `public_host`, `timeout_s`, `params`, `image`, plus `quota_bytes`) and returns a report with `ok`, `accepted`, `rejected`, `progress`, `audits`, `done`, and `render()`. The SDK's own end-to-end tests start the examples with uvicorn and assert on such reports:

```sh
uv run pytest packages/rtgaia-plugin-sdk
```

The checker does not cover everything RT-Gaia does. It serves NIfTI input only, provides no input structures (so `read-masks` is not exercised), and does not enforce capabilities, roles, artifact download rules, quotas across bundles, or UI digests. Test against a real RT-Gaia before you hand a plugin to users.

## Registering a plugin with RT-Gaia

The network must allow three paths:

| From | To | For |
|---|---|---|
| RT-Gaia server (API and any worker) | Plugin endpoint | Manifest, health, runs, polling, cancellation, proxied requests, result files |
| Plugin | RT-Gaia's public URL (`RTGAIA_PUBLIC_URL`) | Callbacks |
| Users' browsers | RT-Gaia only | Bundles and custom endpoints are proxied; browsers never contact the plugin |

To register, an administrator opens the admin page's **Plugins** tab (also reachable through **Manage plugins…** in the **Plugins** menu), enters the endpoint (for example `http://plugin-hello:8701`) and the bearer token the plugin expects, and selects **Register**. Code licenses outside the allow-list (`MIT`, `BSD-2-Clause`, `BSD-3-Clause`, `Apache-2.0`) must be listed in **Allowed licenses**; RT-Gaia records that in the audit log. RT-Gaia fetches and validates the manifest, and the UI bundle if one is declared, and reports problems with their error code.

A deployment can also let plugins register themselves. Set `RTGAIA_PLUGIN_REGISTRATION_TOKEN` on the server; the plugin then calls:

```sh
curl -X POST "$RTGAIA_URL/api/v1/plugins/register" \
     -H "Authorization: Bearer $RTGAIA_PLUGIN_REGISTRATION_TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"endpoint": "http://plugin-hello:8701", "token": "<plugin bearer token>"}'
```

Self-registration cannot allow extra licenses.

After registration:

- RT-Gaia checks `/health` every 30 seconds. After three failures in a row the plugin shows as unreachable until it answers again. **Recheck** runs the check at once; **Disable**, **Enable**, and **Remove** do what they say.
- When `/health` reports a new version, RT-Gaia fetches and validates the manifest again and re-pins the UI bundle. Open viewer pages keep the version they loaded and offer a reload in the **Plugins** menu. Upgrade plugins while no jobs are running: results from a different version than the registered one are rejected (`B1`).
- Administrators see each plugin's full manifest, including `licenses` and `soup`. The **Plugins** tab warns when model weights have a non-commercial license and lists licenses an administrator allowed.

Other settings, such as approved artifact origins, are described in [Configuration](plugin-contract.md#configuration).

### What users see

- The **Plugins** menu in the viewer's toolbar lists every registered plugin. Plugins a user cannot use are shown disabled with the reason, such as the required role. The menu is not available on phones.
- Choosing a plugin opens its panel in the right sidebar; choosing it again closes it. Running a job needs at least the `contourer` role, and at least the plugin's `required_role`.
- Progress appears in the panel. When the job finishes, accepted structures appear under **Plugin results (unsaved)** in the structure list, visible only to that user. **Save** moves them into the user's structure set, where others can see and review them; **Discard** deletes them. Unsaved results are destroyed 30 minutes after the user's last connection to the case closes.

## Services that speak DICOM

A service that already accepts and returns DICOM, such as an existing segmentation server, can be used without writing a plugin. An administrator registers it as a DICOM node with the send role. It then appears in the **Plugins** menu under **DICOM nodes (send and wait for results)**: RT-Gaia sends the case's images with C-STORE and waits up to 30 minutes for RT objects (RTSTRUCT, SEG, RTDOSE, or REG) of the same study to arrive at its own DICOM receiver. Returned objects go into the library, not into the transient set; users add them to the case from the library page. Starting such a call currently requires the admin role. See the [administration guide](administration.md).

## Examples

| Example | What it shows |
|---|---|
| [`examples/plugin-hello-python`](../examples/plugin-hello-python/) | The smallest plugin: an HU threshold turned into one structure. Start here. |
| [`examples/plugin-hello-ui`](../examples/plugin-hello-ui/) | A UI bundle with a right-sidebar panel and an overlay painter |
| [`examples/plugin-nnunet`](../examples/plugin-nnunet/) | An nnU-Net-family auto-contouring adapter (TotalSegmentator by default): label picker panel, custom endpoints, local or remote inference, and a fake engine for tests |

## Troubleshooting

| Problem | Cause and fix |
|---|---|
| `B3`: the label map grid does not match the MaskGrid | The output is not on the input grid, usually because the model resampled internally. Write the label map with the input `grid`. The input grid can also differ from the MaskGrid when the user picked a series that shares its frame of reference with an earlier one. |
| `B8`: the label value is missing (`empty_mask`) | The label map has no voxel with that value. Set `allow_empty` when an empty result is legitimate; the user then sees an empty structure. |
| `B1`: `module_version` does not match | The bundle was not started with `ctx.bundle()`, the manifest's `id` or `version` differs from the registered one, or the plugin was upgraded during the job. |
| `B7` with `PL-ARTIFACT-ORIGIN` | Result URLs point to an origin other than the registered endpoint, including a different host name or port. Set `RTGAIA_PLUGIN_PUBLIC_URL` to the registered endpoint, declare the origin in `artifact_origins`, or have an administrator approve it. |
| `PL-LICENSE` at registration | `licenses` contains a license outside the allow-list. Model-weight licenses belong in `soup` (`kind: "model-weights"`); other code licenses need an administrator's explicit allowance. |
| The checker reports disallowed imports or bundled React | Mark `react`, `react-dom`, `react/jsx-runtime`, and `@rtgaia/sdk` as external in the build. |
| No progress or results arrive; the job times out | The plugin cannot reach `callback.base_url`. Check `RTGAIA_PUBLIC_URL` on every RT-Gaia process that dispatches jobs, and the network path from the plugin. With the checker, use `--public-host` when the plugin runs in a container. |
| The job fails with `PL-DOWN` and a 429 | The plugin was at its `concurrency` limit. RT-Gaia does not retry; the user runs the job again later. |
| The plugin's status is `quarantined` | The UI bundle changed without a version change. Bump the version, or have an administrator register the plugin again. |
| The generated form appears instead of your panel | The manifest's `ui` lacks `"trust": "host-equivalent"`. |
| The plugin is unusable in the **Plugins** menu with a load error | The bundle did not load: `ui.bundle` is not `/ui/index.js`, the digest does not match, or the entry's `id`, `version`, or `sdkVersion` does not fit. The menu shows the reason. |
| `PL-SCHEMA` when a job starts | The parameters do not match `params_schema`; the `pointer` in the error names the field. |

## See also

- [Plugin contract v1](plugin-contract.md): endpoints, fields, validation rules, and limits
- [Python SDK reference](../packages/rtgaia-plugin-sdk/README.md)
- [Contract files](../packages/rtgaia-plugin-api/README.md)
- [Administration guide](administration.md) for deployment and server settings
- [Architecture](architecture.md)
- [Security policy](../SECURITY.md) and [third-party notices](../THIRD_PARTY_NOTICES.md)
