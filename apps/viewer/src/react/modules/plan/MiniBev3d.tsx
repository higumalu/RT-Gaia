/**
 * 3D 格右下角的小 BEV：跟著計畫面板選的射束與控制點；3D 裡同時畫射束軌跡與目前的開口（後端）。
 * 3D 是伺服器出圖：播放時 3D 不跟著每一格重畫，停下來（或逐 CP）才更新；小 BEV 只在停下來時跟著。
 */

import { useEffect, useMemo, useState } from 'react';

import type { ViewerPanelProps } from '../../panels/types';
import { BevCanvas } from './BevView';
import { bevViewHalfMm, clampCp, defaultBevBeam, fetchBeamControlPoints, leafOpacityOf, PLAN_MODULE_ID, showBeams3dOf, showDrrOf, type BeamControlPoints, type PlanModuleState } from './model';
import { useBevDrr } from './useBevDrr';
import { usePlans } from './usePlans';

export function MiniBev3d({ api }: ViewerPanelProps): React.JSX.Element | null {
  const st = api.state.modules[PLAN_MODULE_ID] as PlanModuleState | undefined;
  const { plans } = usePlans(api);
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
  const n = bcp?.control_points.length ?? 0;
  const cp = clampCp(st?.cp ?? 0, n);
  // 跟計畫面板的 BEV 同一套 DRR（小張；同一個請求共用快取）
  const contours = st?.drrContours !== false ? api.state.layers.filter((l) => l.kind === 'mask' && l.visible).map((l) => l.contentRef).slice(0, 12) : [];
  const { drr } = useBevDrr(
    http,
    showBeams3dOf(st) && showDrrOf(st) && studyId && plan && beam !== null && bcp !== null && n > 0
      ? {
          studyId,
          planId: plan.plan_id,
          beam,
          cp,
          halfMm: bevViewHalfMm(bcp, st?.bevView ?? 'fit'),
          preset: st?.drrPreset ?? 'high',
          wc: st?.drrWc ?? 0.5,
          ww: st?.drrWw ?? 1,
          structureIds: contours,
          playing: false,
          small: true,
        }
      : null,
  );
  const leafOpacity = leafOpacityOf(st);
  const drrOpacity = st?.drrOpacity ?? 1;
  const extras = useMemo(
    () => (drr ? { background: { image: drr.image, halfMm: drr.resp.half_mm, opacity: drrOpacity }, contours: drr.resp.contours, leafOpacity } : { leafOpacity }),
    [drr, drrOpacity, leafOpacity],
  );
  if (!showBeams3dOf(st) || plan === null || bcp === null || n === 0) return null;
  return (
    <div className="mini-bev" title={`BEV · ${bcp.number} ${bcp.name} · CP ${cp + 1}`}>
      <BevCanvas bcp={bcp} cp={cp} rotate={st?.bevRotate !== false} title={`${bcp.number} ${bcp.name} · CP ${cp + 1}`} onWheel={() => undefined} extras={extras} viewHalfMm={bevViewHalfMm(bcp, st?.bevView ?? 'fit')} />
    </div>
  );
}
