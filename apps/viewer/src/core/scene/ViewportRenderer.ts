/**
 * 渲染後端抽象。
 *
 * > 🔴 **這是整份規格中成本最高的一項決定。** 兩條渲染路徑代表兩套實作、
 * > 兩份效能調校，**以及受管制產品的兩份顯示驗證**。
 *
 * | 實作 | 光柵化 | 合成 |
 * |---|---|---|
 * | `GpuViewportRenderer` | vtk.js volume mapper ＋ 薄板 ＋ 3D texture | GPU 混合 |
 * | `CpuViewportRenderer` | **WASM 重切核心** → `ImageData` | **CPU 合成器** |
 *
 * **共用（不得各寫一份）**：`geometry/`、`ViewReference` 與相機數學、`Layer`
 * 模型與可見性、`transport/`、`edit/`（筆刷光柵化是體素寫入，與渲染無關）、
 * 互動事件層。
 */

import type { ViewReference } from '../geometry';
import type { Layer } from '../layers/types';
import type { Quality, ViewportInfo } from '../raster/types';

export interface ViewportRenderer {
  readonly info: ViewportInfo;
  setLayers(layers: readonly Layer[]): void;
  setCamera(ref: ViewReference): void;
  resize(w: number, h: number): void;
  render(quality: Quality): void;
  dispose(): void;
}

/**
 * 不畫任何像素、但**行為完整**的 renderer。
 *
 * 第一版（骨架）用它讓 `SceneManager`、註冊表、LRU 記帳與 React 的掛載
 * 流程可以端到端跑起來與測試，而不必先把 `@cornerstonejs/core` 與 WASM 核心
 * 接進來。之後由 `GpuViewportRenderer` / `CpuViewportRenderer` 取代。
 */
export class NullViewportRenderer implements ViewportRenderer {
  readonly info: ViewportInfo;
  private layers: readonly Layer[] = [];
  private camera: ViewReference | null = null;
  readonly renderLog: { quality: Quality; layerCount: number }[] = [];
  disposed = false;

  constructor(info: ViewportInfo) {
    this.info = info;
  }

  setLayers(layers: readonly Layer[]): void {
    this.layers = layers;
  }

  setCamera(ref: ViewReference): void {
    this.camera = ref;
  }

  resize(w: number, h: number): void {
    (this.info as { width: number }).width = w;
    (this.info as { height: number }).height = h;
  }

  render(quality: Quality): void {
    this.renderLog.push({ quality, layerCount: this.layers.length });
  }

  currentCamera(): ViewReference | null {
    return this.camera;
  }

  currentLayers(): readonly Layer[] {
    return this.layers;
  }

  dispose(): void {
    this.disposed = true;
    this.layers = [];
    this.camera = null;
  }
}
