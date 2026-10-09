/**
 * 相機導航。
 *
 * 🔴 **這個檔案先前不存在，那正是 zoom 方向寫反能夠出貨的原因。**
 *
 * 當時的狀況：`eventLayer.zoomAtCursor` 有測試但**沒有人呼叫**，而真正在跑的是
 * `ViewerHost.handleCommand` 裡一段沒有測試的內聯數學。症狀是看起來
 * 像根本沒有 zoom in/out 的功能 —— 因為捲上去影像反而變小。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  createViewReference,
  cross3,
  dot3,
  indexToWorld,
  planeRight,
  type Grid,
  type Vec3,
  type ViewReference,
} from '../src/core/geometry';
import {
  displaySliceIndex,
  fitCamera,
  fitPxMm,
  gridCenterWorld,
  normalSpacing,
  orthoCamera,
  panInPlane,
  planeIntersectsGrid,
  rotateInPlane,
  stepAlongNormal,
  zoomCameraAtCursor,
} from '../src/core/scene/cameras';
import { fromWire } from '../src/core/transport/wire';

type Orient3 = Record<'axial' | 'coronal' | 'sagittal', number[]>;

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/geometry-vectors.json', import.meta.url)), 'utf8'),
) as {
  grid_cases: { name: string; grid: Record<string, unknown> }[];
  display_grid_cases: { source_grid: Record<string, unknown> };
  /** 左右方位向量。由 `scripts/emit-geometry-fixture.py` 產生。 */
  laterality: {
    grid: Record<string, unknown>;
    centroids_world_lps: Record<string, number[]>;
    expected_right: Orient3;
    expected_normal: Orient3;
    expected_view_up: Orient3;
  };
};

/** 非等向（1×1×3 mm）＋ 傾斜的真實網格，比等向立方體更會抓到錯。 */
const tiltedGrid: Grid = fromWire.grid(fixture.display_grid_cases.source_grid);
const CANVAS = { width: 512, height: 512 };

function axialAt(planeOrigin?: Vec3): ViewReference {
  return orthoCamera({
    grid: tiltedGrid,
    orientation: 'axial',
    displayGridId: 'dg_test',
    ...(planeOrigin ? { planeOrigin } : {}),
  });
}

/**
 * canvas 像素 → 世界座標。
 *
 * **與 `CpuViewportRenderer.canvasToWorld` 同一份數學**（列往下增加 = -viewUp）。
 * zoom 的不變式就是靠它表達。
 */
function canvasToWorld(
  view: ViewReference,
  pxMm: number,
  canvas: { width: number; height: number },
  px: { x: number; y: number },
): Vec3 {
  const right = planeRight(view);
  const up = view.viewUp;
  const du = (px.x - (canvas.width - 1) / 2) * pxMm;
  const dv = -(px.y - (canvas.height - 1) / 2) * pxMm;
  return [
    view.planeOrigin[0] + right[0] * du + up[0] * dv,
    view.planeOrigin[1] + right[1] * du + up[1] * dv,
    view.planeOrigin[2] + right[2] * du + up[2] * dv,
  ];
}

