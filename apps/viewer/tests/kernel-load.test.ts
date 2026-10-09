/**
 * wasm 只抓、只編譯一次；抓檔有逾時與重試 —— 以前偶爾那個請求不回來，換病例後一張 canvas 都沒有、
 * 停在「載入中…」、沒有任何錯誤。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { loadResliceKernel, resetKernelModuleCache } from '../src/core/raster/resliceKernel';

const WASM = readFileSync(fileURLToPath(new URL('../public/rtgaia_reslice.wasm', import.meta.url)));
const ok = (): Response => new Response(new Uint8Array(WASM), { status: 200, headers: { 'content-type': 'application/wasm' } });
/** 永遠不回、直到被 abort。 */
const hang = (init?: RequestInit): Promise<Response> =>
  new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));

afterEach(() => resetKernelModuleCache());

describe('loadResliceKernel', () => {
  it('第一次請求不回來 → 逾時後重試成功；之後的 host 不再抓檔（各自一份新的 memory）', async () => {
    let calls = 0;
    const fetcher = ((_url: RequestInfo | URL, init?: RequestInit) => (calls += 1) === 1 ? hang(init) : Promise.resolve(ok())) as typeof fetch;
    const a = await loadResliceKernel('/k.wasm', fetcher, 50);
    const b = await loadResliceKernel('/k.wasm', fetcher, 50);
    expect(calls).toBe(2);
    expect(a.abiVersion).toBe(b.abiVersion);
    expect(a).not.toBe(b);
  });

  it('一直失敗 → 明確的錯誤（不是永遠卡住）；下一次會重新試', async () => {
    let calls = 0;
    const bad = ((_url: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      return hang(init);
    }) as typeof fetch;
    await expect(loadResliceKernel('/k.wasm', bad, 20)).rejects.toThrow(/重切核心（\/k\.wasm）載入失敗/);
    expect(calls).toBe(3);
    const good = (() => Promise.resolve(ok())) as typeof fetch;
    await expect(loadResliceKernel('/k.wasm', good, 20)).resolves.toBeDefined();
  });

  it('HTTP 錯誤也重試', async () => {
    let calls = 0;
    const fetcher = (() => Promise.resolve((calls += 1) < 3 ? new Response('no', { status: 502 }) : ok())) as typeof fetch;
    await expect(loadResliceKernel('/k.wasm', fetcher, 20)).resolves.toBeDefined();
    expect(calls).toBe(3);
  });
});
