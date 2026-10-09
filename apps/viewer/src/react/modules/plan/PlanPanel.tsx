/**
 * 計畫面板（右側欄）：計畫、治療機、病人擺位、處方；ISO（座標、到 ISO、影像上顯示）；射束表。
 *
 * 只看不改 —— 這裡沒有任何改計畫的操作；也不是照射模擬。
 */

import { layoutCellName } from '../../../core';
import type { ViewerPanelProps } from '../../panels/types';
import { BevView } from './BevView';
import {
  BEV_PANEL_ID,
  beamKindText,
  energyText,
  gantryText,
  isGammaKnife,
  machineText,
  metersetText,
  PLAN_MODULE_ID,
  shotBeamOf,
  showArc2dOf,
  showBeams3dOf,
  showIsoOf,
  totalMeterset,
  type PlanInfo,
  type PlanModuleState,
} from './model';
import { usePlans } from './usePlans';
import { joinList, t } from '../../../core/i18n';

function fmtMm(v: readonly number[]): string {
  return v.map((x) => x.toFixed(1)).join(', ');
}

export function PlanPanel({ api }: ViewerPanelProps): React.JSX.Element {
  const { plans, loading, error } = usePlans(api);
  const st = api.state.modules[PLAN_MODULE_ID] as PlanModuleState | undefined;
  const set = (patch: Partial<PlanModuleState>): void => api.commands.setModuleState(PLAN_MODULE_ID, patch);
  const plan = plans.find((p) => p.plan_id === st?.planId) ?? plans[0] ?? null;
  const showIso = showIsoOf(st);

  if (loading) return <div className="slab-panel plan-panel"><header className="slab-header">{t('計畫')}</header><p className="muted hint">{t('讀取計畫…')}</p></div>;
  if (error !== null || plan === null) {
    return (
      <div className="slab-panel plan-panel">
        <header className="slab-header">{t('計畫')}</header>
        <p className="muted hint">{error !== null ? t('讀不到計畫：{msg}', { msg: error }) : t('這個病例沒有 RTPLAN。')}</p>
      </div>
    );
  }
  const gk = isGammaKnife(plan);
  const mu = gk ? null : totalMeterset(plan);
  return (
    <div className="slab-panel plan-panel">
      <header className="slab-header">{t('計畫')}</header>
      {plans.length > 1 && (
        <div className="slab-row">
          <select value={plan.plan_id} onChange={(e) => set({ planId: e.target.value })} aria-label={t('選計畫')}>
            {plans.map((p) => (
              <option key={p.plan_id} value={p.plan_id}>
                {p.label || p.plan_id.slice(-8)}
              </option>
            ))}
          </select>
        </div>
      )}
      <dl className="plan-summary">
        <dt>{t('計畫')}</dt>
        <dd>
          {plan.label}
          {plan.name && plan.name !== plan.label ? <span className="muted"> · {plan.name}</span> : null}
        </dd>
        <dt>{t('治療機')}</dt>
        <dd>
          {plan.machines.length ? joinList(plan.machines.map(machineText)) : '–'}
          {gk && <span className="muted"> · {t('Gamma Knife（{n} 個 shot）', { n: plan.beams.length })}</span>}
        </dd>
        <dt>{t('擺位')}</dt>
        <dd>{joinList(plan.patient_positions) || '–'}</dd>
        <dt>{t('處方')}</dt>
        <dd>
          {plan.prescription_gy.length ? `${plan.prescription_gy.map((g) => +g.toFixed(2)).join(' / ')} Gy` : '–'}
          {plan.fractions_planned !== null ? ` · ${t('{n} 次', { n: plan.fractions_planned })}` : ''}
          {mu !== null ? ` · ${mu.toFixed(1)} MU` : ''}
        </dd>
      </dl>
      <div className="plan-iso">
        {gk ? (
          <label title={t('在每個 2D 格畫 shot 的位置（離切面 8 mm 內；不在這張切面上時畫虛線並標距離）')}>
            <input type="checkbox" checked={showIso} onChange={(e) => set({ showIso: e.target.checked })} /> {t('影像上顯示 shot')}
          </label>
        ) : (
          <>
            <label title={t('在每個 2D 格畫等中心；不在這張切面上時畫虛線並標距離')}>
              <input type="checkbox" checked={showIso} onChange={(e) => set({ showIso: e.target.checked })} /> {t('影像上顯示 ISO')}
            </label>
            <label title={t('軸向格（法線與機架旋轉軸平行）畫目前 BEV 射束的弧：每個控制點一根刻度，長度代表每度 MU；虛線是目前控制點的射束中心軸')}>
              <input type="checkbox" checked={showIso && showArc2dOf(st)} disabled={!showIso} onChange={(e) => set({ showArc2d: e.target.checked })} /> {t('影像上畫弧刻度')}
            </label>
            <label title={t('3D 格裡畫所有治療射束的軌跡與目前射束的開口，右下角放小 BEV')}>
              <input type="checkbox" checked={showBeams3dOf(st)} onChange={(e) => set({ showBeams3d: e.target.checked })} /> {t('3D 顯示射束')}
            </label>
          </>
        )}
        {gk && <ShotTable plan={plan} api={api} />}
        {!gk && plan.isocenters.map((iso, i) => (
          <div key={i} className="plan-iso-row">
            <span className="plan-iso-name">{gk ? `S${i + 1}` : plan.isocenters.length > 1 ? `ISO${i + 1}` : 'ISO'}</span>
            <span className="muted" title={t('RTPLAN 的病人座標（mm）')}>({fmtMm(iso.position_mm)})</span>
            <button
              type="button"
              disabled={iso.position_primary_mm === null}
              title={iso.position_primary_mm === null ? t('病例裡沒有這個計畫的 Frame of Reference 的影像，無法定位') : t('十字線移到這個等中心')}
              onClick={() => iso.position_primary_mm && api.commands.moveCrosshair(iso.position_primary_mm)}
            >
              {gk ? t('到 shot') : t('到 ISO')}
            </button>
            <span className="muted small">
              {gk ? joinList(iso.beam_numbers.map((n) => plan.beams.find((b) => b.number === n)?.name || `#${n ?? '–'}`)) : t('射束 {list}', { list: iso.beam_numbers.join(', ') })}
            </span>
          </div>
        ))}
        {plan.isocenters.length === 0 && <p className="muted hint">{t('射束沒有記錄等中心。')}</p>}
      </div>
      {gk ? (
        <p className="muted hint">
          {t('Gamma Knife 計畫：每個「射束」是一個 shot（鈷 60 源聚焦在一點），沒有機架、准直器、MLC，所以不畫射束、BEV 與弧。')}{' '}
          {t('權重 ＝ 照射時間 ÷ 最長的 shot；各扇區的准直器（4／8／16 mm）不在 DICOM 裡（GammaPlan 匯出的 jaw 是同一組佔位值），所以不顯示。')}
        </p>
      ) : (
        <div className="plan-beams-wrap">
          <table className="dvh-table plan-beams">
            <thead>
              <tr>
                <th>#</th>
                <th>{t('射束')}</th>
                <th>{t('種類')}</th>
                <th title={t('機架角（°）；弧 ＝ 起 → 止 方向')}>{t('機架')}</th>
                <th title={t('准直器角（°）')}>{t('准直器')}</th>
                <th title={t('治療床角（°）')}>{t('床')}</th>
                <th>{t('能量')}</th>
                <th>MU</th>
                <th title={t('控制點數')}>CP</th>
              </tr>
            </thead>
            <tbody>
              {plan.beams.map((b, i) => (
                <tr key={`${b.number ?? 'x'}-${i}`} className={b.is_treatment ? undefined : 'plan-beam-setup'} title={[b.description, b.machine_name, b.devices.map((d) => d.type).join('/')].filter((x) => x).join(' · ')}>
                  <td>{b.number ?? '–'}</td>
                  <td>{b.name || '–'}</td>
                  <td>{beamKindText(b)}</td>
                  <td>{gantryText(b)}</td>
                  <td>{b.collimator_deg === null ? '–' : +b.collimator_deg.toFixed(1)}</td>
                  <td>{b.couch_deg === null ? '–' : +b.couch_deg.toFixed(1)}</td>
                  <td>{energyText(b)}</td>
                  <td>{metersetText(b)}</td>
                  <td>{b.control_points}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!gk && <BevSection api={api} />}
      <p className="muted small plan-disclaimer">{t('只顯示計畫內容，不是照射模擬，也不做碰撞檢查。')}</p>
    </div>
  );
}

/** Gamma Knife 的 shot 表 —— 照射時間、相對權重、處方點貢獻（位置在列的滑鼠提示）；「到 shot」移十字線。 */
function ShotTable({ plan, api }: { plan: PlanInfo; api: ViewerPanelProps['api'] }): React.JSX.Element {
  const fmt = (v: number | null | undefined, d: number): string => (typeof v === 'number' ? v.toFixed(d) : '–');
  return (
    <div className="plan-beams-wrap">
      <table className="dvh-table plan-beams plan-shots">
        <thead>
          <tr>
            <th>{t('shot')}</th>
            <th>{t('名稱')}</th>
            <th title={t('照射時間（分鐘）')}>{t('時間')}</th>
            <th title={t('照射時間 ÷ 最長的 shot')}>{t('權重')}</th>
            <th title={t('這個 shot 在劑量參考點（處方點）的劑量')}>{t('處方點 Gy')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {plan.isocenters.map((iso, i) => {
            const b = shotBeamOf(plan, iso);
            return (
              // 位置放在滑鼠提示（側欄窄，多一欄會把「到 shot」擠出畫面）
              <tr key={i} data-shot={i + 1} title={t('RTPLAN 的病人座標（mm）：{pos}', { pos: fmtMm(iso.position_mm) })}>
                <td>S{i + 1}</td>
                <td>{b?.name || '–'}</td>
                <td>{fmt(b?.shot?.beam_on_min, 2)}</td>
                <td>{typeof b?.shot?.weight === 'number' ? `${Math.round(b.shot.weight * 100)}%` : '–'}</td>
                <td>{fmt(b?.beam_dose_gy, 2)}</td>
                <td>
                  <button
                    type="button"
                    className="mini"
                    disabled={iso.position_primary_mm === null}
                    title={iso.position_primary_mm === null ? t('病例裡沒有這個計畫的 Frame of Reference 的影像，無法定位') : t('十字線移到這個 shot')}
                    onClick={() => iso.position_primary_mm && api.commands.moveCrosshair(iso.position_primary_mm)}
                  >
                    {t('到 shot')}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** BEV 沒放進格子時內嵌在這裡；放進格子後只剩「在哪一格」＋ 取回（同 DVH 圖的做法）。 */
function BevSection({ api }: ViewerPanelProps): React.JSX.Element {
  const { layout } = api.state;
  const cell = layout.cells.find((c) => c.content.kind === 'panel' && c.content.panelId === BEV_PANEL_ID) ?? null;
  const target = layout.cells.find((c) => c.content.kind === 'viewport' && c.content.is3D) ?? layout.cells[layout.cells.length - 1] ?? null;
  return (
    <section className="plan-bev">
      <header className="slab-header">
        {t('BEV／MLC')}
        <span className="slab-header-actions">
          {cell === null ? (
            target !== null && (
              <button type="button" title={t('把 BEV 放到「{p0}」那一格（每格右上角的選單也能換）', { p0: target.label ?? target.cellId })} onClick={() => api.commands.setCellContent(target.cellId, { kind: 'panel', panelId: BEV_PANEL_ID })}>
                {t('放到格子')}
              </button>
            )
          ) : (
            <button type="button" className="reset" title={t('把那一格還回原本的內容，BEV 回到這裡')} onClick={() => api.commands.setCellContent(cell.cellId, null)}>
              {t('取回')}
            </button>
          )}
        </span>
      </header>
      {cell === null ? (
        <div className="plan-bev-embedded">
          <BevView api={api} />
        </div>
      ) : (
        <p className="muted hint">{((name) => (name ? t('BEV 在「{p0}」那一格。', { p0: name }) : t('BEV 在版面的另一格。')))(layoutCellName(api.state.layoutId, cell.cellId))}</p>
      )}
    </section>
  );
}
