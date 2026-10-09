/**
 * BEV（射束視角）畫圖：一張 2D canvas、純函式（給定 context 與一個控制點），不碰 React。
 *
 * 座標：等中心平面上的射束限制裝置座標（mm）—— x 沿 X jaw／MLCX 的葉片移動方向、y 沿 Y jaw；畫面 +x 向右、+y 向上。
 * 「跟著准直器旋轉」開著時整張圖轉准直器角（示意；不處理機架俯仰、床角 —— 那些在 3D 裡才有意義）。
 * 只畫計畫內容，不是照射模擬。
 */

import { apertureAreaCm2, apertureOutline, apertureRects, bevGridStepMm, jawRect, mlcLayers, type BeamDevice, type DrrContour, type ControlPoint, type MlcLayer, type Rect } from './model';
import { t } from '../../../core/i18n';

export const BEV_COLORS = {
  background: '#0b0d10',
  grid: '#2a2f36',
  axis: '#4b5563',
  jaw: '#c8ccd2',
  aperture: 'rgba(255, 224, 102, 0.38)',
  apertureEdge: '#ffe066',
  layers: ['rgba(96, 150, 255, 0.42)', 'rgba(255, 160, 80, 0.42)', 'rgba(180, 120, 255, 0.42)'],
  layerEdges: ['#6c9cff', '#ffa050', '#b478ff'],
  text: '#e5e7eb',
  muted: '#9aa0a6',
  iso: '#f4c542',
} as const;

export interface BevDrawInput {
  readonly cp: ControlPoint;
  readonly devices: readonly BeamDevice[];
  readonly halfMm: number;
  /** 只畫這一層 MLC（分開看）；undefined ＝ 全部疊在一起。 */
  readonly only?: string | undefined;
  readonly rotate: boolean;
  /** 圖上方的標題（射束名、層名）。 */
  readonly title?: string;
  /** devicePixelRatio：canvas 實際像素 ÷ CSS 像素（`width`／`height` 是 CSS 像素）。 */
  readonly dpr?: number;
  /** DRR 背景（BEV 座標，列 0 ＝ +y）。 */
  readonly background?: { readonly image: CanvasImageSource; readonly halfMm: number; readonly opacity: number } | undefined;
  /** 投影到 BEV 的結構輪廓（mm）。 */
  readonly contours?: readonly DrrContour[] | undefined;
  /** 葉片的不透明度倍率（0–1，預設 1）。 */
  readonly leafOpacity?: number | undefined;
}

/** 葉片本體（從場邊到葉尖）的矩形：A 側在 −、B 側在 +；只畫場內的部分。 */
export function leafRects(cp: ControlPoint, layer: MlcLayer, halfMm: number): { a: Rect[]; b: Rect[] } {
  const bank = cp.mlc[layer.type];
  const a: Rect[] = [];
  const b: Rect[] = [];
  if (bank === undefined) return { a, b };
  for (let i = 0; i < layer.boundaries.length - 1; i += 1) {
    const lo = layer.boundaries[i]!;
    const hi = layer.boundaries[i + 1]!;
    const pa = Math.max(-halfMm, Math.min(halfMm, bank.a[i] ?? -halfMm));
    const pb = Math.max(-halfMm, Math.min(halfMm, bank.b[i] ?? halfMm));
    if (layer.travel === 'x') {
      if (pa > -halfMm) a.push({ x1: -halfMm, x2: pa, y1: lo, y2: hi });
      if (pb < halfMm) b.push({ x1: pb, x2: halfMm, y1: lo, y2: hi });
    } else {
      if (pa > -halfMm) a.push({ x1: lo, x2: hi, y1: -halfMm, y2: pa });
      if (pb < halfMm) b.push({ x1: lo, x2: hi, y1: pb, y2: halfMm });
    }
  }
  return { a, b };
}

