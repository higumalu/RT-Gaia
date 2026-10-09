/**
 * 版面模組 —— 走 `registerModule()`。
 *
 * 工具列版面選單（所有 `registerLayout()` 過的版面）＋ 三個並排版面 ＋ 並排時才出現的比較面板。
 * 核心多了兩條泛用縫：每格額外隱藏的 layer、相機連動群（由 `LayoutCell.cameraLink` 宣告）。
 */

import {
  hasLayout,
  registerLayout,
  registerModule,
  type ModuleManifest,
} from "../../../core";
import { ComparePanel } from "./ComparePanel";
import { LayoutPicker } from "./LayoutPicker";
import { compareLayouts, isCompareLayout } from "./model";
import { msg } from '../../../core/i18n';

export const LAYOUT_MODULE_VERSION = "0.1.0";

const MANIFEST: ModuleManifest = {
  id: "rt-gaia-layout",
  version: LAYOUT_MODULE_VERSION,
  panels: [
    {
      id: "layout.picker",
      slot: "toolbar",
      order: 15,
      group: "layout",
      title: msg('版面'),
      component: LayoutPicker,
      // 手機一次一格（方位用影像上方的切換），沒有版面可選
      formFactors: ['tablet', 'desktop'],
    },
    {
      id: "layout.compare",
      slot: "right-sidebar",
      order: 130,
      title: msg('並排比較'),
      component: ComparePanel,
      visibleWhen: (s) => isCompareLayout(s.layoutId),
    },
  ],
};

let registered = false;

/** 冪等；`clearLayouts()` 之後版面會補回來。 */
export function registerLayoutModule(): void {
  for (const spec of compareLayouts())
    if (!hasLayout(spec.id)) registerLayout(spec);
  if (registered) return;
  registered = true;
  registerModule(MANIFEST);
}

export function resetLayoutModuleRegistration(): void {
  registered = false;
}

export * from "./model";
