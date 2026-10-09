# Test fixtures

Test data for the RT-Gaia test backend. Everything committed here is code that generates data; no
image data is stored in this directory.

## Committed (as code)

| What | Where |
|---|---|
| Synthetic phantoms with known answers | `../phantoms/library.py` (definitions only; voxels are generated on demand) |
| Expected answers for a phantom | `phantoms.expected_json()`, also served by `GET /api/v1/_test/expected` |
| Fault-injection (chaos) modes | `rtgaia_core.chaos` in `packages/rtgaia-core` |
| Python test driver | `../driver/` (`from rtgaia_testbe import Session`) |
| Synthetic 4D and dynamic DICOM: 6 CT and 10 MR cases | `synth4d.py` |
| Synthetic RT plan with per-beam and plan doses | `synth_beams.py` |

The two DICOM generators write deterministic, synthetic files (no PHI). Write them into the git-ignored
`data/` directory:

```sh
uv run python -m rtgaia_testbe.fixtures.synth4d --out data/test_4d        # --only ct1,mr1 for a subset, --list to list
uv run python -m rtgaia_testbe.fixtures.synth_beams --out data/test_beams
```

Each generated case directory contains an `expected.json` with the expected result (for example, which
series form one time axis) and the ground truth.

## Not committed

### `cache/`: generated voxels

Phantom voxels are cached as `.npy` files; the largest phantom (`huge`) takes 472 MB. Deleting the cache
is safe: the next load is only slower. The cache is the first of these locations that applies:
`$RTGAIA_DATA_DIR/cache`, `$RTGAIA_LIBRARY_ROOT/.cache`, or this `cache/` directory.

### `dicom/`: real DICOM cases

> Only de-identified data may be placed here, even on internal machines.

The directory is git-ignored and empty in the repository. When you add a case, record the following for
each case in this README:

| Field | Why |
|---|---|
| Source | Public dataset with its license, or a local case with its ethics approval reference |
| De-identification tool and version | Traceability: different tools leave different residual attributes |
| De-identification date and operator | Audit |
| Known geometric features | For example "gantry tilt 15°", "non-uniform slice spacing", "duplicate SOP UIDs": these surprises are what real data is for |

### Real data and CI

- CI uses synthetic data only, so it is deterministic and contains no PHI.
- Tests that need real DICOM run only where the data exists. They skip when it is absent and always skip
  in CI.

### Loading a real case

Start the test backend with the test API and load a de-identified case directory:

```sh
uv run rtgaia-testbe --test-api --port 8080
curl -X POST http://127.0.0.1:8080/api/v1/_test/load \
  -H 'content-type: application/json' \
  -d '{"source": "dicom:/path/to/deidentified/case"}'
```

`uv run rtgaia-testbe --load dicom:/path/to/deidentified/case` loads the case at startup instead. Every
image series, RTSTRUCT, RTDOSE, RTPLAN and REG object in the directory is loaded into one session.

The loader validates the geometry from the DICOM headers. If a series has no `FrameOfReferenceUID`, the
loader creates a synthetic one (`<SeriesInstanceUID>.SYNTHETIC_FOR`) and flags it with
`synthetic_frame_of_reference`. It does not reuse the series UID, because that would make two different
acquisitions look as if they shared one space.

Without a database the backend runs without authentication, and the test API accepts file-system
paths. Run it only on a trusted machine or network.
