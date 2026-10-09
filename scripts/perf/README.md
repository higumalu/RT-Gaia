# Performance scripts

This directory holds two kinds of performance checks: budget gates that run in CI on synthetic data,
and measurement scripts that you run by hand against a running stack with your own data.

## Budget gates (run in CI)

| Command | Measures | Budget |
|---|---|---|
| `uv run python scripts/perf/ci_gate.py` | Backend, in process, cold cache: time from opening a case to the first image at level of detail 2, to the full-resolution image (level 0), and one post-processing round trip (`smooth`) on a small structure. Uses a synthetic 512 × 512 × 160 CT written to a new temporary directory. | 4 s, 10 s, 1.5 s |
| `npm run test:perf` (in `apps/viewer`) | Frontend computation with the WebAssembly kernel on a synthetic 512 × 512 × 160 volume: reslicing at interactive and full resolution, window/level, outlines of 20 structures. Median of 15 runs after a warm-up. | Listed in `apps/viewer/tests/perf/budget.perf.ts` |

Both fail (exit code 1) when a measurement exceeds its budget multiplied by a slack factor. Set the factor
with `RTGAIA_PERF_SLACK` (default 1); `ci_gate.py` also accepts `--slack`. CI uses 1.5 because hosted
runners are slower than a typical workstation. `npm run test:perf` needs
`apps/viewer/public/rtgaia_reslice.wasm`, which `./scripts/build-kernel.sh` builds.

## Manual measurements against a running stack

| Script | Measures | Output |
|---|---|---|
| `measure-showall.js` | Hide all structures, then show all: main-thread long tasks, longest frame gap, mask requests and their timing, 3D render requests | `METRICS {...}` |
| `measure-showall-cached.js` | A second "show all" when every mask is already in the browser: the cost of one full render | `METRICS2 {...}` |
| `measure-3d-drag.js` | A 40-step drag in the 3D cell: number of render requests, average and longest request, time from release to the last image | `DRAG {...}` |
| `profile-showall.mjs` | CPU profile during "show all" (`--action showall`) or slice scrolling (`--action scroll`); prints the functions with the most self time (`--top N`) | Text table |
| `render3d-timing.py` | Direct `/render3d` requests: cold (image only, then 1, 8 and 35 structures), warm, and drag-sized images | One line per request |
| `loop_latency.py` | Event-loop responsiveness: `/healthz` latency while several full-resolution image requests for the largest CT in the library run at once | Median, p95 and maximum latency |

The three `measure-*.js` files are not run directly: `scripts/screenshot.mjs` evaluates them in headless
Chrome until they return `true`, and they print one line to the browser console.

### Requirements

- A stack with authentication off (no database), so the scripts do not have to log in.
- A de-identified case open in that stack. The `measure-*` and `profile-*` scripts wait for at least
  20 rows in the structure list, and `measure-3d-drag.js` needs a 3D cell (the default 2 × 2 layout has
  one).
- The interface in Traditional Chinese: the browser scripts find the **Show all** and **Hide all** buttons
  by their Traditional Chinese labels, so open the viewer with `?lang=zh-TW` (the default language is
  English).
- Google Chrome. The scripts start `google-chrome`; set `CHROME` (or pass `--chrome`) to use another
  binary.

### Option 1: the measurement stack (`stack.sh`)

```sh
scripts/perf/stack.sh start    # backend (rtgaia-testbe) and Vite dev server on fixed local ports
scripts/perf/stack.sh load     # open the case described in .rtgaia/perf/case.json
scripts/perf/stack.sh stop
```

`start` runs the backend with authentication off, no database, `data/` as the library root, plugin
health checks and the DICOM receiver disabled, and writes logs and working data to `.rtgaia/perf/` (set
`RTGAIA_PERF_DIR` to change it). The test API is not mounted unless you set `PERF_TEST_API=1`;
`render3d-timing.py` needs it. The ports are set in the script, and the default `--url` of
`profile-showall.mjs` and the default `--api` of `loop_latency.py` point at this stack.

`load` opens a case through the Python driver as the user `anonymous`. The case is described in a local
file that is not part of the repository, `.rtgaia/perf/case.json` (or the file named by `PERF_CASE`):
the primary image series, image series, structure sets, doses and registrations, by series UID.
[`case.example.json`](case.example.json) opens the PROTEAS P21 demo case (see
[`scripts/demo/README.md`](../demo/README.md) for the download); copy it and change the UIDs to open
your own case. `PERF_ALL_DOSES=1` also loads the doses listed in `extra_dose_uids`.

### Option 2: your own stack

Run any backend and frontend pair with authentication off, for example
`HOST=127.0.0.1 ./scripts/dev.sh` without `RTGAIA_DB_URL`, and open your case once from the library page.
With authentication off, the viewer page (`#/viewer`) attaches to the most recently opened session. Pass
your frontend URL to the browser scripts and your backend URL to `loop_latency.py`.

### Running the measurements

```sh
FRONTEND=http://127.0.0.1:<frontend-port>
node scripts/screenshot.mjs --url "$FRONTEND/?lang=zh-TW#/viewer" --out /tmp/showall.png --wait-ms 240000 --console \
  --until "$(cat scripts/perf/measure-showall.js)" | grep METRICS
node scripts/screenshot.mjs --url "$FRONTEND/?lang=zh-TW#/viewer" --out /tmp/cached.png --wait-ms 200000 --console \
  --until "$(cat scripts/perf/measure-showall-cached.js)" | grep METRICS2
node scripts/screenshot.mjs --url "$FRONTEND/?lang=zh-TW#/viewer" --out /tmp/drag.png --wait-ms 120000 --console \
  --until "$(cat scripts/perf/measure-3d-drag.js)" | grep DRAG
node scripts/perf/profile-showall.mjs --url "$FRONTEND/?lang=zh-TW#/viewer" --top 30 --action showall
uv run python scripts/perf/loop_latency.py --api http://127.0.0.1:<backend-port> --library data --concurrency 4
uv run python scripts/perf/render3d-timing.py
```

`render3d-timing.py` has no options: its backend URL and the structure-set filter (a UID prefix) are set at
the top of the file, so edit both for your stack and case. To measure cold timings again, restart the
backend and open the case again.

The browser scripts run headless Chrome with `--disable-gpu`. Results depend on the machine and the
network path, so compare only runs made under the same conditions.
