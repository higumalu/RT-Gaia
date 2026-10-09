/**
 * 🔴 **chaos 模式 → 前端行為的一對一對照表**。
 *
 * > 不變式 I1–I4 要求前端**拒絕**不合法的資料。**若測試後端永遠守
 * > 規矩，那些拒絕邏輯就是死碼**——會在正式環境第一次遇到問題時才發現寫錯。
 *
 * fixture 由 `scripts/emit-chaos-fixtures.py` 產生：每個模式各打一次測試後端，
 * 把**真實的壞訊框**存成 bytes。因此這個檔案在 Node 下、離線、確定性地驗證
 * 前端會拒絕它們，而不是靠「相信我們有寫檢查」。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ContractViolation } from '../src/core/geometry';
import { decodeFrame } from '../src/core/transport/decode';
import { fromWire } from '../src/core/transport/wire';
import { assertPayloadLength, assertSameFamily } from '../src/core/geometry/invariants';

interface ChaosCase {
  name: string;
  mode: string | null;
  target: string;
  file: string | null;
  expect_code: string | null;
  expected_behaviour: string;
  covered_by?: string;
}

const dir = fileURLToPath(new URL('./fixtures/chaos/', import.meta.url));
const manifest = JSON.parse(readFileSync(`${dir}manifest.json`, 'utf8')) as { cases: ChaosCase[] };

function frameOf(file: string): Uint8Array {
  return new Uint8Array(readFileSync(`${dir}${file}`));
}

/**
 * 🔴 會話的網格 id 來自 `POST /grids`，**不是來自 payload 自己**。
 *
 * 拿 payload 的 id 跟自己比是 I3 最容易寫錯的一種——它永遠會通過，於是
 * `grid_mismatch` 完全測不到。這裡以乾淨 fixture 的 id 當會話基準。
 */
const SESSION = (() => {
  const image = decodeFrame(frameOf('clean_image.bin')).header;
  const mask = decodeFrame(frameOf('clean_mask.bin')).header;
  return {
    displayGridId: String(image.display_grid_id),
    maskGridId: String(mask.mask_grid_id),
  };
})();

/** 完整走一遍前端的解碼路徑：訊框 → header → 幾何 → 描述子長度。 */
function decodeStrict(file: string, target: string): void {
  const { header, body } = decodeFrame(frameOf(file));
  if (target === 'image') {
    // I3：影像的網格 id 必須與會話相符
    assertSameFamily({
      payloadGridRef: String(header.display_grid_id),
      sessionGridId: SESSION.displayGridId,
      family: 'display',
    });
    fromWire.grid(header.grid as Record<string, unknown>);
  } else {
    assertSameFamily({
      payloadGridRef: String(header.mask_grid_id),
      sessionGridId: SESSION.maskGridId,
      family: 'mask',
    });
  }
  const sizeIjk = header.size_ijk as [number, number, number];
  const offsetIjk = header.offset_ijk as number[];
  // I1：整數 offset
  for (const v of offsetIjk) {
    if (!Number.isInteger(v)) {
      throw new ContractViolation('I1', 'offset_ijk 必須是整數 voxel', { offsetIjk });
    }
  }
  // I9：payload 長度必須與描述子相符
  assertPayloadLength({
    sizeIjk,
    components: Number(header.components ?? 1),
    bytesPerElement: String(header.dtype) === 'int16' ? 2 : 1,
    actualBytes: body.byteLength,
  });
}

describe('chaos 對照表', () => {
  it('manifest 涵蓋全部九種模式', () => {
    const modes = new Set(manifest.cases.map((c) => c.mode).filter((m): m is string => m !== null));
    expect(modes).toEqual(
      new Set([
        'grid_mismatch',
        'fractional_offset',
        'missing_direction',
        'stale_hash',
        'latency',
        'truncate',
        'disconnect',
        'wrong_size',
        'push_limit',
      ]),
    );
  });

  it('每個非 payload 模式都指明由哪個測試涵蓋（對照表不留空白）', () => {
    for (const c of manifest.cases.filter((x) => x.file === null)) {
      expect(c.covered_by, `${c.name} 沒有指明涵蓋處`).toBeTruthy();
    }
  });

  // ── 反向保證 ─────────────────────────────────────────────────────────────

  for (const c of manifest.cases.filter((x) => x.mode === null && x.file !== null)) {
    it(`${c.name}：乾淨的 payload 必須正常解碼`, () => {
      expect(() => decodeStrict(c.file!, c.target)).not.toThrow();
    });
  }

  // ── 九種模式中的五種在 payload 層 ────────────────────────────────────────

  for (const c of manifest.cases.filter((x) => x.mode !== null && x.file !== null)) {
    it(`${c.mode}：${c.expected_behaviour}`, () => {
      let thrown: unknown = null;
      try {
        decodeStrict(c.file!, c.target);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `${c.mode} 沒有被拒絕 —— 前端的拒絕邏輯是死碼`).toBeInstanceOf(
        ContractViolation,
      );
      expect((thrown as ContractViolation).code).toBe(c.expect_code);
    });
  }
});

describe('grid_mismatch 的跨會話比對', () => {
  it('payload 的網格 id 與會話不符時拒絕（不得自動對齊）', () => {
    const { header } = decodeFrame(frameOf('grid_mismatch.bin'));
    const clean = decodeFrame(frameOf('clean_mask.bin'));
    const sessionGridId = String(clean.header.mask_grid_id);
    expect(String(header.mask_grid_id)).not.toBe(sessionGridId);
    expect(() =>
      assertSameFamily({
        payloadGridRef: String(header.mask_grid_id),
        sessionGridId,
        family: 'mask',
      }),
    ).toThrowError(/I3/);
  });
});

describe('truncate 的偵測時機', () => {
  it('在解碼時就被抓到，而不是渲染時（不得渲染半張影像）', () => {
    expect(() => decodeFrame(frameOf('truncate.bin'))).toThrowError(/W6/);
  });
});
