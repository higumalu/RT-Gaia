/**
 * mask 輪廓的兩態品質規則。
 *
 * ## 為什麼需要兩態
 *
 * > **捲動切面就是改變平面，因此每一幀都要重算輪廓。** 若只給 outline
 * > 一條預算，它與「MPR 捲動」的幀率要求在三個 Tier 上**全部互斥**
 * > （30 > 16.7、50 > 33、80 > 50）。
 *
 * | 狀態 | outline 行為 |
 * |---|---|
 * | **互動中** | **以 1/2 線性解析度跑 marching squares**（成本 1/4），線寬不變 |
 * | **停止後**（＋150 ms） | 全解析度重算。與高品質重切**同一個時機點** |
 * | **編輯中** | 只重算筆刷影響到的區域 |
 *
 * ## 什麼會讓輪廓失效
 *
 * | 操作 | 失效？ | 互動中的做法 |
 * |---|---|---|
 * | **Pan / Zoom** | ❌ | **對既有 polyline 做 2D 仿射變換。精確，不是近似** |
 * | WW / WL | ❌ | 完全不動 |
 * | **捲動切面** | ✅ 完全失效 | 🔴 **唯一沒有捷徑的操作**。1/2 解析度重算 |
 * | 斜面旋轉 | ✅ | 同上 |
 * | slab 厚度改變 | ✅ | 同上 |
 * | 相位切換 | ✅ | 重算，但**無 texture 上傳** |
 * | 可見結構集合改變 | 只有新增的 | 只算新增的那幾個 |
 * | 筆刷落筆 | 局部 | 只算髒 bbox |
 */

import type { Quality } from '../raster/types';
import { msg, t } from '../i18n';

/** 會讓輪廓失效的操作種類。 */
export type OutlineInvalidationCause =
  | 'pan-zoom'
  | 'window-level'
  | 'slice-scroll'
  | 'oblique-rotate'
  | 'slab-thickness'
  | 'phase-change'
  | 'visible-set-change'
  | 'brush-stroke';

export interface OutlineInvalidation {
  /** false = 可以用既有 polyline 的仿射變換，**完全不必重算**。 */
  needsRecompute: boolean;
  /** true = 只需重算新增／髒的部分，不是全部。 */
  partial: boolean;
  note: string;
}

/** 這張表就是上面那張表的可執行形式。**新增操作時必須在這裡表態。** */
export function outlineInvalidation(cause: OutlineInvalidationCause): OutlineInvalidation {
  switch (cause) {
    case 'pan-zoom':
      return {
        needsRecompute: false,
        partial: false,
        note: t('對既有 polyline 做 2D 仿射變換；輪廓在世界空間沒有動，因此這是精確的'),
      };
    case 'window-level':
      return { needsRecompute: false, partial: false, note: t('輪廓完全不動') };
    case 'slice-scroll':
    case 'oblique-rotate':
    case 'slab-thickness':
      return {
        needsRecompute: true,
        partial: false,
        note: t('平面改變 → 輪廓完全失效。**唯一沒有捷徑的操作**，且是最高頻的'),
      };
    case 'phase-change':
      return {
        needsRecompute: true,
        partial: false,
        note: t('重算，但無 texture 上傳（播放便宜的原因）'),
      };
    case 'visible-set-change':
      return { needsRecompute: true, partial: true, note: t('只算新增的那幾個結構') };
    case 'brush-stroke':
      return { needsRecompute: true, partial: true, note: t('只算髒 bbox') };
  }
}

/**
 * 互動中的解析度縮放。
 *
 * `interactive` → 1/2 線性解析度（**成本 1/4**），線寬不變，輪廓略粗糙但
 * **幾何位置正確**。
 */
export function outlineResolutionScale(quality: Quality): number {
  return quality === 'interactive' ? 0.5 : 1;
}

/**
 * slab 厚度下的輪廓語意。
 *
 * | 語意 | 顯示 | 成本 | 臨床意義 |
 * |---|---|---|---|
 * | **A · slab 中心面**（暫定預設） | 一條線 | **×1** | 與 RTSTRUCT 原生語意一致。厚板時與影像對不上 |
 * | B · slab 內聯集外緣 | 一條較粗的線 | ×N ＋ 多邊形布林 | 與 MIP／composite 的影像語意一致 |
 * | C · 每個取樣面各一條 | 一組線 | ×N | 資訊最多，實務上雜亂 |
 *
 * **互動態**一律取 A；🔴 **B 與 C 絕不進入互動態。**
 */
