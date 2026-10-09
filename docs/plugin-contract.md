# Plugin contract v1

This document is the normative description of contract v1 between RT-Gaia (the host) and an out-of-process plugin service. The machine-readable parts live in [`packages/rtgaia-plugin-api/`](../packages/rtgaia-plugin-api/):

| File | Content |
|---|---|
| `openapi.yaml` | Endpoints on both sides: `x-side: plugin` (the plugin implements them), `x-side: host` (callbacks the host implements), `x-side: host-ui` (host endpoints for UI bundles) |
| `schemas/manifest.schema.json` | The manifest returned by `GET /manifest` |
| `schemas/import-bundle.schema.json` | The ImportBundle a plugin uses to return results |

The reference implementation is the Python SDK in [`packages/rtgaia-plugin-sdk/`](../packages/rtgaia-plugin-sdk/); the host validates bundles with the same validator. For a tutorial, see the [plugin developer guide](plugins.md).

RT-Gaia is research software. It is not a medical device, has not been cleared or approved by any regulatory authority, and must not be used for clinical decision making. Plugin results are research outputs. Use only de-identified data for testing and demonstrations.

Statements marked "currently" describe how this release of RT-Gaia behaves where the contract leaves room or the host does less than the schema allows. Do not build on them as guarantees.

## Terms

| Term | Meaning |
|---|---|
| Host | The RT-Gaia server and the viewer running in the browser. |
| Plugin | An HTTP service that implements the plugin endpoints. Any language; it runs in its own process or container. |
| Endpoint | The base URL an administrator registers for a plugin, for example `http://plugin-nnunet:8702`. Plugin endpoint paths are relative to it. |
| Registration token | The bearer token an administrator registers with the endpoint. The host sends it on every request to the plugin. |
| Job | One run of a plugin on one case. The host creates it with kind `plugin:<id>`. |
| Callback token | A secret the host issues for one job. The plugin presents it when calling the host callbacks. |
| ImportBundle | The JSON document a plugin uses to hand results to the host. |
| Frame of reference (FoR) | A DICOM frame of reference. All coordinates are LPS millimeters within a FoR. |
| MaskGrid | The voxel grid on which the host stores structure masks for one FoR. |
| Transient set | The per-user, per-FoR structure set that holds accepted plugin results until the user saves or discards them. |

## Overview

The contract has three HTTP surfaces:

| Surface | Implemented by | Called by | Authentication | Base URL |
|---|---|---|---|---|
| Plugin endpoints | Plugin | Host | `Authorization: Bearer <registration token>`; no header when no token was registered | The endpoint |
| Host callbacks | Host | Plugin | `Authorization: Bearer <callback token>` | `callback.base_url` from the RunRequest |
| Host plugin API | Host | Viewer, UI bundles, scripts | The signed-in user's session | `/api/v1` on the host |

General rules:

- Request and response bodies are JSON (UTF-8) unless stated otherwise.
- Volumes and masks travel as files referenced by URL, never embedded in JSON. The exceptions are small `data:` URIs and the `json-mask` encoding.
- Coordinates are LPS millimeters.

A run, in order:

1. A user starts the plugin in the viewer. The host checks the user's role and the parameters, creates a job, and issues a callback token.
2. A host worker sends `POST {endpoint}/run` with a RunRequest. The plugin answers `202` and works in the background.
3. The plugin downloads its inputs from the host callbacks, reports progress, and delivers one or more ImportBundles.
4. The host validates each bundle (schema, then rules B1–B8), stores the downloaded files, and adds accepted structures to the user's transient set.
5. The job ends when the plugin reports `/done` (callback mode), when a host poll sees a terminal status (poll mode), when a user cancels it, or at the deadline. The callback token stops working at that moment.

## Manifest

`GET {endpoint}/manifest` returns the manifest. It must validate against `schemas/manifest.schema.json` (JSON Schema draft 2020-12). Unknown fields are rejected in every object the schema defines; only the content of `params_schema` is free-form.

