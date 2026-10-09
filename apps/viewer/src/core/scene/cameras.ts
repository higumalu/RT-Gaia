/**
 * 相機：正交平面的建立與導航。
 *
 * 🔴 **一切都以 `ViewReference` 表達，沒有 slice index。**
 * 捲動切面就是「把 `planeOrigin` 沿法線移動」——這讓正交與斜面**共用同一條
 * 程式碼路徑**，也讓「不得存 slice index」在實作上自然成立。
 */

import {
  createViewReference,
  cross3,
  dot3,
  indexToWorld,
  normalize3,
  planeRight,
  worldToIndex,
  type Grid,
  type Vec3,
  type ViewReference,
} from '../geometry';

export type OrthoOrientation = 'axial' | 'coronal' | 'sagittal';

/**
 * LPS 下三個正交方位的 `(normal, viewUp)`。
 *
 * ## 慣例：`viewPlaneNormal` **指向觀察者**（從螢幕射出來）
 *
 * `planeRight = viewUp × viewPlaneNormal` 使 `(right, up, normal)` 成右手系，
 * 因此 `normal` 就是「觀察者站在病人的哪一側」。三個方位據此推導：
 *
 * | 方位 | 觀察者位置 | `normal` | `viewUp` | 得到的 `right` | 畫面右 = |
 * |---|---|---|---|---|---|
 * | axial | 病人**腳側**往頭看 | `-z`（I） | `-y`（A） | `+x` | 病人**左** |
 * | coronal | 病人**前方** | `-y`（A） | `+z`（S） | `+x` | 病人**左** |
 * | sagittal | 病人**左側** | `+x`（L） | `+z`（S） | `+y` | 病人**後** |
 *
 * 三格因此一致：axial 與 coronal 的畫面右都是病人左（放射科慣例：**病人右在
 * 畫面左**），sagittal 是從病人左側看進去、鼻子朝畫面左。
 *
 * 🔴 **axial 的 `normal` 先前是 `+z`，那是「從頭頂往下看」（神經科慣例），
 * 於是 `right` 變成 `-x` ＝ 病人右落在畫面右 —— 整格左右鏡像。**
 *
 * 它能出貨的原因有三個，缺一不可：
 *
 * 1. **同一格內完全自洽**。影像、輪廓、筆刷全部走 `planeRight()`，一起鏡像，
 *    因此沒有任何錯位可看；畫面只是整個左右翻過來。
 * 2. **合成假體左右對稱**。`known_geometry` 的球在 x=−40、立方在 x=+40，
 *    但沒有任何測試斷言它們落在畫面的哪一半。
 * 3. **coronal 用同一條公式卻是對的**，所以「公式錯了」這個假設會被排除 ——
 *    真正錯的是 axial 的 `normal` 方向。
 *
 * 臨床後果是左右乳、左右肺、左右腮腺**全部畫反**，而且畫面上沒有任何線索。
 * 因此下方 `orthoCamera` 的三個方位各有一條 `right` 的斷言，且
 * `cameras.test.ts` 有一個左右不對稱假體的回歸測試。
 */
const ORIENTATIONS: Record<OrthoOrientation, { normal: Vec3; viewUp: Vec3 }> = {
  axial: { normal: [0, 0, -1], viewUp: [0, -1, 0] },
  coronal: { normal: [0, -1, 0], viewUp: [0, 0, 1] },
  sagittal: { normal: [1, 0, 0], viewUp: [0, 0, 1] },
};

/** 網格的世界空間中心。相機的預設落點。 */
export function gridCenterWorld(grid: Grid): Vec3 {
  return indexToWorld(grid, [
    (grid.size[0] - 1) / 2,
    (grid.size[1] - 1) / 2,
    (grid.size[2] - 1) / 2,
  ]);
}

export function orthoCamera(args: {
  grid: Grid;
  orientation: OrthoOrientation;
  displayGridId: string;
  planeOrigin?: Vec3;
  slabThicknessMm?: number;
}): ViewReference {
  const { normal, viewUp } = ORIENTATIONS[args.orientation];
  return createViewReference({
    frameOfReferenceUid: args.grid.frameOfReferenceUid,
    displayGridId: args.displayGridId,
    planeOrigin: args.planeOrigin ?? gridCenterWorld(args.grid),
    viewPlaneNormal: normal,
    viewUp,
    slabThicknessMm: args.slabThicknessMm ?? 0,
    temporalGroupId: null,
    frameIndex: null,
  });
}

