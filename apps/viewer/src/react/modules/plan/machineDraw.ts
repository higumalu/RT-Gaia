/**
 * 機架／治療床示意：一張 2D canvas，左邊正面（從床尾看）、右邊俯視；跟著控制點的機架、准直器、床角動。
 *
 * 正面：環型機畫一圈機殼（Halcyon 的孔徑 100 cm、射源在 100 cm）、C 臂畫旋轉路徑與 C 形的臂；機頭在機架角、到等中心畫一個射束錐；
 * 病人（仰臥／俯臥）與床面（床高 ＝ IEC 床面相對等中心）。俯視：機架在上方、床繞等中心轉床角，病人頭朝機架（頭先進）或反過來。
 * 只是示意：比例粗略、不做碰撞檢查。
 */

import { headPosition, type MachineKind, type MachinePose } from './model';
import { t } from '../../../core/i18n';

const C = {
  bg: '#0b0d10',
  housing: '#2c323a',
  housingEdge: '#4b5563',
  path: '#4b5563',
  head: '#c8ccd2',
  beam: 'rgba(255, 224, 102, 0.25)',
  beamEdge: '#ffe066',
  couch: '#5b6573',
  patient: 'rgba(140, 190, 140, 0.55)',
  patientEdge: '#8cbe8c',
  text: '#e5e7eb',
  muted: '#9aa0a6',
  iso: '#f4c542',
} as const;

const SAD_MM = 1000;
const COUCH_WIDTH_MM = 530;
const COUCH_LENGTH_MM = 2000;
const COUCH_THICK_MM = 50;

