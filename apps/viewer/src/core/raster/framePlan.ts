/**
 * 一幀要畫什麼 —— **註冊表的查詢結果，與任何 canvas 無關**。
 *
 * ## 為什麼要抽成一個純函式
 *
 * 這段邏輯原本內聯在 `CpuViewportRenderer.render()` 裡，而那個類別**需要真的
 * DOM**（它自己建 canvas）。測試在 Node 下跑，於是整個「哪個 layer 由哪個
 * renderer 畫、順序是什麼」的決策**一條測試都沒有** —— 包括「核心迴圈裡不得
 * 有 `kind === '...'`」這條硬規則。
 *
 * 抽出來之後它是純函式：吃 `(layers, viewport, tier)`，吐一個排好序的清單。
 * 宿主只負責照著畫。
 */

import type { Layer } from '../layers/types';
import { resolveRenderers } from './kinds';
import { getLayerRenderer, resolveBackend, zBandRank } from './registry';
import type { Backend, CpuContext, LayerRendererPlugin, Tier, ViewportInfo } from './types';
import { t } from '../i18n';

/**
 * 一個 `supported` 且**真的會畫東西**的 cpu 後端。
 *
 * `draw` 在 `Backend` 上是選配（GPU 路徑的場景圖自己會畫），但計畫裡的每一步
 * 都已經過濾過 —— 型別說出這件事，宿主才不必再寫一次 `if (draw === undefined)`。
 */
export type DrawableCpuBackend = Extract<Backend<CpuContext, unknown>, { kind: 'supported' }> & {
  draw: NonNullable<Extract<Backend<CpuContext, unknown>, { kind: 'supported' }>['draw']>;
};

export interface FrameDrawStep {
  readonly layer: Layer;
  readonly plugin: LayerRendererPlugin;
  /** 已確認是 `supported`、且有 `draw` 的 cpu 後端。 */
  readonly backend: DrawableCpuBackend;
  /** 走了 fallback 時 ≠ `plugin.rendererId` 原本要的那一個。 */
  readonly requestedRendererId: string;
}

export interface FramePlan {
  readonly steps: readonly FrameDrawStep[];
  /**
   * 被跳過的 `(layer, renderer)` 與原因。
   *
   * 🔴 **跳過必須說得出理由。** 「這一格為什麼沒有東西」是最常見的客訴，
   * 而靜默的 `continue` 讓它無從查起。
   */
  readonly skipped: readonly { layerId: string; rendererId: string; reason: string }[];
}

/**
 * 這一幀的繪製計畫。
 *
 * 排序：先 `zBand`（順序來自註冊表的 `Z_BAND_ORDER`，**混合順序
 * 是資料不是 switch**），同一個 band 內再照 `layer.order`。
 */
export function planCpuFrame(args: {
  layers: readonly Layer[];
  viewport: ViewportInfo;
  tier: Tier;
}): FramePlan {
  const steps: (FrameDrawStep & { rank: number; order: number })[] = [];
  const skipped: { layerId: string; rendererId: string; reason: string }[] = [];

  for (const layer of args.layers) {
    if (!layer.visible) continue;
    let rendererIds: string[];
    try {
      rendererIds = resolveRenderers(layer, args.viewport);
    } catch (error) {
      skipped.push({
        layerId: layer.layerId,
        rendererId: '',
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    for (const rendererId of rendererIds) {
      let resolved;
      try {
        resolved = resolveBackend(rendererId, args.tier);
      } catch (error) {
        skipped.push({
          layerId: layer.layerId,
          rendererId,
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      // hidden 是**明確告知使用者不可用**，不是靜默省略。
      // 通知由 `SceneManager` 發；這裡只記下為什麼沒畫。
      if (resolved.hidden) {
        skipped.push({
          layerId: layer.layerId,
          rendererId,
          reason: resolved.notice ?? t('此 Tier 不支援'),
        });
        continue;
      }
      const plugin = getLayerRenderer(resolved.effectiveRendererId);
      const backend = plugin.cpu;
      if (backend.kind !== 'supported') {
        // resolveBackend 已經處理過 fallback；走到這裡代表退路指向的 renderer
        // 自己也不支援 —— R7 本來就擋掉了，這是防禦性的
        skipped.push({ layerId: layer.layerId, rendererId, reason: backend.reason });
        continue;
      }
      if (backend.draw === undefined) {
        skipped.push({
          layerId: layer.layerId,
          rendererId: plugin.rendererId,
          reason: t('renderer「{rendererId}」的 cpu 後端還沒有 draw（尚未光柵化）', { rendererId: plugin.rendererId }),
        });
        continue;
      }
      steps.push({
        layer,
        plugin,
        backend: backend as FrameDrawStep['backend'],
        requestedRendererId: rendererId,
        rank: zBandRank(plugin.zBand),
        order: layer.order,
      });
    }
  }

  steps.sort((a, b) => a.rank - b.rank || a.order - b.order);
  return {
    steps: steps.map(({ layer, plugin, backend, requestedRendererId }) => ({
      layer,
      plugin,
      backend,
      requestedRendererId,
    })),
    skipped,
  };
}
