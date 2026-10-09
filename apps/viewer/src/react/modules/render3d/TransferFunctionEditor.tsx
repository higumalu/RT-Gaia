/**
 * Scalar opacity／color mapping 編輯器（對照 Slicer Volume Rendering）。
 *
 * 上：體素值（x）× 不透明度（y）的折線，底下畫直方圖（對數尺度）；拖控制點、雙擊空白加點、選中按 Delete 刪。
 * 下：色帶 ＋ 色彩控制點（拖橫向移、點一下改顏色、雙擊色帶加點、Delete 刪）。
 */

import { useEffect, useRef, useState } from 'react';

import {
  addColorPoint,
  addOpacityPoint,
  evalColor,
  hexToRgb,
  removeColorPoint,
  removeOpacityPoint,
  rgbToHex,
  withColorPoint,
  withOpacityPoint,
  type TransferFunction,
} from './transferFunction';
import { t } from '../../../core/i18n';

export interface TfEditorProps {
  readonly tf: TransferFunction;
  readonly range: [number, number];
  readonly histogram: { counts: number[]; min: number; max: number } | null;
  readonly onChange: (tf: TransferFunction) => void;
}

const W = 268;
const H = 120;
const PAD = 6;
const BAR_H = 18;
const HIT = 7;

export function TransferFunctionEditor({ tf, range, histogram, onChange }: TfEditorProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const barRef = useRef<HTMLCanvasElement | null>(null);
  const colorInputRef = useRef<HTMLInputElement | null>(null);
  const [selected, setSelected] = useState<{ kind: 'opacity' | 'color'; index: number } | null>(null);
  const drag = useRef<{ kind: 'opacity' | 'color'; index: number } | null>(null);
  const [lo, hi] = range;
  const xToPx = (x: number) => PAD + ((x + tf.shift - lo) / (hi - lo)) * (W - 2 * PAD);
  const pxToX = (px: number) => lo + ((px - PAD) / (W - 2 * PAD)) * (hi - lo) - tf.shift;
  const aToPy = (a: number) => PAD + (1 - a) * (H - 2 * PAD);
  const pyToA = (py: number) => Math.max(0, Math.min(1, 1 - (py - PAD) / (H - 2 * PAD)));

  useEffect(() => {
    const c = canvasRef.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = W * dpr;
    c.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#15171b';
    ctx.fillRect(0, 0, W, H);
    // 直方圖（對數）
    if (histogram && histogram.counts.length > 0) {
      const n = histogram.counts.length;
      const maxLog = Math.log1p(Math.max(...histogram.counts));
      ctx.fillStyle = '#2e3440';
      for (let i = 0; i < n; i += 1) {
        const x0 = histogram.min + ((histogram.max - histogram.min) * i) / n;
        const x1 = histogram.min + ((histogram.max - histogram.min) * (i + 1)) / n;
        const px0 = PAD + ((x0 - lo) / (hi - lo)) * (W - 2 * PAD);
        const px1 = PAD + ((x1 - lo) / (hi - lo)) * (W - 2 * PAD);
        const hgt = maxLog > 0 ? (Math.log1p(histogram.counts[i]!) / maxLog) * (H - 2 * PAD) : 0;
        ctx.fillRect(px0, H - PAD - hgt, Math.max(1, px1 - px0), hgt);
      }
    }
    // 折線下的顏色填充
    const pts = [...tf.opacity].sort((p, q) => p.x - q.x);
    if (pts.length > 0) {
      const grad = ctx.createLinearGradient(PAD, 0, W - PAD, 0);
      for (let i = 0; i <= 16; i += 1) {
        const x = lo + ((hi - lo) * i) / 16;
        const [r, g, b] = evalColor(tf, x);
        grad.addColorStop(i / 16, `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},0.35)`);
      }
      ctx.beginPath();
      ctx.moveTo(PAD, H - PAD);
      ctx.lineTo(Math.max(PAD, xToPx(pts[0]!.x)), aToPy(pts[0]!.a));
      for (const p of pts) ctx.lineTo(Math.min(W - PAD, Math.max(PAD, xToPx(p.x))), aToPy(p.a));
      ctx.lineTo(W - PAD, aToPy(pts[pts.length - 1]!.a));
      ctx.lineTo(W - PAD, H - PAD);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.strokeStyle = '#f4c542';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(PAD, aToPy(pts[0]!.a));
      for (const p of pts) ctx.lineTo(Math.min(W - PAD, Math.max(PAD, xToPx(p.x))), aToPy(p.a));
      ctx.lineTo(W - PAD, aToPy(pts[pts.length - 1]!.a));
      ctx.stroke();
      tf.opacity.forEach((p, i) => {
        const sel = selected?.kind === 'opacity' && selected.index === i;
        ctx.beginPath();
        ctx.arc(xToPx(p.x), aToPy(p.a), sel ? 5 : 4, 0, Math.PI * 2);
        ctx.fillStyle = sel ? '#7ee0a0' : '#1d1f24';
        ctx.fill();
        ctx.strokeStyle = sel ? '#7ee0a0' : '#f4c542';
        ctx.stroke();
      });
    }
    // 軸標
    ctx.fillStyle = '#9aa0a6';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(String(lo), PAD, H - 1);
    ctx.textAlign = 'right';
    ctx.fillText(String(hi), W - PAD, H - 1);
    // 色帶
    const bar = barRef.current;
    const bctx = bar?.getContext('2d');
    if (bar && bctx) {
      bar.width = W * dpr;
      bar.height = BAR_H * dpr;
      bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const g = bctx.createLinearGradient(PAD, 0, W - PAD, 0);
      for (let i = 0; i <= 32; i += 1) {
        const x = lo + ((hi - lo) * i) / 32;
        const [r, gg, b] = evalColor(tf, x);
        g.addColorStop(i / 32, `rgb(${Math.round(r * 255)},${Math.round(gg * 255)},${Math.round(b * 255)})`);
      }
      bctx.fillStyle = '#15171b';
      bctx.fillRect(0, 0, W, BAR_H);
      bctx.fillStyle = g;
      bctx.fillRect(PAD, 2, W - 2 * PAD, BAR_H - 4);
      tf.color.forEach((p, i) => {
        const sel = selected?.kind === 'color' && selected.index === i;
        const px = Math.min(W - PAD, Math.max(PAD, xToPx(p.x)));
        bctx.beginPath();
        bctx.moveTo(px, 1);
        bctx.lineTo(px - 5, BAR_H - 1);
        bctx.lineTo(px + 5, BAR_H - 1);
        bctx.closePath();
        bctx.fillStyle = rgbToHex(p.r, p.g, p.b);
        bctx.fill();
        bctx.strokeStyle = sel ? '#7ee0a0' : '#fff';
        bctx.lineWidth = sel ? 2 : 1;
        bctx.stroke();
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tf, range, histogram, selected, lo, hi]);

  const local = (e: React.PointerEvent | React.MouseEvent, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * (el === barRef.current ? BAR_H : H) };
  };
  const hitOpacity = (px: number, py: number): number => {
    let best = -1;
    let bd = HIT;
    tf.opacity.forEach((p, i) => {
      const d = Math.hypot(xToPx(p.x) - px, aToPy(p.a) - py);
      if (d <= bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  };
  const hitColor = (px: number): number => {
    let best = -1;
    let bd = HIT;
    tf.color.forEach((p, i) => {
      const d = Math.abs(xToPx(p.x) - px);
      if (d <= bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  };

  useEffect(() => {
    if (drag.current === null) return undefined;
    const move = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      if (d.kind === 'opacity' && canvasRef.current) {
        const r = canvasRef.current.getBoundingClientRect();
        const px = ((e.clientX - r.left) / r.width) * W;
        const py = ((e.clientY - r.top) / r.height) * H;
        onChange(withOpacityPoint(tf, d.index, { x: Math.round(pxToX(px)), a: pyToA(py) }));
      } else if (d.kind === 'color' && barRef.current) {
        const r = barRef.current.getBoundingClientRect();
        const px = ((e.clientX - r.left) / r.width) * W;
        const p = tf.color[d.index]!;
        onChange(withColorPoint(tf, d.index, { ...p, x: Math.round(pxToX(px)) }));
      }
    };
    const up = () => {
      drag.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  });

  const selectedOpacity = selected?.kind === 'opacity' ? tf.opacity[selected.index] : undefined;
  const selectedColor = selected?.kind === 'color' ? tf.color[selected.index] : undefined;

  return (
    <div
      className="tf-editor"
      tabIndex={0}
      onKeyDown={(e) => {
        if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
          onChange(selected.kind === 'opacity' ? removeOpacityPoint(tf, selected.index) : removeColorPoint(tf, selected.index));
          setSelected(null);
          e.preventDefault();
        }
      }}
    >
      <div className="muted tf-title">Scalar opacity mapping</div>
      <canvas
        ref={canvasRef}
        className="tf-canvas"
        style={{ width: W, height: H }}
        onPointerDown={(e) => {
          const { x, y } = local(e, e.currentTarget);
          const i = hitOpacity(x, y);
          if (i >= 0) {
            setSelected({ kind: 'opacity', index: i });
            drag.current = { kind: 'opacity', index: i };
          } else setSelected(null);
          e.preventDefault();
        }}
        onDoubleClick={(e) => {
          const { x, y } = local(e, e.currentTarget);
          if (hitOpacity(x, y) >= 0) return;
          onChange(addOpacityPoint(tf, { x: Math.round(pxToX(x)), a: pyToA(y) }));
        }}
        title={t('拖控制點；雙擊空白加點；選中按 Delete 刪')}
      />
      <div className="muted tf-title">Scalar color mapping</div>
      <canvas
        ref={barRef}
        className="tf-bar"
        style={{ width: W, height: BAR_H }}
        onPointerDown={(e) => {
          const { x } = local(e, e.currentTarget);
          const i = hitColor(x);
          if (i >= 0) {
            setSelected({ kind: 'color', index: i });
            drag.current = { kind: 'color', index: i };
          } else setSelected(null);
          e.preventDefault();
        }}
        onDoubleClick={(e) => {
          const { x } = local(e, e.currentTarget);
          if (hitColor(x) >= 0) {
            colorInputRef.current?.click();
            return;
          }
          onChange(addColorPoint(tf, Math.round(pxToX(x))));
        }}
        title={t('拖色標移動；雙擊色標改顏色；雙擊空白加色標；選中按 Delete 刪')}
      />
      <div className="tf-row">
        {selectedOpacity && (
          <>
            <span className="muted">{t('點')}</span>
            <input type="number" className="num" value={Math.round(selectedOpacity.x)} onChange={(e) => onChange(withOpacityPoint(tf, selected!.index, { x: Number(e.target.value), a: selectedOpacity.a }))} />
            <span className="muted">α</span>
            <input type="number" className="num" step={0.05} min={0} max={1} value={Number(selectedOpacity.a.toFixed(2))} onChange={(e) => onChange(withOpacityPoint(tf, selected!.index, { x: selectedOpacity.x, a: Number(e.target.value) }))} />
          </>
        )}
        {selectedColor && (
          <>
            <span className="muted">{t('色標')}</span>
            <input type="number" className="num" value={Math.round(selectedColor.x)} onChange={(e) => onChange(withColorPoint(tf, selected!.index, { ...selectedColor, x: Number(e.target.value) }))} />
            <input
              ref={colorInputRef}
              type="color"
              value={rgbToHex(selectedColor.r, selectedColor.g, selectedColor.b)}
              onChange={(e) => {
                const [r, g, b] = hexToRgb(e.target.value);
                onChange(withColorPoint(tf, selected!.index, { ...selectedColor, r, g, b }));
              }}
            />
          </>
        )}
        {!selectedOpacity && !selectedColor && <span className="muted hint">{t('點一個控制點來改數值或顏色')}</span>}
      </div>
    </div>
  );
}