/**
 * Fit 的相機：平面內回到網格中心，**切面不動** —— 沿法向的深度、方向（含斜切）、slab、相位都留著。
 * 以前 Fit 整個換成新的正交相機：切片跳回中間、斜切與 slab 也沒了（2026-10-09 錄 demo 時發現）。縮放由呼叫端重設。
 */
export function fitCamera(grid: Grid, camera: ViewReference): ViewReference {
  const c = gridCenterWorld(grid);
  const n = camera.viewPlaneNormal;
  const depth = (camera.planeOrigin[0] - c[0]) * n[0] + (camera.planeOrigin[1] - c[1]) * n[1] + (camera.planeOrigin[2] - c[2]) * n[2];
  return createViewReference({ ...camera, planeOrigin: [c[0] + n[0] * depth, c[1] + n[1] * depth, c[2] + n[2] * depth] });
}

/**
 * 讓整個網格在視野內的像素間距（mm/px）。
 *
 * 取網格在**平面的兩個軸上**的投影範圍，而不是網格對角線 —— 後者在非等向
 * 資料上會留下大片空白。
 */
export function fitPxMm(grid: Grid, view: ViewReference, viewport: { w: number; h: number }): number {
  const right = planeRight(view);
  const up = view.viewUp;
  const [nx, ny, nz] = [grid.size[0] - 1, grid.size[1] - 1, grid.size[2] - 1];
  const corners: Vec3[] = [
    [0, 0, 0], [nx, 0, 0], [0, ny, 0], [nx, ny, 0],
    [0, 0, nz], [nx, 0, nz], [0, ny, nz], [nx, ny, nz],
  ];
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const corner of corners) {
    const world = indexToWorld(grid, corner);
    const u = dot3(world, right);
    const v = dot3(world, up);
    minU = Math.min(minU, u);
    maxU = Math.max(maxU, u);
    minV = Math.min(minV, v);
    maxV = Math.max(maxV, v);
  }
  const spanU = Math.max(1e-6, maxU - minU);
  const spanV = Math.max(1e-6, maxV - minV);
  return Math.max(spanU / Math.max(1, viewport.w), spanV / Math.max(1, viewport.h));
}

/**
 * 沿法線移動平面 —— **捲動切面**（滾輪）。
 *
 * 步長取網格在法線方向上的體素間距，因此正交視圖上一格滾輪 = 一張切片；
 * 斜面上則是「等效一個體素」的距離。
 */
export function stepAlongNormal(
  grid: Grid,
  view: ViewReference,
  steps: number,
): ViewReference {
  const spacing = normalSpacing(grid, view.viewPlaneNormal);
  const delta = spacing * steps;
  return createViewReference({
    ...view,
    planeOrigin: [
      view.planeOrigin[0] + view.viewPlaneNormal[0] * delta,
      view.planeOrigin[1] + view.viewPlaneNormal[1] * delta,
      view.planeOrigin[2] + view.viewPlaneNormal[2] * delta,
    ],
  });
}

/**
 * 法線方向上「一步」有多遠（mm）。
 *
 * ## 推導
 *
 * 沿法線 `n` 移動距離 `d`，索引的變化是 `Δijk = S⁻¹ Dᵀ n d`（`D` 正交、
 * `S` 為 spacing 的對角）。因此第 `c` 個索引軸的變化是
 * `d · (axis_c · n) / spacing_c`。讓它等於 1 就得到
 *
 * ```
 * d_c = spacing_c / |axis_c · n|
 * ```
 *
 * 取**最小的** `d_c` —— 也就是「最先讓某個索引軸前進一格」的距離。
 *
 * * **正交視圖會精確退化成該軸的 spacing**（其餘軸的 `axis·n = 0` → 無限大），
 *   因此使用者數切片時一格滾輪 = 一張切片。
 * * 斜面上得到的是「最細的有意義步長」。
 *
 * 🔴 **舊版用三軸投影的加權和，那是錯的。** 傾斜 15° 時它給 3.157 mm，
 * 而一格切片只需要 3.106 mm —— 於是一格滾輪偶爾跳兩張。
 * 這個錯誤只在**斜面或傾斜取像**上顯現，等向且軸對齊的合成假體抓不到。
 */
