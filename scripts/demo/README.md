# Demo recording

Scripts that record the RT-Gaia demo video: an overview of about three minutes with burned-in English
captions, plus one short clip per scene. They drive a real browser with a real mouse on a virtual screen, so the
video shows the actual application, cursor and animations. Only public data under Creative Commons
Attribution licenses is used.

Everything is written to `.rtgaia/demo/media/`, which is not stored in the repository. The copies used
by the project README (a smaller encode of the overview and an animated preview) are generated with
`render.mjs --readme docs/assets/demo` and are committed.

## Requirements

- Linux with `Xvfb`, `xdotool`, `ffmpeg` (with `libx264` and `libass`), Google Chrome, and the
  Noto Sans font.
- Docker (the demo stack uses its own PostgreSQL container).
- The repository's development environment (`uv sync --all-packages`, `npm install` in `apps/viewer`,
  the WebAssembly kernel built with `./scripts/build-kernel.sh`).
- For the plugin scene: the nnU-Net example plugin's own environment with the inference extras
  (`cd examples/plugin-nnunet && uv sync -p 3.12 --extra inference`; see its
  [README](../../examples/plugin-nnunet/README.md)) and an NVIDIA GPU. TotalSegmentator downloads its
  weights on first use.
- An NVIDIA GPU also lets Chrome on the virtual screen use WebGL through ANGLE and Vulkan, so the
  viewer behaves as on a normal workstation. Set `DEMO_NO_GPU=1` to record without it.

If Chrome hangs on every page load, check whether the user's inotify instances are exhausted
(`/proc/sys/fs/inotify/max_user_instances`); raise the limit, for example
`sudo sysctl -w fs.inotify.max_user_instances=1024`.

## Data

Put the demo data under `data/demo/` (ignored by Git):

| Folder | Data | License |
|---|---|---|
| `pancreatic/` | Pancreatic-CT-CBCT-SEG, patient `Pancreas-CT-CB_014` | CC BY 4.0, doi:10.7937/TCIA.ESHQ-4D90 |
| `cctumor/` | CC-Tumor-Heterogeneity, patient `CCTH-A06` | CC BY 4.0, doi:10.7937/ERZ5-QZ59 |
| `4dlung/` | 4D-Lung, patient `113_HM10395` | CC BY 3.0, doi:10.7937/K9/TCIA.2016.ELN8YGLE |
| `vs/` | Vestibular-Schwannoma-SEG, patient `VS-SEG-131` | CC BY 4.0, doi:10.7937/TCIA.9YTJ-5Q73 |
| `proteas/P21/` | PROTEAS brain metastases (Flouri et al.), patient P21 | CC BY 4.0, doi:10.5281/zenodo.23171182 |

The first four come from The Cancer Imaging Archive through the NCI Imaging Data Commons:

```sh
uv run --no-project --with idc-index idc download-from-selection --download-dir data/demo/pancreatic --patient-id Pancreas-CT-CB_014
uv run --no-project --with idc-index idc download-from-selection --download-dir data/demo/cctumor --patient-id CCTH-A06
uv run --no-project --with idc-index idc download-from-selection --download-dir data/demo/4dlung --patient-id 113_HM10395
uv run --no-project --with idc-index idc download-from-selection --download-dir data/demo/vs --patient-id VS-SEG-131
```

For PROTEAS, download `P21.zip` from the Zenodo record
(`https://zenodo.org/api/records/23171182/files/P21.zip/content`) and extract its CT, RTSTRUCT, RTPLAN and
RTDOSE files into `data/demo/proteas/P21/` (the RT image files are not needed). The PROTEAS images are
not defaced, so the video shows this case only in axial views and the beam's-eye view: no 3D rendering
and no sagittal view.

When you publish recordings, credit the datasets as listed in [`credits.mjs`](credits.mjs) (the end card
of the video) and cite TCIA: Clark K et al., *The Cancer Imaging Archive (TCIA): Maintaining and
Operating a Public Information Repository*, J Digit Imaging 2013;26(6):1045–1057.

## Usage

```sh
scripts/demo/stack.sh start     # PostgreSQL container, backend, built frontend; indexes data/demo
scripts/demo/stack.sh plugin    # optional: nnU-Net plugin on the GPU, registered with the demo backend
node scripts/demo/record.mjs    # records every scene into .rtgaia/demo/media/raw/
node scripts/demo/render.mjs    # captions, title and end cards → .rtgaia/demo/media/rt-gaia-demo.mp4 and clips/
```

| Command | Purpose |
|---|---|
| `stack.sh start`, `stop`, `status` | The demo stack: PostgreSQL on port 5436, backend on 8096 (sign-in required), frontend on 5186. It never touches a development database. Accounts `admin`, `physicist` (contourer) and `oncologist` (approver); the password is `DEMO_PASSWORD` (default `demo-password-2026`). |
| `stack.sh plugin` | Starts the nnU-Net plugin (TotalSegmentator on the GPU) on port 8722 and registers it. |
| `stack.sh reset` | Deletes the container, its volume and the demo data directory, keeping recordings. Run it before a final take, so that every scene starts from the same state. |
| `record.mjs --scenes a,b` | Records only these scenes (the scene list is in [`scenes.mjs`](scenes.mjs)). Scenes build on each other's data (for example, the review scene approves the structure drawn in the contouring scene), so record them in order after a reset. |
| `record.mjs --scenes a --dry 1` | Runs only the setup of a scene and saves `<scene>-setup.png`, for measuring positions. |
| `render.mjs --scenes a,b --out-name x.mp4` | Renders a subset. |
| `render.mjs --readme docs/assets/demo` | Also writes the README copies: `rt-gaia-demo.mp4` (CRF 27, about 10 MB) and `demo-preview.gif` (about 20 seconds of highlights, 800 px wide). GitHub plays inline only videos uploaded through its web interface, so the README shows the animated preview and links to the MP4. The highlights are listed in `PREVIEW` in [`render.mjs`](render.mjs), positioned relative to the captions so that they survive a new take. |
| `render.mjs --play 1` | Renders at the recorded speed. By default the video plays 1.2 times faster than it was recorded (the scenes are performed at a human pace). |

Each scene has a `setup` step that prepares the screen without recording and a `run` step that is
recorded. Captions are timed with `rec.cue(...)`; `rec.mark('fast', ...)` marks a section that the render
speeds up (for example waiting for AI inference) and labels as sped up. The phone scene runs in a
second, phone-sized browser and is placed in the middle of the frame.

If the application shows a native browser dialog during a take, the recorder accepts it so that the take
does not hang, and lists it at the end: check that part of the video.