export function drawBev(ctx: CanvasRenderingContext2D, width: number, height: number, input: BevDrawInput): { areaCm2: number } {
  const { cp, devices, halfMm, only, rotate } = input;
  const dpr = input.dpr ?? 1;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = BEV_COLORS.background;
  ctx.fillRect(0, 0, width, height);
  const margin = 24; // 放得下 X1／X2／Y1／Y2 標籤
  const side = Math.max(10, Math.min(width, height) - margin * 2);
  const s = side / (2 * halfMm);
  const cx = width / 2;
  const cy = height / 2 + 4;
  const angle = rotate ? ((cp.collimator_deg ?? 0) * Math.PI) / 180 : 0;

  // 等中心平面座標 → 畫面：先轉准直器角（逆時針為正，從射源看），再縮放，y 向上
  ctx.translate(cx, cy);
  ctx.rotate(-angle);
  ctx.scale(s, -s);
  const px = 1 / s;
  // 視野外的東西不畫（「適合開口」時葉片、DRR 會超出這個方框）
  ctx.save();
  ctx.beginPath();
  ctx.rect(-halfMm, -halfMm, 2 * halfMm, 2 * halfMm);
  ctx.clip();

  // DRR 背景（影像列 0 在 +y → 先把 y 翻回來再畫）
  if (input.background) {
    const b = input.background;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, b.opacity));
    ctx.scale(1, -1);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(b.image, -b.halfMm, -b.halfMm, 2 * b.halfMm, 2 * b.halfMm);
    ctx.restore();
  }

  // 格線（間距依視野：50／20／10 mm，0 對齊等中心）
  ctx.lineWidth = px;
  ctx.strokeStyle = BEV_COLORS.grid;
  const step = bevGridStepMm(halfMm);
  for (let v = -Math.floor(halfMm / step) * step; v <= halfMm + 1e-6; v += step) {
    ctx.beginPath();
    ctx.moveTo(v, -halfMm);
    ctx.lineTo(v, halfMm);
    ctx.moveTo(-halfMm, v);
    ctx.lineTo(halfMm, v);
    ctx.stroke();
  }
  ctx.strokeStyle = BEV_COLORS.axis;
  ctx.beginPath();
  ctx.moveTo(-halfMm, 0);
  ctx.lineTo(halfMm, 0);
  ctx.moveTo(0, -halfMm);
  ctx.lineTo(0, halfMm);
  ctx.stroke();

  // 葉片
  const layers = mlcLayers(devices).filter((l) => only === undefined || l.type === only);
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, input.leafOpacity ?? 1));
  layers.forEach((layer) => {
    const k = mlcLayers(devices).findIndex((l) => l.type === layer.type);
    const { a, b } = leafRects(cp, layer, halfMm);
    // DRR 上用中性的灰（兩層疊起來不會變成一片褐色）；沒有 DRR 時兩層不同色
    ctx.fillStyle = input.background ? 'rgba(150, 160, 175, 0.55)' : BEV_COLORS.layers[k % BEV_COLORS.layers.length]!;
    ctx.strokeStyle = input.background ? 'rgba(20, 22, 26, 0.9)' : BEV_COLORS.layerEdges[k % BEV_COLORS.layerEdges.length]!;
    ctx.lineWidth = 0.6 * px;
    for (const r of [...a, ...b]) {
      ctx.fillRect(r.x1, r.y1, r.x2 - r.x1, r.y2 - r.y1);
      ctx.strokeRect(r.x1, r.y1, r.x2 - r.x1, r.y2 - r.y1);
    }
  });

  ctx.restore();

  // 結構投影（在葉片上面，看得到射野蓋到哪些器官）
  for (const c of input.contours ?? []) {
    ctx.strokeStyle = `rgb(${c.color_rgb.join(',')})`;
    ctx.lineWidth = 1.6 * px;
    for (const line of c.polylines) {
      if (line.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(line[0]![0], line[0]![1]);
      for (let i = 1; i < line.length; i += 1) ctx.lineTo(line[i]![0], line[i]![1]);
      ctx.closePath();
      ctx.stroke();
    }
  }

  // 開口
  const rects = apertureRects(cp, devices, only);
  // 開口：沒有 DRR 時半透明黃色填滿；有 DRR 時不填（看得到解剖）。兩種都只描外框（相鄰葉片帶共用的邊不畫）
  if (!input.background) {
    ctx.fillStyle = BEV_COLORS.aperture;
    for (const r of rects) ctx.fillRect(r.x1, r.y1, r.x2 - r.x1, r.y2 - r.y1);
  }
  ctx.strokeStyle = BEV_COLORS.apertureEdge;
  ctx.lineWidth = (input.background ? 1.6 : 1.2) * px;
  ctx.beginPath();
  for (const [x1, y1, x2, y2] of apertureOutline(rects)) {
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
  }
  ctx.stroke();

  // jaw（虛線）
  const jaw = jawRect(cp);
  if (jaw !== null) {
    const x1 = Math.max(-halfMm, jaw.x1);
    const x2 = Math.min(halfMm, jaw.x2);
    const y1 = Math.max(-halfMm, jaw.y1);
    const y2 = Math.min(halfMm, jaw.y2);
    ctx.setLineDash([4 * px, 3 * px]);
    ctx.strokeStyle = BEV_COLORS.jaw;
    ctx.lineWidth = 1.2 * px;
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    ctx.setLineDash([]);
  }

  // 等中心
  ctx.strokeStyle = BEV_COLORS.iso;
  ctx.lineWidth = 1.5 * px;
  ctx.beginPath();
  ctx.moveTo(-6 * px, 0);
  ctx.lineTo(6 * px, 0);
  ctx.moveTo(0, -6 * px);
  ctx.lineTo(0, 6 * px);
  ctx.stroke();

  ctx.restore(); // 視野方框的 clip
  // jaw 名稱（跟著轉）
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = BEV_COLORS.muted;
  const r = halfMm * s + 12;
  for (const [label, ux, uy] of [
    ['X1', -1, 0],
    ['X2', 1, 0],
    ['Y1', 0, -1],
    ['Y2', 0, 1],
  ] as const) {
    const vx = ux * Math.cos(angle) - uy * Math.sin(angle);
    const vy = ux * Math.sin(angle) + uy * Math.cos(angle);
    ctx.fillText(label, cx + vx * r, cy - vy * r);
  }

  // 准直器角度盤（右上）
  const dialR = 13;
  const dx = width - dialR - 8;
  const dy = dialR + 8;
  ctx.strokeStyle = BEV_COLORS.muted;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(dx, dy, dialR, 0, Math.PI * 2);
  ctx.stroke();
  const ca = ((cp.collimator_deg ?? 0) * Math.PI) / 180;
  ctx.strokeStyle = BEV_COLORS.apertureEdge;
  ctx.beginPath();
  ctx.moveTo(dx, dy);
  ctx.lineTo(dx - Math.sin(ca) * dialR, dy - Math.cos(ca) * dialR);
  ctx.stroke();
  ctx.fillStyle = BEV_COLORS.text;
  const colText = `${+(cp.collimator_deg ?? 0).toFixed(1)}°`;
  // 角度寫在角度盤下面、靠右（寫在左邊會壓到照野的角）
  ctx.textAlign = 'right';
  ctx.fillText(width >= 240 ? `${t('准直器')} ${colText}` : colText, width - 6, dy + dialR + 9);

  const areaCm2 = apertureAreaCm2(rects);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = BEV_COLORS.text;
  if (input.title) ctx.fillText(input.title, 8, 6);
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = BEV_COLORS.apertureEdge;
  ctx.fillText(t('開口 {area} cm²', { area: areaCm2.toFixed(1) }), 8, height - 6);
  ctx.restore();
  return { areaCm2 };
}
