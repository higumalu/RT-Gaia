/**
 * DVH 圖 ＋ 統計表 —— 可以放進版面格子的面板（`slot:'cell'`），
 * 也被右側設定面板在「圖沒放到格子」時內嵌。**同一時間只有一個實例在抓資料。**
 *
 * 選擇來自 `api.state.modules.dvh`（設定面板寫、這裡讀）。
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { dosePlanName, type Layer } from '../../../core';
import type { ViewerPanelProps } from '../../panels/types';
import {
  curveAlpha,
  curveToCanvas,
  dashFor,
  DVH_MODULE_ID,
  dvhCurvesCsv,
  dvhExportFileName,
  dvhFullCsv,
  dvhPath,
  dvhSelection,
  dvhStamp,
  fmtGy,
  nearestCurve,
  plotBox,
  rgbCss,
  ticks,
  toggleFocus,
  volumeAtDose,
  type DrawnCurve,
  type DvhExportDose,
  type DvhModuleState,
  type DvhResponse,
} from './model';
import { t } from '../../../core/i18n';

const BINS = 200;

type ExportFormat = 'csv-full' | 'csv-curves' | 'png';

export function tooltipPlacement(x: number, y: number, width: number): React.CSSProperties {
  const top = y + 10;
  return x > width / 2 ? { right: width - x + 10, top, maxWidth: Math.max(140, x - 14) } : { left: x + 10, top, maxWidth: Math.max(140, width - x - 14) };
}

function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** PNG：圖 ＋ 圖例（顏色、結構、劑量；部分覆蓋標「下限」）＋ 抬頭（不匿名時有病歷號）。 */
function composePng(chart: HTMLCanvasElement, rows: readonly { color: string; text: string; partial: boolean; dash: readonly number[] }[], header: string): Promise<Blob | null> {
  const scale = 2;
  const font = '11px system-ui, sans-serif';
  const chartW = chart.clientWidth || 300;
  const h = chart.clientHeight || 220;
  const rowH = 16;
  const headH = 20;
  // 圖例比圖寬（側欄很窄時）就把整張加寬，圖例不截字
  const probe = document.createElement('canvas').getContext('2d');
  if (probe) probe.font = font;
  const textW = Math.max(probe ? probe.measureText(header).width + 12 : 0, ...rows.map((r) => (probe ? probe.measureText(r.text).width + 40 : 0)));
  const w = Math.ceil(Math.max(chartW, textW));
  const out = document.createElement('canvas');
  out.width = w * scale;
  out.height = (headH + h + rows.length * rowH + 8) * scale;
  const ctx = out.getContext('2d');
  if (!ctx) return Promise.resolve(null);
  ctx.scale(scale, scale);
  ctx.fillStyle = '#1b1e23';
  ctx.fillRect(0, 0, w, out.height / scale);
  ctx.fillStyle = '#e6e6e6';
  ctx.font = font;
  ctx.textAlign = 'left';
  ctx.fillText(header, 6, 14);
  ctx.drawImage(chart, 0, headH, chartW, h);
  rows.forEach((r, i) => {
    const y = headH + h + 4 + i * rowH;
    ctx.globalAlpha = r.partial ? 0.5 : 1;
    ctx.strokeStyle = r.color;
    ctx.lineWidth = 2;
    ctx.setLineDash([...r.dash]);
    ctx.beginPath();
    ctx.moveTo(6, y + 8);
    ctx.lineTo(26, y + 8);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#e6e6e6';
    ctx.fillText(r.text, 32, y + 12);
  });
  return new Promise((resolve) => out.toBlob(resolve, 'image/png'));
}

/** 表格用的短標籤：日期（沒有就序號）；完整名稱放 title。 */
export function doseShort(layer: Layer, index: number): string {
  const date = layer.seriesMeta?.['series_date'];
  return typeof date === 'string' && date.length >= 8 ? `${date.slice(4, 6)}-${date.slice(6, 8)}` : `#${index + 1}`;
}