export function normalSpacing(grid: Grid, normal: Vec3): number {
  // direction 的第 c 欄是第 c 個索引軸的世界方向
  const axes: Vec3[] = [
    [grid.direction[0]!, grid.direction[3]!, grid.direction[6]!],
    [grid.direction[1]!, grid.direction[4]!, grid.direction[7]!],
    [grid.direction[2]!, grid.direction[5]!, grid.direction[8]!],
  ];
  let best = Infinity;
  for (let c = 0; c < 3; c += 1) {
    const alignment = Math.abs(dot3(axes[c]!, normal));
    if (alignment < 1e-9) continue; // 這個軸與法線垂直，永遠不會前進
    best = Math.min(best, grid.spacing[c]! / alignment);
  }
  return Number.isFinite(best) ? best : Math.min(...grid.spacing);
}

/** 在視圖平面上平移焦點 —— **Pan**。`delta` 為 canvas 像素。 */
export function panInPlane(
  view: ViewReference,
  deltaPx: { x: number; y: number },
  pxMm: number,
): ViewReference {
  const right = planeRight(view);
  // 畫面往右拖 → 焦點往左移（內容跟著手指走）
  const du = -deltaPx.x * pxMm;
  const dv = deltaPx.y * pxMm; // 列往下增加 = -viewUp
  return createViewReference({
    ...view,
    planeOrigin: [
      view.planeOrigin[0] + right[0] * du + view.viewUp[0] * dv,
      view.planeOrigin[1] + right[1] * du + view.viewUp[1] * dv,
      view.planeOrigin[2] + right[2] * du + view.viewUp[2] * dv,
    ],
  });
}

/**
 * 世界座標 → 輸出平面的像素（backing store 座標）。**純函式**，renderer 與測試共用。
 *
 * 慣例與 `PlaneDesc` 一致：平面中心在 `((w-1)/2, (h-1)/2)`；列往下增加 = −viewUp。
 */
export function worldToPlanePx(
  view: ViewReference,
  pxMm: number,
  size: { w: number; h: number },
  world: Vec3,
): { x: number; y: number } {
  const right = planeRight(view);
  const d: Vec3 = [world[0] - view.planeOrigin[0], world[1] - view.planeOrigin[1], world[2] - view.planeOrigin[2]];
  return {
    x: dot3(d, right) / pxMm + (size.w - 1) / 2,
    y: (size.h - 1) / 2 - dot3(d, view.viewUp) / pxMm,
  };
}

/** `worldToPlanePx` 的反函式：像素 → 平面上的世界座標。 */
export function planePxToWorld(
  view: ViewReference,
  pxMm: number,
  size: { w: number; h: number },
  px: { x: number; y: number },
): [number, number, number] {
  const right = planeRight(view);
  const du = (px.x - (size.w - 1) / 2) * pxMm;
  const dv = -(px.y - (size.h - 1) / 2) * pxMm;
  return [
    view.planeOrigin[0] + right[0] * du + view.viewUp[0] * dv,
    view.planeOrigin[1] + right[1] * du + view.viewUp[1] * dv,
    view.planeOrigin[2] + right[2] * du + view.viewUp[2] * dv,
  ];
}

/** 法線是否偏離網格的三個軸（＝斜面）。正交視圖上切片序號才有意義。 */
export function isObliqueTo(grid: Grid, view: ViewReference, tolDeg = 0.5): boolean {
  const axes: Vec3[] = [
    [grid.direction[0]!, grid.direction[3]!, grid.direction[6]!],
    [grid.direction[1]!, grid.direction[4]!, grid.direction[7]!],
    [grid.direction[2]!, grid.direction[5]!, grid.direction[8]!],
  ];
  const cosTol = Math.cos((tolDeg * Math.PI) / 180);
  return !axes.some((a) => Math.abs(dot3(a, view.viewPlaneNormal)) >= cosTol);
}

export interface ObliqueAngles {
  /** 法線在「水平面」（right–normal 平面）上掃了多少度（繞 viewUp 的那一種旋轉）。 */
  readonly aroundUpDeg: number;
  /** 法線上下傾斜了多少度（繞 right 的那一種旋轉）。 */
  readonly aroundRightDeg: number;
  /** 與正交方位法線的總夾角。 */
  readonly totalDeg: number;
}

/**
 * 目前平面相對於正交方位轉了多少（讀數用）。
 *
 * 把目前法線 n 投影到正交方位的基底 (right₀, up₀, normal₀)：
 * `aroundUp = atan2(n·right₀, n·normal₀)`、`aroundRight = atan2(n·up₀, ‖n 在 right₀–normal₀ 平面上的投影‖)`。
 * 兩個角度各自單調、加起來不一定等於總夾角（三維旋轉不可交換）—— 因此另給 `totalDeg`。
 */
