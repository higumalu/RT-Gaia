/**
 * 3D 出圖的擴充點：其他模組可以加「送後端的圖層」與「疊在 3D 格上的元件」，3D 模組不必認識它們。
 *
 * * `register3dLayers(id, fn)`：`fn(state)` 回要附加在 `render3dLayers` 後面的圖層（例：計畫模組的 `{renderer: 'beams', …}`，
 *   後端換成線與面）。回空陣列 ＝ 這次不畫。
 * * `register3dOverlay(id, Component)`：畫在 3D 格右下角的元件（例：小 BEV）；不攔 3D 的拖曳（元件自己 stopPropagation）。
 */

import type { ComponentType } from 'react';

import type { ViewerPanelProps } from '../../panels/types';

export type Render3dState = ViewerPanelProps['api']['state'];
export type Render3dLayerContributor = (state: Render3dState) => Record<string, unknown>[];

const layerContributors = new Map<string, Render3dLayerContributor>();
const overlays = new Map<string, ComponentType<ViewerPanelProps>>();

export function register3dLayers(id: string, fn: Render3dLayerContributor): () => void {
  layerContributors.set(id, fn);
  return () => layerContributors.delete(id);
}

export function register3dOverlay(id: string, component: ComponentType<ViewerPanelProps>): () => void {
  overlays.set(id, component);
  return () => overlays.delete(id);
}

export function contributed3dLayers(state: Render3dState): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const fn of layerContributors.values()) {
    try {
      out.push(...fn(state));
    } catch {
      /* 擴充點出錯不能讓 3D 整個畫不出來 */
    }
  }
  return out;
}

export function render3dOverlays(): [string, ComponentType<ViewerPanelProps>][] {
  return [...overlays.entries()];
}
