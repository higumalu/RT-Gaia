/**
 * 時間軸列 —— `bottom` slot，只在場景有帶時間軸的 layer 時出現（`hasTemporalLayer`）。
 *
 * 每個時間群組一列：播放／暫停、前後一格、跳到頭尾、相位滑桿（下面一條標出已載入的相位）、fps、循環、播放範圍
 * （DCE 的時間窗）、時間曲線（指標所在點；指標不在影像上 ＝ 十字線；沒有點時留空位，版面不跳）。游標屬於群組：同群組的影像、劑量、
 * 結構一起換相位。播放中用低解析度（lod 2），暫停後自動補目前相位的全解析度。
 */

import { useState } from 'react';

import type { TemporalState } from '../../../core';
import { joinList, t } from '../../../core/i18n';
import type { ViewerPanelProps } from '../../panels/types';
import { COMPARE_LEFT, COMPARE_RIGHT, compareLayoutId } from '../layout/model';
import { PhaseStructuresDialog } from './PhaseStructuresDialog';
import { backendMessage, resampleInfo, compareFrames, curvePath, FPS_CHOICES, frameText, fullResText, groupCaption, isExpanded } from './model';

const CURVE_W = 150;
const CURVE_H = 34;

/**
 * 4D ↔ 多個 3D。攤開／收回只改圖層（同一條時間軸）；拆回多張影像會原地重組病例
 * （有只屬某一幀的結構就擋下來，訊息照原樣顯示）；並排比較 ＝ 並排版面 ＋ 兩格各鎖一個相位。
 */
/**
 * 網格跟第一幀不同而被排除的相位（缺片、位移；預設排除）→「重新取樣補進來」；補進來的 →「改回排除」。
 * 同一個病例原地重組；只屬某一幀的結構依序列換幀號（改回排除時畫在補進來那一幀的會被擋，訊息照原樣顯示）。
 */
function ResampleNote({ api, g }: ViewerPanelProps & { g: TemporalState }): React.JSX.Element | null {
  const [busy, setBusy] = useState(false);
  const info = resampleInfo(api.state.layers, g.temporalGroupId);
  if (info === null || (info.excluded.length === 0 && !info.resample)) return null;
  const run = (enabled: boolean): void => {
    setBusy(true);
    api.commands
      .setTemporalResample(g.temporalGroupId, enabled)
      .catch((e: unknown) => api.commands.setError(backendMessage(e)))
      .finally(() => setBusy(false));
  };
  if (info.excluded.length > 0) {
    return (
      <span className="time-resample" data-excluded={info.excluded.length}>
        <span className="warning small" title={info.excluded.map((x) => t('{label}：{detail}', { label: x.label, detail: x.detail })).join('\n')}>
          {t('排除了 {n} 個相位（{labels}）', { n: info.excluded.length, labels: joinList(info.excluded.map((x) => x.label)) })}
        </span>
        <button type="button" disabled={busy} title={t('缺片、位移的相位逐片內插到第一幀的網格，補回時間軸')} onClick={() => run(true)}>
          {t('重新取樣補進來')}
        </button>
      </span>
    );
  }
  return (
    <span className="time-resample" data-resampled={info.resampled.length}>
      <span className="muted small">
        {info.resampled.length > 0 ? t('{labels} 已重新取樣', { labels: joinList(info.resampled.map((x) => x.label)) }) : t('網格不同的幀已重新取樣')}
      </span>
      <button type="button" disabled={busy} onClick={() => run(false)}>
        {t('改回排除')}
      </button>
    </span>
  );
}

/** 「相位結構…」—— 合成一個時間結構、ITV（對話框）。 */
function PhaseStructuresButton({ api, g }: ViewerPanelProps & { g: TemporalState }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" title={t('同一個結構在不同相位各一個 → 合成一個時間結構；各幀聯集成 ITV')} onClick={() => setOpen(true)}>
        {t('相位結構…')}
      </button>
      {open && <PhaseStructuresDialog api={api} g={g} onClose={() => setOpen(false)} />}
    </>
  );
}