export function doseTitle(layer: Layer): string {
  const date = layer.seriesMeta?.['series_date'];
  const d = typeof date === 'string' && date.length >= 8 ? ` ${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : '';
  const plan = dosePlanName(layer);
  return `${plan || layer.label}${d}`;
}

export function DvhChart({ api }: ViewerPanelProps): React.JSX.Element {
  const { layers } = api.state;
  const doses = useMemo(() => layers.filter((l) => l.kind === 'dose'), [layers]);
  const sel = useMemo(() => dvhSelection(layers, api.state.modules[DVH_MODULE_ID] as DvhModuleState | undefined), [layers, api.state.modules]);
  const [results, setResults] = useState<Record<string, DvhResponse>>({});
  const [loading, setLoading] = useState(false);
  // 單位問題是「這份資料不能算」，不是系統錯誤 —— 顯示在面板，不進全域 error
  const [unitProblem, setUnitProblem] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // 強調哪個結構（所有劑量的那條都強調）、滑鼠指著哪條、匯出設定
  const [focused, setFocused] = useState<string | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number; curve: DrawnCurve } | null>(null);
  const [anonymized, setAnonymized] = useState(true);
  const [exporting, setExporting] = useState(false);
  const drawnRef = useRef<DrawnCurve[]>([]);
  const { http } = api;
  const { setError } = api.commands;
  const key = `${sel.doseIds.join('|')}#${sel.structureIds.join('|')}#${sel.referenceGy}`;

  useEffect(() => {
    if (sel.doseIds.length === 0 || sel.structureIds.length === 0) {
      setResults({});
      setUnitProblem(null);
      return;
    }
    let cancelled = false;
    // 連續勾幾個結構只打一次（BODY 那種 680 萬體素的結構一次要 1 s 多）
    const timer = setTimeout(() => {
      setLoading(true);
      void Promise.all(
        sel.doseIds.map((sid) =>
          http.getJson<DvhResponse>(dvhPath(sid, sel.structureIds, { bins: BINS, referenceGy: sel.referenceGy })).then((r) => [sid, r] as const),
        ),
      )
        .then((pairs) => {
          if (!cancelled) {
            setResults(Object.fromEntries(pairs));
            setUnitProblem(null);
          }
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          const msg = e instanceof Error ? e.message : String(e);
          if (/DOSE_UNITS_UNSUPPORTED|DOSE_SCALING_INVALID/.test(msg)) {
            setResults({});
            setUnitProblem(/DOSE_SCALING_INVALID/.test(msg) ? t('這個 RTDOSE 的 DoseGridScaling 不是正的有限值，無法換算成 Gy。') : t('這個劑量的單位不是 Gy（DoseUnits 非 GY），無法計算 DVH。'));
          } else {
            setError(t('DVH：{msg}', { msg }));
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, http, setError]);

  const xMax = Math.max(0, ...Object.values(results).map((r) => r.dose_max_gy));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 300;
    const h = canvas.clientHeight || 220;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const box = plotBox(w, h);
    ctx.strokeStyle = '#3a3f47';
    ctx.fillStyle = '#9aa0a6';
    ctx.font = '10px system-ui, sans-serif';
    ctx.lineWidth = 1;
    for (const t of ticks(xMax)) {
      const x = box.left + (xMax > 0 ? t / xMax : 0) * box.width;
      ctx.beginPath();
      ctx.moveTo(x, box.top);
      ctx.lineTo(x, box.top + box.height);
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.fillText(t.toFixed(t % 1 === 0 ? 0 : 1), x, box.top + box.height + 12);
    }
    for (const p of [0, 20, 40, 60, 80, 100]) {
      const y = box.top + (1 - p / 100) * box.height;
      ctx.beginPath();
      ctx.moveTo(box.left, y);
      ctx.lineTo(box.left + box.width, y);
      ctx.stroke();
      ctx.textAlign = 'right';
      ctx.fillText(`${p}`, box.left - 4, y + 3);
    }
    ctx.textAlign = 'center';
    ctx.fillText('Gy', box.left + box.width / 2, h - 2);
    ctx.save();
    ctx.translate(9, box.top + box.height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(t('% 體積'), 0, 0);
    ctx.restore();
    if (sel.referenceGy > 0 && xMax > 0) {
      const x = box.left + Math.min(1, sel.referenceGy / xMax) * box.width;
      ctx.strokeStyle = '#e8a33c';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, box.top);
      ctx.lineTo(x, box.top + box.height);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const drawn: DrawnCurve[] = [];
    sel.doseIds.forEach((sid, di) => {
      const r = results[sid];
      if (!r) return;
      for (const s of r.structures) {
        const pts = curveToCanvas(r.edges_gy, s.cumulative_pct, box, xMax);
        if (pts.length === 0) continue;
        drawn.push({ doseId: sid, structureId: s.structure_id, points: pts });
        ctx.globalAlpha = curveAlpha(s.structure_id, focused, s.partial === true);
        ctx.lineWidth = focused === s.structure_id ? 2.5 : 1.5;
        ctx.strokeStyle = rgbCss(s.color_rgb);
        ctx.setLineDash([...dashFor(di)]);
        ctx.beginPath();
        ctx.moveTo(pts[0]![0], pts[0]![1]);
        for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i]![0], pts[i]![1]);
        ctx.stroke();
      }
    });
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
    drawnRef.current = drawn;
  }, [results, xMax, sel, focused]);

  // 結構不在選取裡了就取消強調
  useEffect(() => {
    if (focused !== null && !sel.structureIds.includes(focused)) setFocused(null);
  }, [focused, sel.structureIds]);

  const pointerAt = (e: React.MouseEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const doseLabel = (sid: string, anon: boolean): string => {
    const di = sel.doseIds.indexOf(sid);
    const dose = doses.find((d) => d.contentRef === sid);
    if (!dose) return `#${di + 1}`;
    return anon ? doseShort(dose, di) : doseTitle(dose);
  };

  const runExport = async (format: ExportFormat): Promise<void> => {
    const ready = sel.doseIds.filter((sid) => results[sid] !== undefined);
    if (ready.length === 0) return;
    setExporting(true);
    try {
      // 資料離開系統前先登記稽核（每個劑量一筆）；登記失敗就不下載
      for (const sid of ready) {
        await http.postJson(`/dose/${encodeURIComponent(sid)}/dvh/export`, { format, structure_ids: sel.structureIds, anonymized });
      }
      const first = doses.find((d) => d.contentRef === ready[0]);
      const pid = first?.seriesMeta?.['patient_id'];
      const meta = { anonymized, patientId: typeof pid === 'string' && pid ? pid : null, referenceGy: sel.referenceGy, exportedAt: new Date() };
      const items: DvhExportDose[] = ready.map((sid) => ({ doseId: sid, label: doseLabel(sid, anonymized), response: results[sid]! }));
      if (format === 'png') {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rows = items.flatMap((it) =>
          it.response.structures.map((s) => ({
            color: rgbCss(s.color_rgb),
            text: `${s.name} · ${it.label}${s.partial ? ` · ${t('下限（部分在劑量網格外）')}` : ''}`,
            partial: s.partial === true,
            dash: dashFor(sel.doseIds.indexOf(it.doseId)),
          })),
        );
        const header = ['DVH', meta.patientId && !anonymized ? meta.patientId : '', dvhStamp(meta.exportedAt)].filter((x) => x).join(' · ');
        const blob = await composePng(canvas, rows, header);
        if (blob) saveBlob(blob, dvhExportFileName(meta, 'png'));
      } else {
        const text = format === 'csv-full' ? dvhFullCsv(items, meta) : dvhCurvesCsv(items);
        // BOM：Excel 才認得 UTF-8（結構名稱可能是中文）
        saveBlob(new Blob(['\ufeff', text], { type: 'text/csv;charset=utf-8' }), dvhExportFileName(meta, 'csv', format === 'csv-curves' ? 'curves' : undefined));
      }
    } catch (e) {
      setError(t('DVH 匯出：{msg}', { msg: e instanceof Error ? e.message : String(e) }));
    } finally {
      setExporting(false);
    }
  };

  const hovered = hover ? results[hover.curve.doseId]?.structures.find((s) => s.structure_id === hover.curve.structureId) : undefined;
  const hoverResp = hover ? results[hover.curve.doseId] : undefined;

  if (doses.length === 0) return <p className="muted hint" style={{ padding: '6px 10px' }}>{t('這個病例沒有劑量。')}</p>;
  if (sel.doseIds.length === 0 || sel.structureIds.length === 0) {
    return <p className="muted hint" style={{ padding: '6px 10px' }}>{t('到右側「DVH」面板選劑量與結構。')}</p>;
  }
  if (unitProblem !== null) {
    return <p className="muted hint dvh-unit-problem" style={{ padding: '6px 10px' }}>{unitProblem}</p>;
  }
  return (
    <div className="dvh-chart">
      {loading && <span className="muted dvh-loading">{t('計算中…')}</span>}
      <div className="dvh-export-bar">
        <label className="sub" title={t('勾：檔名與內容不含病歷號與計畫名稱；不勾：帶病歷號（與匯出面板的匿名化同一個意思）')}>
          <input type="checkbox" checked={anonymized} onChange={(e) => setAnonymized(e.target.checked)} /> {t('匿名化')}
        </label>
        <button type="button" disabled={exporting || loading} onClick={() => void runExport('csv-full')} title={t('CSV：指標表 ＋ 曲線（含匯出時間、參考劑量）')}>
          {t('CSV（完整）')}
        </button>
        <button type="button" disabled={exporting || loading} onClick={() => void runExport('csv-curves')} title={t('CSV：只有曲線四欄（結構、劑量、Gy、% 體積），方便匯入其他軟體')}>
          {t('CSV（曲線）')}
        </button>
        <button type="button" disabled={exporting || loading} onClick={() => void runExport('png')} title={t('PNG：圖 ＋ 圖例')}>
          PNG
        </button>
      </div>
      <div className="dvh-canvas-wrap">
        <canvas
          ref={canvasRef}
          className="dvh-canvas"
          onMouseMove={(e) => {
            const p = pointerAt(e);
            const c = nearestCurve(drawnRef.current, p.x, p.y);
            setHover(c ? { ...p, curve: c } : null);
          }}
          onMouseLeave={() => setHover(null)}
          onClick={(e) => {
            const p = pointerAt(e);
            const c = nearestCurve(drawnRef.current, p.x, p.y);
            // 點空白處也取消強調（再點一次同一條也是）
            setFocused((f) => (c ? toggleFocus(f, c.structureId) : null));
          }}
          style={{ cursor: hover ? 'pointer' : 'default' }}
        />
        {hover && hovered && hoverResp && (
          <div
            className="dvh-tooltip"
            // 往游標比較寬的那一側長、寬度不超過那一側 —— 側欄很窄時也不會被格子邊緣切掉（字會換行）
            style={tooltipPlacement(hover.x, hover.y, canvasRef.current?.clientWidth ?? 300)}
          >
            <strong>{hovered.name}</strong> · {doseLabel(hover.curve.doseId, false)}
            <br />
            {(() => {
              const box = plotBox(canvasRef.current?.clientWidth || 300, canvasRef.current?.clientHeight || 220);
              const gy = Math.max(0, ((hover.x - box.left) / box.width) * xMax);
              return t('{gy} Gy → {pct}% 體積', { gy: gy.toFixed(2), pct: volumeAtDose(hoverResp.edges_gy, hovered.cumulative_pct, gy).toFixed(1) });
            })()}
            <br />
            {hovered.volume_cc.toFixed(1)} cc · Dmean {fmtGy(hovered.dmean_gy)} · Dmax {fmtGy(hovered.dmax_gy)} · D95 {fmtGy(hovered.d95_gy)}
            {hovered.partial && (
              <>
                <br />
                <span className="warning-text">{t('下限：{p0}% 在劑量網格外', { p0: (hovered.outside_fraction * 100).toFixed(1) })}</span>
              </>
            )}
          </div>
        )}
      </div>
      <div className="dvh-table-wrap">
        <table className="dvh-table">
          <thead>
            <tr>
              <th>{t('結構')}</th>
              <th>{t('劑量')}</th>
              <th>cc</th>
              <th>Dmin</th>
              <th>Dmean</th>
              <th>Dmax</th>
              <th>D98</th>
              <th>D95</th>
              <th>D50</th>
              <th>D2</th>
              {sel.referenceGy > 0 && <th>V{sel.referenceGy}</th>}
            </tr>
          </thead>
          <tbody>
            {sel.doseIds.flatMap((sid, di) => {
              const r = results[sid];
              const dose = doses.find((d) => d.contentRef === sid);
              if (!r || !dose) return [];
              return r.structures.map((s) => (
                <tr
                  key={`${sid}/${s.structure_id}`}
                  className={[focused === s.structure_id ? 'focused' : '', focused !== null && focused !== s.structure_id ? 'dimmed' : ''].filter((x) => x).join(' ') || undefined}
                  onClick={() => setFocused((f) => toggleFocus(f, s.structure_id))}
                  title={
                    s.partial
                      ? t('{p0}% 體素落在劑量網格外：那部分的劑量未知，曲線是下限、整體統計不顯示（Dmax 只看網格內）', { p0: (s.outside_fraction * 100).toFixed(1) })
                      : t('點一下強調這條曲線，再點一次恢復')
                  }
                >
                  <td>
                    <span className="dvh-swatch" style={{ background: rgbCss(s.color_rgb) }} /> {s.name}
                    {s.partial && (
                      <span className="badge badge-unregistered" title={t('部分落在劑量網格外')}>
                        {' '}
                        {t('外', { ctx: '劑量網格' })}
                      </span>
                    )}
                  </td>
                  <td title={doseTitle(dose)}>
                    <span className="dvh-dash" data-dash={di % 4} /> {doseShort(dose, di)}
                  </td>
                  <td>{s.volume_cc.toFixed(1)}</td>
                  <td>{fmtGy(s.dmin_gy)}</td>
                  <td>{fmtGy(s.dmean_gy)}</td>
                  <td>{fmtGy(s.dmax_gy)}</td>
                  <td>{fmtGy(s.d98_gy)}</td>
                  <td>{fmtGy(s.d95_gy)}</td>
                  <td>{fmtGy(s.d50_gy)}</td>
                  <td>{fmtGy(s.d2_gy)}</td>
                  {sel.referenceGy > 0 && <td>{s.v_ref_pct === null ? '–' : `${s.v_ref_pct.toFixed(1)}%`}</td>}
                </tr>
              ));
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
