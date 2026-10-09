/**
 * Tier 的裁決優先序與降級策略。
 *
 * ```
 * 使用者手動覆寫  >  後端否決  >  前端探針建議
 * ```
 *
 * | 來源 | 權限 | 限制 |
 * |---|---|---|
 * | 前端探針 | 提出建議值 | 只是建議 |
 * | 後端否決 | 可**下調** | **不可上調**——後端不知道客戶端真實算力 |
 * | 使用者覆寫 | 最高 | **不得超越硬性能力** |
 */

import { require_ } from '../geometry';
import type { Tier } from '../raster/types';
import type { ClientCapability } from './probe';
import { t } from '../i18n';

export type TierSource = 'probe' | 'backend' | 'manual';

const RANK: Record<Tier, number> = { C: 0, B: 1, A: 2 };

export interface TierState {
  readonly assigned: Tier;
  readonly source: TierSource;
  /** 判定原因（renderer 字串、探針 fps）—— **狀態列常駐顯示，供院內 IT 排查**。 */
  readonly reason: string;
  readonly diagnostics: Record<string, unknown>;
  /** 使用者覆寫後須保留還原路徑。 */
  readonly canRestore: boolean;
}

/** 硬性能力上限。**使用者覆寫也不得超越它。** */
export function hardCapabilityTier(cap: ClientCapability): Tier {
  if (!cap.webgl2 || cap.looksSoftware || cap.probeFps < 10) return 'C';
  if (cap.probeFps < 30) return 'B';
  return 'A';
}

export function arbitrate(args: {
  capability: ClientCapability;
  backendAssigned?: Tier | null;
  manualOverride?: Tier | null;
}): TierState {
  const { capability } = args;
  const hard = hardCapabilityTier(capability);
  const diagnostics: Record<string, unknown> = {
    webgl2: capability.webgl2,
    looksSoftware: capability.looksSoftware,
    rendererString: capability.rendererString,
    probeFps: Math.round(capability.probeFps * 10) / 10,
    maxTexture3d: capability.maxTexture3d,
    hasNorm16: capability.hasNorm16,
    hardCapabilityTier: hard,
    suggestedTier: capability.tier,
    backendAssigned: args.backendAssigned ?? null,
  };

  if (args.manualOverride) {
    require_(
      RANK[args.manualOverride] <= RANK[hard],
      'TIER1',
      t('手動覆寫不得超越硬性能力（無 WebGL2 時不可指定 A/B）'),
      { manualOverride: args.manualOverride, hardCapabilityTier: hard },
    );
    return {
      assigned: args.manualOverride,
      source: 'manual',
      reason: t('使用者手動指定'),
      diagnostics,
      canRestore: true,
    };
  }

  if (args.backendAssigned) {
    // 後端**不可上調**：取兩者中較低的
    const assigned = RANK[args.backendAssigned] < RANK[capability.tier] ? args.backendAssigned : capability.tier;
    const source: TierSource = assigned === args.backendAssigned && assigned !== capability.tier ? 'backend' : 'probe';
    return {
      assigned,
      source,
      reason:
        source === 'backend'
          ? t('後端下調（資料量在該 Tier 放不下）')
          : t('探針 {p0} fps', { p0: diagnostics.probeFps as number }),
      diagnostics,
      canRestore: false,
    };
  }

  return {
    assigned: capability.tier,
    source: 'probe',
    reason: t('探針 {p0} fps，renderer={rendererString}', { p0: diagnostics.probeFps as number, rendererString: capability.rendererString }),
    diagnostics,
    canRestore: false,
  };
}

/**
 * 載入時退讓：**配置量改為「保守起點 ＋ 載入時退讓」**，
 * 不做「加大到失敗」。
 *
 * * texture 上傳失敗或 `webglcontextlost` → **配額對半、重取較低的 lod、重試**
 * * **連續兩次失敗即降一個 Tier** 並通知使用者
 */
export interface YieldState {
  quotaScale: number;
  lodBias: number;
  consecutiveFailures: number;
  tier: Tier;
  downgraded: boolean;
}

export function initialYieldState(tier: Tier): YieldState {
  return { quotaScale: 1, lodBias: 0, consecutiveFailures: 0, tier, downgraded: false };
}

export function yieldOnFailure(state: YieldState): YieldState {
  const failures = state.consecutiveFailures + 1;
  if (failures >= 2) {
    const next: Tier = state.tier === 'A' ? 'B' : 'C';
    return {
      quotaScale: 1,
      lodBias: 0,
      consecutiveFailures: 0,
      tier: next,
      downgraded: state.tier !== next,
    };
  }
  return {
    quotaScale: state.quotaScale / 2,
    lodBias: Math.min(2, state.lodBias + 1),
    consecutiveFailures: failures,
    tier: state.tier,
    downgraded: false,
  };
}

export function yieldOnSuccess(state: YieldState): YieldState {
  return { ...state, consecutiveFailures: 0 };
}
