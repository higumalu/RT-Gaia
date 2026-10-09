/**
 * 3D 出圖的設定面板（right-sidebar，`'render3d'` 模式開著時）—— 對照 Slicer Volume Rendering：
 * 技法（體積渲染／MIP）、mapper（GPU 優先 CPU 備援）、預設集 ＋ Shift、Scalar opacity／color mapping 編輯器、
 * Shading、Crop（六個滑桿 ＋ 快捷）、Display ROI、相機。只寫 `modules.render3d`；3D 格讀它重畫。
 */

import { useCallback } from 'react';

import type { ViewerPanelProps } from '../../panels/types';
import { anglesOf, defaultCamera, fitDistance } from './camera3d';
import {
  clampCrop,
  clampWindow,
  CUSTOM_PRESET_ID,
  isFullCrop,
  PRESETS,
  presetIdForWindow,
  presetOf,
  RENDER3D_MODULE_ID,
  shrinkAxis,
  WINDOW_CENTER_RANGE,
  WINDOW_WIDTH_RANGE,
  windowOf,
  type CropBox,
  type MapperChoice,
  type Render3dState,
} from './model';
import { CUSTOM_TF_ID, presetIdOf, presetTf, serializeTf, TF_PRESETS, type TransferFunction } from './transferFunction';
import { TransferFunctionEditor } from './TransferFunctionEditor';
import { t } from '../../../core/i18n';
import { savePref } from '../../prefs/prefs';

const AXIS_LABEL = ['L–R (x)', 'A–P (y)', 'S–I (z)'] as const;
export const TF_STORAGE_KEY = 'rtgaia.render3d.tf.v1';

