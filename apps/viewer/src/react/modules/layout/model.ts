/**
 * 版面／並排比較模組的**純邏輯**。零 React。
 */

import type { Layer, LayoutSpec, OrthoOrientation } from "../../../core";
import { msg } from '../../../core/i18n';

export const COMPARE_LEFT = "compare-left";
export const COMPARE_RIGHT = "compare-right";
export const COMPARE_LINK = "compare";
export const COMPARE_LAYOUT_PREFIX = "compare-";

/** 版面在註冊時就定下 label，顯示時才 `t(label)` —— 所以每個方位一條字面原文（不用參數）。 */
const COMPARE_LABELS: Record<OrthoOrientation, { layout: string; left: string; right: string }> = {
  axial: { layout: msg('並排 軸向'), left: msg('左 · 軸向'), right: msg('右 · 軸向') },
  coronal: { layout: msg('並排 冠狀'), left: msg('左 · 冠狀'), right: msg('右 · 冠狀') },
  sagittal: { layout: msg('並排 矢狀'), left: msg('左 · 矢狀'), right: msg('右 · 矢狀') },
};

export function compareLayoutId(orientation: OrthoOrientation): string {
  return `${COMPARE_LAYOUT_PREFIX}${orientation}`;
}

export function isCompareLayout(layoutId: string): boolean {
  return layoutId.startsWith(COMPARE_LAYOUT_PREFIX);
}

export function compareOrientationOf(layoutId: string): OrthoOrientation {
  const o = layoutId.slice(COMPARE_LAYOUT_PREFIX.length);
  return o === "coronal" || o === "sagittal" ? o : "axial";
}

/** 三個並排版面：兩格同方位、相機連動。 */
export function compareLayouts(): LayoutSpec[] {
  return (["axial", "coronal", "sagittal"] as const).map((orientation) => ({
    id: compareLayoutId(orientation),
    label: COMPARE_LABELS[orientation].layout,
    gridTemplateColumns: "1fr 1fr",
    gridTemplateRows: "1fr",
    cells: [
      {
        cellId: COMPARE_LEFT,
        label: COMPARE_LABELS[orientation].left,
        content: { kind: "viewport", orientation, cameraLink: COMPARE_LINK },
      },
      {
        cellId: COMPARE_RIGHT,
        label: COMPARE_LABELS[orientation].right,
        content: { kind: "viewport", orientation, cameraLink: COMPARE_LINK },
      },
    ],
  }));
}

/**
 * 這一格只看 `frameOfReferenceUid` 這一組：其餘 FoR 的影像、劑量、結構全部藏起來。
 * 量測等沒有 FoR 概念的 layer 不動。
 */
export function hiddenLayersForCell(
  layers: readonly Layer[],
  frameOfReferenceUid: string,
): string[] {
  return layers
    .filter(
      (l) =>
        (l.kind === "image" || l.kind === "dose" || l.kind === "mask") &&
        l.frameOfReferenceUid !== frameOfReferenceUid,
    )
    .map((l) => l.layerId);
}

/** 預設：左 primary、右第一個次要（沒有次要就也是 primary）。 */
export function defaultCompareSides(
  frameGroups: readonly { frameOfReferenceUid: string; role: string }[],
): [string | null, string | null] {
  const primary =
    frameGroups.find((f) => f.role === "primary")?.frameOfReferenceUid ??
    frameGroups[0]?.frameOfReferenceUid ??
    null;
  const secondary =
    frameGroups.find((f) => f.role === "secondary")?.frameOfReferenceUid ??
    primary;
  return [primary, secondary];
}