function GroupActions({ api, g }: ViewerPanelProps & { g: TemporalState }): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const run = (p: Promise<void>): void => {
    setBusy(true);
    p.catch((e: unknown) => api.commands.setError(backendMessage(e))).finally(() => setBusy(false));
  };
  const compare = (): void => {
    const [a, b] = compareFrames(g.cursor, g.frameCount ?? 1);
    api.commands.setLayout(compareLayoutId('axial'));
    api.commands.setViewportFrame(COMPARE_LEFT, g.temporalGroupId, a);
    api.commands.setViewportFrame(COMPARE_RIGHT, g.temporalGroupId, b);
  };
  return (
    <span className="time-actions">
      <button type="button" disabled={busy} title={t('每一幀在左欄變成一張獨立影像（各自顯示、不透明度、窗位）；結構跟著作用中的那一張')} onClick={() => run(api.commands.setTemporalView(g.temporalGroupId, 'expanded'))}>
        {t('攤開成 3D')}
      </button>
      <button type="button" disabled={busy} title={t('並排兩格：左格鎖在目前這一幀、右格差半圈；每一格角落可以改鎖哪一幀')} onClick={compare}>
        {t('並排比較')}
      </button>
      <button type="button" disabled={busy} title={t('拆回原本的多張影像（同一個病例；有只屬某一幀的結構時不能拆）')} onClick={() => run(api.commands.dissolveTemporal(g.temporalGroupId))}>
        {t('拆回多張影像')}
      </button>
      <PhaseStructuresButton api={api} g={g} />
      <ResampleNote api={api} g={g} />
    </span>
  );
}

/** 攤開中的時間軸 —— 不播放；說明結構跟著哪一張、一鍵收回。 */
function ExpandedRow({ api, g, count }: ViewerPanelProps & { g: TemporalState; count: number }): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const label = g.frameLabels?.[g.cursor] ?? `#${g.cursor + 1}`;
  return (
    <div className="time-group is-expanded" data-temporal-group={g.temporalGroupId} data-cursor={g.cursor} data-playing="false" data-expanded="true">
      <span className="time-title">{groupCaption(g, api.state.layers, count)}</span>
      <span className="time-text">
        {t('已攤開成 {n} 張影像', { n: g.frameCount ?? 0 })}
        <span className="muted" title={t('左欄把某一張設成「作用中」，結構就顯示、新畫在那一幀')}>
          {' · '}
          {t('結構跟著作用中的那一張：{label}', { label })}
        </span>
      </span>
      <span className="time-actions">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            api.commands
              .setTemporalView(g.temporalGroupId, 'timeline')
              .catch((e: unknown) => api.commands.setError(backendMessage(e)))
              .finally(() => setBusy(false));
          }}
        >
          {t('收回成 4D')}
        </button>
        {api.state.usesStructureSets && <PhaseStructuresButton api={api} g={g} />}
      </span>
    </div>
  );
}

