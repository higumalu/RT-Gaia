/**
 * 角度、Cobb 角、曲線長度：幾何值、工具互動（fake ToolContext）、SVG 描述、量測範本。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  angleArc,
  angleDeg,
  clearTools,
  cobbAngleDeg,
  createMeasurement,
  formatMeasurementValue,
  getTool,
  measurementHandles,
  measurementNodes,
  measurementValue,
  measureToolFor,
  polylineLength,
  primaryFrameGroupOf,
  registerBuiltinTools,
  requiredPoints,
  translatePoints,
  type Layer,
  type Measurement,
  type MeasurementKind,
  type ToolContext,
  type ViewReference,
} from '../src/core';
import { canInsertAfter, deleteVertex, insertVertexAfter, measurementRows, toCsv } from '../src/react/modules/measure/model';
import {
  BUILTIN_TEMPLATES,
  copyTemplate,
  nextRun,
  parseTemplates,
  serializeTemplates,
  stepLabel,
  templateProblems,
  upsertTemplate,
} from '../src/react/modules/measure/templates';

const coronal: ViewReference = {
  frameOfReferenceUid: 'for.a',
  displayGridId: 'dg',
  planeOrigin: [0, 0, 0],
  viewPlaneNormal: [0, 1, 0],
  viewUp: [0, 0, 1],
  slabThicknessMm: 0,
  temporalGroupId: null,
  frameIndex: null,
};
const axial: ViewReference = { ...coronal, viewPlaneNormal: [0, 0, -1], viewUp: [0, -1, 0] };

const make = (kind: MeasurementKind, points: number[], view: ViewReference | null = null): Measurement =>
  createMeasurement({ kind, frameOfReferenceUid: 'for.a', points, viewReference: view, editedOn: axial, label: 'x' });

describe('幾何值', () => {
  it('角度：直角 90°、平角 180°、重合 0；與平面無關（3D）', () => {
    expect(angleDeg([10, 0, 0], [0, 0, 0], [0, 10, 0])).toBeCloseTo(90);
    expect(angleDeg([10, 0, 0], [0, 0, 0], [-5, 0, 0])).toBeCloseTo(180);
    expect(angleDeg([0, 0, 0], [0, 0, 0], [1, 0, 0])).toBe(0);
    expect(angleDeg([1, 0, 0], [0, 0, 0], [1, 0, 1])).toBeCloseTo(45);
    expect(measurementValue(make('angle', [10, 0, 0, 0, 0, 0, 0, 10, 0]))).toEqual({ value: 90, unit: 'deg' });
    expect(measurementValue(make('angle', [10, 0, 0, 0, 0, 0])).value).toBe(0);
  });

  it('Cobb：跟畫的方向無關；> 90° 量得出（兩條終板各傾斜 50° 相反方向 → 100°）', () => {
    // 冠狀面：right 軸 = viewUp × normal = (0,0,1)×(0,1,0) = (-1,0,0)，up = +z
    const tilt = (deg: number, z0: number, flip = false): number[] => {
      const r = (deg * Math.PI) / 180;
      const a = [0, 0, z0];
      const b = [-Math.cos(r) * 40, 0, z0 + Math.sin(r) * 40];
      return flip ? [...b, ...a] : [...a, ...b];
    };
    const p = [...tilt(50, 0), ...tilt(-50, 100)];
    expect(cobbAngleDeg(p, coronal)).toBeCloseTo(100, 5);
    // 其中一條反著畫：一樣
    expect(cobbAngleDeg([...tilt(50, 0, true), ...tilt(-50, 100)], coronal)).toBeCloseTo(100, 5);
    // 小角度
    expect(cobbAngleDeg([...tilt(10, 0), ...tilt(-15, 100)], coronal)).toBeCloseTo(25, 5);
    // 平行 → 0
    expect(cobbAngleDeg([...tilt(12, 0), ...tilt(12, 80, true)], coronal)).toBeCloseTo(0, 5);
    // 沒有平面（舊資料）→ 3D 直線夾角的銳角
    expect(cobbAngleDeg(p, null)).toBeCloseTo(80, 5);
    expect(measurementValue(make('cobb', p, coronal)).unit).toBe('deg');
    expect(cobbAngleDeg(p.slice(0, 9), coronal)).toBe(0);
  });

  it('曲線：逐段相加（3D）；一點 → 0', () => {
    expect(polylineLength([0, 0, 0, 3, 4, 0, 3, 4, 12])).toBeCloseTo(17);
    expect(polylineLength([1, 2, 3])).toBe(0);
    expect(measurementValue(make('curve', [0, 0, 0, 3, 4, 0]))).toEqual({ value: 5, unit: 'mm' });
  });

  it('點數需求、格式、平移（Cobb 位移投到自己的平面）', () => {
    expect([requiredPoints('angle'), requiredPoints('cobb'), requiredPoints('curve')]).toEqual([3, 4, 2]);
    const m = make('angle', [10, 0, 0, 0, 0, 0, 0, 10, 0]);
    expect(formatMeasurementValue(m, { value: 90, unit: 'deg' })).toBe('90.0°');
    const c = make('cobb', [0, 0, 0, 1, 0, 0, 0, 0, 5, 1, 0, 5], coronal);
    expect(translatePoints(c, [1, 7, 2]).slice(0, 3)).toEqual([1, 0, 2]);
    expect(measureToolFor('cobb')).toBe('measure-cobb');
    expect(measureToolFor('curve')).toBe('measure-curve');
  });
});

// ── 工具 ───────────────────────────────────────────────────────────────

const image: Layer = { layerId: 'img', kind: 'image', label: 'CT', groupId: null, frameOfReferenceUid: 'for.a', contentRef: 's', visible: true, opacity: 1, order: 0 };

function fakeContext() {
  const store = new Map<string, Measurement>();
  const log: string[] = [];
  const preview: { current: readonly number[][] | null } = { current: null };
  const ctx = {
    viewport: { viewportId: 'v', is3D: false, width: 100, height: 100 },
    camera: axial,
    canvasToWorld: (x: number, y: number) => [x, y, 0] as [number, number, number],
    worldToCanvas: (w: readonly number[]) => ({ x: w[0]!, y: w[1]! }),
    frameGroup: (uid: string) => primaryFrameGroupOf(uid, 's'),
    params: {},
    layers: () => [image],
    activeImageLayer: () => image,
    measurements: () => [...store.values()],
    addMeasurement: (m: Measurement, o?: { commit?: boolean }) => {
      store.set(m.measurementId, m);
      log.push(`add:${o?.commit === false ? 'draft' : 'commit'}`);
    },
    updateMeasurement: (id: string, patch: { points?: Float64Array | readonly number[] }) => {
      const m = store.get(id)!;
      store.set(id, { ...m, ...(patch.points ? { points: Float64Array.from(patch.points) } : {}) });
    },
    removeMeasurement: (id: string) => {
      store.delete(id);
      log.push('remove');
    },
    commitMeasurement: (id: string) => log.push(`commit:${store.get(id)?.kind}`),
    selectMeasurement: () => {},
    cssToBackingScale: () => ({ sx: 1, sy: 1 }),
    setLassoPreview: (poly: readonly number[][] | null) => {
      preview.current = poly;
    },
    highlightVertex: () => {},
  } as unknown as ToolContext;
  return { ctx, store, log, preview };
}

const click = (tool: ReturnType<ReturnType<typeof getTool>['activate']>, x: number, y: number): void => {
  tool.onPointerDown?.(x, y);
  tool.onPointerUp?.(x, y);
};

beforeEach(() => {
  clearTools();
  registerBuiltinTools();
});
afterEach(() => clearTools());

describe('工具', () => {
  it('角度：三下完成、第二點是頂點；橡皮筋；雙擊（同一點）不疊點；Esc 取消', () => {
    const { ctx, store, log, preview } = fakeContext();
    const t = getTool('measure-angle').activate(ctx);
    click(t, 20, 0);
    t.onHover?.({ x: 5, y: 5 });
    expect(preview.current).toHaveLength(2);
    click(t, 0, 0);
    click(t, 0, 0); // 雙擊的第二下
    t.onAction?.('finish'); // 點數不夠：不算結束、也不取消
    expect(store.size).toBe(1);
    click(t, 0, 20);
    const m = [...store.values()][0]!;
    expect(m.kind).toBe('angle');
    expect(m.label).toBe('角度 1');
    expect(m.viewReference).toBeNull();
    expect(measurementValue(m).value).toBeCloseTo(90);
    expect(log.at(-1)).toBe('commit:angle');
    expect(preview.current).toBeNull();
    click(t, 50, 50);
    expect(t.onKeyDown?.('Escape')).toBe(true);
    expect(store.size).toBe(1);
  });

  it('Cobb：四下完成、綁平面；第一條線畫完、第二條起頭前不拉橡皮筋；編號', () => {
    const { ctx, store, log, preview } = fakeContext();
    const t = getTool('measure-cobb').activate(ctx);
    click(t, 0, 0);
    click(t, 40, 10);
    t.onHover?.({ x: 30, y: 30 });
    expect(preview.current).toBeNull();
    click(t, 0, 60);
    t.onHover?.({ x: 30, y: 30 });
    expect(preview.current).toHaveLength(2);
    click(t, 40, 50);
    const m = [...store.values()][0]!;
    expect(m.kind).toBe('cobb');
    expect(m.points.length).toBe(12);
    expect(m.viewReference).not.toBeNull();
    expect(log.at(-1)).toBe('commit:cobb');
    // 軸向面 right=(-1,0,0)?? → 用 viewReference 算：兩條線各 +14.04° 與 -14.04°（y 向下）
    expect(measurementValue(m).value).toBeCloseTo(2 * (Math.atan2(10, 40) * 180) / Math.PI, 5);
    // 拖曳不是點
    t.onPointerDown?.(0, 0);
    t.onPointerUp?.(30, 30);
    expect(store.size).toBe(1);
    // 畫一半換工具 → 丟掉
    click(t, 1, 1);
    t.deactivate?.();
    expect(store.size).toBe(1);
  });

  it('曲線：逐點、再點最後一點或 Enter 結束；一點就結束 → 丟掉；雙擊結束', () => {
    const { ctx, store, log } = fakeContext();
    const t = getTool('measure-curve').activate(ctx);
    click(t, 0, 0);
    click(t, 30, 40);
    click(t, 30, 52);
    click(t, 31, 53); // 最後一點附近 ＝ 結束
    const m = [...store.values()][0]!;
    expect(m.kind).toBe('curve');
    expect(measurementValue(m).value).toBeCloseTo(62);
    expect(log.at(-1)).toBe('commit:curve');
    click(t, 80, 80);
    t.onKeyDown?.('Enter');
    expect(store.size).toBe(1);
    click(t, 70, 70);
    click(t, 90, 70);
    t.onAction?.('finish');
    expect(store.size).toBe(2);
  });
});

describe('SVG 描述', () => {
  const base = { mode: 'full' as const, selected: false, editable: true, valueText: '90.0°' };
  it('角度：兩臂 ＋ 頂點小弧；把手兩段', () => {
    const m = make('angle', [10, 0, 0, 0, 0, 0, 0, 10, 0]);
    const nodes = measurementNodes({ ...base, measurement: m, pointsPx: [{ x: 50, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 50 }] });
    expect(nodes.filter((n) => n.tag === 'polyline')).toHaveLength(1);
    const arc = nodes.find((n) => n.attrs['class']?.includes('rt-measure-arc'));
    expect(arc?.attrs['d']).toMatch(/^M20\.0 0\.0A20\.0 20\.0 0 0 1 0\.0 20\.0$/);
    expect(nodes.some((n) => n.tag === 'text' && n.text?.includes('∠ x  90.0°'))).toBe(true);
    const handles = measurementHandles({ ...base, measurement: m, pointsPx: [{ x: 50, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 50 }] });
    expect(handles.filter((h) => h.kind === 'measurement-body')).toHaveLength(2);
    expect(angleArc({ x: 1, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1 })).toBeNull(); // 臂太短
  });

  it('Cobb：兩條線 ＋ 中點連線；草稿只畫得出第一條；提示依種類', () => {
    const m = make('cobb', [0, 0, 0, 1, 0, 0, 0, 0, 5, 1, 0, 5], coronal);
    const px = [{ x: 0, y: 0 }, { x: 40, y: 10 }, { x: 0, y: 60 }, { x: 40, y: 50 }];
    const nodes = measurementNodes({ ...base, measurement: m, pointsPx: px });
    expect(nodes.filter((n) => n.tag === 'line')).toHaveLength(3);
    expect(nodes.some((n) => n.attrs['class']?.includes('rt-measure-link'))).toBe(true);
    const draft = measurementNodes({ ...base, measurement: m, pointsPx: px.slice(0, 2), draft: true });
    expect(draft.filter((n) => n.tag === 'line')).toHaveLength(1);
    expect(draft.find((n) => n.tag === 'text')?.text).toContain('畫兩條線');
    expect(measurementHandles({ ...base, measurement: m, pointsPx: px }).filter((h) => h.kind === 'measurement-body')).toHaveLength(2);
  });

  it('曲線：開放折線（不是 polygon）', () => {
    const m = make('curve', [0, 0, 0, 3, 4, 0, 3, 4, 12]);
    const nodes = measurementNodes({ ...base, measurement: m, pointsPx: [{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 3, y: 16 }] });
    expect(nodes.some((n) => n.tag === 'polyline')).toBe(true);
    expect(nodes.some((n) => n.tag === 'polygon')).toBe(false);
  });
});

describe('面板', () => {
  it('表格值與 CSV：角度用 °／deg；曲線頂點至少兩點、最後一點後面不能插', () => {
    const angle = { ...make('angle', [10, 0, 0, 0, 0, 0, 0, 10, 0]), result: { value: 90, unit: 'deg' as const } };
    const layer: Layer = { layerId: 'measurement:a', kind: 'measurement', label: 'x', groupId: 'measurements', frameOfReferenceUid: 'for.a', contentRef: 'a', visible: true, opacity: 1, order: 0, measurement: angle };
    const rows = measurementRows([layer]);
    expect(rows[0]!.valueText).toBe('90.0°');
    expect(rows[0]!.kindLabel).toBe('角度');
    expect(toCsv(rows).split('\n')[1]).toMatch(/^angle,x,90\.000,deg,/);
    const curve = make('curve', [0, 0, 0, 10, 0, 0]);
    expect(deleteVertex(curve, 0)).toBeNull();
    expect(canInsertAfter(curve, 1)).toBe(false);
    expect(insertVertexAfter(curve, 0)).toEqual([0, 0, 0, 5, 0, 0, 10, 0, 0]);
  });
});

describe('量測範本', () => {
  it('內建範本合法、名稱依語言；下一步／完成', () => {
    for (const tpl of BUILTIN_TEMPLATES) expect(templateProblems(tpl)).toEqual([]);
    const recist = BUILTIN_TEMPLATES[0]!;
    expect(stepLabel(recist, 1)).toBe('短徑');
    expect(nextRun({ templateId: recist.id, step: 0 }, recist)).toEqual({ templateId: recist.id, step: 1 });
    expect(nextRun({ templateId: recist.id, step: 1 }, recist)).toBeNull();
  });

  it('使用者範本：驗證、存取來回、壞資料丟掉、不能冒用 builtin: id、複製', () => {
    expect(templateProblems({ name: ' ', steps: [] })).toHaveLength(2);
    expect(templateProblems({ name: 'a', steps: [{ kind: 'distance', label: '' }] })).toEqual(['第 1 步要有名稱']);
    expect(templateProblems({ name: 'a', steps: [{ kind: 'nope' as MeasurementKind, label: 'x' }] })).toEqual(['第 1 步的種類不對']);
    const mine = upsertTemplate([], { id: 'tpl_1', name: '  膝  ', steps: [{ kind: 'angle', label: ' 股脛角 ' }] });
    expect(mine[0]).toEqual({ id: 'tpl_1', name: '膝', steps: [{ kind: 'angle', label: '股脛角' }] });
    expect(parseTemplates(serializeTemplates(mine))).toEqual(mine);
    expect(upsertTemplate(mine, { ...mine[0]!, name: '膝關節' })).toHaveLength(1);
    const junk = JSON.stringify([{ id: 'builtin:x', name: 'a', steps: [{ kind: 'distance', label: 'b' }] }, { id: 'y', name: '', steps: [] }, 5, { id: 'z', name: 'ok', steps: [{ kind: 'curve', label: '長' }] }]);
    expect(parseTemplates(junk).map((x) => x.id)).toEqual(['z']);
    expect(parseTemplates('{bad')).toEqual([]);
    const copy = copyTemplate(BUILTIN_TEMPLATES[1]!, 'tpl_2');
    expect(copy.builtin).toBeUndefined();
    expect(copy.steps[0]).toEqual({ kind: 'cobb', label: '主彎 Cobb 角' });
    expect(copy.name).toContain('（複本）');
    expect(serializeTemplates([...BUILTIN_TEMPLATES, ...mine])).toBe(serializeTemplates(mine));
  });
});