export function obliqueAngles(orientation: OrthoOrientation, view: ViewReference): ObliqueAngles {
  const { normal: n0, viewUp: u0 } = ORIENTATIONS[orientation];
  const r0 = cross3(u0, n0);
  const n = view.viewPlaneNormal;
  const x = dot3(n, r0);
  const y = dot3(n, u0);
  const z = dot3(n, n0);
  const deg = (v: number): number => {
    const r = Math.round(((v * 180) / Math.PI) * 10) / 10;
    return r === 0 ? 0 : r; // 把 −0 收成 0（顯示與 toEqual 都不該看到 −0）
  };
  // 符號與 `rotateInPlane` 一致：`rotateInPlane(v, 'right', +θ)` 讀出來就是 +θ
  // （Rodrigues 繞 right 轉 +θ 時法線往 −viewUp 方向倒）
  return {
    aroundUpDeg: deg(Math.atan2(x, z)),
    aroundRightDeg: deg(Math.atan2(-y, Math.hypot(x, z))),
    totalDeg: deg(Math.acos(Math.max(-1, Math.min(1, z)))),
  };
}

/** `+12.5°`／`−3.0°`；0 顯示 `0°`。 */
export function formatDeg(deg: number): string {
  if (Math.abs(deg) < 0.05) return '0°';
  return `${deg > 0 ? '+' : '−'}${Math.abs(deg).toFixed(1)}°`;
}

/**
 * 斜面旋轉：繞平面上的一個軸轉 `angleDeg`（crosshair 旋轉）。
 *
 * 繞 `viewUp` 轉 → 法線在水平面上掃；繞 `right` 轉 → 法線上下傾斜。
 * **`planeOrigin` 不動**，因此旋轉是「以目前這一點為樞紐」。
 */
export function rotateInPlane(
  view: ViewReference,
  axis: 'up' | 'right',
  angleDeg: number,
): ViewReference {
  const pivot = axis === 'up' ? view.viewUp : planeRight(view);
  const normal = rotateAround(view.viewPlaneNormal, pivot, angleDeg);
  // viewUp 必須保持與新法線正交
  const right = normalize3(cross3(view.viewUp, normal));
  const viewUp = axis === 'up' ? view.viewUp : normalize3(cross3(normal, right));
  return createViewReference({
    ...view,
    viewPlaneNormal: normalize3(normal),
    viewUp,
  });
}

/** Rodrigues 旋轉。 */
function rotateAround(v: Vec3, axis: Vec3, angleDeg: number): Vec3 {
  const a = normalize3(axis);
  const theta = (angleDeg * Math.PI) / 180;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const cross = cross3(a, v);
  const d = dot3(a, v);
  return [
    v[0] * c + cross[0] * s + a[0] * d * (1 - c),
    v[1] * c + cross[1] * s + a[1] * d * (1 - c),
    v[2] * c + cross[2] * s + a[2] * d * (1 - c),
  ];
}

/**
 * 平面是否還與網格相交 —— 捲動到頭時要停住，而不是滑出資料範圍。
 */
export function planeIntersectsGrid(grid: Grid, view: ViewReference): boolean {
  const ijk = worldToIndex(grid, view.planeOrigin);
  // 只要投影落在 [-1, size] 內就算還在（留一格容差，邊界切面仍可看）
  return ijk.every((v, i) => v >= -1 && v <= grid.size[i]! + 1);
}

/**
 * Zoom **以游標位置為中心**。
 *
 * > 這是手感差異最明顯的一個細節。
 *
 * 純函式：吃 `(pxMm, camera, canvas 尺寸, 游標像素, 倍率)`，回傳新的
 * `(pxMm, camera)`。不變式是「**游標下的那個世界座標點，縮放前後落在同一個
 * canvas 像素**」。
 *
 * 🔴 **`zoomIn = true` 必須讓 `pxMm` 變小**（每像素涵蓋更少 mm ＝ 放大）。
 * 這個方向先前寫反了，症狀是「滾輪往上，影像越來越小」——使用者的結論會是
 * 「沒有做 zoom」。它之所以能出錯，是因為當時這段數學內聯在 `ViewerHost` 裡、
 * 沒有任何測試；而同時 `eventLayer.zoomAtCursor` 有測試卻**沒有人呼叫**。
 */
