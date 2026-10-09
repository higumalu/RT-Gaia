/**
 * 十字線讀數：物理座標 ＋ 體素值。`bottom` slot 第一列 —— 畫面左下角的狀態列。
 *
 * ## 為什麼是一份、而且在狀態列
 *
 * 十字線是那個**單一 3D 空間**的性質，不是某一格的性質。每格各放一份
 * 會暗示它們各自獨立；而 viewport 的三個角落也已被方位標籤、切面索引、
 * slab 標示占滿。因此從工具列搬到左下角，並在沒指到、
 * 指標離開、或超出體積時顯示 `N/A`（原本是留最後一次讀數與 `—`）。
 *
 * ## 這個元件不做任何幾何
 *
 * 取樣、逆變換、單位判定全在 `core/scene/probe.ts`；文字在 `probeModel.ts`。
 * 這裡只排版。永遠佔一列：讀數出現時版面不能跳。
 * 影像讀數後面列出這一點所在的**顯示中** ROI（色塊＋名稱、體積小的在前、前 5 個）。
 */

import { probeLine, probeRois } from './probeModel';
import type { ViewerPanelProps } from './types';
import { t } from '../../core/i18n';

export function ProbePanel({ api }: ViewerPanelProps): React.JSX.Element {
  const line = probeLine(api.state.probe);
  const empty = line.readings.length === 0;
  // 讀數點所在的 ROI（只看顯示中的）
  const rois = probeRois(api.state.probe, api.state.structures, api.state.structureSets, api.state.user?.username ?? null);
  const hasRois = rois.shown.length > 0 || rois.notResident > 0;
  return (
    <div className={`probe${empty ? ' probe-empty' : ''}`} role="status" aria-live="off">
      <span className="probe-caption">{t('座標')}</span>
      <span className={`probe-world${empty ? ' probe-na' : ''}`} title={line.worldTitle}>
        {line.world}
      </span>
      {line.readings.map((r) => (
        <span key={r.key} className="probe-reading">
          <span className="probe-label">{r.label}</span>
          {r.ijk && (
            <span className="probe-ijk" title={t('取像網格索引 (i, j, k)')}>
              {r.ijk}
            </span>
          )}
          <span className={`probe-value${r.na ? ' probe-na' : ''}`} title={r.title}>
            {r.value}
          </span>
        </span>
      ))}
      {hasRois && (
        <span className="probe-rois" aria-label={t('這一點所在的 ROI')}>
          <span className="probe-caption">ROI</span>
          {rois.shown.map((c) => (
            <span key={c.key} className="probe-roi" title={c.title}>
              <span className="probe-roi-swatch" style={{ background: c.color }} />
              {c.name}
            </span>
          ))}
          {rois.more > 0 && (
            <span className="probe-roi-more" title={rois.moreTitle}>
              {t('＋{more}', { more: rois.more })}
            </span>
          )}
          {rois.notResident > 0 && (
            <span className="probe-roi-pending muted" title={rois.notResidentTitle}>
              {t('{notResident}個未載入', { notResident: rois.notResident })}
            </span>
          )}
        </span>
      )}
    </div>
  );
}
