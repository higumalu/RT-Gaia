/** e2e 的每檔案 setup：註冊 Node 的 zstd 解壓器（同 `tests/setup.ts`）。 */
import { zstdDecompressSync } from 'node:zlib';

import { registerZstdDecoder } from '../../src/core/transport/decode';

registerZstdDecoder((compressed) => new Uint8Array(zstdDecompressSync(compressed)));
