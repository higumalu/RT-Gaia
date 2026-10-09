/**
 * 圈選工具 `scissors`：在目前平面逐點畫多邊形（與面積量測同手感），
 * 點回第一個頂點或 Enter 收口 → 光柵化成一筆 patch（加或減，`params.lasso.mode`）；Esc 取消。
 * 進行中的多邊形由 host 畫在 SVG（`ctx.setLassoPreview`）。
 */

import { ContractViolation, type Vec3 } from '../geometry';
import { rasterizeLasso, readLasso } from '../edit/lasso';
import type { ToolContext, ToolInstance } from './registry';
import { t } from '../i18n';

export const LASSO_CLOSE_PX = 8;

export function scissorsTool(ctx: ToolContext): ToolInstance {
  const structureId = ctx.activeStructureId();
  if (structureId === null) throw new ContractViolation('TL4', t('編輯工具需要先選一個結構'), { toolId: 'scissors' });
  if (!ctx.isEditable(structureId)) throw new ContractViolation('TL5', t('這個結構目前顯示的是替代表示（唯讀），不得編輯'), { toolId: 'scissors', structureId });
  const layer = ctx.layers().find((l) => l.kind === 'mask' && l.contentRef === structureId);
  if (layer === undefined) throw new ContractViolation('TL4', t('找不到結構的 layer'), { structureId });
  const frameIndex = ctx.frameOf?.(layer) ?? (layer.temporalGroupId ? 0 : null);
  let points: Vec3[] = [];
  let downAt: { x: number; y: number } | null = null;

  const cancel = (): void => {
    points = [];
    ctx.setLassoPreview(null);
  };
  const finish = (): void => {
    if (points.length >= 3) {
      const patch = rasterizeLasso({
        maskGrid: ctx.maskGridFor(layer.frameOfReferenceUid),
        frameGroup: ctx.frameGroup(layer.frameOfReferenceUid),
        polygonPrimaryWorld: points,
        planeNormalPrimary: ctx.camera.viewPlaneNormal,
        viewUpPrimary: ctx.camera.viewUp,
        mode: readLasso(ctx.params).mode,
      });
      if (patch !== null) {
        ctx.applyPatch({ structureId, frameIndex, patch });
        ctx.endStroke('scissors');
      }
    }
    cancel();
  };

  return {
    onPointerDown(x, y) {
      downAt = { x, y };
    },
    onPointerUp(x, y) {
      if (downAt !== null && Math.hypot(x - downAt.x, y - downAt.y) > LASSO_CLOSE_PX) {
        downAt = null;
        return; // 拖著走不是頂點
      }
      downAt = null;
      if (points.length >= 3) {
        const first = ctx.worldToCanvas(points[0]!);
        const { sx, sy } = ctx.cssToBackingScale();
        if (Math.hypot(first.x / sx - x, first.y / sy - y) <= LASSO_CLOSE_PX) {
          finish();
          return;
        }
      }
      points = [...points, ctx.canvasToWorld(x, y)];
      ctx.setLassoPreview(points);
    },
    onKeyDown(key) {
      if (key === 'Enter') finish();
      else if (key === 'Escape') cancel();
      else return false;
      return true;
    },
    deactivate() {
      cancel();
    },
  };
}