export interface MachineDrawInput {
  readonly kind: MachineKind;
  readonly pose: MachinePose;
  /** HFS／HFP／FFS／FFP。 */
  readonly position: string;
  readonly dpr?: number;
  /** 正面在上、俯視在下（放在 BEV 右邊的窄欄）；預設左右並排。 */
  readonly vertical?: boolean;
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string = C.muted): void {
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

export function drawMachine(ctx: CanvasRenderingContext2D, width: number, height: number, input: MachineDrawInput): void {
  const dpr = input.dpr ?? 1;
  const { pose, kind, position } = input;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, width, height);
  ctx.font = '11px system-ui, sans-serif';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  // 兩個窗格：左右並排，或上下（窄欄；最下面留 16 px 給讀數）
  const paneH = input.vertical ? (height - 16) / 2 : height;
  const front = { x: 0, y: 0, w: input.vertical ? width : width / 2, h: paneH };
  const top = input.vertical ? { x: 0, y: paneH, w: width, h: paneH } : { x: width / 2, y: 0, w: width / 2, h: height };
  const prone = position.endsWith('P');
  const feetFirst = position.startsWith('FF');

  // ── 正面（從床尾看）──────────────────────────────────────────────────────
  {
    const cx = front.x + front.w / 2;
    const cy = front.y + front.h / 2 + 6;
    const R = Math.min(front.w / 2, front.h / 2) * 0.78; // 射源距離（SAD）
    const mm = R / SAD_MM;
    if (kind === 'ring') {
      // 機殼：孔徑半徑 500 mm、外徑 1200 mm
      ctx.fillStyle = C.housing;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.2, 0, Math.PI * 2);
      ctx.arc(cx, cy, R * 0.5, 0, Math.PI * 2, true);
      ctx.fill();
      ctx.strokeStyle = C.housingEdge;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 0.5, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.strokeStyle = C.path;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      // C 形的臂：從機頭往外、繞到對側（配重那側）
      const a0 = ((pose.gantry - 90) * Math.PI) / 180;
      ctx.strokeStyle = C.housingEdge;
      ctx.lineWidth = Math.max(4, R * 0.09);
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.22, a0, a0 + Math.PI);
      ctx.stroke();
      ctx.lineWidth = 1;
    }
    const head = headPosition(pose.gantry, R);
    const hx = cx + head.x;
    const hy = cy - head.y;
    // 射束錐（示意寬 ±100 mm 在等中心）
    const a = (pose.gantry * Math.PI) / 180;
    const px = Math.cos(a);
    const py = Math.sin(a);
    const w = 100 * mm;
    ctx.fillStyle = C.beam;
    ctx.strokeStyle = C.beamEdge;
    ctx.beginPath();
    ctx.moveTo(hx, hy);
    ctx.lineTo(cx + px * w, cy + py * w);
    ctx.lineTo(cx - px * w, cy - py * w);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // 床（床角改變投影寬度）與病人
    const phi = (pose.couch * Math.PI) / 180;
    const couchW = (COUCH_WIDTH_MM * Math.abs(Math.cos(phi)) + COUCH_LENGTH_MM * Math.abs(Math.sin(phi))) * mm;
    const top = cy - pose.tableVerticalMm * mm; // 床高負 ＝ 在等中心下方 ＝ 畫面往下
    ctx.fillStyle = C.couch;
    ctx.fillRect(cx - Math.min(couchW, R * 2.2) / 2, top, Math.min(couchW, R * 2.2), COUCH_THICK_MM * mm);
    ctx.fillStyle = C.patient;
    ctx.strokeStyle = C.patientEdge;
    const pw = 360 * mm;
    const ph = 230 * mm;
    ctx.beginPath();
    ctx.ellipse(cx, top - ph / 2, pw / 2, ph / 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // 前方（鼻子）的記號：仰臥在上、俯臥在下（貼床）
    ctx.fillStyle = C.patientEdge;
    ctx.beginPath();
    ctx.arc(cx, prone ? top - 3 : top - ph + 3, 2.5, 0, Math.PI * 2);
    ctx.fill();
    // 機頭（准直器角只寫在讀數：正面圖看不出繞射束軸的轉動）
    ctx.save();
    ctx.translate(hx, hy);
    ctx.rotate(a);
    ctx.fillStyle = C.head;
    const hw = Math.max(10, R * 0.2);
    const hh = Math.max(7, R * 0.12);
    ctx.fillRect(-hw / 2, -hh, hw, hh);
    ctx.restore();
    ctx.strokeStyle = C.iso;
    ctx.beginPath();
    ctx.moveTo(cx - 4, cy);
    ctx.lineTo(cx + 4, cy);
    ctx.moveTo(cx, cy - 4);
    ctx.lineTo(cx, cy + 4);
    ctx.stroke();
    label(ctx, t('正面（從床尾看）'), front.x + 6, front.y + 4);
  }

  // ── 俯視 ─────────────────────────────────────────────────────────────────
  {
    const cx = top.x + top.w / 2;
    const cy = top.y + top.h * 0.42;
    // 床 2 m、往床尾伸 70% → 1.4 R 要放得下；機架在上方 0.9 R
    const R = Math.max(10, Math.min(top.w / 2, (top.y + top.h - cy - (input.vertical ? 4 : 18)) / 1.4, (cy - top.y - 16) / 0.9));
    const mm = R / SAD_MM;
    // 機架在上方（+Y 往機架 ＝ 畫面往上）
    ctx.fillStyle = C.housing;
    const gy = cy - R * 0.55;
    if (kind === 'ring') {
      ctx.fillRect(cx - R * 1.2, gy - R * 0.35, R * 2.4, R * 0.35);
      ctx.fillStyle = C.bg;
      ctx.fillRect(cx - R * 0.5, gy - R * 0.36, R, R * 0.37); // 孔
    } else {
      ctx.fillRect(cx - R * 0.45, gy - R * 0.55, R * 0.9, R * 0.3);
      // 機頭的投影位置（機架角的 x 分量）
      const head = headPosition(pose.gantry, R);
      ctx.fillStyle = C.head;
      ctx.fillRect(cx + head.x - R * 0.08, gy - R * 0.25, R * 0.16, R * 0.25);
    }
    // 床：繞等中心轉床角（從上看逆時針為正）；床從等中心往機架伸 30%、往床尾 70%
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((-pose.couch * Math.PI) / 180);
    const L = COUCH_LENGTH_MM * mm;
    const W = COUCH_WIDTH_MM * mm;
    ctx.fillStyle = C.couch;
    ctx.fillRect(-W / 2, -L * 0.3, W, L);
    // 病人：頭先進 → 頭在機架那端
    ctx.fillStyle = C.patient;
    ctx.strokeStyle = C.patientEdge;
    const bodyL = 1700 * mm;
    const headEnd = feetFirst ? L * 0.6 : -L * 0.25;
    ctx.beginPath();
    ctx.ellipse(0, headEnd + (feetFirst ? -bodyL / 2 : bodyL / 2), 170 * mm, bodyL / 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = C.patientEdge;
    ctx.beginPath();
    ctx.arc(0, headEnd, 110 * mm, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = C.iso;
    ctx.beginPath();
    ctx.moveTo(cx - 4, cy);
    ctx.lineTo(cx + 4, cy);
    ctx.moveTo(cx, cy - 4);
    ctx.lineTo(cx, cy + 4);
    ctx.stroke();
    label(ctx, t('俯視'), top.x + 6, top.y + 4);
  }

  ctx.textBaseline = 'bottom';
  label(
    ctx,
    t('機架 {g}° · 床 {c}° · 准直器 {k}°', { g: +pose.gantry.toFixed(1), c: +pose.couch.toFixed(1), k: +pose.collimator.toFixed(1) }),
    6,
    height - 4,
    C.text,
  );
  ctx.restore();
}
