/**
 * 2026-09-30「nnU-Net plugin 掛掉了」：以區網 IP 走 http 開檢視器時沒有 `crypto.subtle`，plugin bundle 的 digest 驗證丟例外 →
 * plugin 載入失敗。純 JS 的 SHA-256 備援：標準測試向量、與 Node crypto 逐一比對、`sha256Hex` 在沒有 subtle 時照樣驗得出來。
 */
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { sha256Hex, verifyBundleDigest } from '../src/react/plugins/loader';
import { sha256HexSync } from '../src/react/plugins/sha256';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('純 JS SHA-256', () => {
  it('FIPS 180-4 測試向量', () => {
    expect(sha256HexSync(enc(''))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256HexSync(enc('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256HexSync(enc('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
    expect(sha256HexSync(enc('a'.repeat(1_000_000)))).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  });

  it('跟 Node crypto 逐一比對（各種長度跨越 55／56／64 位元組邊界、含中文）', () => {
    for (const n of [1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 4097]) {
      const text = `劑量${'x'.repeat(n)}`;
      expect(sha256HexSync(enc(text)), `n=${n}`).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
    }
  });
});

describe('沒有 crypto.subtle（非安全環境）時 digest 驗證照做', () => {
  it('sha256Hex 退回純 JS，結果與 subtle 相同', async () => {
    const text = 'export default { id: "nnunet-oar" };';
    const expected = createHash('sha256').update(text).digest('hex');
    expect(await sha256Hex(text, undefined)).toBe(expected);
    expect(await sha256Hex(text, globalThis.crypto.subtle)).toBe(expected);
  });

  it('verifyBundleDigest：對的 digest 放行、錯的擋下（不因為沒有 subtle 就略過）', async () => {
    const body = 'console.log("bundle")';
    const good = createHash('sha256').update(body).digest('hex');
    const fakeFetch = (async () => new Response(body, { status: 200 })) as typeof fetch;
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true }); // 模擬 http://192.168.x.x
    try {
      expect(await verifyBundleDigest('/x.js', good, fakeFetch)).toBeNull();
      expect(await verifyBundleDigest('/x.js', 'f'.repeat(64), fakeFetch)).toMatch(/digest/);
    } finally {
      if (saved) Object.defineProperty(globalThis, 'crypto', saved);
    }
  });
});
