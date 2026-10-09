# rtgaia-reslice

The CPU reslice kernel of RT-Gaia, written in Rust. One source tree is built for two targets:

| Consumer | Build target | Loaded by |
|---|---|---|
| Browser: the CPU rendering path of the viewer | `wasm32-unknown-unknown` | `WebAssembly.instantiate` in `apps/viewer/src/core/raster/resliceKernel.ts` |
| Backend: MIP projections for server-side 3D rendering | `cdylib` (`librtgaia_reslice.so`) | Python `ctypes` in `rtgaia_geom.kernel` |

Because both hosts run the same code, the tests can check that they compute the same pixels:
`scripts/emit-geometry-fixture.py` records outputs of the native build in
`apps/viewer/tests/fixtures/geometry-vectors.json`, and `apps/viewer/tests/kernel.test.ts` recomputes
them with the WebAssembly build. `packages/rtgaia-geom/tests/test_kernel.py` checks the native build
against the Python geometry.

## What it does

- Trilinear sampling of `int16`, `uint8` and `float32` volumes on an arbitrary plane, including oblique
  planes and slabs (center plane, MIP, mean, composite).
- Window/level to 8-bit, gray to RGBA, and mask compositing.
- Marching squares and polyline stitching for structure outlines and isodose lines.

## Why a plain `extern "C"` ABI

The API is "numeric arrays in, numeric arrays out". A plain C ABI lets `WebAssembly.instantiate` and
Python `ctypes` use the same symbols, so:

- the build needs only `cargo build` (no wasm-pack, wasm-bindgen-cli or maturin);
- both hosts see the same function signatures, so the equivalence test cannot diverge because of a
  binding layer;
- the kernel adds fewer third-party dependencies.

The computing functions return an `i32`: zero or a positive count on success, a negative error code on
failure; they report errors instead of panicking across the FFI boundary. After loading, each host checks
`rt_version()` and compares `rt_struct_sizes()` with its own layout of the `repr(C)` structs, so a layout
mismatch fails at load time instead of silently reading the wrong fields.

## Build

```sh
cargo build --release                                   # target/release/librtgaia_reslice.so
cargo build --release --target wasm32-unknown-unknown   # target/wasm32-unknown-unknown/release/rtgaia_reslice.wasm
cargo test                                              # unit tests of the kernel
```

From the repository root, `./scripts/build-kernel.sh` runs the tests, builds both targets and copies them
to where they are loaded: `packages/rtgaia-geom/src/rtgaia_geom/_native/librtgaia_reslice.so` (backend)
and `apps/viewer/public/rtgaia_reslice.wasm` (frontend). The backend also accepts a library path in
`RTGAIA_RESLICE_LIB`.