describe('Zoom', () => {
  it('🔴 放大（factor > 1）必須讓 pxMm 變小', () => {
    const view = axialAt();
    const result = zoomCameraAtCursor({
      camera: view,
      pxMm: 2,
      canvas: CANVAS,
      cursorPx: { x: 255.5, y: 255.5 },
      factor: 1.15,
    });
    expect(result.pxMm).toBeLessThan(2);
    expect(result.pxMm).toBeCloseTo(2 / 1.15, 9);
  });

  it('🔴 縮小（factor < 1）必須讓 pxMm 變大', () => {
    const result = zoomCameraAtCursor({
      camera: axialAt(),
      pxMm: 2,
      canvas: CANVAS,
      cursorPx: { x: 255.5, y: 255.5 },
      factor: 1 / 1.15,
    });
    expect(result.pxMm).toBeGreaterThan(2);
  });

  it('以畫面中心縮放時 planeOrigin 不動', () => {
    const view = axialAt();
    const result = zoomCameraAtCursor({
      camera: view,
      pxMm: 2,
      canvas: CANVAS,
      cursorPx: { x: (CANVAS.width - 1) / 2, y: (CANVAS.height - 1) / 2 },
      factor: 1.5,
    });
    for (let k = 0; k < 3; k += 1) {
      expect(result.camera.planeOrigin[k]!).toBeCloseTo(view.planeOrigin[k]!, 9);
    }
  });

  it('🔴 不變式：游標下的世界座標點，縮放前後落在同一個 canvas 像素', () => {
    const view = axialAt();
    const pxMm = 2;
    for (const cursor of [
      { x: 0, y: 0 },
      { x: 511, y: 0 },
      { x: 120, y: 400 },
      { x: 300, y: 137 },
    ]) {
      for (const factor of [1.15, 1 / 1.15, 3, 1 / 3]) {
        const before = canvasToWorld(view, pxMm, CANVAS, cursor);
        const result = zoomCameraAtCursor({ camera: view, pxMm, canvas: CANVAS, cursorPx: cursor, factor });
        const after = canvasToWorld(result.camera, result.pxMm, CANVAS, cursor);
        for (let k = 0; k < 3; k += 1) {
          expect(
            Math.abs(after[k]! - before[k]!),
            `cursor=${JSON.stringify(cursor)} factor=${factor}`,
          ).toBeLessThan(1e-9);
        }
      }
    }
  });

  it('對照：以畫面中心縮放時游標下的點會跑掉（為何必須以游標為中心）', () => {
    const view = axialAt();
    const cursor = { x: 100, y: 100 };
    const before = canvasToWorld(view, 2, CANVAS, cursor);
    // 只改 pxMm、不動 planeOrigin ＝ 以畫面中心縮放
    const naive = canvasToWorld(view, 2 / 1.5, CANVAS, cursor);
    expect(Math.hypot(naive[0] - before[0], naive[1] - before[1], naive[2] - before[2])).toBeGreaterThan(
      10,
    );
  });

  it('連續放大再縮小同樣倍率會回到原點', () => {
    const view = axialAt();
    const cursor = { x: 77, y: 401 };
    const inOnce = zoomCameraAtCursor({ camera: view, pxMm: 2, canvas: CANVAS, cursorPx: cursor, factor: 1.15 });
    const back = zoomCameraAtCursor({
      camera: inOnce.camera,
      pxMm: inOnce.pxMm,
      canvas: CANVAS,
      cursorPx: cursor,
      factor: 1 / 1.15,
    });
    expect(back.pxMm).toBeCloseTo(2, 9);
    for (let k = 0; k < 3; k += 1) {
      expect(back.camera.planeOrigin[k]!).toBeCloseTo(view.planeOrigin[k]!, 9);
    }
  });

  it('pxMm 有下限，不會縮到 0 或負數', () => {
    const result = zoomCameraAtCursor({
      camera: axialAt(),
      pxMm: 1e-6,
      canvas: CANVAS,
      cursorPx: { x: 0, y: 0 },
      factor: 1e9,
    });
    expect(result.pxMm).toBeGreaterThan(0);
  });
});

describe('fit', () => {
  it('fit 後整個網格落在視野內', () => {
    const view = axialAt();
    const pxMm = fitPxMm(tiltedGrid, view, { w: CANVAS.width, h: CANVAS.height });
    const right = planeRight(view);
    const up = view.viewUp;
    const [nx, ny, nz] = [tiltedGrid.size[0] - 1, tiltedGrid.size[1] - 1, tiltedGrid.size[2] - 1];
    const corners: Vec3[] = [
      [0, 0, 0], [nx, 0, 0], [0, ny, 0], [nx, ny, 0],
      [0, 0, nz], [nx, 0, nz], [0, ny, nz], [nx, ny, nz],
    ];
    for (const corner of corners) {
      const world = indexToWorld(tiltedGrid, corner);
      const du = dot3(world, right) - dot3(view.planeOrigin, right);
      const dv = dot3(world, up) - dot3(view.planeOrigin, up);
      // 半視野 ＋ 半像素容差
      expect(Math.abs(du) / pxMm).toBeLessThanOrEqual(CANVAS.width / 2 + 1);
      expect(Math.abs(dv) / pxMm).toBeLessThanOrEqual(CANVAS.height / 2 + 1);
    }
  });

  it('視野變窄時 pxMm 變大（要塞進更小的畫面）', () => {
    const view = axialAt();
    const wide = fitPxMm(tiltedGrid, view, { w: 1024, h: 1024 });
    const narrow = fitPxMm(tiltedGrid, view, { w: 256, h: 256 });
    expect(narrow).toBeGreaterThan(wide);
  });
});

