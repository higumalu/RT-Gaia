/**
 * 核心內建擴充點的註冊入口。
 *
 * 🔴 **必須在第一次 React render 之前呼叫**，不能放在 `useEffect` 裡。
 *
 * 註冊表不是 reactive 的，而 `Toolbar` 在 render 時就呼叫 `listTools()`。
 * 放進 effect 的症狀是**工具列永遠是空的**——畫面不會報錯、console 也乾淨，
 * 只是少了東西。（這個 bug 是用真的 Chrome 載入頁面才發現的。）
 */

import { registerBuiltins } from './raster/builtins';
import { registerBuiltinColormaps } from './raster/colormaps';
import { DOSE_KIND, registerDoseModule } from './raster/doseModule';
import { listLayerKinds } from './raster/kinds';
import { listLayerRenderers } from './raster/registry';
import { registerVoxelStorage } from './scene/volumeStore';
import { registerBuiltinTools } from './tools/builtins';
import { hasZstdDecoder } from './transport/decode';
import { registerDefaultZstdDecoder } from './transport/zstd';

/** 冪等：重複呼叫（StrictMode、測試）不會重複註冊。 */
export function registerCoreBuiltins(): void {
  if (listLayerRenderers().length === 0 || listLayerKinds().length === 0) registerBuiltins();
  registerBuiltinColormaps();
  // 劑量是第一個「非核心」kind —— 走的是與第三方模組相同的註冊路徑
  registerDoseModule();
  registerVoxelStorage(DOSE_KIND, 'volume');
  // 逐 id 冪等 —— 不能用「空的才註冊」：模組可能已先註冊自己的工具（曾經因此回歸）
  registerBuiltinTools();
  // 🔴 少了這個，真瀏覽器一載入影像就 `[W8] 尚未註冊解壓器`（見 transport/zstd.ts）
  if (!hasZstdDecoder()) registerDefaultZstdDecoder();
}
