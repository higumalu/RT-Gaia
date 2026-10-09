/**
 * 地標對與 TG-132 TRE —— 對位面板裡的一個區塊。
 *
 * 記錄方式（十字線，不另做點擊工具）：在主影像上把十字線放到一個解剖特徵 →「記錄固定點」；切到這組次要影像
 * （資料面板「只看」、棋盤格或並排）把十字線放到**同一個**特徵 →「記錄移動點」。移動點以**目前**的對位換回次要序列
 * 自己的座標存起來，之後 TRE 一律用當下的對位重算 —— 微調時即時看到誤差變化，關掉對位就是未對位的誤差。
 */

import { useState } from 'react';

import type { FrameGroup } from '../../../core';
import { t } from '../../../core/i18n';
import type { ViewerPanelProps } from '../../panels/types';
import { DEFAULT_TRE_THRESHOLD_MM, landmarkCsv, landmarkRows, nextLandmarkLabel, treSummary } from './landmarks';
import { REGISTRATION_MODULE_ID } from './mode';
import { copyText } from '../../components/copyText';

type P3 = readonly [number, number, number];
const fmt3 = (p: P3): string => p.map((v) => v.toFixed(1)).join(', ');

export function LandmarkPairs({ api, fg, primaryUid }: ViewerPanelProps & { fg: FrameGroup; primaryUid: string }): React.JSX.Element {
  const [fixed, setFixed] = useState<P3 | null>(null);
  const [moving, setMoving] = useState<P3 | null>(null);
  const [copied, setCopied] = useState(false);
  const state = api.state.modules[REGISTRATION_MODULE_ID] as { treThresholdMm?: number } | undefined;
  const threshold = state?.treThresholdMm ?? DEFAULT_TRE_THRESHOLD_MM;
  const rows = landmarkRows(api.state.layers, fg.frameOfReferenceUid);
  const summary = treSummary(rows, threshold);

  const commit = (f: P3, m: P3): void => {
    const labels = api.state.layers.flatMap((l) => (l.measurement?.kind === 'landmark' ? [l.measurement.label] : []));
    api.commands.addLandmarkPair({ movingFrameOfReferenceUid: fg.frameOfReferenceUid, moving: m, fixed: f, label: nextLandmarkLabel(labels) });
    setFixed(null);
    setMoving(null);
  };
  const captureFixed = (): void => {
    const w = api.commands.crosshairWorld();
    if (w === null) return;
    if (moving !== null) commit(w, moving);
    else setFixed(w);
  };
  const captureMoving = (): void => {
    const w = api.commands.crosshairWorld();
    const own = w === null ? null : api.commands.worldToFrame(fg.frameOfReferenceUid, w);
    if (own === null) return;
    if (fixed !== null) commit(fixed, own);
    else setMoving(own);
  };

  return (
    <div className="reg-landmarks" data-landmark-count={rows.length}>
      <div className="slab-row">
        <strong>{t('地標對（TG-132 TRE）')}</strong>
        <span className="slab-header-actions">
          <button
            type="button"
            className="reset"
            disabled={rows.length === 0}
            title={t('把地標對與 TRE 複製成 CSV（QA 紀錄用）')}
            onClick={() => {
              void copyText(landmarkCsv(rows, primaryUid, fg.frameOfReferenceUid)).then((ok) => {
                if (!ok) return;
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? t('已複製') : t('複製 CSV')}
          </button>
        </span>
      </div>
      <p className="muted hint">
        {t('主影像上把十字線放到一個解剖特徵 →「記錄固定點」；切到這組次要影像（「只看」、棋盤格或並排）把十字線放到同一個特徵 →「記錄移動點」。TRE 一律用目前的對位重算。')}
      </p>
      <div className="slab-row">
        <button type="button" className={`reset${fixed ? ' is-set' : ''}`} onClick={captureFixed} title={t('記錄十字線目前的位置為固定點（主影像上的特徵）')}>
          {fixed ? `✓ ${t('固定點')} (${fmt3(fixed)})` : t('記錄固定點')}
        </button>
        <button type="button" className={`reset${moving ? ' is-set' : ''}`} onClick={captureMoving} title={t('記錄十字線目前的位置為移動點（次要影像上的同一個特徵）')}>
          {moving ? `✓ ${t('移動點')} (${fmt3(moving)})` : t('記錄移動點')}
        </button>
        {(fixed !== null || moving !== null) && (
          <button type="button" className="reset" onClick={() => { setFixed(null); setMoving(null); }}>
            {t('取消')}
          </button>
        )}
      </div>
      {rows.length > 0 && (
        <>
          <table className="dvh-table reg-landmark-table">
            <thead>
              <tr>
                <th>{t('名稱')}</th>
                <th>TRE (mm)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.measurementId} data-measurement={r.measurementId} className={r.tre > threshold ? 'is-over' : ''} title={t('點一下：十字線移到固定點')} onClick={() => api.commands.moveCrosshair(r.fixed)}>
                  <td>{r.label}</td>
                  <td className="num">{r.tre.toFixed(2)}</td>
                  <td>
                    <button
                      type="button"
                      className="measure-delete"
                      title={t('刪除（可復原）')}
                      onClick={(e) => {
                        e.stopPropagation();
                        api.commands.removeMeasurement(r.measurementId);
                      }}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="slab-row reg-tre-summary">
            <span>{t('{n} 對 · 平均 {mean} · RMS {rms} · 最大 {max} mm', { n: summary.n, mean: summary.mean.toFixed(2), rms: summary.rms.toFixed(2), max: summary.max.toFixed(2) })}</span>
            <label title={t('TG-132 以 TRE 做定量驗證；門檻依機構的 QA 程序設定')}>
              {t('門檻')}
              <input
                type="number"
                className="num"
                min={0.1}
                step={0.5}
                value={threshold}
                onChange={(e) => api.commands.setModuleState(REGISTRATION_MODULE_ID, { treThresholdMm: Math.max(0.1, Number(e.target.value) || DEFAULT_TRE_THRESHOLD_MM) })}
              />
              mm
            </label>
            <span className={summary.over > 0 ? 'reg-tre-over' : 'reg-tre-ok'}>{summary.over > 0 ? t('{n} 對超過門檻', { n: summary.over }) : t('全部在門檻內')}</span>
          </div>
        </>
      )}
    </div>
  );
}