describe('捲動切面 = 沿法線移動平面', () => {
  it('一步等於法線方向上一個體素', () => {
    const view = axialAt();
    const next = stepAlongNormal(tiltedGrid, view, 1);
    const spacing = normalSpacing(tiltedGrid, view.viewPlaneNormal);
    const moved: Vec3 = [
      next.planeOrigin[0] - view.planeOrigin[0],
      next.planeOrigin[1] - view.planeOrigin[1],
      next.planeOrigin[2] - view.planeOrigin[2],
    ];
    expect(Math.hypot(moved[0], moved[1], moved[2])).toBeCloseTo(spacing, 9);
    // 而且只沿法線移動（平面內不位移）
    expect(Math.abs(dot3(moved, planeRight(view)))).toBeLessThan(1e-9);
    expect(Math.abs(dot3(moved, view.viewUp))).toBeLessThan(1e-9);
  });

  it('🔴 正交視圖上一步精確等於該軸的 spacing（使用者會數切片）', () => {
    // 軸對齊的等向網格：軸向一步 = spacing_z
    const axisAligned: Grid = {
      size: [64, 64, 20],
      spacing: [1, 1, 3],
      origin: [0, 0, 0],
      direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      frameOfReferenceUid: 'for.aligned',
    };
    expect(normalSpacing(axisAligned, [0, 0, 1])).toBeCloseTo(3, 12);
    expect(normalSpacing(axisAligned, [0, 1, 0])).toBeCloseTo(1, 12);
    expect(normalSpacing(axisAligned, [1, 0, 0])).toBeCloseTo(1, 12);
  });

  it('🔴 傾斜取像上一步 = spacing_z / cos(傾角)，剛好讓 k 前進一格', () => {
    // direction 第 3 欄 = (d[2], d[5], d[8])；與 (0,0,1) 的內積是 d[8] = cos15°
    const cos = Math.abs(tiltedGrid.direction[8]!);
    expect(normalSpacing(tiltedGrid, [0, 0, 1])).toBeCloseTo(tiltedGrid.spacing[2] / cos, 9);
    // 舊版的加權和會給一個**更大**的值 → 一格滾輪跳兩張切片
    const weightedSum =
      Math.abs(tiltedGrid.direction[8]!) * tiltedGrid.spacing[2] +
      Math.abs(tiltedGrid.direction[7]!) * tiltedGrid.spacing[1] +
      Math.abs(tiltedGrid.direction[6]!) * tiltedGrid.spacing[0];
    expect(weightedSum).toBeGreaterThan(normalSpacing(tiltedGrid, [0, 0, 1]));
  });

  it('往回捲同樣步數會回到原點', () => {
    const view = axialAt();
    const round = stepAlongNormal(tiltedGrid, stepAlongNormal(tiltedGrid, view, 7), -7);
    for (let k = 0; k < 3; k += 1) {
      expect(round.planeOrigin[k]!).toBeCloseTo(view.planeOrigin[k]!, 9);
    }
  });

  it('捲到資料範圍外會被 planeIntersectsGrid 擋住', () => {
    const view = axialAt();
    expect(planeIntersectsGrid(tiltedGrid, view)).toBe(true);
    const far = stepAlongNormal(tiltedGrid, view, 10_000);
    expect(planeIntersectsGrid(tiltedGrid, far)).toBe(false);
  });
});

