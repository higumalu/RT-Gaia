/**
 * 工具列「3D」開關（開右側設定面板）。**也是裁切方框 painter 的宿主**：它永遠掛著（工具列），
 * 方框才能不管 3D 格在不在都畫在 2D 切面上（Slicer 的 Display ROI）。
 * 3D 設定面板開著時，方框交給核心當可調方框（`setEditableBox`）—— 十字線工具下，正交切面上拖截面的角（兩軸）
 * 或邊中點（一軸；把手由核心畫在 SVG）；拖曳中只更新本地草稿（painter 跟著畫），放手才寫回模組狀態（3D 重畫一次）。
 */

import { useEffect, useState } from 'react';

import { boxPlaneSection } from '../../../core';
import type { ViewerPanelProps } from '../../panels/types';
import { clampCrop, cropCorners, RENDER3D_MODE, RENDER3D_MODULE_ID, type CropBox, type Render3dState } from './model';
import { t } from '../../../core/i18n';

const CROP_BOX_OWNER = 'render3d.crop';

export function Render3dToggle({ api }: ViewerPanelProps): React.JSX.Element {
  const on = api.state.modes.includes(RENDER3D_MODE);
  const st = (api.state.modules[RENDER3D_MODULE_ID] as Render3dState | undefined) ?? {};
  const saved = st.crop ?? null;
  const [draft, setDraft] = useState<CropBox | null>(null);
  const crop = draft ?? saved;
  const show = (st.showCropBox ?? true) && crop !== null;
  const editable = on && show;
  const cropKey = crop ? JSON.stringify(crop) : '';
  const savedKey = saved ? JSON.stringify(saved) : '';
  const { overlay } = api;
  const { setEditableBox, setModuleState, seriesGridBounds } = api.commands;
  const primarySeriesId = api.state.frameGroups.find((f) => f.role === 'primary')?.seriesId ?? null;

  // 模組狀態（滑桿、快速鈕）變了 → 丟掉草稿、把新方框交給核心
  useEffect(() => {
    setDraft(null);
    if (!editable || saved === null) {
      setEditableBox(CROP_BOX_OWNER, null);
      return undefined;
    }
    setEditableBox(CROP_BOX_OWNER, saved, (box, phase) => {
      const bounds = primarySeriesId ? seriesGridBounds(primarySeriesId) : null;
      const asCrop: CropBox = { min: [box.min[0], box.min[1], box.min[2]], max: [box.max[0], box.max[1], box.max[2]] };
      const next = bounds ? clampCrop(asCrop, bounds) : asCrop;
      if (phase === 'move') setDraft(next);
      else setModuleState(RENDER3D_MODULE_ID, { crop: next });
    });
    return () => setEditableBox(CROP_BOX_OWNER, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable, savedKey, primarySeriesId]);

  useEffect(() => {
    if (!show || crop === null) return undefined;
    const corners = cropCorners(crop);
    return overlay.register({
      id: 'render3d.crop-box',
      order: 5,
      paint(ctx) {
        const section = boxPlaneSection(corners, ctx.camera);
        ctx.ctx.lineWidth = 1.5;
        if (section.length >= 3) {
          // 切面穿過方框：畫截面
          ctx.ctx.strokeStyle = 'rgba(255, 159, 67, 0.95)';
          ctx.ctx.setLineDash([6, 4]);
          ctx.ctx.beginPath();
          section.forEach((p, i) => {
            const q = ctx.project(p);
            if (i === 0) ctx.ctx.moveTo(q.x, q.y);
            else ctx.ctx.lineTo(q.x, q.y);
          });
          ctx.ctx.closePath();
          ctx.ctx.stroke();
        } else {
          // 切面在方框外：淡淡地畫投影的外接矩形，提示方框在別的層
          const pts = corners.map((c) => ctx.project(c));
          const xs = pts.map((p) => p.x);
          const ys = pts.map((p) => p.y);
          ctx.ctx.strokeStyle = 'rgba(255, 159, 67, 0.35)';
          ctx.ctx.setLineDash([3, 5]);
          ctx.ctx.strokeRect(Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
        }
        ctx.ctx.setLineDash([]);
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show, cropKey, overlay]);

  return (
    <span className="mode-toggle render3d-toggle">
      <button
        type="button"
        aria-pressed={on}
        title={on ? t('關閉 3D 出圖設定面板') : t('3D 出圖設定：預設集、裁切範圍（Crop）、相機')}
        onClick={() => api.commands.setMode(RENDER3D_MODE, !on)}
      >
        3D
      </button>
    </span>
  );
}