function GroupRow({ api, g, count }: ViewerPanelProps & { g: TemporalState; count: number }): React.JSX.Element {
  const last = Math.max(0, (g.frameCount ?? 1) - 1);
  const loading = !g.residentFrames.includes(g.cursor);
  const world = api.state.probe?.source === 'pointer' ? api.state.probe.world : undefined;
  const seriesId = g.seriesIds[0];
  const curve = seriesId === undefined || g.frameCount === null || g.frameCount < 2 ? null : curvePath(api.commands.temporalCurve(seriesId, world), CURVE_W, CURVE_H);
  const current = curve?.points.find((p) => p.i === g.cursor) ?? null;
  const cmd = api.commands;
  return (
    <div className="time-group" data-temporal-group={g.temporalGroupId} data-cursor={g.cursor} data-playing={g.playing ? 'true' : 'false'}>
      <span className="time-title">{groupCaption(g, api.state.layers, count)}</span>
      <span className="time-buttons">
        <button type="button" title={t('跳到播放範圍的開頭')} onClick={() => cmd.setTemporalFrame(g.temporalGroupId, Math.min(g.rangeFrom, g.rangeTo))}>
          ⏮
        </button>
        <button type="button" title={t('上一個')} onClick={() => cmd.stepTemporal(g.temporalGroupId, -1)}>
          ◀
        </button>
        <button type="button" className="time-play" aria-pressed={g.playing} title={g.playing ? t('暫停') : t('播放')} onClick={() => cmd.setTemporalPlayback(g.temporalGroupId, { playing: !g.playing })}>
          {g.playing ? '⏸' : '▶'}
        </button>
        <button type="button" title={t('下一個')} onClick={() => cmd.stepTemporal(g.temporalGroupId, 1)}>
          ▶|
        </button>
        <button type="button" title={t('跳到播放範圍的結尾')} onClick={() => cmd.setTemporalFrame(g.temporalGroupId, Math.max(g.rangeFrom, g.rangeTo))}>
          ⏭
        </button>
      </span>
      <span className="time-slider">
        <input
          type="range"
          min={0}
          max={last}
          step={1}
          value={g.cursor}
          aria-label={t('相位')}
          onChange={(e) => cmd.setTemporalFrame(g.temporalGroupId, Number(e.target.value))}
        />
        <span className="time-resident" aria-hidden="true">
          {Array.from({ length: last + 1 }, (_, i) => (
            <i key={i} className={`${g.residentFrames.includes(i) ? 'is-loaded' : ''}${g.fullResFrames.includes(i) ? ' is-full' : ''}${i >= Math.min(g.rangeFrom, g.rangeTo) && i <= Math.max(g.rangeFrom, g.rangeTo) ? ' in-range' : ''}`} />
          ))}
        </span>
      </span>
      <span className="time-text">
        {frameText(g)}
        {loading && <span className="muted"> · {t('載入中…')}</span>}
        {!loading && fullResText(g) !== null && (
          <span className="muted" title={t('每一幀的全解析度都到了，播放才會一直清楚；記憶體預算放不下全部幀時，只有停下來的那一幀是全解析度')}>
            {' · '}
            {fullResText(g)}
          </span>
        )}
      </span>
      <label title={t('每秒幾格')}>
        <select value={g.fps} onChange={(e) => cmd.setTemporalPlayback(g.temporalGroupId, { fps: Number(e.target.value) })}>
          {FPS_CHOICES.map((f) => (
            <option key={f} value={f}>
              {f} fps
            </option>
          ))}
        </select>
      </label>
      <label title={t('播到結尾接回開頭')}>
        <input type="checkbox" checked={g.loop} onChange={(e) => cmd.setTemporalPlayback(g.temporalGroupId, { loop: e.target.checked })} />
        {t('循環')}
      </label>
      <label className="time-range" title={t('播放範圍（含兩端）：只在這一段之間播放與循環')}>
        {t('範圍')}
        <input type="number" min={1} max={last + 1} value={g.rangeFrom + 1} aria-label={t('播放範圍開頭')} onChange={(e) => cmd.setTemporalPlayback(g.temporalGroupId, { rangeFrom: Number(e.target.value) - 1 })} />
        –
        <input type="number" min={1} max={last + 1} value={g.rangeTo + 1} aria-label={t('播放範圍結尾')} onChange={(e) => cmd.setTemporalPlayback(g.temporalGroupId, { rangeTo: Number(e.target.value) - 1 })} />
      </label>
      {/* 指標經過影像外（例如從軸向移到冠狀）時沒有點：留著同樣大小的空曲線，不然整列高度一變、上面的影像格跟著跳 */}
      {curve !== null && (
        <span className="time-curve" title={world ? t('時間曲線：指標所在點') : t('時間曲線：十字線所在點')}>
          <svg width={CURVE_W} height={CURVE_H} role="img" aria-label={t('時間曲線')}>
            <path d={curve.d} />
            {curve.points.map((p) => (
              <circle key={p.i} cx={p.x} cy={p.y} r={p.i === g.cursor ? 3 : 1.5} className={p.i === g.cursor ? 'is-current' : ''} onClick={() => cmd.setTemporalFrame(g.temporalGroupId, p.i)} />
            ))}
          </svg>
          <span className="muted">{current !== null ? current.v.toFixed(0) : '—'}</span>
        </span>
      )}
      {api.state.usesStructureSets && <GroupActions api={api} g={g} />}
    </div>
  );
}

export function TimeBar({ api }: ViewerPanelProps): React.JSX.Element | null {
  const groups = api.state.temporal.filter((g) => g.frameCount !== null && g.frameCount > 1);
  if (groups.length === 0) return null;
  return (
    <div className="time-bar">
      {groups.map((g) =>
        isExpanded(api.state.layers, g.temporalGroupId) ? (
          <ExpandedRow key={g.temporalGroupId} api={api} g={g} count={groups.length} />
        ) : (
          <GroupRow key={g.temporalGroupId} api={api} g={g} count={groups.length} />
        ),
      )}
    </div>
  );
}