describe('Pan', () => {
  it('只在平面內位移，不改變切片', () => {
    const view = axialAt();
    const panned = panInPlane(view, { x: 30, y: -12 }, 1.5);
    const moved: Vec3 = [
      panned.planeOrigin[0] - view.planeOrigin[0],
      panned.planeOrigin[1] - view.planeOrigin[1],
      panned.planeOrigin[2] - view.planeOrigin[2],
    ];
    // 沿法線的位移必須是 0（Pan 不該換切片）
    expect(Math.abs(dot3(moved, view.viewPlaneNormal))).toBeLessThan(1e-9);
    expect(Math.hypot(moved[0], moved[1], moved[2])).toBeGreaterThan(0);
  });

  it('內容跟著手指走：往右拖 → 焦點往左移', () => {
    const view = axialAt();
    const panned = panInPlane(view, { x: 10, y: 0 }, 1);
    const right = planeRight(view);
    const along = dot3(
      [
        panned.planeOrigin[0] - view.planeOrigin[0],
        panned.planeOrigin[1] - view.planeOrigin[1],
        panned.planeOrigin[2] - view.planeOrigin[2],
      ],
      right,
    );
    expect(along).toBeLessThan(0);
  });
});

describe('斜面旋轉', () => {
  it('旋轉後仍是合法的 ViewReference（法線單位、viewUp 正交）', () => {
    let view = axialAt();
    for (const angle of [5, 15, -30, 90]) {
      view = rotateInPlane(view, 'right', angle);
      expect(() => createViewReference(view)).not.toThrow();
    }
  });

  it('planeOrigin 不動 —— 旋轉以目前這一點為樞紐', () => {
    const view = axialAt();
    const rotated = rotateInPlane(view, 'up', 25);
    expect(rotated.planeOrigin).toEqual(view.planeOrigin);
  });

  it('繞 viewUp 旋轉時 viewUp 不變', () => {
    const view = axialAt();
    const rotated = rotateInPlane(view, 'up', 33);
    for (let k = 0; k < 3; k += 1) {
      expect(rotated.viewUp[k]!).toBeCloseTo(view.viewUp[k]!, 9);
    }
  });
});

describe('切片序號僅供顯示（不得儲存）', () => {
  it('軸向平面在網格中心時序號約為 size_z / 2', () => {
    const view = axialAt(gridCenterWorld(tiltedGrid));
    // 連續索引恰為 (size-1)/2 = 49.5；落在 49 或 50 都對（半格的四捨五入本質上
    // 是模糊的，不該用測試把它釘死）
    const index = displaySliceIndex(tiltedGrid, view);
    expect(Math.abs(index - (tiltedGrid.size[2] - 1) / 2)).toBeLessThanOrEqual(0.5);
  });

  /**
   * 捲動一步 = **序號動一格**，方向由法線決定。
   *
   * axial 的法線是 `-z`（從腳側往頭看，見 `ORIENTATIONS`），而網格的 k 軸朝 S，
   * 因此往 `+normal` 捲一步序號**減一**。這條刻意斷言「差一格」而不是「加一」：
   * 釘死符號等於把某一個方位的觀察者位置寫進測試，而那正是 axial 鏡像 bug
   * 藏身的地方。三個方位都測，缺一個就漏掉那一格。
   */
  it('捲動一步序號剛好動一格（方向隨法線）', () => {
    for (const orientation of ['axial', 'coronal', 'sagittal'] as const) {
      const view = orthoCamera({
        grid: tiltedGrid,
        orientation,
        displayGridId: 'dg',
        planeOrigin: gridCenterWorld(tiltedGrid),
      });
      const before = displaySliceIndex(tiltedGrid, view);
      const after = displaySliceIndex(tiltedGrid, stepAlongNormal(tiltedGrid, view, 1));
      expect(Math.abs(after - before), orientation).toBe(1);
    }
  });

  it('axial 往 +normal 捲是往腳側（k 減少）—— 法線指向觀察者的直接後果', () => {
    const view = axialAt(gridCenterWorld(tiltedGrid));
    const before = displaySliceIndex(tiltedGrid, view);
    const after = displaySliceIndex(tiltedGrid, stepAlongNormal(tiltedGrid, view, 1));
    expect(after - before).toBe(-1);
  });
});