| Field | Type | Required | Rules |
|---|---|---|---|
| `id` | string | yes | `^[a-z][a-z0-9-]{2,40}$`. Unique on a host. Appears in URLs, in the UI mode `plugin:<id>`, and in `<id>@<version>`. |
| `version` | string | yes | Semantic version: `MAJOR.MINOR.PATCH`, optional `-prerelease` and `+build`. Must equal the `version` reported by `/health`. |
| `api_version` | string | yes | Must be `"1"`. |
| `label` | string | yes | 1–40 characters. Shown in the **Plugins** menu and the admin **Plugins** tab. |
| `description` | string | no | Up to 2000 characters. Shown as the menu tooltip and on the declarative panel. |
| `icon` | string | no | Up to 32 characters, shown before the label. |
| `licenses` | string[] | yes | At least one. SPDX identifiers of the plugin's own code. See [Licenses and SOUP](#licenses-and-soup). |
| `soup` | object[] | yes, may be empty | Third-party components, including model weights. See [SOUP entries](#soup-entries). |
| `required_role` | string | yes | `viewer`, `contourer`, `approver`, or `admin`: the minimum role to use the plugin. |
| `capabilities` | string[] | yes | Unique values from [Capabilities](#capabilities). Limits which host callbacks the plugin may call. |
| `inputs` | object | yes | See [Inputs](#inputs). |
| `outputs` | object | yes | See [Outputs](#outputs). |
| `artifact_origins` | string[] | no | Unique origins `scheme://host[:port]` (pattern `^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$`) the host may download result files from, in addition to the endpoint's own origin. See [Artifact downloads](#artifact-downloads). |
| `execution` | object | yes | See [Execution](#execution). |
| `ui` | object | no | Declares a UI bundle. See [UI](#ui) and [UI bundles](#ui-bundles). |

### SOUP entries

| Field | Type | Required | Rules |
|---|---|---|---|
| `name` | string | yes | Component name. |
| `version` | string | yes | Version or version range. |
| `license` | string | yes | License identifier; use SPDX where one exists. |
| `url` | string (URI) | no | Where the component or its license is documented. |
| `kind` | string | no | `library`, `model-weights`, `dataset`, or `other`. |

List model weights as their own entries with `kind: "model-weights"` and the license of the weights, which often differs from the license of the code that runs them.

### Capabilities

| Capability | Grants |
|---|---|
| `read-image` | `GET /inputs/image` |
| `read-structures` | `GET /inputs/structures` |
| `read-masks` | `GET /inputs/structures/{structure_id}` |
| `write-transient` | `POST /results` |
| `kv` | `GET`, `PUT`, and `DELETE /kv/{key}` |
| `audit` | `POST /audit` |

`/progress` and `/done` need no capability. The host checks the capability against its stored copy of the manifest on every callback.

### Inputs

```json
{
  "image": { "required": true, "format": "nifti", "modalities": ["CT"] },
  "structures": { "required": false, "multiple": true, "statuses": ["under_review", "approved"] },
  "params_schema": {
    "type": "object",
    "properties": { "hu_min": { "type": "number", "default": 0, "title": "Lower HU limit" } }
  }
}
```

| Field | Required | Rules |
|---|---|---|
| `image.required` | yes | Boolean. |
| `image.format` | yes | `nifti`, `dicom-zip`, or `rtgaia-grid`. The host currently serves NIfTI for every value, so declare `nifti`. |
| `image.multiple` | no | Boolean, default `false`. The host sends exactly one image per job. |
| `image.modalities` | no | DICOM modality codes, for example `["CT"]`. |
| `structures` | no | Object; when present, `required` (boolean) is mandatory. |
| `structures.multiple` | no | Boolean, default `true`. |
| `structures.statuses` | no | Values from `under_review`, `approved`, `rejected`. |
| `params_schema` | yes | A JSON Schema (draft 2020-12) for `RunRequest.inputs.params`. |

The host validates the user's parameters against `params_schema` when a job starts and refuses invalid ones with `PL-SCHEMA`. The host currently does not enforce `image.required`, `image.multiple`, `image.modalities`, or the `structures` fields; for example, a user can run a CT-only plugin on an MR series. Check the input in the plugin and fail the job with a clear message when it does not fit.

Plugins without a UI bundle get a declarative panel generated from the top-level `properties` of `params_schema`:

| Property schema | Control |
|---|---|
| Has `enum` | Drop-down list |
| `type: boolean` | Checkbox |
| `type: number` or `integer` | Numeric text field |
| `type: array` whose `items` has `enum` | One checkbox per value |
| Other `type: array` | Comma-separated text field |
| Anything else | Text field (string) |

`title` labels the control, `description` becomes its tooltip, `default` sets the initial value, and properties listed in `required` are marked and checked before the job starts. The schema allows an `x-ui-widget` annotation on properties; the declarative panel currently ignores it. The declarative panel runs the plugin on the primary image series and sends no input structures.

### Outputs

| Field | Required | Rules |
|---|---|---|
| `kinds` | yes | Non-empty, unique values from `images`, `structures`, `doses`, `measurements`, `reports`. |
| `encodings` | yes | Non-empty, unique values from `nifti`, `labelmap`, `json-mask`, `rtgaia-grid`, `dicom-series`, `dicom-rtstruct`, `dicom-seg`, `dicom-rtdose`, `dicom-reg`. |

`outputs` documents what the plugin returns. The host currently does not compare delivered bundles against it.

### Execution

| Field | Required | Rules |
|---|---|---|
| `timeout_s` | yes | Integer, 1–86400. The job deadline in seconds, counted from the moment the user starts the job (time in the queue counts). |
| `progress` | yes | `callback`: the plugin delivers results with `POST /results` and ends the job with `POST /done`. `poll`: the host polls `GET /jobs/{job_id}` and pulls `GET /jobs/{job_id}/result`. |
| `concurrency` | yes | Integer, at least 1. The number of jobs the plugin runs at once; beyond it the plugin answers `429`. |

### UI

| Field | Required | Rules |
|---|---|---|
| `bundle` | yes | Pattern `^/ui/.+\.js$`. The viewer always requests `index.js`, so the only working value is `/ui/index.js`. |
| `sdk_version` | yes | Semver range of `@rtgaia/sdk` the bundle targets. Currently informational: the viewer checks the `sdkVersion` of the bundle's entry object instead. Keep both equal. |
| `trust` | no | `host-equivalent`. Declares that the bundle runs with the host's privileges. Without it the host never loads the bundle and shows the declarative panel. |
| `panels` | no | Panel ids the bundle registers. Informational. |

### Licenses and SOUP

The host accepts a manifest only when every entry in `licenses` is on the allow-list (`MIT`, `BSD-2-Clause`, `BSD-3-Clause`, `Apache-2.0`) or an administrator allowed it explicitly while registering the plugin (`allow_licenses`). Otherwise registration fails with `PL-LICENSE`. Each explicit allowance is written to the audit log (`plugin.license_override`).

`soup` licenses are not checked against the allow-list; they are disclosed. Administrators see the full manifest, including `licenses` and `soup`, in `GET /api/v1/plugins`. The admin **Plugins** tab highlights `model-weights` entries whose license string indicates non-commercial use (it contains `NC` or "non-commercial") and lists licenses an administrator allowed.

## Plugin endpoints

Paths are relative to the endpoint. The host sends `Authorization: Bearer <registration token>` when a token is registered.

| Method | Path | Success | Other responses |
|---|---|---|---|
| GET | `/manifest` | `200` manifest | |
| GET | `/health` | `200` health object | |
| POST | `/run` | `202 {"job_id": "..."}` | `429` with `Retry-After` at the concurrency limit; `422` for a malformed RunRequest |
| GET | `/jobs/{job_id}` | `200` JobStatus | `404` for an unknown job |
| DELETE | `/jobs/{job_id}` | `204` | Also `204` for unknown or finished jobs |
| GET | `/jobs/{job_id}/result` | `200` ImportBundle | `409` until the job is done |
| GET | `/ui/{path}` | The UI bundle | Only when the manifest declares `ui` |

### GET /health

```json
{ "status": "ok", "version": "0.1.0", "detail": "optional text" }
```

`status` (`ok` or `degraded`) and `version` are required by the schema. The host calls `/health` periodically (every 30 seconds by default) with a 10-second timeout. A network error, a non-2xx status, or a body that is not JSON counts as a failure; three failures in a row set the plugin's status to `failed`, and the next successful check restores `active`. The host does not interpret `status`. A `version` that differs from the registered one makes the host fetch and validate the manifest again (see [Versioning](#versioning)).

### POST /run

The body is a [RunRequest](#runrequest). The plugin must answer promptly with `202` and do the work in the background; the host waits at most 120 seconds for the response. The `job_id` in the response is the id the host then uses for `/jobs/{job_id}` on the plugin; when it is missing, the host uses its own job id.

The host does not retry a refused run and ignores `Retry-After`. A `429` fails the job at once with an error carrying the code `PL-DOWN`, and the user has to start the job again. Any other status than `202`, or a connection failure, also fails the job with `PL-DOWN`.

### RunRequest

```json
{
  "job_id": "job_1a2b3c",
  "callback": {
    "base_url": "https://rtgaia.example/api/v1/plugins/hello-threshold/jobs/job_1a2b3c",
    "token": "...",
    "expires_at": "2026-01-01T12:00:00+00:00"
  },
  "case": { "case_id": "case_0123456789ab", "primary_frame_of_reference_uid": "1.2.826.0.1.3680043.8.498.1" },
  "inputs": {
    "image": {
      "series_id": "1.2.826.0.1.3680043.8.498.2",
      "frame_of_reference_uid": "1.2.826.0.1.3680043.8.498.1",
      "modality": "CT",
      "grid": {
        "size": [512, 512, 120], "spacing": [0.98, 0.98, 2.5], "origin": [-250.0, -250.0, -150.0],
        "direction": [1, 0, 0, 0, 1, 0, 0, 0, 1], "frame_of_reference_uid": "1.2.826.0.1.3680043.8.498.1"
      },
      "content_hash": "sha256:...",
      "url": "https://rtgaia.example/api/v1/plugins/hello-threshold/jobs/job_1a2b3c/inputs/image"
    },
    "structures": [],
    "params": { "hu_min": 0 }
  },
  "actor": { "username": "alice", "role": "contourer" },
  "timeout_s": 300
}
```

| Field | Type | Meaning |
|---|---|---|
| `job_id` | string | Host job id. Also the last segment of `callback.base_url`. |
| `callback.base_url` | string (URI) | `{host public URL}/api/v1/plugins/{plugin_id}/jobs/{job_id}`. Base for every callback. |
| `callback.token` | string | Callback token for this job. |
| `callback.expires_at` | string (date-time) | Token expiry: job start + `timeout_s` + 10 minutes. The token also stops working when the job ends. |
| `case.case_id` | string | Host case id. |
| `case.primary_frame_of_reference_uid` | string | FoR of the case's primary image series. |
| `inputs.image.series_id` | string | The image series the user chose; the primary image series by default. |
| `inputs.image.frame_of_reference_uid` | string | FoR of that series. |
| `inputs.image.modality` | string | DICOM modality of that series. |
| `inputs.image.grid` | [Grid](#grid) | Grid of that series, including `frame_of_reference_uid`. |
| `inputs.image.content_hash` | string | `sha256:` followed by 64 hex digits; identifies the input. Use it as `provenance.parent_hash`. |
| `inputs.image.url` | string (URI) | `{callback.base_url}/inputs/image`. |
| `inputs.image.value_unit` | string | Present only for series with a declared value unit, such as PET (`SUV`, or the stored activity unit). The image served at `url` is already in this unit. |
| `inputs.image.value_scale` | number | Present only with `value_unit`. The host's internal storage scale, already applied to the served image; do not apply it again. |
| `inputs.structures` | object[] | One `{structure_id, name, url}` per input structure the user selected; `url` is `{callback.base_url}/inputs/structures/{structure_id}`. |
| `inputs.params` | object | User parameters, already validated against `params_schema`. |
| `actor.username` | string | The user who started the job. |
| `actor.role` | string | That user's role. For display and records only; authorization is the host's job. |
| `timeout_s` | integer | `execution.timeout_s` from the manifest. |

Notes:

- The MaskGrid of a FoR is the grid of the first image series of that FoR in the case; for the primary FoR that is the primary image series. When `inputs.image` is that series, `inputs.image.grid` is the MaskGrid. If the user picks a different series that shares the FoR, its grid can differ from the MaskGrid, and structures returned on the input grid are rejected with B3. The RunRequest does not carry the MaskGrid separately.
- For a time-resolved (4D) series the host sends the first frame.
- Structures that exist only on individual frames of a 4D series are not listed in `inputs.structures`.

### Grid

| Field | Type | Meaning |
|---|---|---|
| `size` | integer[3], each ≥ 1 | Voxel counts along the index axes i, j, k. |
| `spacing` | number[3], each > 0 | Voxel spacing in millimeters along i, j, k. |
| `origin` | number[3] | LPS position (mm) of the center of voxel (0, 0, 0). |
| `direction` | number[9] | Row-major 3×3 matrix; column c is the unit direction of index axis c. Must be orthonormal. |
| `frame_of_reference_uid` | string | Present in RunRequest grids. ImportBundle grids omit it; the member carries the FoR. |

A voxel index maps to LPS coordinates as `world = origin + direction · (spacing ⊙ ijk)`, the same convention as ITK's `SetDirection`. Arrays in the Python SDK are indexed `(k, j, i)`.

### GET /jobs/{job_id}

```json
{ "status": "running", "percent": 40, "phase": "inference", "error": null }
```

| Field | Required | Meaning |
|---|---|---|
| `status` | yes | `queued`, `running`, `done`, or `failed`. |
| `percent` | no | 0–100. |
| `phase` | no | Short text describing the current step. |
| `error` | no | Failure reason when `failed`. |

In poll mode the host calls this endpoint on every pass of its plugin loop (every 5 seconds by default). `failed` fails the host job with `error`; `done` makes the host pull the result; otherwise the host forwards `percent` and `phase` to the viewer. Network errors and non-2xx responses are retried on the next pass.

### DELETE /jobs/{job_id}

Cancels a job; idempotent. The host calls it when a user cancels a job (10-second timeout, errors ignored) and then marks its own job failed with `cancelled`. The host does not call it when a job times out.

### GET /jobs/{job_id}/result

Poll mode only. Returns the job's ImportBundle once `/jobs/{job_id}` reports `done`, and `409` before that. The host validates it exactly like a bundle sent to `/results`.

### GET /ui/{path}

Serves the UI bundle declared in `ui.bundle`. The host downloads it with the registration token at registration and after every version change to pin its SHA-256 digest, and proxies it to the viewer; see [UI bundles](#ui-bundles).

### Custom endpoints

A plugin may serve additional paths under its endpoint, for example `GET /labels` for its own panel. The host exposes them to signed-in users as `/api/v1/modules/{plugin_id}/{path}` for `GET`, `POST`, `PUT`, `PATCH`, and `DELETE`. Before forwarding, the host requires the plugin to be active and the user's role to be at least `required_role`; methods other than `GET` also need at least `contourer`. The host forwards the method, query string, body, and `Content-Type`, and adds:

| Header | Value |
|---|---|
| `Authorization` | `Bearer <registration token>` |
| `X-RTGaia-Actor` | Username of the signed-in user |
| `X-RTGaia-Role` | `viewer`, `contourer`, `approver`, or `admin` |

From the plugin's response the host passes on the status code, the body, and only these headers: `Content-Type`, `Cache-Control`, `ETag`, `X-RTGaia-Engine`. Requests time out after 120 seconds without a response.

Custom endpoints must apply their own access rules with `X-RTGaia-Role` (for example, admin-only settings) and must refuse requests that lack the header. The identity headers are trustworthy only on requests that came through the host: verify the registration token on custom endpoints as well, or make the plugin reachable from the host only. Custom endpoints are not part of `openapi.yaml`; the plugin documents them itself.

## Host callbacks

Paths are relative to `callback.base_url`. Every request needs `Authorization: Bearer <callback.token>`. The host answers `403 PL-SCOPE` when the job does not exist or belongs to another plugin, when the token does not match, has expired, or the job has ended, and when the manifest does not declare the required capability.

| Method | Path | Capability | Request body | Response |
|---|---|---|---|---|
| GET | `/inputs/image` | `read-image` | | `200` gzip-compressed NIfTI |
| GET | `/inputs/structures` | `read-structures` | | `200` array of structure summaries |
| GET | `/inputs/structures/{structure_id}` | `read-masks` | | `200` gzip-compressed NIfTI mask |
| POST | `/progress` | | `{"percent": 0–100, "phase": "..."}` | `204` |
| POST | `/results` | `write-transient` | ImportBundle | `200` ResultsOutcome |
| POST | `/done` | | `{"status": "done" \| "failed", "error": "..."}` | `204` |
| POST | `/audit` | `audit` | `{"kind": "...", "payload": {...}}` | `204` |
| GET | `/kv/{key}` | `kv` | | `200` JSON value, `404` when absent |
| PUT | `/kv/{key}` | `kv` | Any JSON value | `204`, `413` over a limit |
| DELETE | `/kv/{key}` | `kv` | | `204` |

### GET /inputs/image

Returns the input series as a gzip-compressed NIfTI file (`application/gzip`), whatever `inputs.image.format` says. Headers:

| Header | Content |
|---|---|
| `X-RTGaia-Grid` | The [Grid](#grid) as JSON, including `frame_of_reference_uid` |
| `X-RTGaia-Content-Hash` | Same value as `inputs.image.content_hash` |

Voxel values are the series' stored values; series with `value_unit` arrive converted to that unit (for PET in SUV, as 32-bit floats). NIfTI carries no FoR, so take it from the RunRequest.

### GET /inputs/structures

Returns summaries, without voxels, of the case's structures that the user who started the job can see (other users' transient results are excluded). When the job has input structures, only those are listed. Each item has, among others: `structure_id`, `name`, `tg263_code`, `color_rgb`, `frame_of_reference_uid`, `status`, `bbox_ijk`, `volume_cc`, `provenance`, `structure_set_id`, `structure_set_kind`, and `content_hash`.

### GET /inputs/structures/{structure_id}

Returns one input structure as a gzip-compressed NIfTI file: 8-bit, 1 inside and 0 outside, on the MaskGrid of the structure's FoR. Only structures listed in `inputs.structures` can be fetched; others get `403 PL-SCOPE`. The `format` query parameter in `openapi.yaml` is currently ignored.

### POST /progress

`percent` is clamped to 0–100 and truncated to an integer; `phase` is optional. The host stores both on the job and pushes them to the viewer.

### POST /results

Delivers one ImportBundle. A plugin may call it several times while the job runs; each body must be a complete bundle and is validated on its own (see [Validation](#validation)). The response is `200` with a ResultsOutcome even when some or all members are rejected:

```json
{
  "accepted": [ { "kind": "structure", "index": 0, "id": "job_1a2b3c:0:structure:0" } ],
  "rejected": [ { "kind": "structure", "index": 1, "code": "B3", "reason": "..." } ]
}
```

| Field | Meaning |
|---|---|
| `kind` | `bundle`, `frame_group`, `image`, `structure`, `dose`, `measurement`, or `report`. |
| `index` | Position in the member array; `-1` for a rejection of the whole bundle (`kind: bundle`). |
| `id` | Opaque string of the form `<job_id>:<batch>:<kind>:<index>`, where `batch` numbers the bundles of this job that passed the schema check, starting at 0. It is not the id of a structure in the case; do not parse it. |
| `code` | `B1`–`B8`. |
| `reason` | Human-readable explanation in English. Do not parse it. |

Other responses: `422 PL-SCHEMA` when the body violates the schema (with a JSON `pointer`), `409 PL-SCOPE` when the job is no longer running, `409 PL-CASE-CHANGED` when the case's series selection changed while the job ran, and `400` with a geometry code such as `G5` when a grid in the bundle is not a valid grid, for example a `direction` that is not orthonormal.

### POST /done

Ends the job. `status: failed` fails the host job with `error` (or a generic message). `status: done` in callback mode completes the job, except that the job fails when the plugin delivered members and none of them was accepted; the job's error then states how many members were rejected, and the job record holds the code and reason of each. In poll mode, `/done` only makes the host pull `/jobs/{job_id}/result` at once. After `/done`, every callback with this token gets `403`.

### POST /audit

Appends an event to the host's audit log. The host records it as action `plugin.<kind>`, with the user who started the job as the actor and the plugin as the object; the event details are `module` (the plugin id), `job_id`, and the keys of `payload`. The plugin cannot set the actor or the object. Do not use the keys `module` and `job_id` in `payload`: they would replace the values the host fills in. Use a namespaced `kind`, such as `hello.run`, so plugin events cannot be mistaken for host events.

### KV callbacks

See [KV storage](#kv-storage). In callbacks, `user/<name>` refers to the namespace of the user who started the job.

## Job lifecycle

Host jobs and plugin jobs use the same status names: `queued`, `running`, `done`, `failed`. There is no separate cancelled status; a cancelled job is `failed` with the error `cancelled`.

1. **Start.** `POST /api/v1/plugins/{plugin_id}/run` creates a `queued` job of kind `plugin:<plugin_id>`, issues the callback token, and sets the deadline to now + `timeout_s`.
2. **Dispatch.** A host worker marks the job `running`, builds the RunRequest, and sends `POST {endpoint}/run`. After a `202` the job shows phase `dispatched`. A refused or failed dispatch fails the job (`PL-DOWN`); if the case's series selection changed since the job started, the job fails with `PL-CASE-CHANGED`.
3. **Work.** The plugin calls the callbacks. In callback mode it delivers results with `/results`; in poll mode it keeps them until the host pulls them.
4. **End.** The first matching event ends the job:

| Event | Host job |
|---|---|
| `/done` with `failed` | `failed` with the plugin's `error` |
| `/done` with `done` (callback mode) | `done`; `failed` when every delivered member was rejected |
| Poll sees `failed` | `failed` with the plugin's `error` |
| Poll sees `done` | The host pulls the result: `done`, or `failed` when every member was rejected or the pull fails |
| Cancellation (`DELETE /api/v1/plugins/{plugin_id}/jobs/{job_id}` by the user who started the job or an admin) | `failed` with `cancelled`; the host sends `DELETE /jobs/{job_id}` |
| The deadline passes | `failed` with `timeout (N s)`; the plugin is not notified |

The host checks deadlines on every pass of its plugin loop (every 5 seconds by default). When a job ends, the host revokes its callback token, so later callbacks get `403`; `/results` for a job that is not running is refused with `409` even while a token is still valid.

Disabling a plugin stops new runs, proxied requests, and UI loading, but does not cancel jobs already dispatched; they continue until they finish or time out. After a plugin is removed, callbacks that need a capability fail, poll-mode jobs fail with "The plugin was removed", and other jobs end at `/done` or at their deadline.

| | Callback mode | Poll mode |
|---|---|---|
| Progress | Plugin calls `/progress` | Host reads `percent` and `phase` from `GET /jobs/{job_id}` |
| Results | Plugin calls `/results`, one or more times | Host pulls `GET /jobs/{job_id}/result` once, after `done` |
| End | Plugin calls `/done` | Host sees `done` or `failed`; the plugin may call `/done` to trigger an immediate pull |

## ImportBundle

A plugin returns results as an ImportBundle, either in the body of `POST /results` or from `GET /jobs/{job_id}/result`. It must validate against `schemas/import-bundle.schema.json`. Unknown fields are rejected at every level.

| Field | Type | Required | Content |
|---|---|---|---|
| `bundle_version` | string | yes | Must be `"1"`. |
| `provenance` | object | yes | See below. |
| `frame_groups` | object[] | no | New frames of reference introduced by this bundle. |
| `images` | object[] | no | Up to 8 image volumes. |
| `structures` | object[] | no | Up to 256 structures. |
| `doses` | object[] | no | Up to 8 dose volumes. |
| `measurements` | object[] | no | Measurements. |
| `reports` | object[] | no | Documents. |

### Provenance

| Field | Required | Rules |
|---|---|---|
| `module_version` | yes | `<id>@<version>` of the plugin, pattern `^[a-z][a-z0-9-]{2,40}@<semver>$`. Must equal the registered id and version (B1). |
| `source` | yes | `model`, `post-process`, or `import`. |
| `parent_hash` | no | `sha256:` followed by 64 lowercase hex digits, or `null`. Use `inputs.image.content_hash` from the RunRequest. |

### Frame groups

| Field | Required | Rules |
|---|---|---|
| `frame_of_reference_uid` | yes | [UID](#shared-definitions) of the new FoR. |
| `series_id` | yes | Must equal the `series_id` of an image in this bundle (B2). |
| `transform_to_primary` | yes | 16 numbers: a column-major 4×4 matrix that maps this FoR's coordinates to the primary FoR. |
| `transform_kind` | yes | `rigid` or `affine`. Deformable registration is not part of v1. |

### Images

| Field | Required | Rules |
|---|---|---|
| `series_id` | yes | Non-empty string. |
| `label` | yes | Non-empty string. |
| `modality` | yes | 2–16 characters. |
| `frame_of_reference_uid` | yes | Existing FoR or one declared in `frame_groups` (B2). |
| `grid` | yes | [Grid](#grid) without `frame_of_reference_uid`. |
| `voxels` | yes | [Volume reference](#shared-definitions). |
| `window_level` | no | `{"center": number, "width": number > 0}`. |

### Structures

| Field | Required | Rules |
|---|---|---|
| `name` | yes | 1–64 characters, unique within the bundle (B5). |
| `color_rgb` | yes | Three integers, 0–255. |
| `tg263_code` | no | String or `null`. |
| `frame_of_reference_uid` | yes | Must be a FoR of the case that has a MaskGrid (B2, B3). |
| `allow_empty` | no | Boolean, default `false`. When `true`, an empty `labelmap` structure is accepted instead of rejected (B8). |
| `mask` | yes | One of the encodings below. |

| `mask.encoding` | Other fields | Content |
|---|---|---|
| `labelmap` | `url`, `value` (integer ≥ 1) | A NIfTI file (`.nii` or `.nii.gz`) holding an integer label map on the MaskGrid. The structure is the set of voxels equal to `value`. Several structures may share one `url`; the host downloads it once per bundle. |
| `json-mask` | `grid`, `bbox_ijk`, `bits` | `grid` must equal the MaskGrid. `bbox_ijk` is `{"offset": [i, j, k], "size": [si, sj, sk]}` (non-negative integers): the box inside the grid that the bits cover. `bits` is described below. |
| `dicom-rtstruct` | `url`, `roi_number` (integer ≥ 1) | A DICOM RT Structure Set; `roi_number` selects the ROI. |
| `dicom-seg` | `url`, `segment_number` (integer ≥ 1) | A DICOM Segmentation; `segment_number` selects the segment. |

`json-mask` bits: take the box as a binary array of shape `(sk, sj, si)` in C order (i varies fastest), pack it 8 voxels per byte with the most significant bit first (the default of NumPy's `packbits`), compress the bytes as one zstd frame that records the decompressed size (one-shot compression does this), and base64-encode the frame.

### Doses

| Field | Required | Rules |
|---|---|---|
| `label` | yes | Non-empty string. |
| `unit` | yes | `"Gy"`. |
| `frame_of_reference_uid` | yes | Existing FoR or one declared in `frame_groups` (B2). |
| `grid` | yes | [Grid](#grid) without `frame_of_reference_uid`. |
| `voxels` | yes | [Volume reference](#shared-definitions). |
| `dose_summation_type` | no | `PLAN`, `FRACTION`, `BEAM`, or `MULTI_PLAN`. |

### Measurements

| Field | Required | Rules |
|---|---|---|
| `kind` | yes | `distance`, `area`, `roi3d`, or `point`. |
| `label` | yes | String. |
| `frame_of_reference_uid` | yes | Existing FoR or one declared in `frame_groups` (B2). |
| `points` | yes | Flat list of x, y, z triplets in LPS mm of that FoR; length a multiple of 3 (B4). |

### Reports

| Field | Required | Rules |
|---|---|---|
| `label` | yes | String. |
| `media_type` | yes | `application/pdf`, `application/json`, `text/plain`, or `text/html`. |
| `url` | yes | [URL](#shared-definitions) of the document. |

### Shared definitions

| Name | Definition |
|---|---|
| UID | `^[A-Za-z0-9._-]{1,128}$`: a DICOM UID or a host-internal FoR id. |
| URL | Must start with `http://`, `https://`, or `data:`. `http(s)` URLs must be downloadable by the host under the rules in [Artifact downloads](#artifact-downloads). `data:` URIs must be base64-encoded (`data:<media type>;base64,<data>`) and at most 1 MB. |
| Volume reference | `{"encoding": "nifti" \| "rtgaia-grid" \| "dicom-series" \| "dicom-rtdose", "url": URL}`. |

### What the host does with accepted members

| Member | Checked | Result |
|---|---|---|
| Structure, `labelmap` or `json-mask` | All rules | Added to the transient set of the user who started the job (see [Transient results](#transient-results)) |
| Structure, `dicom-rtstruct` or `dicom-seg` | Downloaded | Stored with the job; currently not added to the case |
| Image or dose | Grid; for `nifti` also the file header; downloaded | Stored with the job; currently not shown in the viewer |
| Frame group | Series reference | Makes its FoR known to the rest of the bundle; structures in a new FoR are rejected (B3) |
| Measurement | FoR, point triplets | Currently not added to the case |
| Report | Schema only; not downloaded | Currently not shown |

"Stored with the job" means the host keeps every downloaded file in its blob store under the job, and the job record (`GET /api/v1/jobs/{job_id}`) lists each bundle with its accepted and rejected members. Structures added to the case carry the provenance `module_version` = `<id>@<version>`, source `model`, and the host's content hash of the input series as parent; their status is `ai_generated`, and their creator is `plugin:<id>`.

## Validation

The host validates every bundle in two stages.

1. **Schema.** A bundle that violates `import-bundle.schema.json`, including the count limits (256 structures, 8 images, 8 doses), is refused as a whole with `422 PL-SCHEMA` and a JSON pointer to the first error.
2. **Rules B1–B8.** Each member is accepted or rejected on its own, except where a rule rejects the whole bundle.

| Code | Rule | Scope |
|---|---|---|
| B1 | `provenance.module_version` must equal `<registered id>@<registered version>`. | Whole bundle |
| B2 | Each member's `frame_of_reference_uid` must be a FoR of the case (one that has a MaskGrid) or one declared in this bundle's `frame_groups`. Each frame group's `series_id` must match an image in this bundle. | Member |
| B3 | A structure's mask grid (the `labelmap` file header, or the `json-mask` `grid`) must equal the MaskGrid of its FoR. A structure in a FoR that has no MaskGrid, such as one declared in this bundle, is rejected. The host never resamples. | Member |
| B4 | For images and doses with `nifti` voxels, the file header must match the declared `grid`. Measurement `points` must be a multiple of 3 long. | Member |
| B5 | Structure names must be unique within the bundle. | Member |
| B6 | A NIfTI file whose decompressed size (from the gzip trailer) exceeds the remaining quota is rejected without decoding. If the bundle's data (downloaded files plus `json-mask` bits) exceeds the remaining quota, the whole bundle is rejected and nothing from it is accepted. | Member or whole bundle |
| B7 | Every `url` must be downloadable. Download failures are B7, including refused origins (reason starting with `PL-ARTIFACT-ORIGIN`) and size limits (reason starting with `PL-QUOTA`). | Member |
| B8 | A `labelmap` structure must contain at least one voxel with its `value`, unless `allow_empty` is `true`. | Member |

Grids compare equal when `size` matches exactly, `spacing` and `origin` agree within 0.001 mm per component, `direction` agrees within 1e-6 per element, and the FoR is the same.

Every `direction` in a bundle (image, dose, and `json-mask` grids) must be orthonormal. The host currently checks this while parsing the grid, so a non-orthonormal `direction` refuses the whole request with `400` and a geometry code such as `G5` instead of rejecting the member.

The remaining quota is the transient quota (see [Limits](#limits)) minus the bytes this job has already delivered and the size of the user's existing transient structures in the case.

## Artifact downloads

The host downloads the files that bundle members reference.

- `data:` URIs are decoded locally; no request is made.
- Only `http` and `https` URLs are downloaded.
- The URL's origin (`scheme://host[:port]`, compared in lowercase as written) must be approved: the origin of the registered endpoint, an origin in the manifest's `artifact_origins`, or an origin an administrator added with `PATCH /api/v1/plugins/{plugin_id}` (`artifact_origins`). Origins compare as strings, so `http://plugin:80` and `http://plugin` differ.
- The path must not contain a `..` segment.
- The host name must resolve, and no resolved address may be link-local (which covers the link-local metadata endpoints many cloud platforms use), unspecified, multicast, or reserved. Private network addresses are allowed when the origin is approved.
- Redirects are not followed.
- The request carries `Authorization: Bearer <registration token>`. The host sends no request at all to an origin that is not approved.
- A declared `Content-Length` above the limit refuses the file before download; otherwise the download stops as soon as it passes the limit. The limit is the smaller of the remaining quota and the per-artifact limit.
- Timeouts: 30 seconds to connect, 120 seconds between reads.

Every refusal becomes a B7 rejection of the member that references the URL.

## Transient results

Accepted structures are not written to the case directly. They go to a transient set.

- **Owner.** The transient set belongs to the user who started the job; there is one per user and FoR. The viewer lists it in the structure list as **Plugin results (unsaved)**. Only the owner sees it.
- **Editing.** Transient structures can be edited like other structures. They cannot be approved.
- **Save.** **Save** moves the structures into the owner's own structure set for that FoR, with status `under_review`; from then on everyone sees them. Audit event `transient.save`.
- **Discard.** **Discard** deletes them permanently. Audit event `transient.discard`.
- **Lifetime.** Transient structures are not stored in the database. They are destroyed 30 minutes after the owner's last connection to the case closes, and they do not survive a server restart. The viewer asks before the user leaves a case with unsaved plugin results.
- **Export.** Export does not select transient structures by default.
- **Quota.** Delivered data counts against a quota per user and case (2 GiB by default).

## Host plugin API

Endpoints under `/api/v1` on the host, used by the viewer, by UI bundles through `api.http`, and by administrators' scripts. All need a signed-in user except self-registration. Besides the per-endpoint rules below, the host requires at least `viewer` for `GET` requests and at least `contourer` for other methods.

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/plugins` | Any user | List plugins |
| GET | `/plugins/{plugin_id}` | Any user | One plugin |
| POST | `/plugins` | Admin | Register: `{"endpoint", "token"?, "allow_licenses"?}` → `201` record |
| POST | `/plugins/register` | `Bearer <RTGAIA_PLUGIN_REGISTRATION_TOKEN>` | Self-registration: `{"endpoint", "token"?}` → `201` record |
| PATCH | `/plugins/{plugin_id}` | Admin | Change `enabled`, `token`, `endpoint`, `allow_licenses`, or `artifact_origins` |
| DELETE | `/plugins/{plugin_id}` | Admin | Remove → `204` |
| POST | `/plugins/{plugin_id}/refresh` | Admin | Run the health and version check now |
| POST | `/plugins/{plugin_id}/run` | Role ≥ `required_role` and ≥ `contourer` | Start a job |
| DELETE | `/plugins/{plugin_id}/jobs/{job_id}` | The user who started the job, or an admin | Cancel → `204` |
| GET | `/jobs/{job_id}` | Any user | Job status and result summary |
| GET, PUT, DELETE | `/plugins/{plugin_id}/kv/{key}` | Role ≥ `required_role` | [KV storage](#kv-storage) |
| GET, POST, PUT, PATCH, DELETE | `/modules/{plugin_id}/{path}` | Role ≥ `required_role` | Proxy to [custom endpoints](#custom-endpoints) |
| GET | `/plugins/{plugin_id}/ui/{path}` | Any user | Proxy for the UI bundle |

Run, KV, proxy, and UI requests also need the plugin to be enabled and `active` (`503 PL-DOWN` otherwise).

### Plugin records

`GET /plugins` returns, for every user:

| Field | Meaning |
|---|---|
| `plugin_id`, `version`, `label`, `icon`, `description` | From the manifest |
| `required_role`, `params_schema`, `ui` | From the manifest |
| `has_ui` | `true` when the manifest declares `ui` with `trust: host-equivalent` |
| `ui_trust`, `ui_digest` | Declared trust and the pinned SHA-256 of the bundle |
| `status` | `active`, `disabled`, `failed`, `version-mismatch`, `license`, or `quarantined` |
| `enabled` | Whether an administrator enabled the plugin |
| `allowed` | Whether the requesting user's role is at least `required_role` |

Administrators also get `endpoint`, `token_set`, `manifest`, `error`, `allow_licenses`, `registered_by`, `created_at`, `updated_at`, `last_seen_at`, `health_failures`, `artifact_origins`, and `effective_artifact_origins`. The token itself is never returned.

| Status | Meaning |
|---|---|
| `active` | Usable. |
| `disabled` | Disabled by an administrator. |
| `failed` | Three health checks in a row failed. Returns to `active` after the next successful check. |
| `version-mismatch` | A new version was reported, but its manifest could not be fetched or validated. |
| `license` | A new version's manifest has a license that is not allowed. |
| `quarantined` | The served UI bundle no longer matches the pinned digest. Cleared by registering the plugin again or by a new plugin version. |

### Starting a job

`POST /api/v1/plugins/{plugin_id}/run`:

| Field | Required | Meaning |
|---|---|---|
| `params` | yes | Parameters; validated against `params_schema` (`422 PL-SCHEMA` with a pointer). |
| `image_series_id` | no | The image series to process; must be an image series of the case (`422 PL-SCHEMA` otherwise). Default: the primary image series. |
| `structure_ids` | no | Input structures. Each must exist and be visible to the user, or the request fails with `404 NO_STRUCTURE`. |
| `session_id` | no | The viewer session that identifies the case; takes precedence over `study_id`. |
| `study_id` | no | Identifies the case by study when `session_id` is absent. Without either, the user's current session is used. |

The response is `202 {"job_id", "case_id", "status"}`. The job record at `GET /api/v1/jobs/{job_id}` includes `status`, `phase`, `percent`, and `error`, and for plugin jobs also `accepted`, `rejected`, `materialized` (structures added to the case), `bundles` (each delivered bundle with its outcome), and `module_version`.

## KV storage

The host keeps a small key-value store for each plugin, so a plugin does not need its own database for settings or preferences.

- **Keys.** `plugin/<name>` is shared by all users of the plugin; `user/<name>` is private to one user. Names must match `[A-Za-z0-9._-]{1,128}`. The host currently checks only the prefix and that the name is not empty.
- **Values.** Any JSON value. `PUT` replaces the value; `DELETE` is idempotent; `GET` of a missing key returns `404`.
- **Limits.** One value may be at most 1 MiB of serialized JSON. All values in one namespace together (`plugin`, or one user's `user`) may be at most 16 MiB by default. Exceeding either returns `413 PL-QUOTA`.
- **No queries.** There is no listing, query, or transaction support.
- **Removal.** Removing a plugin does not delete its KV data.

| Caller | `user/<name>` | `plugin/<name>` |
|---|---|---|
| Plugin, through the callback (`kv` capability) | Read and write the value of the user who started the job | Read and write |
| User, through `/api/v1/plugins/{plugin_id}/kv/{key}` | Read and write the user's own value | Read; only admins write |

## UI bundles

A plugin can ship a browser bundle that registers its own panels and overlays in the viewer. Without one, the viewer shows the declarative panel.

### Format

1. **One file.** The bundle is a single, self-contained ES module served at `/ui/index.js` (manifest `ui.bundle: "/ui/index.js"`). The host proxies only that one file and answers `404 PL-UI-PATH` for any other path, so code-split chunks, separate CSS files, and other assets are not reachable. Inline them.
2. **Imports.** The bundle may import only the bare specifiers `react`, `react-dom`, `react/jsx-runtime`, and `@rtgaia/sdk`, and must not include them. The viewer's import map resolves them to the host's own instances, so the bundle shares the host's React and SDK.
3. **Entry object.** The default export is:

```ts
export default {
  id: 'hello-threshold',       // must equal manifest id
  version: '0.1.0',            // must equal manifest version
  sdkVersion: '^0.1.0',        // semver range the host's @rtgaia/sdk version must satisfy
  register(sdk) { /* call sdk.registerModule({...}) */ },
};
```

4. **Manifest.** Declare `"ui": {"bundle": "/ui/index.js", "sdk_version": "^0.1.0", "trust": "host-equivalent"}`.

The viewer pages are cross-origin isolated (COOP `same-origin`, COEP `require-corp`). That is why bundles load through the same-origin host proxy, and why a bundle cannot load cross-origin resources unless they send suitable CORP or CORS headers. `data:` URIs work.

### Loading

1. At registration and after each version change, the host downloads the bundle with the registration token and pins its SHA-256 digest (`ui_digest`). If the bundle cannot be downloaded, registration fails with `PL-DOWN`.
2. When the viewer starts, it lists the plugins. For each plugin that is enabled, `active`, and allowed for the user, it either registers the declarative panel (no `ui`, no `trust: host-equivalent`, or no pinned digest) or loads the bundle.
3. To load a bundle, the viewer fetches `/api/v1/plugins/{plugin_id}/ui/index.js?v=<version>`, computes its SHA-256, and compares it with `ui_digest`. On a mismatch it does not import the bundle and marks the plugin as failed in the **Plugins** menu.
4. The viewer imports the module and checks the entry object: `id` and `version` must equal the plugin's, `sdkVersion` must be satisfied by the host SDK version, and `register` must be a function. Then it calls `register(sdk)` once.
5. The host proxy compares every copy it serves with the pinned digest. On a mismatch it answers `502 PL-UI-DIGEST`, sets the plugin's status to `quarantined`, and writes the audit event `plugin.quarantine`. A quarantined plugin cannot run, proxy, or load its UI until an administrator registers it again (accepting the new digest) or the plugin reports a new version.

The proxy serves the bundle as `text/javascript` with `Cache-Control: no-cache`. A failure while importing or registering a bundle affects only that plugin.

When anything about a registered plugin changes (registration, version, or status), open viewer pages keep what they loaded and the **Plugins** menu offers a page reload; there is no in-page replacement.

### Runtime API

`register(sdk)` receives the same module that `import ... from '@rtgaia/sdk'` resolves to. At runtime it exports `registerModule`, `registerLayout`, `hasLayout`, `useViewerApi`, the localization functions `registerMessages`, `t`, `msg` and `getLang` (since `0.1.1`), and `SDK_VERSION`; everything else is TypeScript types. The type definitions are in [`apps/viewer/src/sdk/index.ts`](../apps/viewer/src/sdk/index.ts). `@rtgaia/sdk` is not published as an npm package; build against that file from a checkout. The current SDK version is `0.1.1`.

`registerModule(manifest)` takes:

| Field | Meaning |
|---|---|
| `id`, `version` | Module identity; use the plugin's id and version. A second registration with the same id fails. |
| `panels` | Panel registrations (below). |
| `tools`, `layerRenderers`, `layouts` | Viewer tools, layer renderers, and layouts. |
| `onDispose` | Called when the user switches, reloads, or closes a case; release overlay painters, timers, and subscriptions here. |

A panel registration has `id` (unique), `slot` (`left-sidebar`, `right-sidebar`, `bottom`, `viewport-overlay`, `toolbar`, or `cell`), `order`, `component`, and optionally `title`, `help`, `group`, `visibleWhen`, and `formFactors`. Picking a plugin in the **Plugins** menu turns on the UI mode `plugin:<id>`; the plugin's main panel should use `slot: 'right-sidebar'` and `visibleWhen: (s) => s.modes.includes('plugin:<id>')`.

A panel component receives `{ api }`:

| Member | Content |
|---|---|
| `api.state` | Read-only snapshot of the viewer: layers, structures, structure sets, frame groups, active image layer, open modes, signed-in user, case and study ids, and more. |
| `api.commands` | Viewer commands: visibility, window and level, crosshair, modes, structure and measurement operations, `refreshStructures()`, `refreshStructureSets()`, `repaintOverlays()`, and more. |
| `api.overlay` | Overlay painter registry: `register(painter)` returns a function that unregisters it. |
| `api.http` | JSON helpers for host endpoints, with paths relative to `/api/v1`: `getJson`, `postJson`, `patchJson`, `deleteJson`. A non-2xx response throws an `Error` carrying the status and the start of the body. |

`api.http` has no `PUT` helper. To write KV values from a bundle, call `fetch('/api/v1/plugins/<id>/kv/<key>', { method: 'PUT', ... })`; the request runs with the user's session. The SDK does not expose server push events to bundles; poll `GET /api/v1/jobs/{job_id}` to follow a job, and call `api.commands.refreshStructureSets()` and `api.commands.refreshStructures()` after it finishes.

An overlay painter is `{ id, order?, viewportId?, paint(ctx), dispose? }`; `viewportId` defaults to `'*'` (all 2D viewports). `paint` receives a 2D canvas context that is saved and restored around the call, the canvas `width` and `height`, the `camera`, the render `quality`, `project(world)` (LPS mm to canvas pixels), and `signedDistanceMm(world)` (distance from the current plane). Do not allocate buffers, make network requests, or change layers inside `paint`, and always convert with `project()`. A painter that throws is disabled until it is registered again.

A panel that throws while rendering is replaced by an error message; the rest of the viewer keeps working. This is fault isolation, not a security boundary.

## Security and trust

- **Plugin endpoints.** The host authenticates to the plugin with the registration token. Plugins never receive user cookies or sessions; they learn the user's name and role from `RunRequest.actor` and from the proxy headers.
- **Callback tokens.** Each job gets a random token, bound to the plugin and the job and limited to the declared capabilities. Once the RunRequest is sent, the host keeps only the token's SHA-256 hash. The token is revoked when the job ends and expires at the deadline plus 10 minutes.
- **Network exposure.** The host forwards user identity in plain headers on proxied requests, so only the host should be able to reach a plugin. A plugin that cannot be isolated must check the registration token on every endpoint, including custom endpoints and file downloads.
- **Results.** A plugin can write only into the transient set of the user who started the job. Results become shared data only when that user saves them.
- **UI bundles.** A UI bundle is trusted code. It runs in the viewer page with the signed-in user's privileges: same origin, same cookies, full access to the page and to every API the user can call. There is no sandbox. An administrator registers the plugin, the manifest must declare `trust: host-equivalent`, and the host pins the bundle by digest at registration and at each version change. The pin guarantees only that the viewer runs the bundle the host pinned: a new plugin version is pinned automatically and recorded in the audit log (`plugin.version`). Register only plugins whose publisher you trust, and review new versions.
- **Downloads.** Artifact downloads are limited to approved origins and safe addresses (see [Artifact downloads](#artifact-downloads)), so a plugin cannot make the host fetch arbitrary URLs.
- **Licenses.** Code licenses must be on the allow-list or explicitly allowed by an administrator; SOUP, including model-weight licenses, is shown to administrators.

The Python SDK, when `RTGAIA_PLUGIN_TOKEN` is set, checks the bearer token on the contract endpoints (`/manifest`, `/health`, `/run`, `/jobs/...`). It serves `/artifacts/...` and `/ui/...` without checking the token, and its `require_role()` helper for custom endpoints checks only the identity headers. Without `RTGAIA_PLUGIN_TOKEN` it checks nothing, which is suitable for local development only.

Audit events written for plugins:

| Action | When |
|---|---|
| `plugin.register`, `plugin.update` | An administrator registers a new plugin, or registers an existing id again |
| `plugin.license_override` | A registration allows licenses outside the allow-list |
| `plugin.enable`, `plugin.disable` | An administrator enables or disables a plugin |
| `plugin.remove` | An administrator removes a plugin |
| `plugin.artifact_origins` | An administrator changes approved artifact origins |
| `plugin.version` | The host detected a new plugin version (actor `system`) |
| `plugin.quarantine` | The served UI bundle did not match its digest (actor `system`) |
| `plugin.results` | The host validated a delivered bundle (counts of accepted and rejected members) |
| `plugin.cancel` | A user cancelled a job |
| `plugin.<kind>` | The plugin called `/audit` |
| `transient.save`, `transient.discard` | A user saved or discarded transient results |

## Limits

| Limit | Value | Configurable with |
|---|---|---|
| Structures, images, doses per bundle | 256, 8, 8 | Fixed (schema) |
| Structure name | 1–64 characters | Fixed (schema) |
| `execution.timeout_s` | 1–86400 seconds | Fixed (schema) |
| Transient quota per user and case | 2 GiB | `RTGAIA_TRANSIENT_MAX_GB` |
| One artifact download | 2 GiB, and never more than the remaining quota | `RTGAIA_PLUGIN_ARTIFACT_MAX_BYTES` |
| `data:` URI | 1 MB (not separately enforced) | Fixed (contract) |
| One KV value | 1 MiB of serialized JSON | Fixed |
| One KV namespace | 16 MiB | `RTGAIA_PLUGIN_KV_MAX_MB` |
| Callback token lifetime | `timeout_s` + 10 minutes, or until the job ends | Fixed |
| Health check | Every 30 s, 10 s timeout, `failed` after 3 failures | `RTGAIA_PLUGIN_HEALTH_SECONDS` |
| Poll and deadline loop | Every 5 s | `RTGAIA_PLUGIN_TICK_SECONDS` |
| Host requests to the plugin | 30 s to connect, 120 s to read | Fixed |
| Cancel request | 10 s | Fixed |
| Transient results after the owner disconnects | 30 minutes | Fixed |

## Configuration

Host environment variables that affect plugins:

| Variable | Default | Effect |
|---|---|---|
| `RTGAIA_PUBLIC_URL` | Required when `RTGAIA_AUTH=required`; otherwise `http://127.0.0.1:8080` | Base of `callback.base_url`. Must be reachable from the plugin. Set it on every host process that dispatches jobs, including a standalone worker. |
| `RTGAIA_PLUGIN_HEALTH_SECONDS` | `30` | Interval between health checks of each plugin. |
| `RTGAIA_PLUGIN_TICK_SECONDS` | `5` | Interval of the loop that runs health checks, polls poll-mode jobs, and enforces deadlines. `0` turns the loop off. |
| `RTGAIA_PLUGIN_REGISTRATION_TOKEN` | Unset | Enables self-registration with this bearer token. |
| `RTGAIA_TRANSIENT_MAX_GB` | `2` | Transient quota per user and case, in GiB. |
| `RTGAIA_PLUGIN_ARTIFACT_MAX_BYTES` | `2147483648` | Largest single artifact download, in bytes. |
| `RTGAIA_PLUGIN_KV_MAX_MB` | `16` | Largest total size of one KV namespace, in MiB. |

Per-plugin settings that administrators manage: the endpoint, the registration token, enabled or disabled, allowed licenses, and approved artifact origins. The admin **Plugins** tab registers plugins (endpoint, bearer token, **Allowed licenses**) and offers **Recheck**, **Disable** or **Enable**, and **Remove**; approved artifact origins are currently changed only through `PATCH /api/v1/plugins/{plugin_id}`.

Python SDK environment variables:

| Variable | Default | Effect |
|---|---|---|
| `RTGAIA_PLUGIN_TOKEN` | Unset | Bearer token the plugin expects from the host. Unset: no check. |
| `RTGAIA_PLUGIN_PUBLIC_URL` | Unset | Base URL for artifact URLs. Unset: the base URL of the host's `/run` request. |
| `RTGAIA_PLUGIN_ARTIFACTS` | `./artifacts` | Directory where result files are written and served from. |

A plugin's own settings belong in its own storage or in the `plugin/` KV namespace. Expose them through custom endpoints that check `X-RTGaia-Role`; the nnU-Net example lets every user read its settings and only admins change them.

## Error codes

| Code | Meaning | HTTP status |
|---|---|---|
| `PL-SCHEMA` | A manifest, bundle, parameter set, or request does not match its schema (with `pointer` where available); also unknown plugins, sessions, and KV keys | `422`, or `404` for things that do not exist |
| `PL-LICENSE` | A code license is neither on the allow-list nor allowed by an administrator | `422` at registration |
| `PL-API` | Reserved for an unsupported `api_version`. Currently such a manifest fails the schema check and is reported as `PL-SCHEMA` at `/api_version`. | `422` |
| `PL-SCOPE` | Invalid, expired, or revoked callback token; capability not declared; input structure not in the RunRequest; results for a job that is no longer running; wrong self-registration token | `403`; `409` for results on a finished job |
| `PL-ROLE` | The user's role is too low | `403` |
| `PL-DOWN` | The plugin is not active or cannot be reached, its manifest or UI bundle cannot be downloaded, or it refused `/run` | `503`; `502` when the manifest or UI bundle cannot be downloaded; a refused `/run` fails the job with this code |
| `PL-QUOTA` | A KV limit was exceeded; in a B7 reason, an artifact exceeded its size limit | `413` |
| `PL-ARTIFACT-ORIGIN` | An artifact URL breaks the download rules | Reported in a B7 reason |
| `PL-UI-PATH` | A UI path other than the declared bundle was requested, or the plugin has no trusted UI | `404` |
| `PL-UI-DIGEST` | The UI bundle no longer matches its pinned digest; the plugin is quarantined | `502` |
| `PL-CASE-CHANGED` | The case's series selection changed while the job was running | `409`; fails the job at dispatch |
| `B1`–`B8` | Bundle validation; see [Validation](#validation) | In `ResultsOutcome.rejected` (`200`) |
| `G`-codes, for example `G5` | A grid in a bundle is not a valid grid | `400` |

Error bodies carry `code` and `message` (and `pointer` where available) either at the top level or inside a `detail` object; accept both shapes. The general access checks of the host return `401 AUTH_REQUIRED` or `403 FORBIDDEN`. Messages are in English unless the request prefers Traditional Chinese (for example `Accept-Language: zh-TW`); bundle validation reasons and other messages that come from the plugin SDK are always in English.

## Versioning

- **Contract.** `api_version` is `"1"` and `bundle_version` is `"1"`; the host accepts no other values. The OpenAPI document is version `1.0.0`. Changes that only add optional fields, encodings, capabilities, or callbacks keep `api_version`; a change that would make existing plugins fail requires a new `api_version`.
- **Plugin versions.** Every artifact a plugin produces is traced to `<id>@<version>`. The host compares the `version` in each `/health` response with the registered one. On a change it fetches the manifest again, validates it, checks that `id` did not change, pins the UI bundle digest again, writes `plugin.version` to the audit log, and notifies open viewer pages, which offer a reload. If the new manifest fails validation, the plugin's status becomes `version-mismatch`, or `license` for a license problem.
- **Upgrades.** Rule B1 compares against the version the host has registered when a bundle arrives. A bundle produced by a different version than the registered one, for example by a job that was running across an upgrade, is rejected. Upgrade plugins while no jobs are running.
- **UI SDK.** The bundle's `sdkVersion` range is matched against the host's `@rtgaia/sdk` version (`SDK_VERSION`, currently `0.1.1`). Supported range forms: exact (`1.2.3` or `=1.2.3`), `^`, `~`, `>=`, and `*`. For `0.x` versions, `^` matches only the same minor version.

## Conformance

`rtgaia-plugin-check` in the Python SDK plays the host against a running plugin: it validates the manifest, checks `/health`, runs one job on a synthetic CT with a mock callback server, validates every bundle with the same validator as the host (schema and B1–B8), and checks a declared UI bundle. See [Testing with rtgaia-plugin-check](plugins.md#testing-with-rtgaia-plugin-check). A real host additionally enforces roles, capabilities, artifact download rules, quotas across bundles, and UI digests.

The contract files themselves are checked with [`packages/rtgaia-plugin-api/check_contract.py`](../packages/rtgaia-plugin-api/check_contract.py).
