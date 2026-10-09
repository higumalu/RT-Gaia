/**
 * 對位微調面板 —— `right-sidebar`，**只在 `'registration'` 模式開著時出現**。
 *
 * 選一組次要序列 → 平移 x/y/z（±1／±0.1 mm）、繞 x/y/z 轉（±1°／±0.1°，樞紐＝該序列體積中心）、
 * 目前相對 REG 的 Δ、拖曳工具、「重設為 REG」、「提交」。所有動作都只是改 `transformToPrimary`
 * 的覆寫（`setFrameGroupTransform`）；提交才進後端。
 */

import { useEffect, useMemo, useState } from 'react';

import {
  applyMat16,
  rigidDelta,
  rotateTransformAboutPivot,
  translateTransform,
  type FrameGroup,
  type RigidAxis,
  type Vec3,
} from '../../../core';
import type { ViewerPanelProps } from '../../panels/types';
import { REGISTRATION_DRAG_TOOL, REGISTRATION_PARAMS_KEY } from './mode';
import { LandmarkPairs } from './LandmarkPairs';
import { t } from '../../../core/i18n';

const AXES: readonly { axis: RigidAxis; index: 0 | 1 | 2; label: string }[] = [
  { axis: 'x', index: 0, label: 'L–R (x)' },
  { axis: 'y', index: 1, label: 'A–P (y)' },
  { axis: 'z', index: 2, label: 'S–I (z)' },
];

function fmt(v: number, digits: number): string {
  const s = v.toFixed(digits);
  return s.startsWith('-') || s === (0).toFixed(digits) ? s : `+${s}`;
}

