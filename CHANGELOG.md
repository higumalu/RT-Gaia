# Changelog

All notable changes to RT-Gaia are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0, minor versions may contain
breaking changes.

## [Unreleased]

First public release candidate. RT-Gaia is research software; it is not a medical device.

### Library and data management

- DICOM import from the browser (files, folders, zip), from a server directory, and from DICOM nodes;
  staged validation, de-duplication and content-addressed storage, with a PostgreSQL catalog.
- Library page with a patient / study / series tree, search and filters, RT objects attached to their
  images (plans carry their doses; registrations attach to the moving series), case status badges and a
  worklist.
- 4D and dynamic series grouped from real DICOM: one series per phase (4DCT), several time points in one
  series (DCE, cine), parameter axes (multi-echo TE, diffusion b-value), Enhanced multi-frame CT and MR.
- Deleted data goes to a trash with a restore window; deleted signed-off items are kept in an archive
  visible to administrators. Storage capacity warning and an integrity check of stored files.
- Decoding of JPEG 2000, RLE and baseline JPEG compressed images on import; images that cannot be decoded
  are listed and cannot be opened.

### Viewing

- Axial, coronal and sagittal MPR, oblique MPR with an averaging slab (3, 5 or 10 mm), slice scroll bar,
  window/level presets that you can edit, and a readout of image value, dose and the structures at the
  cursor.
- Several series in one space through registrations: overlay, checkerboard and difference fusion, and
  manual registration adjustment saved as a new transform.
- Layout editor (split, resize and close cells, choose what each cell shows; dockable side panels);
  layouts follow the account.
- PET SUV (body weight) readout; diffusion b-values inferred from series descriptions when the tags were
  removed by de-identification.
- 4D playback with ranges and time-intensity curves; composing several 3D series into a 4D group and
  expanding a group back into 3D series; a phase lock per viewport cell; resampling of phases whose grids
  differ.
- Server-rendered 3D view: volume rendering with transfer-function presets, a crop box drawn on the 2D
  planes, structure surfaces and dose, double-click to move the crosshair, PNG export.

### Contouring and structures

- Brush and eraser (2D or 3D), threshold brush, polygon lasso, region growing, threshold segmentation and
  post-processing operations; one stroke is one undo step.
- Imported structure sets are read-only; each user edits a personal working set and merges explicitly.
  Filled or outlined display, TG-263 name suggestions, moving and copying structures between sets.
- Temporal structures across 4D phases, copy to other phases, and ITV creation.
- Save status in the header and recovery of edits that did not reach the server.

### Dose and plans

- Dose colorwash, isodose lines (prescription-relative, or evenly spaced in Gy without a prescription),
  per-cell legend, color range, jump to Dmax.
- DVH for any dose and structure through the registration chain, with D98, D95, D50, D2 and V(ref);
  partial coverage is flagged; CSV and PNG export.
- Dose operations: add or subtract two doses (rigidly resampled), multiply or divide by a constant, chain
  steps, sum beam doses into a plan dose, and save results as RTDOSE.
- 3D gamma comparison between two doses in the same space (global or local, low-dose threshold, search
  step and cap): a gamma map with a pass/fail colormap and γ = 1 line, pass rate, an explanation of where
  failures lie (high-gradient or flat regions, evaluated high or low), a histogram and per-structure pass
  rates.
- Dose recalculation of photon plans with OpenTOPAS (Geant4) Monte Carlo in a container: static, step-and-shoot
  and VMAT beams with jaws and MLC, MU-weighted control points, MU calibration from a simulated reference field,
  per-beam doses and per-voxel statistical uncertainty; results load as temporary doses for gamma, DVH and RTDOSE
  export. Ships with demo 6 MV beam models (flattened, flattening-filter-free, and flattening-filter-free with a
  dual-layer MLC); unsupported plan features are refused with reasons. The Monte Carlo dose is scored on a
  coarser calculation grid (4 mm by default) and interpolated to the dose grid, and each job reports the
  statistical uncertainty in the high-dose region with a warning when it is too noisy for a 3% comparison.
  Loading a result also adds a per-voxel uncertainty map, and gamma comparisons note when Monte Carlo noise
  is large compared with the dose criterion.
- GPU Monte Carlo dose engine (optional `gpu` extra, NVIDIA GPU): coupled photon–electron transport with physics
  tables from Geant4, the same beam, source and patient model as the OpenTOPAS engine, and about a hundred times
  more histories per second; it is offered by default when available.
- A loaded dose recalculation can be compared with the plan's TPS dose in one click: gamma (3%/2 mm, TG-218)
  and a DVH with both doses.
- Admin page **Beam models**: the parameters of each dose calculation beam model (spectrum, source, collimators),
  its MU calibration on this server with the simulated reference depth dose, and its sources and limitations.
- CT calibration curves for dose calculation (HU → mass density and material): a built-in generic
  Schneider 2000 curve marked as demo, administrator-managed curves from phantom tables with draft, active
  and retired states, and matching by scanner manufacturer, model and kVp with the reason shown. Any curve,
  the built-in one included, can be copied to an editable draft, and a default curve can replace the
  built-in one for scanners that match nothing else.
