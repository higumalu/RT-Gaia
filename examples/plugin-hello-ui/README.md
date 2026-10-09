# plugin-hello-ui

A minimal UI bundle for RT-Gaia plugin contract v1. It registers one right-sidebar panel and one overlay painter, and it imports nothing but `@rtgaia/sdk` and React. Its `id` and `version` (`hello-threshold`, `0.1.1`) match [`plugin-hello-python`](../plugin-hello-python/), so it can be served as that plugin's panel.

- **Panel.** Shown while the plugin's mode (`plugin:hello-threshold`) is on. It shows the number of structures and of frame groups (one per image series) in the case, and a checkbox that turns the painter on and off. The panel's text is in Traditional Chinese.
- **Overlay painter.** Draws a small cross at the world origin (0, 0, 0) in every 2D viewport, using `api.overlay.register()` and `project()`.

The panel does not start jobs; it only demonstrates the panel and overlay APIs. A panel that runs its plugin calls `POST /api/v1/plugins/<id>/run` through `api.http`, as the [nnU-Net example](../plugin-nnunet/) does.

## Build and check

The bundle is type-checked and built with the viewer's toolchain, so `examples/` needs no `node_modules` of its own:

```sh
cd apps/viewer
npm ci   # once, installs the viewer's dependencies
npx tsc -p ../../examples/plugin-hello-ui/tsconfig.json --noEmit
npx vite build --config ../../examples/plugin-hello-ui/vite.config.ts
node ../../examples/check-ui-bundle.mjs ../../examples/plugin-hello-ui/dist/index.js hello-threshold 0.1.1
```

The build writes `dist/index.js`, a single ES module (not minified, with a source map). [`vite.config.ts`](vite.config.ts) uses Vite's library mode and marks `react`, `react-dom`, `react/jsx-runtime`, and `@rtgaia/sdk` as external; at runtime the viewer's import map supplies the host's own copies. For type checking, `@rtgaia/sdk` points at `apps/viewer/src/sdk/index.ts`, because the SDK is not published as an npm package.

`check-ui-bundle.mjs` applies the same rules as the UI step of `rtgaia-plugin-check`: only the four allowed imports, React not bundled, and the `id` and `version` present as string literals.

## Serve it from plugin-hello-python

Serve `dist/` at `/ui/` and declare the bundle in the manifest, for example at the end of `examples/plugin-hello-python/plugin.py`:

```python
from pathlib import Path

UI_DIR = Path(__file__).parent.parent / "plugin-hello-ui" / "dist"
MANIFEST["ui"] = {
    "bundle": "/ui/index.js",
    "sdk_version": "^0.1.0",
    "trust": "host-equivalent",
    "panels": ["hello-threshold.panel"],
}
app = PluginApp(manifest=MANIFEST, run=run, ui_dir=UI_DIR).app
```

`rtgaia-plugin-check` then downloads and checks the bundle as well. Once the plugin is registered, this panel replaces the form RT-Gaia would otherwise generate. RT-Gaia pins the bundle's SHA-256 digest at registration and on each version change, so change `version` in the manifest and in `src/index.tsx` whenever you rebuild the bundle.

A UI bundle runs inside the viewer page with the signed-in user's privileges, and RT-Gaia does not sandbox it; `"trust": "host-equivalent"` states exactly that. See [UI bundles](../../docs/plugin-contract.md#ui-bundles) in the plugin contract.
