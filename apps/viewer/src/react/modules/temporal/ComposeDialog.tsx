/**
 * 左欄同一組（同一個 FoR）裡的幾張單張影像 → 組成一條時間軸（4D）。
 *
 * 讓左欄多個相位的影像組成 4D 觀看。
 * 勾要放進來的影像、排順序、改每一幀的名稱、選「相位」（循環播放）或「時間」（照掃描時間）→ 後端原地重組同一個病例
 * （結構、量測都留著）。網格不同、不同 FoR 的由後端擋下來，訊息照原樣顯示。
 */

import { useState } from 'react';

import type { Layer, ViewerApi } from '../../../core';
import { t } from '../../../core/i18n';
import { Dialog } from '../../components/Dialog';
import { backendMessage, defaultFrameLabel, defaultFrameOrder, frameLabelsToSend, looksDerived } from './model';

interface Row {
  readonly layer: Layer;
  checked: boolean;
  label: string;
}

export function ComposeDialog(props: { api: ViewerApi; images: readonly Layer[]; onClose: () => void }): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>(() =>
    defaultFrameOrder(props.images).map((layer, n) => ({ layer, checked: !looksDerived(layer.seriesMeta), label: defaultFrameLabel(layer.seriesMeta, n) })),
  );
  const [axis, setAxis] = useState<'phase' | 'time'>(() => (rows.some((r) => /%$/.test(r.label)) ? 'phase' : 'time'));
  const [resample, setResample] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = rows.filter((r) => r.checked);
  const move = (i: number, d: -1 | 1): void => {
    const j = i + d;
    if (j < 0 || j >= rows.length) return;
    const next = [...rows];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setRows(next);
  };
  const submit = (): void => {
    if (chosen.length < 2) return;
    setBusy(true);
    setError(null);
    props.api.commands
      .composeTemporal({ seriesUids: chosen.map((r) => r.layer.contentRef), labels: frameLabelsToSend(chosen.map((r) => r.label), axis), axis, resample })
      .then(() => props.onClose())
      .catch((e: unknown) => {
        setBusy(false);
        setError(backendMessage(e));
      });
  };
  return (
    <Dialog label={t('組成 4D')} className="compose-4d-dialog" busy={busy} onClose={props.onClose}>
      <h3>{t('組成 4D')}</h3>
      <p className="muted small">{t('勾要放進時間軸的影像，照播放順序排好（第一列是第一幀）。同一個病例原地重組，結構與量測都會留著。')}</p>
      <ol className="compose-4d-list">
        {rows.map((r, i) => (
          <li key={r.layer.layerId} data-checked={r.checked ? 'true' : 'false'}>
            <input
              type="checkbox"
              checked={r.checked}
              aria-label={t('放進時間軸')}
              onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, checked: e.target.checked } : x)))}
            />
            <span className="compose-4d-name" title={r.layer.label}>
              {typeof r.layer.seriesMeta?.['series_description'] === 'string' ? (r.layer.seriesMeta['series_description']) : r.layer.label}
            </span>
            <input
              className="compose-4d-label"
              value={r.label}
              aria-label={t('這一幀的名稱')}
              maxLength={24}
              disabled={!r.checked}
              onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, label: e.target.value } : x)))}
            />
            <button type="button" className="mini" aria-label={t('上移')} title={t('上移')} disabled={i === 0} onClick={() => move(i, -1)}>
              ↑
            </button>
            <button type="button" className="mini" aria-label={t('下移')} title={t('下移')} disabled={i === rows.length - 1} onClick={() => move(i, 1)}>
              ↓
            </button>
          </li>
        ))}
      </ol>
      <label className="compose-4d-axis">
        {t('種類')}
        <select value={axis} onChange={(e) => setAxis(e.target.value === 'time' ? 'time' : 'phase')}>
          <option value="phase">{t('相位（循環播放，例：4DCT 呼吸相位）')}</option>
          <option value="time">{t('時間（照掃描時間，例：DCE）')}</option>
        </select>
      </label>
      <label className="compose-4d-resample" title={t('缺片、位移的相位逐片內插到第一張的網格；不勾 ＝ 網格不同就不能組')}>
        <input type="checkbox" checked={resample} onChange={(e) => setResample(e.target.checked)} />
        {t('網格不同的重新取樣到第一張的網格')}
      </label>
      {error && <p className="error">{error}</p>}
      <div className="dialog-actions">
        <button type="button" onClick={props.onClose} disabled={busy}>
          {t('取消')}
        </button>
        <button type="button" className="primary" data-autofocus onClick={submit} disabled={busy || chosen.length < 2}>
          {busy ? t('組成中…') : t('組成（{n} 幀）', { n: chosen.length })}
        </button>
      </div>
    </Dialog>
  );
}
