/**
 * 各 Tier 的記憶體配額。
 *
 * > 🔄 **Tier C 的取捨方向與 A/B 相反，配額不能直接沿用。**
 * > 記憶體反而寬鬆（系統 RAM，不是 VRAM），**算力才是瓶頸**。
 *
 * ## mask 配額改為 CPU 端解讀
 *
 * outline 成為預設之後，「mask 合計 ≤ 1.2 GB **VRAM**」這一列在 GPU 上已經不
 * 對應任何東西（outline 的 GPU 常駐 ≈ 0）。真正需要配額的是**CPU 端的 mask
 * 體素常駐**（編輯與 marching squares 都要它），而原表沒有 Tier A/B 的 CPU 欄。
 *
 * 因此本檔把 mask 配額一律當作 **CPU 端**配額，三個 Tier 都適用；GPU 側只有
 * `mask-fill` 的打包 texture 需要 VRAM，另立 `maskFillVramBytes`。
 * **mask 常駐的 LRU 門檻取自這裡。**
 */

import type { Tier } from '../raster/types';

export interface TierBudget {
  /** GPU 常駐（Tier A/B）或系統 RAM（Tier C）的影像上限。 */
  imageBytes: number;
  /** **CPU 端**的 mask 體素常駐上限。 */
  maskCpuBytes: number;
  /** `mask-fill` 打包 texture 的 VRAM 上限（僅 GPU 路徑）。 */
  maskFillVramBytes: number;
  meshBytes: number;
  totalBytes: number;
}

const MB = 1_000_000;

const SINGLE: Record<Tier, TierBudget> = {
  A: { imageBytes: 1200 * MB, maskCpuBytes: 1200 * MB, maskFillVramBytes: 250 * MB, meshBytes: 300 * MB, totalBytes: 3000 * MB },
  B: { imageBytes: 400 * MB, maskCpuBytes: 300 * MB, maskFillVramBytes: 80 * MB, meshBytes: 100 * MB, totalBytes: 1000 * MB },
  C: { imageBytes: 1000 * MB, maskCpuBytes: 2000 * MB, maskFillVramBytes: 0, meshBytes: 400 * MB, totalBytes: 4000 * MB },
};

const DUAL: Record<Tier, TierBudget> = {
  A: { imageBytes: 1800 * MB, maskCpuBytes: 800 * MB, maskFillVramBytes: 250 * MB, meshBytes: 300 * MB, totalBytes: 3000 * MB },
  B: { imageBytes: 550 * MB, maskCpuBytes: 250 * MB, maskFillVramBytes: 80 * MB, meshBytes: 100 * MB, totalBytes: 1000 * MB },
  C: { imageBytes: 1600 * MB, maskCpuBytes: 1600 * MB, maskFillVramBytes: 0, meshBytes: 400 * MB, totalBytes: 4000 * MB },
};

/**
 * `seriesCount` ≥ 2 一律用「雙影像」那一欄。
 *
 * 配額表只有單／雙兩欄；3 個以上序列的做法是：不設序列數
 * 硬上限，改以 `maxFullResVolumes()` 限制同時全解析度常駐的數量，其餘序列以
 * lod 2 常駐（1/64 大小）。因此 3 個以上序列的總量仍落在雙影像的預算內。
 */
export function budgetFor(tier: Tier, seriesCount: number): TierBudget {
  const base = seriesCount <= 1 ? SINGLE[tier] : DUAL[tier];
  if (deviceClass !== 'phone') return base;
  return {
    imageBytes: Math.min(base.imageBytes, PHONE.imageBytes),
    maskCpuBytes: Math.min(base.maskCpuBytes, PHONE.maskCpuBytes),
    maskFillVramBytes: Math.min(base.maskFillVramBytes, PHONE.maskFillVramBytes),
    meshBytes: Math.min(base.meshBytes, PHONE.meshBytes),
    totalBytes: Math.min(base.totalBytes, PHONE.totalBytes),
  };
}

/**
 * 手機另一級記憶體預算 —— 手機瀏覽器單一分頁能用的記憶體比桌面少很多，超過時分頁會被系統直接重新載入
 * （編輯到一半的東西若還沒送出就不見了）。Tier 照 GPU 探針判，預算再取兩者較小的。
 * 數字是保守的起點（Android Chrome 實機量過再調）；mask 一律在原始網格，所以 mask 不降解析度、只限常駐量。
 */
const PHONE: TierBudget = { imageBytes: 400 * MB, maskCpuBytes: 300 * MB, maskFillVramBytes: 40 * MB, meshBytes: 50 * MB, totalBytes: 800 * MB };
export type DeviceMemoryClass = 'default' | 'phone';
let deviceClass: DeviceMemoryClass = 'default';
/** App 依版面設定（手機 → `'phone'`）；之後新建的 host 與預算計算都用它。 */
export function setDeviceMemoryClass(c: DeviceMemoryClass): void {
  deviceClass = c;
}
export function deviceMemoryClass(): DeviceMemoryClass {
  return deviceClass;
}

/**
 * 同時以 lod 0 常駐的體積數上限：A 4、B 2、C 3。
 *
 * 超過的序列保留 lod 2（`VolumeStore.enforceFullResBudget`），重新顯示時再補。
 */
export function maxFullResVolumes(tier: Tier): number {
  const n = tier === 'A' ? 4 : tier === 'B' ? 2 : 3;
  return deviceClass === 'phone' ? Math.min(n, 2) : n;
}

/**
 * 同時可見結構數上限。
 *
 * outline 模式 **50**；fill 模式 **4**。超過時提示改用 3D mesh 總覽。
 */
export const VISIBLE_STRUCTURE_LIMIT = { outline: 50, fill: 4 } as const;

/**
 * 缺 `EXT_texture_norm16` 時 int16 會以 float32 上傳（**記憶體翻倍**）。
 * 上面的預算必須留得下這個情況。
 */
export function imageBytesPerVoxel(args: { tier: Tier; hasNorm16: boolean; dtype: 'int16' | 'uint8' }): number {
  if (args.dtype === 'uint8') return 1;
  if (args.tier === 'C') return 2; // CPU 路徑沒有 texture，就是 int16 本身
  return args.hasNorm16 ? 2 : 4;
}
