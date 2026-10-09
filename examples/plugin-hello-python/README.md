# plugin-hello-python

The smallest RT-Gaia plugin for contract v1. It thresholds the input CT at a configurable HU value and returns the result as one structure. Use it to try the plugin framework and as a template for your own plugin. It is not a clinical tool, and RT-Gaia is research software that must not be used for clinical decision making.

## Run it and check it

```sh
# At the repository root
uv sync --all-packages
RTGAIA_PLUGIN_ARTIFACTS=/tmp/hello-artifacts \
  uv run uvicorn --app-dir examples/plugin-hello-python plugin:app --port 8701

# In a second terminal
uv run rtgaia-plugin-check http://127.0.0.1:8701 --params '{"hu_min": 0, "name": "Sphere"}'
```

`rtgaia-plugin-check` plays RT-Gaia: it sends a synthetic CT (a +200 HU sphere in air), receives the label map, and validates it with rules B1–B8, including that the label map lies exactly on the input grid. `PASS` means the plugin meets the contract as far as the checker can test it.

## What it does

| Manifest field | Value |
|---|---|
| `id`, `version` | `hello-threshold`, `0.1.1` |
| `required_role` | `contourer` |
| `capabilities` | `read-image`, `write-transient`, `audit` |
| `inputs` | One CT image as NIfTI; parameters `hu_min` (number, default 0) and `name` (string, default `Hello`) |
| `outputs` | Structures, as a label map |
| `execution` | Callback mode, 300-second timeout, up to 2 concurrent jobs |

`run(ctx)` in [`plugin.py`](plugin.py):

1. Downloads the input image with `ctx.fetch_image()`.
2. Marks every voxel above `hu_min` and writes the mask as a NIfTI file on the input grid with `ctx.publish_nifti()`.
3. Builds a bundle with one structure called `name` and delivers it with `ctx.submit()`.
4. Records an audit event `hello.run` with the voxel count, and reports progress along the way.

The parameter titles and the description in the manifest are in Traditional Chinese; RT-Gaia shows them on the form it generates for this plugin.

## Use it as a template

1. Copy `plugin.py` and change `id`, `version`, `label`, `licenses`, `soup`, and `params_schema` in `MANIFEST`.
2. Replace the threshold in `run()` with your own processing. Keep every output on the input grid; RT-Gaia does not resample and rejects masks on other grids (`B3`).
3. Run `rtgaia-plugin-check` until it prints `PASS`.

The [plugin developer guide](../../docs/plugins.md) explains each step, and the [SDK reference](../../packages/rtgaia-plugin-sdk/README.md) lists everything `RunContext` offers.

## Register it with RT-Gaia

1. Start the plugin with a token and an address RT-Gaia can reach, for example `RTGAIA_PLUGIN_TOKEN=<token> uv run uvicorn --app-dir examples/plugin-hello-python plugin:app --host 0.0.0.0 --port 8701`. The plugin must in turn reach RT-Gaia's public URL for its callbacks.
2. In RT-Gaia, an administrator opens the admin page's **Plugins** tab, enters the endpoint (for example `http://plugin-hello:8701`) and the token, and selects **Register**.
3. In the viewer, the plugin appears in the **Plugins** menu as **Hello threshold**. Its panel is generated from the parameter schema.

## Container image

The [`Dockerfile`](Dockerfile) installs the SDK from wheel files that it copies from a build context named `rtgaia-sdk` (directory `wheels/`). Build the wheels first:

```sh
# At the repository root
uv build --package rtgaia-geom --wheel -o /tmp/rtgaia-sdk/wheels
uv build --package rtgaia-plugin-sdk --wheel -o /tmp/rtgaia-sdk/wheels
docker build --build-context rtgaia-sdk=/tmp/rtgaia-sdk -t plugin-hello-python examples/plugin-hello-python
docker run --rm -p 8701:8701 --add-host=host.docker.internal:host-gateway \
       -e RTGAIA_PLUGIN_TOKEN=<token> plugin-hello-python
uv run rtgaia-plugin-check http://127.0.0.1:8701 --token <token> --public-host host.docker.internal
```

The image listens on port 8701 and writes result files to `/data/artifacts`. `--public-host` tells the plugin in the container how to reach the checker on your machine.
