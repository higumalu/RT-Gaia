/**
 * `registration-drag`：左鍵在畫面上拖 ＝ 目標次要序列在**目前平面內**平移。
 *
 * 純核心 API：`canvasToWorld`（primary 世界座標）→ Δ → `setFrameGroupTransform`。
 * 目標 FoR 從 `ctx.params.registration.frameOfReferenceUid` 來（面板寫進去）。
 * 沒有目標、或目標是 primary 時 `activate()` 拒絕 —— 與筆刷「沒選結構就不啟動」同一條規則。
 */

import {
  ContractViolation,
  registerTool,
  listTools,
  translateTransform,
  type Mat16,
  type ToolContext,
  type ToolInstance,
  type ToolPlugin,
  type Vec3,
} from '../../../core';
import { REGISTRATION_DRAG_TOOL, REGISTRATION_PARAMS_KEY } from './mode';
import { msg, t } from '../../../core/i18n';

export interface RegistrationToolParams {
  frameOfReferenceUid: string | null;
}

export function registrationTargetOf(params: Record<string, unknown>): string | null {
  const p = params[REGISTRATION_PARAMS_KEY] as Partial<RegistrationToolParams> | undefined;
  return typeof p?.frameOfReferenceUid === 'string' && p.frameOfReferenceUid.length > 0 ? p.frameOfReferenceUid : null;
}

/** 拖曳的純數學：起點／目前點（primary 世界座標）→ 新的 transformToPrimary。 */
export function draggedTransform(base: Mat16, startWorld: Vec3, currentWorld: Vec3): number[] {
  return translateTransform(base, [
    currentWorld[0] - startWorld[0],
    currentWorld[1] - startWorld[1],
    currentWorld[2] - startWorld[2],
  ]);
}

function activate(ctx: ToolContext): ToolInstance {
  const uid = registrationTargetOf(ctx.params);
  if (uid === null) throw new ContractViolation('RG1', t('對位拖曳需要先在面板選一組要動的序列'), {});
  const fg = ctx.frameGroup(uid);
  if (fg.role !== 'secondary') throw new ContractViolation('RG2', t('primary 序列不能動 —— 它就是參考座標系'), { uid });
  let start: { world: Vec3; base: Mat16 } | null = null;
  return {
    onPointerDown(x, y) {
      // 每一筆拖曳都以「當下」的變換為底 —— 面板的按鈕可能在兩筆之間改過它
      start = { world: ctx.canvasToWorld(x, y), base: ctx.frameGroup(uid).transformToPrimary };
    },
    onPointerMove(x, y) {
      if (start === null) return;
      ctx.setFrameGroupTransform(uid, draggedTransform(start.base, start.world, ctx.canvasToWorld(x, y)));
    },
    onPointerUp() {
      start = null;
    },
    deactivate() {
      start = null;
    },
  };
}

export const REGISTRATION_DRAG_PLUGIN: ToolPlugin = {
  id: REGISTRATION_DRAG_TOOL,
  label: msg('對位拖曳'),
  icon: '⤧',
  cursor: 'move',
  appliesTo: (vp) => !vp.is3D,
  hidden: true,
  activate,
};

/** 冪等：`clearTools()` 之後可以再註冊。 */
export function registerRegistrationTool(): void {
  if (listTools().some((t) => t.id === REGISTRATION_DRAG_TOOL)) return;
  registerTool(REGISTRATION_DRAG_PLUGIN);
}
