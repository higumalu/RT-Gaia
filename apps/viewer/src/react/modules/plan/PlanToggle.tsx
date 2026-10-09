/**
 * 工具列「計畫」開關 —— 病例有 RTPLAN 才出現；也是 ISO 標記 painter 的宿主（同 `RefLinesToggle` 的做法）：
 * 在每個 2D 格畫等中心（金色十字＋圓）；不在這張切面上時畫虛線並標帶正負號的距離。
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import type { ViewerPanelProps } from '../../panels/types';
import { PLAN_MODE } from './mode';
import { arcTicks, clampCp, defaultBevBeam, drawableIsocenters, fetchBeamControlPoints, ISO_COLOR, isoLabel, isoOnPlane, PLAN_MODULE_ID, showArc2dOf, showIsoOf, type BeamControlPoints, type PlanModuleState } from './model';
import { usePlans } from './usePlans';
import { t } from '../../../core/i18n';

const ARM_PX = 9;
const RING_PX = 5;
const LINE_PX = 13;
const LABEL_NEAR_PX = 60;
/** 弧刻度的顏色（射束 1 號色，與 3D 的第一個射束同色）。 */
const ARC_COLOR = '#6c9cff';

export function PlanToggle({ api }: ViewerPanelProps): React.JSX.Element | null {
  const on = api.state.modes.includes(PLAN_MODE);
  const { plans } = usePlans(api);
  const showIso = showIsoOf(api.state.modules[PLAN_MODULE_ID]);
  const isos = useMemo(() => drawableIsocenters(plans), [plans]);
  const { overlay } = api;
  const commandsRef = useRef(api.commands);
  commandsRef.current = api.commands;
  const isoKey = isos.map((i) => i.world.join(',')).join('|');

  useEffect(() => {
    if (!showIso || isos.length === 0) return undefined;
    // 標籤位置（預先配置，paint 裡不配置新緩衝 —— overlayRegistry P1）：兩個 ISO 投影到同一點時
    // （例：軸向格裡 x、y 相同、z 不同的兩個等中心）標籤往下錯開一行，不疊在一起
    const labelXY = new Float64Array(isos.length * 2);
    const unregister = overlay.register({
      id: 'plan.isocenter',
      order: 6,
      paint(ctx) {
        const g = ctx.ctx;
        g.font = '11px system-ui, sans-serif';
        g.textBaseline = 'bottom';
        isos.forEach((iso, i) => {
          const d = ctx.signedDistanceMm(iso.world);
          if (iso.maxDistanceMm !== undefined && Math.abs(d) > iso.maxDistanceMm) {
            labelXY[i * 2] = Number.NaN; // 沒畫 → 不參與標籤錯開
            return;
          }
          const p = ctx.project(iso.world);
          const onPlane = isoOnPlane(d);
          g.strokeStyle = ISO_COLOR;
          g.fillStyle = ISO_COLOR;
          g.globalAlpha = onPlane ? 1 : 0.75;
          g.lineWidth = 1.5;
          g.setLineDash(onPlane ? [] : [3, 3]);
          g.beginPath();
          g.moveTo(p.x - ARM_PX, p.y);
          g.lineTo(p.x + ARM_PX, p.y);
          g.moveTo(p.x, p.y - ARM_PX);
          g.lineTo(p.x, p.y + ARM_PX);
          g.stroke();
          g.beginPath();
          g.arc(p.x, p.y, RING_PX, 0, Math.PI * 2);
          g.stroke();
          g.setLineDash([]);
          const lx = p.x + RING_PX + 3;
          let ly = p.y - 3;
          for (let k = 0; k < i; k += 1) {
            if (Math.abs(labelXY[k * 2]! - lx) < LABEL_NEAR_PX && Math.abs(labelXY[k * 2 + 1]! - ly) < LINE_PX) {
              ly += LINE_PX;
              k = -1; // 移動後重新檢查前面的每一個
            }
          }
          labelXY[i * 2] = lx;
          labelXY[i * 2 + 1] = ly;
          // 深色描邊：金色字疊在 colorwash 上也讀得到
          const text = isoLabel(d, i, isos.length, ctx.camera.viewPlaneNormal, iso.label);
          g.lineWidth = 3;
          g.strokeStyle = '#000000b0';
          g.strokeText(text, lx, ly);
          g.fillText(text, lx, ly);
        });
      },
    });
    commandsRef.current.repaintOverlays();
    return () => {
      unregister();
      commandsRef.current.repaintOverlays();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isoKey 就是 isos 的識別
  }, [showIso, isoKey, overlay]);

  // 計畫一載入就把 planId 寫進模組狀態 —— 3D 的射束圖層與小 BEV 靠它（不用等使用者打開面板）
  const st = api.state.modules[PLAN_MODULE_ID] as PlanModuleState | undefined;
  const { setModuleState } = api.commands;
  useEffect(() => {
    if (plans.length > 0 && !plans.some((p) => p.plan_id === st?.planId)) setModuleState(PLAN_MODULE_ID, { planId: plans[0]!.plan_id });
  }, [plans, st?.planId, setModuleState]);

  // 2D 格的弧刻度（目前 BEV 選的射束）—— 每個 CP 一根，長度 ∝ MU/°；目前的 CP 畫中心軸（虛線）
  const plan = plans.find((p) => p.plan_id === st?.planId) ?? null;
  const beam = plan ? defaultBevBeam(plan, st?.bevBeam) : null;
  const [bcp, setBcp] = useState<BeamControlPoints | null>(null);
  const studyId = api.state.studyId;
  const { http } = api;
  useEffect(() => {
    if (!studyId || !plan || beam === null) return undefined;
    let cancelled = false;
    fetchBeamControlPoints(studyId, plan.plan_id, beam, http.getJson.bind(http)).then(
      (r) => !cancelled && setBcp(r),
      () => !cancelled && setBcp(null),
    );
    return () => {
      cancelled = true;
    };
  }, [studyId, plan, beam, http]);
  const showArc = showArc2dOf(st) && showIso;
  const cp = st?.cp ?? 0;
  useEffect(() => {
    if (!showArc || bcp === null || !bcp.track) return undefined;
    const cur = clampCp(cp, bcp.control_points.length);
    const unregister = overlay.register({
      id: 'plan.arc',
      order: 5,
      paint(ctx) {
        const ticks = arcTicks(bcp, ctx.camera.viewPlaneNormal, (w) => ctx.project(w));
        if (ticks === null) return;
        const g = ctx.ctx;
        const r = Math.min(ctx.width, ctx.height) * 0.2;
        const len = r * 0.3;
        const { x: cx, y: cy } = ticks.center;
        g.globalAlpha = 0.3;
        g.strokeStyle = ARC_COLOR;
        g.lineWidth = 1;
        g.beginPath();
        g.arc(cx, cy, r, 0, Math.PI * 2);
        g.stroke();
        // 深色底線再畫刻度：疊在 colorwash 上也看得到
        g.globalAlpha = 0.6;
        g.strokeStyle = '#000000';
        g.lineWidth = Math.max(2.5, r / 40);
        g.beginPath();
        for (const d of ticks.dirs) {
          if (d.weight <= 0) continue;
          g.moveTo(cx + d.dx * r, cy + d.dy * r);
          g.lineTo(cx + d.dx * (r + len * d.weight), cy + d.dy * (r + len * d.weight));
        }
        g.stroke();
        g.globalAlpha = 1;
        g.strokeStyle = ARC_COLOR;
        g.lineWidth = Math.max(1.5, r / 70);
        g.beginPath();
        for (const d of ticks.dirs) {
          if (d.weight <= 0) continue;
          g.moveTo(cx + d.dx * r, cy + d.dy * r);
          g.lineTo(cx + d.dx * (r + len * d.weight), cy + d.dy * (r + len * d.weight));
        }
        g.stroke();
        const now = ticks.dirs[cur];
        if (now !== undefined) {
          g.globalAlpha = 1;
          g.strokeStyle = ISO_COLOR;
          g.lineWidth = 1.5;
          g.setLineDash([6, 4]);
          g.beginPath();
          g.moveTo(cx, cy);
          g.lineTo(cx + now.dx * (r + len + 6), cy + now.dy * (r + len + 6));
          g.stroke();
          g.setLineDash([]);
          const g0 = bcp.control_points[cur]?.gantry_deg;
          const text = `${bcp.name} ${g0 === null || g0 === undefined ? '' : `${+g0.toFixed(1)}°`} · CP ${cur + 1}`;
          const tx = cx + now.dx * (r + len + 10);
          const ty = cy + now.dy * (r + len + 10);
          g.font = '11px system-ui, sans-serif';
          g.textAlign = now.dx >= 0 ? 'left' : 'right';
          g.textBaseline = 'middle';
          g.lineWidth = 3;
          g.strokeStyle = '#000000b0';
          g.strokeText(text, tx, ty);
          g.fillStyle = ISO_COLOR;
          g.fillText(text, tx, ty);
        }
      },
    });
    commandsRef.current.repaintOverlays();
    return () => {
      unregister();
      commandsRef.current.repaintOverlays();
    };
  }, [showArc, bcp, cp, overlay]);

  if (plans.length === 0) return null;
  return (
    <span className="mode-toggle plan-toggle">
      <button
        type="button"
        aria-pressed={on}
        title={on ? t('關閉計畫面板') : t('開啟計畫：射束清單、治療機、等中心（只看，不算劑量）')}
        onClick={() => api.commands.setMode(PLAN_MODE, !on)}
      >
        {t('計畫')}
      </button>
    </span>
  );
}