describe('三個正交方位', () => {
  it('法線互相正交，且都通過契約驗證', () => {
    const cameras = (['axial', 'coronal', 'sagittal'] as const).map((orientation) =>
      orthoCamera({ grid: tiltedGrid, orientation, displayGridId: 'dg' }),
    );
    for (const camera of cameras) expect(() => createViewReference(camera)).not.toThrow();
    for (let a = 0; a < 3; a += 1) {
      for (let b = a + 1; b < 3; b += 1) {
        expect(Math.abs(dot3(cameras[a]!.viewPlaneNormal, cameras[b]!.viewPlaneNormal))).toBeLessThan(
          1e-9,
        );
      }
    }
  });

  it('三個方位的 planeOrigin 都是網格中心（十字線一開始就對齊）', () => {
    const center = gridCenterWorld(tiltedGrid);
    for (const orientation of ['axial', 'coronal', 'sagittal'] as const) {
      const camera = orthoCamera({ grid: tiltedGrid, orientation, displayGridId: 'dg' });
      for (let k = 0; k < 3; k += 1) {
        expect(camera.planeOrigin[k]!).toBeCloseTo(center[k]!, 9);
      }
    }
  });
});

/**
 * 🔴 **左右方位 —— 全案最危險的一類 bug。**
 *
 * 畫錯左右不會有任何視覺線索：同一格內影像、輪廓、筆刷全部走 `planeRight()`，
 * 一起鏡像，所以畫面「看起來完全正常」，只是整格翻過來。發現它的時候，
 * 已經有一批左右乳／左右肺／左右腮腺的輪廓畫在錯的那一側了。
 *
 * 這一組測試因此有三層，缺一層都還是漏得掉：
 *
 * 1. **三個方位的 `right` 互相不得矛盾** —— axial 之所以錯而 coronal 沒錯，
 *    就是因為沒有任何東西逼它們一致。
 * 2. **與 Python 端的期望值逐條比對** —— 向量由後端產生，
 *    前端只斷言；兩邊各自寫一次只證明各自自洽。
 * 3. **左右不對稱假體的實際投影** —— 上面兩層都還是「檢查向量」，這一層
 *    才是「病人右真的落在畫面左」。
 */
describe('左右方位（放射科慣例：病人右在畫面左）', () => {
  const lat = fixture.laterality;
  const latGrid: Grid = fromWire.grid(lat.grid);

  /** 世界座標投影到畫面橫軸的座標（u，往右為正）。 */
  function screenU(view: ViewReference, world: readonly number[]): number {
    return dot3([world[0]!, world[1]!, world[2]!], planeRight(view));
  }

  it('三個方位的 normal／viewUp／right 與 Python 端一致', () => {
    for (const orientation of ['axial', 'coronal', 'sagittal'] as const) {
      const camera = orthoCamera({ grid: latGrid, orientation, displayGridId: 'dg' });
      const right = planeRight(camera);
      for (let k = 0; k < 3; k += 1) {
        expect(camera.viewPlaneNormal[k]!, `${orientation} normal[${k}]`).toBeCloseTo(
          lat.expected_normal[orientation][k]!,
          9,
        );
        expect(camera.viewUp[k]!, `${orientation} viewUp[${k}]`).toBeCloseTo(
          lat.expected_view_up[orientation][k]!,
          9,
        );
        expect(right[k]!, `${orientation} right[${k}]`).toBeCloseTo(
          lat.expected_right[orientation][k]!,
          9,
        );
      }
    }
  });

  it('🔴 axial 與 coronal 的畫面右必須是同一個解剖方向（先前互相矛盾）', () => {
    const axial = orthoCamera({ grid: latGrid, orientation: 'axial', displayGridId: 'dg' });
    const coronal = orthoCamera({ grid: latGrid, orientation: 'coronal', displayGridId: 'dg' });
    // 兩格都看得到左右，因此兩者的 right 必須相同 —— 不同就代表其中一格是鏡像的
    const dot = dot3(planeRight(axial), planeRight(coronal));
    expect(dot).toBeCloseTo(1, 9);
    // 而且是 +x（LPS 的病人左）
    expect(planeRight(axial)[0]).toBeCloseTo(1, 9);
  });

  it('🔴 病人右側的結構落在畫面左半（axial）', () => {
    const axial = orthoCamera({ grid: latGrid, orientation: 'axial', displayGridId: 'dg' });
    const markerU = screenU(axial, lat.centroids_world_lps.marker_r!);
    const bodyU = screenU(axial, lat.centroids_world_lps.body!);
    expect(
      markerU,
      `Marker_R（病人右）的 u=${markerU} 必須小於中線 u=${bodyU}；` +
        '大於就代表 axial 整格左右鏡像',
    ).toBeLessThan(bodyU);
  });

  it('🔴 病人右側的結構落在畫面左半（coronal）', () => {
    const coronal = orthoCamera({ grid: latGrid, orientation: 'coronal', displayGridId: 'dg' });
    expect(screenU(coronal, lat.centroids_world_lps.marker_r!)).toBeLessThan(
      screenU(coronal, lat.centroids_world_lps.body!),
    );
  });

  it('sagittal 的畫面右是病人後方（A 在畫面左）', () => {
    const sagittal = orthoCamera({ grid: latGrid, orientation: 'sagittal', displayGridId: 'dg' });
    const right = planeRight(sagittal);
    // +y = P（後）
    expect(right[1]).toBeCloseTo(1, 9);
  });

  it('法線指向觀察者：axial 從腳側看（-z）、coronal 從前方看（-y）', () => {
    const axial = orthoCamera({ grid: latGrid, orientation: 'axial', displayGridId: 'dg' });
    const coronal = orthoCamera({ grid: latGrid, orientation: 'coronal', displayGridId: 'dg' });
    expect(axial.viewPlaneNormal[2]).toBeCloseTo(-1, 9);
    expect(coronal.viewPlaneNormal[1]).toBeCloseTo(-1, 9);
  });

  it('(right, up, normal) 三個方位都是右手系 —— right × up = normal', () => {
    for (const orientation of ['axial', 'coronal', 'sagittal'] as const) {
      const camera = orthoCamera({ grid: latGrid, orientation, displayGridId: 'dg' });
      const handed = cross3(planeRight(camera), camera.viewUp);
      for (let k = 0; k < 3; k += 1) {
        expect(handed[k]!, `${orientation}[${k}]`).toBeCloseTo(camera.viewPlaneNormal[k]!, 9);
      }
    }
  });
});