export type SlabOutlineSemantics = 'center' | 'union-outer' | 'stacked';

/** A 中心面為預設，三種都實作並可切換。 */
export const DEFAULT_SLAB_OUTLINE_SEMANTICS: SlabOutlineSemantics = 'center';

/** slab > 2 mm 時要在 viewport 角落常駐標示，避免使用者誤以為輪廓涵蓋整個厚度。 */
export const SLAB_NOTICE_THRESHOLD_MM = 2;

/**
 * B／C 允許的最大 slab。實測 10 mm 時 B ×6.8、C ×10.9；再厚就超過
 * 250 ms 的線，因此 > 10 mm 一律降級回 A 並在角落說明。
 */
export const SLAB_MULTI_PLANE_MAX_MM = 10;

export const SLAB_SEMANTICS_LABEL: Record<SlabOutlineSemantics, string> = {
  center: msg('輪廓＝slab 中心面'),
  'union-outer': msg('輪廓＝slab 內聯集外緣'),
  stacked: msg('輪廓＝逐取樣面堆疊'),
};

export interface SlabOutlinePlan {
  semantics: SlabOutlineSemantics;
  /** 要在 slab 內取樣幾個平面。`center` 恆為 1。 */
  samplePlanes: number;
  /** 需要在畫面上顯示的常駐提示；null = 不需要。 */
  notice: string | null;
}

export function planSlabOutline(args: {
  slabThicknessMm: number;
  quality: Quality;
  semantics?: SlabOutlineSemantics;
  sampleSpacingMm?: number;
}): SlabOutlinePlan {
  const requested = args.semantics ?? DEFAULT_SLAB_OUTLINE_SEMANTICS;
  const thick = args.slabThicknessMm > SLAB_NOTICE_THRESHOLD_MM;
  const notice = thick ? t(SLAB_SEMANTICS_LABEL[requested]) : null;

  if (requested === 'center' || args.slabThicknessMm <= 0) {
    return { semantics: 'center', samplePlanes: 1, notice: args.slabThicknessMm <= 0 ? null : notice };
  }
  // 🔴 B 與 C 絕不進入互動態：×N 成本乘上互動預算後三個 Tier 全部破表。
  if (args.quality === 'interactive') {
    return {
      semantics: 'center',
      samplePlanes: 1,
      notice: t('互動中一律取 slab 中心面，放手後補算'),
    };
  }
  // 太厚就降級回 A，並說出原因（不是靜默變回中心面）
  if (args.slabThicknessMm > SLAB_MULTI_PLANE_MAX_MM) {
    return {
      semantics: 'center',
      samplePlanes: 1,
      notice: t('slab > {SLAB_MULTI_PLANE_MAX_MM} mm：{p1}成本過高，降級為中心面', { SLAB_MULTI_PLANE_MAX_MM, p1: SLAB_SEMANTICS_LABEL[requested] }),
    };
  }
  const spacing = args.sampleSpacingMm ?? 1;
  const planes = Math.max(2, Math.min(32, Math.round(args.slabThicknessMm / spacing) + 1));
  return { semantics: requested, samplePlanes: planes, notice };
}

/**
 * outline 預算（每幀，20 結構）。**這是全表最脆弱的一格。**
 *
 * > 「10–30 ms」這個估計換掉了整個 mask 渲染架構，論證是對的，但
 * > **這個數字目前沒有任何實測支撐，而三個 Tier 的預算全部靠它**。
 * > 是必量項，且是全案最該優先量的單一數字。
 */
export const OUTLINE_BUDGET_MS = {
  interactive: { A: 8, B: 12, C: 20 },
  final: { A: 30, B: 50, C: 80 },
} as const;

export interface OutlineTiming {
  structureCount: number;
  quality: Quality;
  elapsedMs: number;
  tier: 'A' | 'B' | 'C';
}

export interface BudgetVerdict {
  withinBudget: boolean;
  budgetMs: number;
  /** 以 20 結構為基準normalise 後的耗時，方便與預算數字直接比。 */
  normalizedMs: number;
}

/** 把一次實測與預算對照。 */
export function checkOutlineBudget(timing: OutlineTiming): BudgetVerdict {
  const budgetMs = OUTLINE_BUDGET_MS[timing.quality][timing.tier];
  const normalizedMs =
    timing.structureCount > 0 ? (timing.elapsedMs * 20) / timing.structureCount : timing.elapsedMs;
  return { withinBudget: normalizedMs <= budgetMs, budgetMs, normalizedMs };
}