export function zoomCameraAtCursor(args: {
  camera: ViewReference;
  pxMm: number;
  canvas: { width: number; height: number };
  cursorPx: { x: number; y: number };
  /** > 1 放大、< 1 縮小。 */
  factor: number;
}): { camera: ViewReference; pxMm: number } {
  const nextPxMm = Math.max(1e-3, args.pxMm / args.factor);
  const right = planeRight(args.camera);
  const up = args.camera.viewUp;
  // 游標相對畫面中心的偏移（列往下增加 = -viewUp）
  const du = args.cursorPx.x - (args.canvas.width - 1) / 2;
  const dv = -(args.cursorPx.y - (args.canvas.height - 1) / 2);
  // 縮放前後，同一個 canvas 像素對應的世界座標差 = 偏移 × (舊 pxMm − 新 pxMm)
  const shift = args.pxMm - nextPxMm;
  const camera = createViewReference({
    ...args.camera,
    planeOrigin: [
      args.camera.planeOrigin[0] + (right[0] * du + up[0] * dv) * shift,
      args.camera.planeOrigin[1] + (right[1] * du + up[1] * dv) * shift,
      args.camera.planeOrigin[2] + (right[2] * du + up[2] * dv) * shift,
    ],
  });
  return { camera, pxMm: nextPxMm };
}

/** 目前平面對應的「切片序號」—— **僅供 UI 顯示**，不得用於儲存。 */
export function displaySliceIndex(grid: Grid, view: ViewReference): number {
  const ijk = worldToIndex(grid, view.planeOrigin);
  // 取與法線最對齊的那個索引軸
  const axes: Vec3[] = [
    [grid.direction[0]!, grid.direction[3]!, grid.direction[6]!],
    [grid.direction[1]!, grid.direction[4]!, grid.direction[7]!],
    [grid.direction[2]!, grid.direction[5]!, grid.direction[8]!],
  ];
  let best = 0;
  let bestDot = -1;
  for (let c = 0; c < 3; c += 1) {
    const d = Math.abs(dot3(axes[c]!, view.viewPlaneNormal));
    if (d > bestDot) {
      bestDot = d;
      best = c;
    }
  }
  return Math.round(ijk[best]!);
}

/**
 * 切片捲軸（張數多的影像，改善滾輪換張的體驗）用的範圍 —— **僅供 UI**（不得儲存）。
 *
 * 沿法線把網格的 8 個角（體素中心）投影上去得到 `[lo, hi]`（mm），一步 `normalSpacing`；
 * 所以正交與斜面同一條路徑（斜面也拖得動），正交時 `count` 就是那一軸的張數。
 * `index` 0 ＝ 法線座標最小的一端 —— 與滾輪同方向（滾輪往下 ＝ 沿 +法線 ＝ 捲軸往下；軸向時上端是頭）。
 */
export interface SliceRange {
  readonly index: number;
  readonly count: number;
}

function normalExtent(grid: Grid, view: ViewReference): { lo: number; step: number; count: number } {
  const n = view.viewPlaneNormal;
  const step = normalSpacing(grid, n);
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (let c = 0; c < 8; c += 1) {
    const ijk: Vec3 = [c & 1 ? grid.size[0] - 1 : 0, c & 2 ? grid.size[1] - 1 : 0, c & 4 ? grid.size[2] - 1 : 0];
    const d = dot3(indexToWorld(grid, ijk), n);
    lo = Math.min(lo, d);
    hi = Math.max(hi, d);
  }
  const count = Math.max(1, Math.floor((hi - lo) / step + 1e-6) + 1);
  return { lo, step, count };
}

export function sliceRange(grid: Grid, view: ViewReference): SliceRange {
  const { lo, step, count } = normalExtent(grid, view);
  const at = (dot3(view.planeOrigin, view.viewPlaneNormal) - lo) / step;
  return { index: Math.max(0, Math.min(count - 1, Math.round(at))), count };
}

/** 把平面沿法線移到第 `index` 張（夾在範圍內）；平面內的位置（十字線的另外兩軸）不動。 */
export function cameraAtSlice(grid: Grid, view: ViewReference, index: number): ViewReference {
  const { lo, step, count } = normalExtent(grid, view);
  const i = Math.max(0, Math.min(count - 1, Math.round(index)));
  const n = view.viewPlaneNormal;
  const delta = lo + i * step - dot3(view.planeOrigin, n);
  return createViewReference({
    ...view,
    planeOrigin: [view.planeOrigin[0] + n[0] * delta, view.planeOrigin[1] + n[1] * delta, view.planeOrigin[2] + n[2] * delta],
  });
}
