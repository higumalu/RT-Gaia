/**
 * SVG overlay —— **只給需要 hit-test 的少量內容**。
 *
 * > **量測維持 SVG，mask 輪廓不是。** 量測需要 hit-test、hover、可拖曳控制點，
 * > 且每個 viewport 只有數十個節點——SVG 的 DOM 語意它**全部用得上**。
 * > mask 輪廓是唯讀的、每幀數萬座標，一項都用不上（走 canvas 2D）。
 *
 * ## 🟢 這是雙路徑架構中少數的免費午餐
 *
 * SVG 是 DOM，**不在乎底下的像素來自 WebGL 還是 canvas 2D**。因此
 * GPU/CPU 雙路徑成本**不適用於量測層**——投影數學（world → canvas）本來就
 * 已共用。值得在排程時算進去。
 */

import type { Measurement, MeasurementResult } from '../layers/types';
import { measurementValue } from '../measure/geometry';
import type { Vec2 } from '../raster/types';
import type { ViewReference } from '../geometry';
import { planeRelation } from '../geometry';

/** 控制點的命中半徑（像素）。手感相關，不是幾何。 */
export const HANDLE_HIT_RADIUS_PX = 8;

export interface SvgHandle {
  readonly id: string;
  /** canvas 像素座標。 */
  readonly position: Vec2;
  readonly kind:
    | 'measurement-point'
    | 'measurement-body'
    | 'measurement-box-corner'
    | 'crosshair-center'
    | 'crosshair-rotate'
    | 'slab-thickness'
    /** 模組交給核心的可調方框（3D 裁切範圍）—— 截面的角（平面內兩軸）與邊中點（一軸）。 */
    | 'editable-box-corner'
    | 'editable-box-edge';
  /** 所屬物件（量測 id、viewport id，或可調方框的擁有者 id）。 */
  readonly ownerId: string;
  /** 控制點在 `points` 中的索引（量測用）；`measurement-box-corner` 時是截面矩形的角索引。 */
  readonly pointIndex?: number;
  /** 線段型把手（量測的身體）：命中 ＝ 點到線段距離 ≤ 半徑。有它時 `position` 只是參考點。 */
  readonly segment?: readonly [Vec2, Vec2];
}

function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2));
  return Math.hypot(a.x + vx * t - p.x, a.y + vy * t - p.y);
}

/** 命中測試 —— **這就是 mask 輪廓用不到、量測用得到的那一項**。 */
export function hitTest(
  handles: readonly SvgHandle[],
  at: Vec2,
  radiusPx = HANDLE_HIT_RADIUS_PX,
): SvgHandle | null {
  // 點把手優先於線段把手（頂點就在邊上，不能被邊搶走）
  let best: SvgHandle | null = null;
  let bestDistance = radiusPx;
  for (const handle of handles) {
    if (handle.segment !== undefined) continue;
    const d = Math.hypot(handle.position.x - at.x, handle.position.y - at.y);
    if (d <= bestDistance) {
      best = handle;
      bestDistance = d;
    }
  }
  if (best !== null) return best;
  for (const handle of handles) {
    if (handle.segment === undefined) continue;
    const d = distanceToSegment(at, handle.segment[0], handle.segment[1]);
    if (d <= bestDistance) {
      best = handle;
      bestDistance = d;
    }
  }
  return best;
}

/**
 * 平面型量測在斜面上的顯示方式。
 *
 * | 關係 | 顯示 | 可編輯 |
 * |---|---|---|
 * | 共面 | **完整顯示**多邊形、控制點、數值 | ✅ |
 * | 平行但不同層 | 淡色輪廓 | ❌ |
 * | **相交（斜面）** | **只顯示交線**，標示 label | ❌ |
 * | 不相交 | 不顯示 | ❌ |
 *
 * > **編輯只允許在共面時進行。** 平面型物件與任意斜面求交不是一個多邊形。
 *
 * ⚠️ 非共面時**顯示交線，不直接隱藏**：MR-Linac cine 這類情境需要看到交線，
 * 交線不是選配。
 */
export type MeasurementDisplayMode = 'full' | 'faded' | 'intersection-only' | 'hidden';

export function measurementDisplayMode(
  view: ViewReference,
  measurement: Measurement,
): MeasurementDisplayMode {
  // 與平面無關的型別（3D 歐氏距離、體積 ROI、標記點）任何視角都完整可見
  if (measurement.kind !== 'area' || measurement.viewReference === null) return 'full';
  switch (planeRelation(view, measurement.viewReference)) {
    case 'coplanar':
      return 'full';
    case 'parallel':
      return 'faded';
    case 'intersecting':
      return 'intersection-only';
    case 'disjoint':
      return 'hidden';
  }
}

export function isMeasurementEditable(
  view: ViewReference,
  measurement: Measurement,
): boolean {
  if (measurement.kind !== 'area' || measurement.viewReference === null) return true;
  return measurementDisplayMode(view, measurement) === 'full';
}

/**
 * 由 `points` 重算量測結果。
 *
 * 🔴 **`result` 永遠由 `points` 重算，不得獨立儲存為真相**。
 * 拖曳控制點後若忘記重算，畫面上的數值就會與圖形不一致——而那是**量測工具
 * 最不能出的錯**。
 */
export function computeMeasurementValue(measurement: Measurement): {
  value: number;
  unit: MeasurementResult['unit'];
} {
  // 與 `measure/geometry.ts` 的 `measurementValue` 同一份（以前兩份各寫一次，新增種類時容易漏）
  return measurementValue(measurement);
}
