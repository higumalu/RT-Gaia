/**
 * 瀏覽器端的 zstd 解壓（相依清單裡 `zstd (wasm)` 那一條）。
 *
 * 🔴 **這個檔案存在的理由是一個真實踩過的洞。**
 *
 * `decode.ts` 刻意把解壓做成可插拔（Node 測試用內建 `zlib`、瀏覽器用套件）。
 * 但「可插拔」加上「忘了在 app 註冊」的結果是：**測試全綠，真瀏覽器一載入影像
 * 就 `[W8] 尚未註冊解壓器`**。因此預設實作放進 `registerCoreBuiltins()`，
 * 讓忘記註冊變成不可能；測試仍可事後覆寫。
 *
 * 選 `fzstd`（MIT，約 10 KB，純 TypeScript）而非 wasm 版：
 * * 授權只允許 MIT / BSD / Apache-2.0 ✅
 * * 少一個 wasm 資產要處理 COOP/COEP 與快取
 * * 影像 payload 的解壓不是瓶頸（zstd level 3 的解壓吞吐 > 1 GB/s）
 */

import { decompress } from 'fzstd';

import { registerZstdDecoder } from './decode';

/**
 * 註冊預設的 zstd 解壓器。**冪等**；後註冊者覆寫（測試用）。
 */
export function registerDefaultZstdDecoder(): void {
  registerZstdDecoder((compressed, uncompressedBytes) => {
    const out = decompress(compressed);
    if (out.byteLength !== uncompressedBytes) {
      // 長度不符交給 decode.ts 的 W7 報錯，這裡不吞掉
      return out;
    }
    return out;
  });
}