- Beam data for fitting and validating beam models (administrator page **Beam data**): datasets per machine and
  beam with their source, citation and licence; depth doses, profiles, output factors, single values and absolute
  calibration with conditions and uncertainties; import as generic CSV; drafts, locking and copies. Built-in
  datasets reproduce tables from five open-access TrueBeam and Halcyon articles (CC BY).
- Beam model check against beam data (`rtgaia-dosecalc check-model`, GPU): every measurement is simulated in a
  water tank under its own conditions and compared point by point (depth doses, depth of maximum, TPR20,10,
  output factors, penumbra, field width, FFF unflatness and slope, MLC transmission, absolute calibration), with
  the detector's volume averaging applied to profiles, batch uncertainties for every derived value and
  tolerances of 1 % or 1 mm; unsupported measurements are listed with the reason.
- Beam model fitting (`rtgaia-dosecalc fit-model`, GPU): staged fits of the spectrum, electron contamination,
  focal spot, head scatter, monitor backscatter and collimator density to beam data from linear combinations of
  simulated source components, with the measurements each parameter was fitted to, parameter uncertainties,
  equally good alternatives for weakly constrained parameters, unconstrained parameters kept at the prior, and a
  point-by-point check against fit and validation datasets.
- Fitted beam models on the administrator page **Beam models**: fit jobs on the GPU from built-in or locked beam
  data with separate validation data, drafts with their fit reports and point-by-point checks, activation that
  retires the previous model for the same beams, optional machine names, and automatic use of the active fitted
  model in dose calculations (the built-in demo models remain the fallback). The dose calculation request accepts
  an explicit `beam_model_id`.
- Full water-tank curves in beam data: PDD and profile points are compared and fitted point by point with a
  combined 1 % / 1 mm tolerance (profiles normalized at the central axis, after detector averaging); build-up
  points constrain electron contamination, small-field profiles the focal spot, large-field profiles head scatter.
  Profiles can be crossline (x) or inline (y).
- HD120 demo beam models, and model selection by MLC family from the plan's leaf boundaries (Millennium 120 or
  HD120). The demo DLG values are now measured sweeping-gap means (Isono et al. 2020), added as public beam data
  with the leaf transmission.
- Model sensitivity for GPU dose calculations: the plan is recalculated with each set of fitted beam-model
  parameters that fits the beam data equally well, and the job reports how much the high-dose region changes.
- TPR and TMR curves in beam data are compared and fitted, simulated in isocentric setups at every measured depth.
- Beam models can carry a radial fluence profile of the primary source (GPU engine), fitted from the in-field
  part of measured profiles, for off-axis shapes that a single angular distribution cannot describe.
- Dosimetric leaf gap (DLG) per MLC in beam models and both engines, with assumed typical values in the demo
  models and fits that take it from DLG or leaf-end-effect measurements. Without it, VMAT and SRS doses were
  systematically low.
- On the GPU engine, head-scatter photons are aimed at the field opening from their starting point on the
  extended source, so the collimators decide how much of the source each field sees.
- Beam models can carry fitted components: a virtual electron contamination source (GPU engine), monitor chamber
  backscatter and an effective collimator density factor (both engines).
- The reference field of dual-layer MLC beam models now opens every leaf that overlaps the field; the upper
  layer previously opened 9 cm instead of 10 cm in the MU calibration field. Cached MU calibrations are redone.
- Plan display (view only): beam table, isocenter markers, beam's-eye view with jaws and MLC, a
  control-point timeline, arc ticks on axial images, beams in 3D, a gantry and couch sketch, and a DRR
  computed from the planning CT.

### Measurements

- Distance, area, volume ROI with HU statistics, landmarks with target registration error, angle, Cobb
  angle, curve length and measurement templates; CSV export.

### Review, export and collaboration

- Local accounts with roles (viewer, contourer, approver, administrator), password policy, lockout and
  CSV account import; append-only audit log.
- Sign-off of structures (signed-off structures are locked for everyone), presence showing who is in a
  case and what they are editing.
- RTSTRUCT export by download, to the library, or to a DICOM node, with export profiles and optional
  de-identification; an export log with resend.

### Plugins

- Out-of-process plugin contract (HTTP, versioned, OpenAPI and JSON Schema), a Python SDK with a contract
  checker, UI bundles for side panels, and examples including nnU-Net-based auto-contouring.
- UI bundles can register translations (`registerMessages`, `t` in `@rtgaia/sdk` 0.1.1), so plugin panels,
  names and descriptions follow the viewer's language.
- The Python SDK, the contract checker and the example plugins report in English.

### Platform

- English and Traditional Chinese user interface (English by default; the choice is saved per account).
  Server messages follow the interface language; API clients get English unless they ask for Traditional
  Chinese with `Accept-Language`. Command-line help and logs are in English.
- Phones and tablets (Android Chrome): touch gestures, a single-viewport phone layout, touch and stylus
  contouring, sign-off on a phone, and an "add to home screen" shortcut.
- CPU rendering in the browser (Rust compiled to WebAssembly); no GPU required on the client.
- Docker Compose deployment with separate API, job worker and DICOM receiver processes.
- Continuous integration for Rust, Python and the frontend, including end-to-end tests, performance
  budgets and a deployment smoke test.