export function Render3dSettings({ api }: ViewerPanelProps): React.JSX.Element {
  const st = (api.state.modules[RENDER3D_MODULE_ID] as Render3dState | undefined) ?? {};
  const set = useCallback((patch: Partial<Render3dState>) => api.commands.setModuleState(RENDER3D_MODULE_ID, patch as Record<string, unknown>), [api.commands]);
  const primary = api.state.frameGroups.find((f) => f.role === 'primary') ?? null;
  const bounds = primary ? api.commands.seriesGridBounds(primary.seriesId) : null;
  const boundsBox: CropBox | null = bounds ? { min: [...bounds.min] as [number, number, number], max: [...bounds.max] as [number, number, number] } : null;
  const technique = st.technique ?? 'composite';
  const mapper = st.mapper ?? 'auto';
  const tf = st.tf ?? presetTf(TF_PRESETS[0]!.id);
  const tfPreset = presetIdOf({ ...tf, shift: 0 });
  const setTf = (next: TransferFunction) => {
    set({ tf: next });
    try {
      savePref(TF_STORAGE_KEY, serializeTf(next));
    } catch {
      // 私密視窗
    }
  };
  const histogram = primary ? api.commands.seriesHistogram(primary.seriesId, 128, [-1024, 3071]) : null;
  const window3d = windowOf(st);
  const presetId = presetIdForWindow(window3d);
  const setWindow = (w: { center: number; width: number }) => {
    const c = clampWindow(w);
    set({ window: c, preset: presetIdForWindow(c) });
  };
  const cropOn = st.crop != null;
  const crop: CropBox | null = st.crop ?? boundsBox;
  const showBox = st.showCropBox ?? true;
  const setCrop = (next: CropBox) => set({ crop: boundsBox ? clampCrop(next, boundsBox) : next });
  const setAxis = (axis: 0 | 1 | 2, which: 'min' | 'max', value: number) => {
    if (!crop) return;
    const min = [...crop.min] as [number, number, number];
    const max = [...crop.max] as [number, number, number];
    if (which === 'min') min[axis] = Math.min(value, max[axis] - 1);
    else max[axis] = Math.max(value, min[axis] + 1);
    setCrop({ min, max });
  };
  const angles = st.camera ? anglesOf(st.camera) : null;

  return (
    <div className="slab-panel render3d-panel">
      <header className="slab-header">{t('3D 出圖')}</header>
      <div className="slab-row">
        <span className="slab-presets" title={t('體積渲染＝VTK ray cast（真的 transfer function ＋ 光照）；MIP＝最大強度投影（沒 VTK 時的備援）')}>
          <button type="button" aria-pressed={technique === 'composite'} onClick={() => set({ technique: 'composite' })}>
            {t('體積渲染')}
          </button>
          <button type="button" aria-pressed={technique === 'mip'} onClick={() => set({ technique: 'mip' })}>
            MIP
          </button>
        </span>
        {technique === 'composite' && (
          <label title={t('GPU 優先、不行就 CPU（fixed-point ray cast）；可強制 CPU')}>
            mapper
            <select value={mapper} onChange={(e) => set({ mapper: e.target.value as MapperChoice })}>
              <option value="auto">{t('自動（GPU 優先）')}</option>
              <option value="gpu">GPU</option>
              <option value="cpu">CPU</option>
            </select>
          </label>
        )}
      </div>

      {technique === 'composite' ? (
        <>
          <div className="slab-row">
            <label>
              {t('預設集')}
              <select
                value={tfPreset}
                onChange={(e) => {
                  const p = TF_PRESETS.find((x) => x.id === e.target.value);
                  if (p) setTf({ ...p.tf, shift: 0 });
                }}
              >
                {TF_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {t(p.label)}
                  </option>
                ))}
                {tfPreset === CUSTOM_TF_ID && <option value={CUSTOM_TF_ID}>{t('自訂')}</option>}
              </select>
            </label>
            <span className="muted render3d-axis">Shift</span>
            <input type="range" min={-500} max={500} step={5} value={tf.shift} title={t('整條 TF 沿 HU 平移（Slicer 的 Shift）')} onChange={(e) => setTf({ ...tf, shift: Number(e.target.value) })} />
            <span className="render3d-range">{tf.shift > 0 ? `+${tf.shift}` : tf.shift}</span>
          </div>
          <TransferFunctionEditor tf={tf} range={[-1024, 3071]} histogram={histogram} onChange={setTf} />
          <div className="slab-row">
            <label>
              <input type="checkbox" checked={tf.shade} onChange={(e) => setTf({ ...tf, shade: e.target.checked })} />
              {t('光照')}
            </label>
            {(['ambient', 'diffuse', 'specular'] as const).map((k) => (
              <label key={k} className="render3d-shade" title={k}>
                {k === 'ambient' ? t('環境') : k === 'diffuse' ? t('漫射') : t('鏡面')}
                <input type="range" min={0} max={1} step={0.05} value={tf[k]} disabled={!tf.shade} onChange={(e) => setTf({ ...tf, [k]: Number(e.target.value) })} />
              </label>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="slab-row">
            <label>
              {t('預設集')}
              <select value={presetId} onChange={(e) => set({ preset: e.target.value, window: presetOf(e.target.value).window })}>
                {PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {t('{label}（{center}／{width}）', { label: p.label, center: p.window.center, width: p.window.width })}
                  </option>
                ))}
                {presetId === CUSTOM_PRESET_ID && <option value={CUSTOM_PRESET_ID}>{t('自訂')}</option>}
              </select>
            </label>
          </div>
          <div className="slab-row render3d-window">
            <span className="muted render3d-axis">{t('WL（中心）')}</span>
            <input type="range" min={WINDOW_CENTER_RANGE.min} max={WINDOW_CENTER_RANGE.max} step={10} value={window3d.center} onChange={(e) => setWindow({ ...window3d, center: Number(e.target.value) })} />
            <input type="number" className="num" value={window3d.center} onChange={(e) => setWindow({ ...window3d, center: Number(e.target.value) })} />
          </div>
          <div className="slab-row render3d-window">
            <span className="muted render3d-axis">{t('WW（寬度）')}</span>
            <input type="range" min={WINDOW_WIDTH_RANGE.min} max={WINDOW_WIDTH_RANGE.max} step={10} value={window3d.width} onChange={(e) => setWindow({ ...window3d, width: Number(e.target.value) })} />
            <input type="number" className="num" min={1} value={window3d.width} onChange={(e) => setWindow({ ...window3d, width: Number(e.target.value) })} />
          </div>
        </>
      )}

      <div className="slab-row">
        <label title={t('Slicer Volume Rendering 的 Crop：只渲染方框內')}>
          <input type="checkbox" checked={cropOn} disabled={boundsBox === null} onChange={(e) => set({ crop: e.target.checked && boundsBox ? shrinkAxis(boundsBox, 2, 0.5) : null })} />
          {t('裁切範圍')}
        </label>
        <label title={t('在 2D 切面畫出方框（Slicer 的 Display ROI）')}>
          <input type="checkbox" checked={showBox} disabled={!cropOn} onChange={(e) => set({ showCropBox: e.target.checked })} />
          {t('在 2D 畫出方框')}
        </label>
        {boundsBox === null && <span className="muted hint">{t('等影像載入…')}</span>}
      </div>
      <div className="render3d-row">
        <label title={t('2D 十字線移到哪裡，3D 相機就把焦點搬到那裡（方向與距離不變）')}>
          <input type="checkbox" checked={st.followCrosshair ?? false} onChange={(e) => set({ followCrosshair: e.target.checked })} />
          {t('相機跟著十字線')}
        </label>
      </div>
      {cropOn && crop && boundsBox && (
        <>
          {([0, 1, 2] as const).map((axis) => (
            <div key={axis} className="slab-row render3d-crop-axis">
              <span className="muted render3d-axis">{AXIS_LABEL[axis]}</span>
              <input type="range" min={boundsBox.min[axis]} max={boundsBox.max[axis]} step={1} value={crop.min[axis]} onChange={(e) => setAxis(axis, 'min', Number(e.target.value))} />
              <input type="range" min={boundsBox.min[axis]} max={boundsBox.max[axis]} step={1} value={crop.max[axis]} onChange={(e) => setAxis(axis, 'max', Number(e.target.value))} />
              <span className="render3d-range">
                {t('{p0} ～ {p1}mm', { p0: crop.min[axis].toFixed(0), p1: crop.max[axis].toFixed(0) })}
              </span>
            </div>
          ))}
          <div className="slab-row">
            <span className="slab-presets">
              <button type="button" disabled={isFullCrop(crop, boundsBox)} onClick={() => setCrop(boundsBox)}>
                {t('全範圍')}
              </button>
              <button type="button" onClick={() => setCrop(shrinkAxis(crop, 2, 0.5))}>
                {t('縱向 ½')}
              </button>
              <button type="button" onClick={() => setCrop(shrinkAxis(shrinkAxis(crop, 0, 0.5), 1, 0.5))}>
                {t('橫向 ½')}
              </button>
              <button type="button" onClick={() => setCrop(shrinkAxis(shrinkAxis(shrinkAxis(boundsBox, 0, 0.5), 1, 0.5), 2, 0.5))}>
                {t('中心 ⅛')}
              </button>
            </span>
          </div>
        </>
      )}

      <div className="slab-row">
        <span className="muted">{t('相機')}</span>
        <span className="render3d-range">{angles ? t('方位 {azimuthDeg}° · 仰角 {elevationDeg}°', { azimuthDeg: angles.azimuthDeg, elevationDeg: angles.elevationDeg }) : '—'}</span>
        <button type="button" className="reset" disabled={!boundsBox} onClick={() => boundsBox && set({ camera: defaultCamera(boundsBox) })}>
          {t('回正面')}
        </button>
        <button type="button" className="reset" disabled={!boundsBox || !st.camera} onClick={() => boundsBox && st.camera && set({ camera: fitDistance(st.camera, boundsBox) })}>
          Fit
        </button>
        <span className="muted hint">{t('3D 格：左鍵轉、滾輪前進後退、右鍵／中鍵／Shift＋左鍵平移')}</span>
      </div>
    </div>
  );
}
