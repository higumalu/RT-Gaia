/**
 * `public/plugin-shims/sdk.js` 的具名匯出是手寫的清單：SDK 加了執行期匯出（例：0.1.1 的 registerMessages／t）
 * 卻忘了加進 shim，plugin bundle 的 `import { t } from '@rtgaia/sdk'` 在瀏覽器裡就是 undefined —— 型別檢查與建置都抓不到。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as sdk from '../src/sdk';

describe('plugin SDK shim', () => {
  it('shim 的具名匯出 ＝ SDK 的執行期匯出', () => {
    const src = readFileSync(fileURLToPath(new URL('../public/plugin-shims/sdk.js', import.meta.url)), 'utf8');
    const list = /export const \{([^}]+)\} = M;/.exec(src)?.[1] ?? '';
    const names = list
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
      .sort();
    expect(names).toEqual(Object.keys(sdk).sort());
  });

  it('0.1.1：介面語言的函式是 SDK 的一部分', () => {
    expect(sdk.SDK_VERSION).toBe('0.1.1');
    for (const name of ['registerMessages', 't', 'msg', 'getLang'] as const) expect(typeof sdk[name]).toBe('function');
  });
});
