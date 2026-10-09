/**
 * 四個量測工具—— 走 `activate() → onPointerDown/Move/Up/KeyDown` 同一條接縫。
 *
 * | 工具 | 互動 |
 * |---|---|
 * | `measure-point` | 點一下 |
 * | `measure-distance` | 按下第一點、拖到第二點放開（拖曳中有橡皮筋線） |
 * | `measure-area` | 逐點點擊成多邊形；點回第一個頂點、再點一次最後頂點（雙擊）或 Enter 收口；Esc 取消 |
 * | `measure-roi3d` | 平面內拖出矩形，深度預設＝矩形短邊（面板可改） |
 * | `measure-angle` | 依序點三點，第二點是頂點 |
 * | `measure-cobb` | 畫兩條線（各點兩點）；綁畫的平面 |
 * | `measure-curve` | 逐點點擊成開放折線；雙擊、再點最後頂點或 Enter 結束，Esc 取消 |
 *
 * 量測綁**作用中影像**的 FoR（`ctx.activeImageLayer()`），`points` 存那個 FoR 自己的世界座標
 * （畫面點 → primary → `fromPrimaryWorld`）；沒有可見影像就拒絕啟動（TL6）。
 * 進行中的量測 `commit:false`（不進 undo、不存），完成才 `commitMeasurement()`。
 */

import { ContractViolation, cross3, fromPrimaryWorld, normalize3, signedDistance, viewInFrame, type Vec3, type ViewReference } from '../geometry';
import type { Layer, Measurement, MeasurementKind } from '../layers/types';
import { createMeasurement, isPlanarKind, nextMeasurementLabel, pointAt, requiredPoints } from '../measure';
import type { ToolContext, ToolInstance, ToolPlugin } from './registry';
import { t } from '../i18n';

export const MEASURE_TOOL_IDS = ['measure-distance', 'measure-area', 'measure-roi3d', 'measure-point', 'measure-angle', 'measure-cobb', 'measure-curve'] as const;
export type MeasureToolId = (typeof MEASURE_TOOL_IDS)[number];

const KIND_OF: Record<MeasureToolId, MeasurementKind> = {
  'measure-distance': 'distance',
  'measure-area': 'area',
  'measure-roi3d': 'roi3d',
  'measure-point': 'point',
  'measure-angle': 'angle',
  'measure-cobb': 'cobb',
  'measure-curve': 'curve',
};

/** 量測種類 → 畫它的工具（量測範本切工具用）。 */
export function measureToolFor(kind: MeasurementKind): MeasureToolId {
  return (Object.keys(KIND_OF) as MeasureToolId[]).find((id) => KIND_OF[id] === kind)!;
}

/** 點回第一個頂點的判定半徑（CSS px）。 */
export const CLOSE_POLYGON_PX = 8;
/** 小於這個距離的「拖曳」視為點擊（mm）。 */
export const CLICK_TOLERANCE_MM = 0.5;

function requireImage(toolId: string, ctx: ToolContext): Layer {
  const layer = ctx.activeImageLayer();
  if (layer === null) throw new ContractViolation('TL6', t('量測需要一張可見的影像（量測綁它的座標系、取它的 HU）'), { toolId });
  return layer;
}

/** 畫面點 → 該影像 FoR 自己的世界座標。 */
export function ownPoint(ctx: ToolContext, layer: Layer, x: number, y: number): [number, number, number] {
  return fromPrimaryWorld(ctx.frameGroup(layer.frameOfReferenceUid), ctx.canvasToWorld(x, y));
}

/** 目前平面搬到該影像 FoR（面積量測存的平面、Provenance 的 view）。 */
export function ownView(ctx: ToolContext, layer: Layer): ViewReference {
  return viewInFrame(ctx.camera, ctx.frameGroup(layer.frameOfReferenceUid));
}

function projectToPlane(p: Vec3, plane: ViewReference): [number, number, number] {
  const d = signedDistance(plane, p);
  const n = plane.viewPlaneNormal;
  return [p[0] - n[0] * d, p[1] - n[1] * d, p[2] - n[2] * d];
}