function titleOf(fg: FrameGroup, api: ViewerPanelProps['api']): string {
  const image = api.state.layers.find((l) => l.kind === 'image' && l.frameOfReferenceUid === fg.frameOfReferenceUid);
  const date = image?.seriesMeta?.['series_date'];
  const dateStr = typeof date === 'string' && date.length >= 8 ? ` ${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : '';
  return `${image?.modality ?? fg.seriesId}${dateStr}`;
}

export function RegistrationPanel({ api }: ViewerPanelProps): React.JSX.Element | null {
  const secondaries = useMemo(() => api.state.frameGroups.filter((f) => f.role === 'secondary'), [api.state.frameGroups]);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const uid = selected !== null && secondaries.some((f) => f.frameOfReferenceUid === selected) ? selected : (secondaries[0]?.frameOfReferenceUid ?? null);
  const { setToolParams } = api.commands;
  // 拖曳工具的目標跟著選單走
  useEffect(() => {
    setToolParams({ [REGISTRATION_PARAMS_KEY]: { frameOfReferenceUid: uid } });
  }, [uid, setToolParams]);

  if (secondaries.length === 0) {
    return (
      <div className="slab-panel reg-panel">
        <header className="slab-header">{t('對位微調')}</header>
        <p className="muted hint" style={{ padding: '6px 10px' }}>{t('這個病例只有一組座標系，沒有可以對位的次要序列。')}</p>
      </div>
    );
  }
  const fg = secondaries.find((f) => f.frameOfReferenceUid === uid)!;
  const override = api.state.transformOverrides.find((o) => o.frameOfReferenceUid === uid)?.transformToPrimary ?? null;
  const current = override ?? fg.transformToPrimary;
  const disabled = api.state.disabledTransforms.includes(fg.frameOfReferenceUid);
  // 樞紐：該序列體積中心（自身 FoR）→ primary。體積還沒到就用原點。
  const centerOwn: Vec3 = api.commands.seriesGridCenter(fg.seriesId) ?? [0, 0, 0];
  const delta = rigidDelta(current, fg.transformToPrimary, centerOwn);
  const dragging = api.state.activeToolId === REGISTRATION_DRAG_TOOL;

  const set = (m: number[]) => api.commands.setFrameGroupTransform(fg.frameOfReferenceUid, m);
  // 🔴 以 host **此刻**的矩陣為底，不是 render 時的 `current`：連按五下 +1 才會是 +5
  const live = () => api.commands.currentTransformToPrimary(fg.frameOfReferenceUid);
  const nudge = (index: 0 | 1 | 2, mm: number) => {
    const d: [number, number, number] = [0, 0, 0];
    d[index] = mm;
    set(translateTransform(live(), d));
  };
  const spin = (axis: RigidAxis, deg: number) => {
    const base = live();
    set(rotateTransformAboutPivot(base, axis, deg, applyMat16(base, centerOwn)));
  };

  return (
    <div className="slab-panel reg-panel">
      <header className="slab-header">{t('對位微調')}</header>
      <div className="slab-row">
        <label>
          {t('要動的序列')}
          <select value={fg.frameOfReferenceUid} onChange={(e) => setSelected(e.target.value)}>
            {secondaries.map((f) => (
              <option key={f.frameOfReferenceUid} value={f.frameOfReferenceUid}>
                {titleOf(f, api)}
              </option>
            ))}
          </select>
        </label>
        <span className={`badge ${override ? 'badge-unregistered' : 'badge-registered'}`}>
          {override ? t('微調中，未提交') : (fg.registration?.source ?? 'REG')}
        </span>
        {disabled && <span className="badge badge-disabled" title={t('資料面板把這組的對位關掉了；微調對關掉的組不會顯示')}>{t('對位已關')}</span>}
      </div>
      <div className="slab-row">
        <span className="muted">{t('平移（primary mm）')}</span>
        {AXES.map((a) => (
          <span key={a.axis} className="slab-presets" title={t('沿 {label} 平移', { label: a.label })}>
            {a.label}
            <button type="button" onClick={() => nudge(a.index, -1)}>−1</button>
            <button type="button" onClick={() => nudge(a.index, -0.1)}>−.1</button>
            <button type="button" onClick={() => nudge(a.index, 0.1)}>+.1</button>
            <button type="button" onClick={() => nudge(a.index, 1)}>+1</button>
          </span>
        ))}
      </div>
      <div className="slab-row">
        <span className="muted">{t('旋轉（繞體積中心，度）')}</span>
        {AXES.map((a) => (
          <span key={a.axis} className="slab-presets" title={t('繞 {label} 軸轉', { label: a.label })}>
            {a.axis}
            <button type="button" onClick={() => spin(a.axis, -1)}>−1°</button>
            <button type="button" onClick={() => spin(a.axis, -0.1)}>−.1°</button>
            <button type="button" onClick={() => spin(a.axis, 0.1)}>+.1°</button>
            <button type="button" onClick={() => spin(a.axis, 1)}>+1°</button>
          </span>
        ))}
      </div>
      <div className="slab-row reg-delta" title={t('相對後端目前的對位（REG 或上次提交）差多少：體積中心的位移 ＋ Euler 角')}>
        <span className="muted">{t('相對 REG')}</span>
        <span>
          Δ ({delta.translationMm.map((v) => fmt(v, 1)).join(', ')}) mm
        </span>
        <span>
          {t('∠ ({p0})° · 總 {p1}°', { p0: delta.rotationDeg.map((v) => fmt(v, 1)).join(', '), p1: delta.totalRotationDeg.toFixed(1) })}
        </span>
      </div>
      <div className="slab-row">
        <button
          type="button"
          className="reset"
          aria-pressed={dragging}
          title={t('左鍵在任一 2D 畫面拖：這組序列在該平面內平移（中鍵 pan、右鍵 WW/WL 不變）')}
          onClick={() => api.commands.setActiveTool(dragging ? 'navigate' : REGISTRATION_DRAG_TOOL)}
        >
          {dragging ? t('結束拖曳') : t('拖曳平移')}
        </button>
        <button
          type="button"
          className="reset"
          disabled={override === null}
          title={t('丟掉未提交的調整，回到後端目前的對位')}
          onClick={() => api.commands.setFrameGroupTransform(fg.frameOfReferenceUid, null)}
        >
          {t('重設為 REG')}
        </button>
        <button
          type="button"
          className="reset submit"
          disabled={override === null || busy}
          title={t('POST /transforms（apply_to_frame_group）：後端換掉這組的 FrameGroup，registration.source 變 manual')}
          onClick={() => {
            setBusy(true);
            api.commands
              .submitFrameGroupTransform(fg.frameOfReferenceUid)
              .catch((e: unknown) => api.commands.setError(e instanceof Error ? e.message : String(e)))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? t('提交中…') : t('提交')}
        </button>
      </div>
      <LandmarkPairs api={api} fg={fg} primaryUid={api.state.frameGroups.find((f) => f.role === 'primary')?.frameOfReferenceUid ?? ''} />
    </div>
  );
}