describe('Fit 的相機（fitCamera）', () => {
  const grid: Grid = {
    frameOfReferenceUid: '1.2.3',
    size: [100, 80, 60],
    spacing: [1, 1, 3],
    origin: [-50, -40, 0],
    direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  };

  it('切片不動、平面內回到網格中心（以前 Fit 會跳回中間那張）', () => {
    const center = gridCenterWorld(grid);
    const start = orthoCamera({ grid, orientation: 'axial', displayGridId: 'd' });
    // 換到別的切片、也平移過
    const moved = createViewReference({ ...start, planeOrigin: [center[0] + 20, center[1] - 15, center[2] + 30] });
    const fit = fitCamera(grid, moved);
    const n = fit.viewPlaneNormal;
    const depth = (p: Vec3) => dot3(p, n);
    expect(depth(fit.planeOrigin)).toBeCloseTo(depth(moved.planeOrigin), 6);
    // 平面內的分量 = 網格中心
    const inPlane = (p: Vec3): Vec3 => [p[0] - n[0] * depth(p), p[1] - n[1] * depth(p), p[2] - n[2] * depth(p)];
    const a = inPlane(fit.planeOrigin);
    const b = inPlane(center);
    for (let i = 0; i < 3; i += 1) expect(a[i]).toBeCloseTo(b[i]!, 6);
  });

  it('斜切、slab、相位都留著', () => {
    const start = orthoCamera({ grid, orientation: 'coronal', displayGridId: 'd', slabThicknessMm: 5 });
    const oblique = rotateInPlane({ ...start, temporalGroupId: 'tg', frameIndex: 3 }, 'right', 20);
    const fit = fitCamera(grid, oblique);
    expect(fit.viewPlaneNormal).toEqual(oblique.viewPlaneNormal);
    expect(fit.viewUp).toEqual(oblique.viewUp);
    expect(fit.slabThicknessMm).toBe(5);
    expect([fit.temporalGroupId, fit.frameIndex]).toEqual(['tg', 3]);
  });
});

