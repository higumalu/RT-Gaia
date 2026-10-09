/**
 * 量測的 SVG 描述（量測以 SVG overlay 疊在 canvas 之上，GPU／CPU 路徑共用）。
 *
 * **純函式**：輸入是已經投影成 backing store 像素的點與顯示模式，輸出是要建的 SVG 節點描述
 * 與可拖的控制點；DOM 由 `SvgOverlayHost.updateMeasurements()` 建。`measurement-svg.test.ts` 直接測。
 */

import type { Measurement, MeasurementResult } from '../layers/types';
import type { Vec2 } from '../raster/types';
import type { MeasurementDisplayMode, SvgHandle } from './svgOverlay';
import { msg, t } from '../i18n';

export interface SvgNode {
  readonly tag: 'line' | 'polyline' | 'polygon' | 'circle' | 'text' | 'path' | 'rect';
  readonly attrs: Readonly<Record<string, string>>;
  readonly text?: string;
}

export interface MeasurementSvgInput {
  readonly measurement: Measurement;
  /** 全部控制點的投影（primary → canvas）。 */
  readonly pointsPx: readonly Vec2[];
  readonly mode: MeasurementDisplayMode;
  readonly selected: boolean;
  /** 共面且不是方框才可拖。 */
  readonly editable: boolean;
  /** 已格式化的值（`12.3 mm`）。 */
  readonly valueText: string;
  /** 面積在斜面上的交線（`mode === 'intersection-only'`）。 */
  readonly intersectionPx?: readonly (readonly [Vec2, Vec2])[];
  /** 方框在目前切面上的截面。 */
  readonly sectionPx?: readonly Vec2[];
  /** 編輯工具作用中時 false：不出身體把手，免得搶走下筆。預設 true。 */
  readonly allowBody?: boolean;
  /** 方框在**正交**切面上：截面角可拉（`measurement-box-corner`）。 */
  readonly boxCornersDraggable?: boolean;
  /**
   * 進行中的草稿（面積多邊形還沒收口）：每個頂點都畫控制點（第一點就要有回饋）、頂點可拖、
   * 標籤改成操作提示（不放按鈕，但要有結束圈選的方式）。
   */
  readonly draft?: boolean;
  /** 面板的「編輯頂點」模式：不管目前工具，這個量測的頂點都顯示、都可拖。 */
  readonly editingVertices?: boolean;
  /** 要強調的頂點（草稿吸附到起點時＝0；面板滑過某列時＝那一列）；`null`／沒給＝沒有。 */
  readonly highlightIndex?: number | null;
}

/** 面積草稿至少要幾個頂點才算多邊形。 */
export const MIN_POLYGON_VERTICES = 3;

/** 草稿標籤上的操作提示（取代按鈕）。 */
export const DRAFT_HINT = msg('雙擊／Enter 結束、Esc 取消');
/** 點數固定的工具（角度、Cobb）的草稿提示。 */
export const DRAFT_HINT_ANGLE = msg('依序點三點（第二點是頂點）；Esc 取消');
export const DRAFT_HINT_COBB = msg('畫兩條線，各點兩點；Esc 取消');

export const KIND_ICON: Record<Measurement['kind'], string> = { distance: '↔', area: '▱', roi3d: '▣', point: '✚', angle: '∠', cobb: '∡', curve: '∿', landmark: '⌖' };

function draftHint(kind: Measurement['kind']): string {
  if (kind === 'angle') return DRAFT_HINT_ANGLE;
  if (kind === 'cobb') return DRAFT_HINT_COBB;
  return DRAFT_HINT;
}

export function formatMeasurementValue(m: Measurement, result: Pick<MeasurementResult, 'value' | 'unit'> | undefined): string {
  if (m.kind === 'point') {
    const p = m.points;
    return p.length >= 3 ? `(${p[0]!.toFixed(1)}, ${p[1]!.toFixed(1)}, ${p[2]!.toFixed(1)}) mm` : '';
  }
  if (result === undefined) return '';
  if (result.unit === 'deg') return `${result.value.toFixed(1)}°`;
  if (m.kind === 'landmark') return `TRE ${result.value.toFixed(1)} mm`;
  const unit = result.unit === 'mm2' ? 'mm²' : result.unit;
  return `${result.value.toFixed(result.unit === 'cc' ? 2 : 1)} ${unit}`;
}

function pts(points: readonly Vec2[]): string {
  return points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
}

function cls(input: MeasurementSvgInput, extra = ''): string {
  return ['rt-measure', `rt-measure-${input.measurement.kind}`, input.mode === 'faded' ? 'faded' : '', input.selected ? 'selected' : '', extra]
    .filter(Boolean)
    .join(' ');
}

