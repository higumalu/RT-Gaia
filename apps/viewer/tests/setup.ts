/**
 * vitest 全域設定。
 *
 * 註冊 Node 的 zstd 解壓器 —— `core/transport/decode.ts` 刻意把解壓做成可插拔
 * （瀏覽器用 wasm、Node 用內建 zlib），因此測試不需要引入 wasm 解壓套件。
 */

import { zstdDecompressSync } from 'node:zlib';

import { registerZstdDecoder } from '../src/core/transport/decode';

/**
 * 🔴 **`node:zlib` 的 zstd 是 Node 22.15+ 才有的。**
 *
 * 少了這道檢查，症狀是 `chaos-matrix.test.ts` 掛在
 * `(0 , zstdDecompressSync) is not a function` —— 而那句話不會讓任何人想到
 * Node 版本。CI 曾經釘在 Node 20，於是 chaos 一對一對照表**整組沒跑到**，
 * 而其餘 453 條全綠。
 *
 * 型別上 `zstdDecompressSync` 一定存在（`@types/node` 這麼說），執行期不一定 ——
 * 因此要先把 `undefined` 加回型別才檢查得到。這是「型別比現實樂觀」的一個實例。
 */
const decompress = zstdDecompressSync as typeof zstdDecompressSync | undefined;
if (decompress === undefined) {
  throw new Error(
    `node:zlib 缺少 zstdDecompressSync —— 測試需要 Node 22.15+，` +
      `目前是 ${process.version}（見 apps/viewer/package.json 的 engines）。`,
  );
}

registerZstdDecoder((compressed) => new Uint8Array(decompress(compressed)));

// 英文字典在瀏覽器是 lazy 載入；測試直接放進來，`setLang('en')` 之後馬上 `t()` 照舊是同步的
import { installEnglish, setLang } from '../src/core/i18n';
import { EN } from '../src/core/i18n/en';

installEnglish(EN);
// 介面預設英文，但單元測試是對原文（繁中）斷言 —— 測試一律從繁中開始；要看英文的測試自己 `setLang('en')`
void setLang('zh-TW');
