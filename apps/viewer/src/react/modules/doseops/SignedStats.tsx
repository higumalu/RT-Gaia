/**
 * 差值統計：差值不畫 DVH 曲線（「體積接受 ≥ x Gy」對負的劑量沒有意義），改列整體與每個顯示中結構的
 * 最大正差、最大負差、平均差（`GET /dose/{id}/signed-stats`）。
 */

import { useEffect, useState } from 'react';

import type { ViewerPanelProps } from '../../panels/types';
import { t } from '../../../core/i18n';

interface Stats {
  readonly max_pos_gy: number | null;
  readonly max_neg_gy: number | null;
  readonly mean_gy: number | null;
}
interface Row extends Stats {
  readonly structure_id: string;
  readonly name: string;
  readonly color_rgb: readonly number[];
  readonly outside_fraction: number;
}

const MAX_STRUCTURES = 30;
const fmt = (v: number | null): string => (v === null ? '–' : v.toFixed(2));

export function SignedStats({ api, seriesId }: { api: ViewerPanelProps['api']; seriesId: string }): React.JSX.Element {
  const ids = api.state.layers
    .filter((l) => l.kind === 'mask' && l.visible)
    .slice(0, MAX_STRUCTURES)
    .map((l) => l.contentRef);
  const key = ids.join(',');
  const [data, setData] = useState<{ whole: Stats; structures: Row[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { http } = api;
  useEffect(() => {
    let cancelled = false;
    setErr(null);
    http.getJson<{ whole: Stats; structures: Row[] }>(`/dose/${encodeURIComponent(seriesId)}/signed-stats?structure_ids=${encodeURIComponent(key)}`).then(
      (r) => !cancelled && setData(r),
      (e: unknown) => !cancelled && setErr(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [http, seriesId, key]);
  if (err) return <p className="error small">{err}</p>;
  if (!data) return <p className="muted small">{t('計算中…')}</p>;
  return (
    <div className="signed-stats">
      <table className="small">
        <thead>
          <tr>
            <th>{t('範圍')}</th>
            <th title={t('最大正差（Gy）')}>+max</th>
            <th title={t('最大負差（Gy）')}>−max</th>
            <th title={t('平均差（Gy）')}>{t('平均')}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>{t('整個網格')}</td>
            <td>{fmt(data.whole.max_pos_gy)}</td>
            <td>{fmt(data.whole.max_neg_gy)}</td>
            <td>{fmt(data.whole.mean_gy)}</td>
          </tr>
          {data.structures.map((s) => (
            <tr key={s.structure_id}>
              <td>
                <span className="swatch" style={{ background: `rgb(${s.color_rgb.join(',')})` }} /> {s.name}
                {s.outside_fraction > 0.001 && (
                  <span className="badge warn" title={t('有 {pct}% 的體積在差值網格外或沒有資料；只算有資料的部分', { pct: (s.outside_fraction * 100).toFixed(1) })}>
                    {t('部分')}
                  </span>
                )}
              </td>
              <td>{fmt(s.max_pos_gy)}</td>
              <td>{fmt(s.max_neg_gy)}</td>
              <td>{fmt(s.mean_gy)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {ids.length === 0 && <p className="muted small">{t('打開結構就會列出每個結構的差值。')}</p>}
    </div>
  );
}