export const LABEL_FONT_PX = 13;
const LABEL_PAD_X = 5;
const LABEL_PAD_Y = 3;

/** 估字寬（SVG 沒有純函式量字寬）：CJK／全形 1 em、其餘 0.55 em。偏大一點無妨。 */
export function estimateTextWidthPx(text: string, fontPx = LABEL_FONT_PX): number {
  let w = 0;
  for (const ch of text) w += /[\u1100-\u11ff\u2e80-\ua4cf\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/.test(ch) ? fontPx : fontPx * 0.55;
  return Math.ceil(w);
}

/**
 * 標籤 ＝ 半透明底色的 `rect` ＋ 不描邊的 `text`（描邊字又粗又小、拖曳中難辨認）。
 */
function label(input: MeasurementSvgInput, at: Vec2): SvgNode[] {
  const text =
    input.draft === true
      ? t('{p0} {label}（草稿）{DRAFT_HINT}', { p0: KIND_ICON[input.measurement.kind], label: input.measurement.label, DRAFT_HINT: t(draftHint(input.measurement.kind)) })
      : `${KIND_ICON[input.measurement.kind]} ${input.measurement.label}${input.valueText ? `  ${input.valueText}` : ''}`;
  const w = estimateTextWidthPx(text) + LABEL_PAD_X * 2;
  const h = LABEL_FONT_PX + LABEL_PAD_Y * 2;
  const x = at.x + 8;
  const yBaseline = at.y - 8;
  const id = input.measurement.measurementId;
  return [
    {
      tag: 'rect',
      attrs: {
        class: cls(input, 'rt-measure-label-bg'),
        x: x.toFixed(1),
        y: (yBaseline - LABEL_FONT_PX - LABEL_PAD_Y + 1).toFixed(1),
        width: String(w),
        height: String(h),
        rx: '3',
        'data-measurement': id,
      },
    },
    {
      tag: 'text',
      attrs: { class: cls(input, 'rt-measure-label'), x: (x + LABEL_PAD_X).toFixed(1), y: yBaseline.toFixed(1), 'data-measurement': id },
      text,
    },
  ];
}

/** 控制點要不要出現：選中且可拖（Slicer 的做法）；草稿與面板編輯模式例外 —— 第一點按下去就要看得到。 */
function showKnobs(input: MeasurementSvgInput): boolean {
  return input.draft === true || input.editingVertices === true || (input.editable && input.selected);
}

function knobs(input: MeasurementSvgInput): SvgNode[] {
  if (!showKnobs(input)) return [];
  const extra = input.draft === true ? ' draft' : input.editingVertices === true ? ' editing' : '';
  return input.pointsPx.map((p, i) => ({
    tag: 'circle',
    attrs: {
      class: cls(input, `rt-measure-knob${extra}${input.highlightIndex === i ? ' highlight' : ''}`),
      cx: p.x.toFixed(1),
      cy: p.y.toFixed(1),
      r: input.highlightIndex === i ? '8' : '5',
      'data-measurement': input.measurement.measurementId,
      'data-index': String(i),
    },
  }));
}

/** 角 ABC 在頂點 B 的小弧（SVG path）；臂太短或三點共線回 null。 */
export function angleArc(a: Vec2, b: Vec2, c: Vec2): string | null {
  const ua = { x: a.x - b.x, y: a.y - b.y };
  const uc = { x: c.x - b.x, y: c.y - b.y };
  const la = Math.hypot(ua.x, ua.y);
  const lc = Math.hypot(uc.x, uc.y);
  if (la < 4 || lc < 4) return null;
  const r = Math.min(22, 0.4 * Math.min(la, lc));
  const cross = ua.x * uc.y - ua.y * uc.x;
  if (Math.abs(cross) < 1e-9 && ua.x * uc.x + ua.y * uc.y > 0) return null;
  const p = { x: b.x + (ua.x / la) * r, y: b.y + (ua.y / la) * r };
  const q = { x: b.x + (uc.x / lc) * r, y: b.y + (uc.y / lc) * r };
  // y 朝下的畫面座標：cross > 0 ＝ 由 A 臂順時針轉到 C 臂（sweep=1）
  return `M${p.x.toFixed(1)} ${p.y.toFixed(1)}A${r.toFixed(1)} ${r.toFixed(1)} 0 0 ${cross > 0 ? 1 : 0} ${q.x.toFixed(1)} ${q.y.toFixed(1)}`;
}

/** 一個量測 → SVG 節點。看不見（`hidden`）回空。 */
export function measurementNodes(input: MeasurementSvgInput): SvgNode[] {
  const { measurement: m, pointsPx, mode } = input;
  if (mode === 'hidden' || pointsPx.length === 0) return [];
  const id = m.measurementId;
  const base = { 'data-measurement': id };
  switch (m.kind) {
    case 'point': {
      const p = pointsPx[0]!;
      return [
        { tag: 'path', attrs: { ...base, class: cls(input), d: `M${p.x - 8} ${p.y}H${p.x + 8}M${p.x} ${p.y - 8}V${p.y + 8}` } },
        { tag: 'circle', attrs: { ...base, class: cls(input, 'rt-measure-ring'), cx: p.x.toFixed(1), cy: p.y.toFixed(1), r: '5' } },
        ...knobs(input),
        ...label(input, p),
      ];
    }
    case 'distance': {
      if (pointsPx.length < 2) return [];
      const [a, b] = [pointsPx[0]!, pointsPx[1]!];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      return [
        { tag: 'line', attrs: { ...base, class: cls(input), x1: a.x.toFixed(1), y1: a.y.toFixed(1), x2: b.x.toFixed(1), y2: b.y.toFixed(1) } },
        ...knobs(input),
        ...label(input, mid),
      ];
    }
    case 'area': {
      if (mode === 'intersection-only') {
        const segs = input.intersectionPx ?? [];
        if (segs.length === 0) return [];
        return [
          ...segs.map(([a, b]) => ({
            tag: 'line' as const,
            attrs: { ...base, class: cls(input, 'rt-measure-section'), x1: a.x.toFixed(1), y1: a.y.toFixed(1), x2: b.x.toFixed(1), y2: b.y.toFixed(1) },
          })),
          ...label(input, segs[0]![0]),
        ];
      }
      const closed = pointsPx.length >= MIN_POLYGON_VERTICES;
      return [
        { tag: closed ? 'polygon' : 'polyline', attrs: { ...base, class: cls(input), points: pts(pointsPx) } },
        ...knobs(input),
        ...label(input, pointsPx[0]!),
      ];
    }
    case 'angle': {
      // 兩臂 ＋ 頂點上的小弧；點還沒點完時畫到哪算到哪
      const arms = { tag: 'polyline' as const, attrs: { ...base, class: cls(input), points: pts(pointsPx.slice(0, 3)) } };
      const arc = pointsPx.length >= 3 ? angleArc(pointsPx[0]!, pointsPx[1]!, pointsPx[2]!) : null;
      return [
        arms,
        ...(arc === null ? [] : [{ tag: 'path' as const, attrs: { ...base, class: cls(input, 'rt-measure-arc'), d: arc } }]),
        ...knobs(input),
        ...label(input, pointsPx[Math.min(1, pointsPx.length - 1)]!),
      ];
    }
    case 'cobb': {
      const lines: SvgNode[] = [];
      for (let i = 0; i + 1 < pointsPx.length && i < 4; i += 2) {
        const a = pointsPx[i]!;
        const b = pointsPx[i + 1]!;
        lines.push({ tag: 'line', attrs: { ...base, class: cls(input), x1: a.x.toFixed(1), y1: a.y.toFixed(1), x2: b.x.toFixed(1), y2: b.y.toFixed(1) } });
      }
      const mids = [0, 2].filter((i) => i + 1 < pointsPx.length).map((i) => ({ x: (pointsPx[i]!.x + pointsPx[i + 1]!.x) / 2, y: (pointsPx[i]!.y + pointsPx[i + 1]!.y) / 2 }));
      if (mids.length === 2) {
        // 兩條線中點的虛線：看得出這兩條線是一組
        lines.push({ tag: 'line', attrs: { ...base, class: cls(input, 'rt-measure-link'), x1: mids[0]!.x.toFixed(1), y1: mids[0]!.y.toFixed(1), x2: mids[1]!.x.toFixed(1), y2: mids[1]!.y.toFixed(1) } });
      }
      const at = mids.length === 2 ? { x: (mids[0]!.x + mids[1]!.x) / 2, y: (mids[0]!.y + mids[1]!.y) / 2 } : pointsPx[0]!;
      return [...lines, ...knobs(input), ...label(input, at)];
    }
    case 'landmark': {
      // pointsPx ＝ [移動點（經目前對位）, 固定點]；兩點之間的虛線就是配準誤差向量
      const [mv, fx] = [pointsPx[0]!, pointsPx[1] ?? pointsPx[0]!];
      return [
        { tag: 'line', attrs: { ...base, class: cls(input, 'rt-landmark-error'), x1: mv.x.toFixed(1), y1: mv.y.toFixed(1), x2: fx.x.toFixed(1), y2: fx.y.toFixed(1) } },
        { tag: 'circle', attrs: { ...base, class: cls(input, 'rt-landmark-fixed'), cx: fx.x.toFixed(1), cy: fx.y.toFixed(1), r: '5' } },
        { tag: 'path', attrs: { ...base, class: cls(input, 'rt-landmark-moving'), d: `M${mv.x - 6} ${mv.y - 6}L${mv.x + 6} ${mv.y + 6}M${mv.x - 6} ${mv.y + 6}L${mv.x + 6} ${mv.y - 6}` } },
        ...label(input, fx),
      ];
    }
    case 'curve': {
      return [
        { tag: 'polyline', attrs: { ...base, class: cls(input), points: pts(pointsPx) } },
        ...knobs(input),
        ...label(input, pointsPx[pointsPx.length - 1]!),
      ];
    }
    case 'roi3d': {
      const section = input.sectionPx ?? [];
      if (section.length < 3) return [];
      return [
        { tag: 'polygon', attrs: { ...base, class: cls(input, 'rt-measure-section'), points: pts(section) } },
        ...(input.selected && input.boxCornersDraggable
          ? section.map((p, i) => ({
              tag: 'circle' as const,
              attrs: { class: cls(input, 'rt-measure-knob'), cx: p.x.toFixed(1), cy: p.y.toFixed(1), r: '5', 'data-measurement': m.measurementId, 'data-corner': String(i) },
            }))
          : []),
        ...label(input, section[0]!),
      ];
    }
  }
}

/**
 * 可拖的把手：
 * * 頂點（`measurement-point`）—— **選中**且共面時；方框沒有（角用下面那種）。
 * * 身體（`measurement-body`，線段）—— 所有畫得出來的量測都有（`allowBody`）：點一下選中、拖了整體平移。
 * * 方框角（`measurement-box-corner`）—— 選中且在正交切面上。
 */
export function measurementHandles(input: MeasurementSvgInput): SvgHandle[] {
  const { measurement: m, pointsPx, mode } = input;
  const id = m.measurementId;
  if (mode === 'hidden') return [];
  const out: SvgHandle[] = [];
  if (showKnobs(input) && input.editable && mode === 'full' && m.kind !== 'roi3d' && m.kind !== 'landmark') {
    pointsPx.forEach((p, i) => out.push({ id: `${id}:pt:${i}`, kind: 'measurement-point', ownerId: id, pointIndex: i, position: p }));
  }
  if (input.selected && m.kind === 'roi3d' && input.boxCornersDraggable && (input.sectionPx?.length ?? 0) >= 4) {
    input.sectionPx!.forEach((p, i) => out.push({ id: `${id}:corner:${i}`, kind: 'measurement-box-corner', ownerId: id, pointIndex: i, position: p }));
  }
  if (input.allowBody === false) return out;
  const seg = (a: Vec2, b: Vec2, i: number): SvgHandle => ({ id: `${id}:body:${i}`, kind: 'measurement-body', ownerId: id, position: a, segment: [a, b] });
  switch (m.kind) {
    case 'point':
      if (pointsPx[0]) out.push({ id: `${id}:body:0`, kind: 'measurement-body', ownerId: id, position: pointsPx[0] });
      break;
    case 'distance':
      if (pointsPx.length >= 2) out.push(seg(pointsPx[0]!, pointsPx[1]!, 0));
      break;
    case 'angle':
    case 'curve':
      for (let i = 0; i + 1 < pointsPx.length; i += 1) out.push(seg(pointsPx[i]!, pointsPx[i + 1]!, i));
      break;
    case 'cobb':
      for (let i = 0; i + 1 < pointsPx.length && i < 4; i += 2) out.push(seg(pointsPx[i]!, pointsPx[i + 1]!, i));
      break;
    case 'landmark':
      break; // 不拖：兩點在不同座標系，改用對位面板重新記錄
    case 'area': {
      if (mode === 'intersection-only') {
        (input.intersectionPx ?? []).forEach(([a, b], i) => out.push(seg(a, b, i)));
      } else if (pointsPx.length >= 2) {
        pointsPx.forEach((p, i) => {
          const q = pointsPx[(i + 1) % pointsPx.length]!;
          if (pointsPx.length >= 3 || i < pointsPx.length - 1) out.push(seg(p, q, i));
        });
      }
      break;
    }
    case 'roi3d': {
      const sec = input.sectionPx ?? [];
      sec.forEach((p, i) => out.push(seg(p, sec[(i + 1) % sec.length]!, i)));
      break;
    }
  }
  return out;
}
