/**
 * 斜面 MPR 模組的操作面板 —— `right-sidebar`，**只在 `'mpr'` 模式開著時出現**。
 *
 * 每個 2D viewport 一列：目前轉了多少（水平／傾斜／總夾角，與畫面上十字線旁的讀數同一個
 * 來源 `ViewportView.angles`）、精確轉角按鈕（±1°／±5°）、slab 檔位、回正交。
 * 底下是三種 slab 輪廓語意。
 */

import { formatDeg, SLAB_MULTI_PLANE_MAX_MM, SLAB_SEMANTICS_LABEL, type SlabOutlineSemantics } from '../../../core';
import type { ViewerPanelProps } from '../../panels/types';
import { msg, t } from '../../../core/i18n';

const SLAB_PRESETS_MM = [0, 3, 5, 10] as const;
const ORIENTATION_LABEL = { axial: msg('軸向'), coronal: msg('冠狀'), sagittal: msg('矢狀') } as const;

const SEMANTICS: readonly { id: SlabOutlineSemantics; label: string; hint: string }[] = [
  { id: 'center', label: msg('A 中心面'), hint: msg('一條線；與 RTSTRUCT 原生語意一致（預設）') },
  { id: 'union-outer', label: msg('B 聯集外緣'), hint: msg('slab 內所有切面的聯集外緣；與 MIP 影像一致，×N 取樣') },
  { id: 'stacked', label: msg('C 逐面堆疊'), hint: msg('每個取樣面各一條淡線；資訊最多') },
];

export function MprPanel({ api }: ViewerPanelProps): React.JSX.Element | null {
  const { viewports, slabOutlineSemantics } = api.state;
  if (viewports.length === 0) return null;
  return (
    <div className="slab-panel">
      <header className="slab-header">{t('斜面 MPR')}</header>
      <p className="muted hint" style={{ padding: '4px 10px', margin: 0 }}>
        {t('在畫面上拖十字線的 handle 像轉錶盤：左右 handle 讓法線在水平面掃、上下 handle 上下傾斜；樞紐是十字線那一點。')}
      </p>
      {viewports.map((vp) => (
        <div key={vp.viewportId} className="slab-row" data-oblique={vp.oblique ? 'true' : 'false'}>
          <span className="slab-vp">
            {t(ORIENTATION_LABEL[vp.orientation])}
            {vp.oblique && <span className="badge badge-registered"> {t('斜面')}</span>}
          </span>
          <span className="slab-angles" title={t('相對正交方位：法線在水平面掃了多少 · 上下傾斜多少（總夾角）')}>
            {t('水平{p0} · 傾斜 {p1}', { p0: formatDeg(vp.angles.aroundUpDeg), p1: formatDeg(vp.angles.aroundRightDeg) })}
            {vp.oblique && t(' （總 {p0}°）', { p0: vp.angles.totalDeg.toFixed(1) })}
          </span>
          <span className="slab-presets" title={t('精確轉角')}>
            <button type="button" onClick={() => api.commands.rotateViewport(vp.viewportId, 'up', -5)}>{t('水平 −5°')}</button>
            <button type="button" onClick={() => api.commands.rotateViewport(vp.viewportId, 'up', -1)}>−1°</button>
            <button type="button" onClick={() => api.commands.rotateViewport(vp.viewportId, 'up', 1)}>+1°</button>
            <button type="button" onClick={() => api.commands.rotateViewport(vp.viewportId, 'up', 5)}>+5°</button>
          </span>
          <span className="slab-presets">
            <button type="button" onClick={() => api.commands.rotateViewport(vp.viewportId, 'right', -5)}>{t('傾斜 −5°')}</button>
            <button type="button" onClick={() => api.commands.rotateViewport(vp.viewportId, 'right', -1)}>−1°</button>
            <button type="button" onClick={() => api.commands.rotateViewport(vp.viewportId, 'right', 1)}>+1°</button>
            <button type="button" onClick={() => api.commands.rotateViewport(vp.viewportId, 'right', 5)}>+5°</button>
          </span>
          <span className="slab-presets">
            slab
            {SLAB_PRESETS_MM.map((mm) => (
              <button
                key={mm}
                type="button"
                aria-pressed={vp.slabThicknessMm === mm}
                onClick={() => api.commands.setSlabThickness(vp.viewportId, mm)}
              >
                {mm}
              </button>
            ))}
            <input
              type="number"
              className="num"
              min={0}
              max={20}
              step={1}
              value={vp.slabThicknessMm}
              title={t('slab 厚度（mm，最大 20）')}
              onChange={(e) => api.commands.setSlabThickness(vp.viewportId, Number(e.target.value))}
            />
            mm
          </span>
          <button
            type="button"
            className="reset"
            disabled={!vp.oblique}
            title={t('回到正交方位（十字線那一點不動）')}
            onClick={() => api.commands.resetOrientation(vp.viewportId)}
          >
            {t('回正交')}
          </button>
        </div>
      ))}

      <div className="slab-semantics">
        <span className="muted">{t('slab 內的輪廓')}</span>
        {SEMANTICS.map((s) => (
          <label key={s.id} title={t(s.hint)}>
            <input
              type="radio"
              name="slab-semantics"
              checked={slabOutlineSemantics === s.id}
              onChange={() => api.commands.setSlabOutlineSemantics(s.id)}
            />
            {t(s.label)}
          </label>
        ))}
        <span className="muted hint">
          {t('{p0}；B／C 互動中一律退回 A，> {SLAB_MULTI_PLANE_MAX_MM}mm 降級', { p0: SLAB_SEMANTICS_LABEL[slabOutlineSemantics], SLAB_MULTI_PLANE_MAX_MM })}
        </span>
      </div>
    </div>
  );
}
