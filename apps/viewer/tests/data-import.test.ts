/**
 * 匯入面板的純邏輯：DICM 前導、zip 判斷、本機前篩、併行上傳、結果彙整。
 */

import { describe, expect, it } from 'vitest';

import {
  attention,
  DICM_OFFSET,
  hasDicmPreamble,
  isTerminal,
  isZip,
  precheck,
  runWithConcurrency,
  summarizeCounts,
  type Candidate,
  type ImportItem,
} from '../src/react/data/importModel';

function dicm(): Uint8Array {
  const b = new Uint8Array(DICM_OFFSET + 4);
  b.set([0x44, 0x49, 0x43, 0x4d], DICM_OFFSET);
  return b;
}

describe('前導判斷', () => {
  it('DICM 在 offset 128；太短或別的字都不是', () => {
    expect(hasDicmPreamble(dicm())).toBe(true);
    expect(hasDicmPreamble(new Uint8Array(100))).toBe(false);
    const wrong = dicm();
    wrong[DICM_OFFSET] = 0x41;
    expect(hasDicmPreamble(wrong)).toBe(false);
  });
  it('zip 看副檔名或 PK 魔數', () => {
    expect(isZip('a/b/case.ZIP')).toBe(true);
    expect(isZip('case.dcm')).toBe(false);
    expect(isZip('blob', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0]))).toBe(true);
  });
});

describe('本機前篩', () => {
  it('隱藏檔與非 DICOM 跳過；zip 不讀前導直接上傳；位元組只算要上傳的', async () => {
    const reads: string[] = [];
    const c = (relativePath: string, size: number, bytes: Uint8Array): Candidate => ({
      relativePath,
      size,
      head: () => {
        reads.push(relativePath);
        return Promise.resolve(bytes);
      },
    });
    const pre = await precheck([
      c('ct/1.dcm', 500_000, dicm()),
      c('ct/.DS_Store', 6000, new Uint8Array(200)),
      c('DICOMDIR', 4000, new Uint8Array(200)),
      c('tiny', 10, dicm()),
      c('bundle.zip', 9_000_000, new Uint8Array(0)),
      c('report.pdf', 80_000, new Uint8Array(200)),
    ]);
    expect(pre.upload.map((u) => u.relativePath)).toEqual(['ct/1.dcm', 'bundle.zip']);
    expect(pre.skipped.map((s) => `${s.relativePath}:${s.reason}`)).toEqual([
      'ct/.DS_Store:隱藏檔',
      'DICOMDIR:沒有 DICM 前導',
      'tiny:太小，不是 DICOM',
      'report.pdf:沒有 DICM 前導',
    ]);
    expect(pre.bytes).toBe(9_500_000);
    // zip 與太小的檔不讀前導
    expect(reads).toEqual(['ct/1.dcm', 'DICOMDIR', 'report.pdf']);
  });
});

describe('併行上傳', () => {
  it('同時最多 limit 個；單一失敗不中斷；結果照原順序；進度遞增到 total', async () => {
    let inFlight = 0;
    let peak = 0;
    const progress: number[] = [];
    const results = await runWithConcurrency(
      [1, 2, 3, 4, 5, 6, 7],
      3,
      async (n) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5 + (n % 3) * 3));
        inFlight -= 1;
        if (n === 4) throw new Error('boom');
        return n * 10;
      },
      (done) => progress.push(done),
    );
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : 'x'))).toEqual([10, 20, 30, 'x', 50, 60, 70]);
    expect(progress).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
  it('空清單直接回空', async () => {
    expect(await runWithConcurrency([], 6, async () => 1)).toEqual([]);
  });
});

describe('結果彙整', () => {
  const item = (outcome: ImportItem['outcome'], path = 'p'): ImportItem => ({
    relative_path: path,
    outcome,
    reason: '',
    sop_instance_uid: '',
    modality: '',
    size: 0,
  });
  it('摘要只列非零；重複（相同內容）不算需要注意', () => {
    expect(summarizeCounts({ accepted: 187, duplicate_same: 3, rejected: 1, duplicate_diff: 0 })).toBe('接受 187 · 重複 3 · 拒絕 1');
    expect(summarizeCounts({})).toBe('（空）');
    expect(attention([item('accepted'), item('duplicate_same'), item('rejected', 'r'), item('duplicate_diff', 'd')]).map((i) => i.relative_path)).toEqual(['r', 'd']);
    expect(['done', 'failed', 'discarded'].map((s) => isTerminal(s as never))).toEqual([true, true, true]);
    expect(isTerminal('running')).toBe(false);
  });
});