function make(ctx: ToolContext, layer: Layer, kind: MeasurementKind, points: readonly number[], view: ViewReference): Measurement {
  return createMeasurement({
    kind,
    frameOfReferenceUid: layer.frameOfReferenceUid,
    points,
    viewReference: isPlanarKind(kind) ? view : null,
    editedOn: view,
    label: nextMeasurementLabel(kind, ctx.measurements()),
  });
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** 方框：兩個平面內的角 ＋ 沿平面法線的深度 → 軸對齊 min／max。 */
export function boxFromCorners(a: Vec3, b: Vec3, view: ViewReference, depthMm: number): number[] {
  const n = normalize3(view.viewPlaneNormal);
  const half = depthMm / 2;
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  for (const c of [a, b]) {
    for (const s of [-half, half]) {
      xs.push(c[0] + n[0] * s);
      ys.push(c[1] + n[1] * s);
      zs.push(c[2] + n[2] * s);
    }
  }
  return [Math.min(...xs), Math.min(...ys), Math.min(...zs), Math.max(...xs), Math.max(...ys), Math.max(...zs)];
}

/** 矩形在平面內的兩邊長（沿 right／up）。 */
export function inPlaneExtent(a: Vec3, b: Vec3, view: ViewReference): { w: number; h: number } {
  const right = normalize3(cross3(view.viewUp, view.viewPlaneNormal));
  const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const w = Math.abs(d[0] * right[0] + d[1] * right[1] + d[2] * right[2]);
  const h = Math.abs(d[0] * view.viewUp[0] + d[1] * view.viewUp[1] + d[2] * view.viewUp[2]);
  return { w, h };
}

function pointTool(ctx: ToolContext, layer: Layer): ToolInstance {
  let id: string | null = null;
  return {
    onPointerDown(x, y) {
      const view = ownView(ctx, layer);
      const m = make(ctx, layer, 'point', ownPoint(ctx, layer, x, y), view);
      id = m.measurementId;
      ctx.addMeasurement(m, { commit: false });
    },
    onPointerMove(x, y) {
      if (id !== null) ctx.updateMeasurement(id, { points: ownPoint(ctx, layer, x, y) }, { commit: false });
    },
    onPointerUp() {
      if (id !== null) ctx.commitMeasurement(id, null);
      id = null;
    },
    deactivate() {
      if (id !== null) ctx.commitMeasurement(id, null);
      id = null;
    },
  };
}

function distanceTool(ctx: ToolContext, layer: Layer): ToolInstance {
  let id: string | null = null;
  let start: Vec3 | null = null;
  return {
    onPointerDown(x, y) {
      start = ownPoint(ctx, layer, x, y);
      const m = make(ctx, layer, 'distance', [...start, ...start], ownView(ctx, layer));
      id = m.measurementId;
      ctx.addMeasurement(m, { commit: false });
    },
    onPointerMove(x, y) {
      if (id === null || start === null) return;
      ctx.updateMeasurement(id, { points: [...start, ...ownPoint(ctx, layer, x, y)] }, { commit: false });
    },
    onPointerUp(x, y) {
      if (id === null || start === null) return;
      const end = ownPoint(ctx, layer, x, y);
      if (dist(start, end) < CLICK_TOLERANCE_MM) ctx.removeMeasurement(id, { commit: false }); // 只是點了一下
      else {
        ctx.updateMeasurement(id, { points: [...start, ...end] }, { commit: false });
        ctx.commitMeasurement(id, null);
      }
      id = null;
      start = null;
    },
    deactivate() {
      if (id !== null) ctx.removeMeasurement(id, { commit: false });
      id = null;
    },
  };
}

function areaTool(ctx: ToolContext, layer: Layer): ToolInstance {
  let id: string | null = null;
  let plane: ViewReference | null = null;
  let downAt: { x: number; y: number } | null = null;

  const current = (): Measurement | undefined => (id === null ? undefined : ctx.measurements().find((m) => m.measurementId === id));
  const finish = (): void => {
    ctx.setLassoPreview(null);
    if (id !== null) ctx.highlightVertex(id, null);
    const m = current();
    if (id === null || m === undefined) return;
    if (m.points.length >= 9) ctx.commitMeasurement(id, null);
    else ctx.removeMeasurement(id, { commit: false }); // 不到三點：不算量測
    id = null;
    plane = null;
  };
  const cancel = (): void => {
    ctx.setLassoPreview(null);
    if (id !== null) {
      ctx.highlightVertex(id, null);
      ctx.removeMeasurement(id, { commit: false });
    }
    id = null;
    plane = null;
  };

  return {
    onPointerDown(x, y) {
      downAt = { x, y };
    },
    onPointerUp(x, y) {
      // 拖著走不是點頂點
      if (downAt !== null && Math.hypot(x - downAt.x, y - downAt.y) > CLOSE_POLYGON_PX) {
        downAt = null;
        return;
      }
      downAt = null;
      if (id === null) {
        plane = ownView(ctx, layer);
        const m = make(ctx, layer, 'area', ownPoint(ctx, layer, x, y), plane);
        id = m.measurementId;
        ctx.addMeasurement(m, { commit: false });
        return;
      }
      const m = current();
      if (m === undefined || plane === null) return;
      // 點回第一個頂點、或再點一次最後的頂點（＝雙擊）→ 收口（第二種收口方式，只靠點回第一點太難用）
      const { sx, sy } = ctx.cssToBackingScale();
      const nearVertex = (index: number): boolean => {
        const v = ctx.worldToCanvas(fromOwnToPrimary(ctx, layer, pointAt(m.points, index)));
        return Math.hypot(v.x / sx - x, v.y / sy - y) <= CLOSE_POLYGON_PX;
      };
      const lastIndex = m.points.length / 3 - 1;
      if (m.points.length >= 9 && (nearVertex(0) || nearVertex(lastIndex))) {
        finish();
        return;
      }
      if (nearVertex(lastIndex)) return; // 不到三點時重複點同一處：不疊一個重複頂點
      const p = projectToPlane(ownPoint(ctx, layer, x, y), plane);
      ctx.updateMeasurement(id, { points: [...m.points, ...p] }, { commit: false });
    },
    onKeyDown(key) {
      if (key === 'Enter') finish();
      else if (key === 'Escape') cancel();
      else return false;
      return true;
    },
    // 橡皮筋：最後頂點 → 游標（→ 第一頂點，讓人看到收口後的形狀）。點一個點的時候就要有回饋
    // 游標靠近起點（三點起）→ 橡皮筋吸附到起點、起點放大成環：「點這裡就會閉合」
    onHover(position) {
      const m = current();
      if (position === null || m === undefined || id === null) {
        ctx.setLassoPreview(null);
        if (id !== null) ctx.highlightVertex(id, null);
        return;
      }
      const first = fromOwnToPrimary(ctx, layer, pointAt(m.points, 0));
      const last = fromOwnToPrimary(ctx, layer, pointAt(m.points, m.points.length / 3 - 1));
      const { sx, sy } = ctx.cssToBackingScale();
      const firstPx = ctx.worldToCanvas(first);
      const snap = m.points.length >= 9 && Math.hypot(firstPx.x / sx - position.x, firstPx.y / sy - position.y) <= CLOSE_POLYGON_PX;
      if (snap) {
        ctx.setLassoPreview([last, first]);
        ctx.highlightVertex(id, 0);
        return;
      }
      ctx.highlightVertex(id, null);
      const cursor = ctx.canvasToWorld(position.x, position.y);
      const preview: Vec3[] = [last, cursor];
      if (m.points.length >= 6) preview.push(first);
      ctx.setLassoPreview(preview);
    },
    // host 轉過來的結束動作：雙擊、點一下草稿的第一或最後一個頂點 ＝ finish
    onAction(action) {
      if (action === 'finish') finish();
      else cancel();
    },
    deactivate() {
      finish();
    },
  };
}

/**
 * 點數固定的量測（角度 3 點、Cobb 4 點）—— 逐點點擊，點滿自動完成；橡皮筋從最後一點拉到游標
 * （Cobb 在第一條線畫完、第二條線還沒起頭時不拉）。雙擊不算結束（點數不夠不能收），Esc 取消。
 */
function fixedClickTool(ctx: ToolContext, layer: Layer, kind: 'angle' | 'cobb'): ToolInstance {
  const need = requiredPoints(kind);
  let id: string | null = null;
  let plane: ViewReference | null = null;
  let downAt: { x: number; y: number } | null = null;
  const current = (): Measurement | undefined => (id === null ? undefined : ctx.measurements().find((m) => m.measurementId === id));
  const reset = (): void => {
    ctx.setLassoPreview(null);
    id = null;
    plane = null;
  };
  const cancel = (): void => {
    if (id !== null) ctx.removeMeasurement(id, { commit: false });
    reset();
  };
  const place = (x: number, y: number): Vec3 => {
    const p = ownPoint(ctx, layer, x, y);
    return kind === 'cobb' && plane !== null ? projectToPlane(p, plane) : p;
  };
  return {
    onPointerDown(x, y) {
      downAt = { x, y };
    },
    onPointerUp(x, y) {
      if (downAt !== null && Math.hypot(x - downAt.x, y - downAt.y) > CLOSE_POLYGON_PX) {
        downAt = null;
        return;
      }
      downAt = null;
      if (id === null) {
        plane = ownView(ctx, layer);
        const m = make(ctx, layer, kind, place(x, y), plane);
        id = m.measurementId;
        ctx.addMeasurement(m, { commit: false });
        return;
      }
      const m = current();
      if (m === undefined) return;
      const last = pointAt(m.points, m.points.length / 3 - 1);
      const p = place(x, y);
      if (dist(last, p) < CLICK_TOLERANCE_MM) return; // 同一處連點（含雙擊的第二下）不疊點
      const points = [...m.points, ...p];
      ctx.updateMeasurement(id, { points }, { commit: false });
      if (points.length / 3 >= need) {
        ctx.commitMeasurement(id, null);
        reset();
      }
    },
    onHover(position) {
      const m = current();
      if (position === null || m === undefined) {
        ctx.setLassoPreview(null);
        return;
      }
      const n = m.points.length / 3;
      if (kind === 'cobb' && n === 2) {
        ctx.setLassoPreview(null);
        return;
      }
      const last = fromOwnToPrimary(ctx, layer, pointAt(m.points, n - 1));
      ctx.setLassoPreview([last, ctx.canvasToWorld(position.x, position.y)]);
    },
    onKeyDown(key) {
      if (key !== 'Escape') return false;
      cancel();
      return true;
    },
    onAction(action) {
      if (action !== 'finish') cancel(); // 點數不夠不能「結束」：雙擊、點草稿頂點都不算
    },
    deactivate() {
      cancel();
    },
  };
}

/** 開放折線（曲線長度）—— 與面積同一套逐點點擊，但不收口、不吸附起點，兩點起就能結束。 */
function curveTool(ctx: ToolContext, layer: Layer): ToolInstance {
  let id: string | null = null;
  let downAt: { x: number; y: number } | null = null;
  const current = (): Measurement | undefined => (id === null ? undefined : ctx.measurements().find((m) => m.measurementId === id));
  const finish = (): void => {
    ctx.setLassoPreview(null);
    const m = current();
    if (id !== null && m !== undefined) {
      if (m.points.length >= 6) ctx.commitMeasurement(id, null);
      else ctx.removeMeasurement(id, { commit: false }); // 只有一點：不算量測
    }
    id = null;
  };
  const cancel = (): void => {
    ctx.setLassoPreview(null);
    if (id !== null) ctx.removeMeasurement(id, { commit: false });
    id = null;
  };
  return {
    onPointerDown(x, y) {
      downAt = { x, y };
    },
    onPointerUp(x, y) {
      if (downAt !== null && Math.hypot(x - downAt.x, y - downAt.y) > CLOSE_POLYGON_PX) {
        downAt = null;
        return;
      }
      downAt = null;
      if (id === null) {
        const m = make(ctx, layer, 'curve', ownPoint(ctx, layer, x, y), ownView(ctx, layer));
        id = m.measurementId;
        ctx.addMeasurement(m, { commit: false });
        return;
      }
      const m = current();
      if (m === undefined) return;
      const { sx, sy } = ctx.cssToBackingScale();
      const lastIndex = m.points.length / 3 - 1;
      const v = ctx.worldToCanvas(fromOwnToPrimary(ctx, layer, pointAt(m.points, lastIndex)));
      if (Math.hypot(v.x / sx - x, v.y / sy - y) <= CLOSE_POLYGON_PX) {
        if (m.points.length >= 6) finish(); // 再點一次最後的頂點 ＝ 結束
        return;
      }
      ctx.updateMeasurement(id, { points: [...m.points, ...ownPoint(ctx, layer, x, y)] }, { commit: false });
    },
    onHover(position) {
      const m = current();
      if (position === null || m === undefined) {
        ctx.setLassoPreview(null);
        return;
      }
      const last = fromOwnToPrimary(ctx, layer, pointAt(m.points, m.points.length / 3 - 1));
      ctx.setLassoPreview([last, ctx.canvasToWorld(position.x, position.y)]);
    },
    onKeyDown(key) {
      if (key === 'Enter') finish();
      else if (key === 'Escape') cancel();
      else return false;
      return true;
    },
    onAction(action) {
      if (action === 'finish') finish();
      else cancel();
    },
    deactivate() {
      finish();
    },
  };
}

function fromOwnToPrimary(ctx: ToolContext, layer: Layer, own: Vec3): Vec3 {
  const fg = ctx.frameGroup(layer.frameOfReferenceUid);
  // 反向：own → primary。fromPrimaryWorld 的逆就是 toPrimaryWorld；為了不多 import 這裡用 FrameGroup 的矩陣
  const m = fg.transformToPrimary;
  return [
    m[0]! * own[0] + m[4]! * own[1] + m[8]! * own[2] + m[12]!,
    m[1]! * own[0] + m[5]! * own[1] + m[9]! * own[2] + m[13]!,
    m[2]! * own[0] + m[6]! * own[1] + m[10]! * own[2] + m[14]!,
  ];
}

function roiTool(ctx: ToolContext, layer: Layer): ToolInstance {
  let id: string | null = null;
  let start: Vec3 | null = null;
  let view: ViewReference | null = null;
  const box = (a: Vec3, b: Vec3, v: ViewReference): number[] => {
    const { w, h } = inPlaneExtent(a, b, v);
    return boxFromCorners(a, b, v, Math.max(1, Math.min(w, h)));
  };
  return {
    onPointerDown(x, y) {
      view = ownView(ctx, layer);
      start = ownPoint(ctx, layer, x, y);
      const m = make(ctx, layer, 'roi3d', box(start, start, view), view);
      id = m.measurementId;
      ctx.addMeasurement(m, { commit: false });
    },
    onPointerMove(x, y) {
      if (id === null || start === null || view === null) return;
      ctx.updateMeasurement(id, { points: box(start, ownPoint(ctx, layer, x, y), view) }, { commit: false });
    },
    onPointerUp(x, y) {
      if (id === null || start === null || view === null) return;
      const end = ownPoint(ctx, layer, x, y);
      const { w, h } = inPlaneExtent(start, end, view);
      if (w < CLICK_TOLERANCE_MM || h < CLICK_TOLERANCE_MM) ctx.removeMeasurement(id, { commit: false });
      else {
        ctx.updateMeasurement(id, { points: box(start, end, view) }, { commit: false });
        ctx.commitMeasurement(id, null);
      }
      id = null;
      start = null;
    },
    deactivate() {
      if (id !== null) ctx.removeMeasurement(id, { commit: false });
      id = null;
    },
  };
}

/** 給 `builtins.ts` 用：量測工具的 `activate`。 */
export function measureTool(toolId: MeasureToolId): ToolPlugin['activate'] {
  return (ctx) => {
    const layer = requireImage(toolId, ctx);
    switch (KIND_OF[toolId]) {
      case 'point':
        return pointTool(ctx, layer);
      case 'distance':
        return distanceTool(ctx, layer);
      case 'area':
        return areaTool(ctx, layer);
      case 'roi3d':
        return roiTool(ctx, layer);
      case 'angle':
      case 'cobb':
        return fixedClickTool(ctx, layer, KIND_OF[toolId]);
      case 'curve':
        return curveTool(ctx, layer);
      case 'landmark':
        // 地標對不是畫出來的：對位面板用十字線記錄
        throw new ContractViolation('TL7', t('地標對由對位面板記錄，沒有繪製工具'), { toolId });
    }
  };
}
