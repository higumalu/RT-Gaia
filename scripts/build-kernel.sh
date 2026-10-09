#!/usr/bin/env bash
# 建置 CPU 重切核心的兩個目標（單一來源，三處使用）。
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"

CRATE=packages/rtgaia-reslice
NATIVE_OUT=packages/rtgaia-geom/src/rtgaia_geom/_native
WASM_OUT=apps/viewer/public

echo "== cargo test（純核心）"
(cd "$CRATE" && cargo test --release --quiet)

echo "== 原生 cdylib（後端 ＋ 等效性測試）"
(cd "$CRATE" && cargo build --release --quiet)
mkdir -p "$NATIVE_OUT"
cp "$CRATE"/target/release/librtgaia_reslice.so "$NATIVE_OUT/"

echo "== wasm32（瀏覽器 Tier C）"
(cd "$CRATE" && cargo build --release --quiet --target wasm32-unknown-unknown)
mkdir -p "$WASM_OUT"
cp "$CRATE"/target/wasm32-unknown-unknown/release/rtgaia_reslice.wasm "$WASM_OUT/"

ls -la "$NATIVE_OUT"/librtgaia_reslice.so "$WASM_OUT"/rtgaia_reslice.wasm
