/**
 * 多影像合成：opacity、coverage（FOV 外透明）、閾值、色階。
 */

import { describe, expect, it } from 'vitest';

import { clearColormaps, getColormap, listColormaps, registerBuiltinColormaps } from '../src/core/raster/colormaps';
import { compositeOver, coverageFromPlane, normalizeToU8 } from '../src/core/raster/composite';

function target(n: number): ImageData {
  return { width: n, height: 1, data: new Uint8ClampedArray(n * 4) } as unknown as ImageData;
}

describe('compositeOver', () => {
  const gray = getColormap('gray');

  it('第一層 opacity 1 疊在透明底上 ＝ 它自己，alpha 255', () => {
    const t = target(2);
    compositeOver({ target: t, gray: new Uint8Array([100, 200]), lut: gray, opacity: 1 });
    expect([...t.data]).toEqual([100, 100, 100, 255, 200, 200, 200, 255]);
  });

  it('第二層 opacity 0.5 ＝ 50% 融合', () => {
    const t = target(1);
    compositeOver({ target: t, gray: new Uint8Array([0]), lut: gray, opacity: 1 });
    compositeOver({ target: t, gray: new Uint8Array([200]), lut: gray, opacity: 0.5 });
    expect(t.data[0]).toBe(100);
    expect(t.data[3]).toBe(255);
  });

  it('🔴 coverage 為 0 的像素不畫 —— CBCT 的小 FOV 不得把下面的 CT 塗黑', () => {
    const t = target(2);
    compositeOver({ target: t, gray: new Uint8Array([50, 50]), lut: gray, opacity: 1 });
    compositeOver({
      target: t,
      gray: new Uint8Array([250, 250]),
      lut: gray,
      opacity: 1,
      coverage: new Uint8Array([1, 0]),
    });
    expect(t.data[0]).toBe(250);
    expect(t.data[4]).toBe(50);
  });

  it('threshold：低於閾值的像素不畫（劑量 colorwash 的低劑量截止）', () => {
    const t = target(2);
    compositeOver({ target: t, gray: new Uint8Array([10, 200]), lut: gray, opacity: 1, thresholdU8: 20 });
    expect(t.data[3]).toBe(0);
    expect(t.data[7]).toBe(255);
  });

  it('半透明疊在透明底上：顏色不被拉暗，alpha 是 opacity', () => {
    const t = target(1);
    compositeOver({ target: t, gray: new Uint8Array([200]), lut: gray, opacity: 0.5 });
    expect(t.data[0]).toBe(200);
    expect(t.data[3]).toBe(128);
  });

  it('色階：green 只寫 G 通道', () => {
    registerBuiltinColormaps();
    const t = target(1);
    compositeOver({ target: t, gray: new Uint8Array([255]), lut: getColormap('green'), opacity: 1 });
    expect([...t.data]).toEqual([0, 255, 0, 255]);
  });
});

describe('coverageFromPlane / normalizeToU8', () => {
  it('沒有 NaN 時回 null（省下合成的一次分支）；有 NaN 時 0/1', () => {
    expect(coverageFromPlane(new Float32Array([1, 2, 3]))).toBeNull();
    expect([...coverageFromPlane(new Float32Array([1, Number.NaN, 3]))!]).toEqual([1, 0, 1]);
  });

  it('線性正規化到 0–255，NaN → 0，超界夾住', () => {
    expect([...normalizeToU8(new Float32Array([0, 25, 50, 60, -5, Number.NaN]), 0, 50)]).toEqual([
      0, 128, 255, 255, 0, 0,
    ]);
    expect([...normalizeToU8(new Float32Array([1]), 5, 5)]).toEqual([0]);
  });
});

describe('colormap 註冊表', () => {
  it('內建色階齊全，找不到退回 gray 而不拋例外，未註冊時懶註冊', () => {
    clearColormaps();
    expect(listColormaps()).toEqual([]);
    const lut = getColormap('nope');
    expect(lut).toBe(getColormap('gray'));
    expect(listColormaps()).toEqual(expect.arrayContaining(['gray', 'green', 'magenta', 'jet', 'hot', 'viridis']));
    expect(getColormap('jet')[0 * 3 + 2]).toBeGreaterThan(100); // jet 低端是藍
    expect(getColormap('jet')[255 * 3]).toBeGreaterThan(100); // 高端是紅
  });
});

describe('棋盤格／差值', () => {
  const gray = getColormap('gray');
  function wide(w: number, h: number): ImageData {
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) } as unknown as ImageData;
  }

  it('棋盤格：只畫 (⌊x/s⌋+⌊y/s⌋) 為奇數的格子，其餘露出底下', () => {
    const t = wide(4, 2);
    compositeOver({ target: t, gray: new Uint8Array(8).fill(10), lut: gray, opacity: 1 });
    compositeOver({ target: t, gray: new Uint8Array(8).fill(200), lut: gray, opacity: 1, blendMode: 'checkerboard', checkerPx: 2 });
    // 第 0 列：x 0,1 → 格 0（偶，不畫）；x 2,3 → 格 1（奇，畫）
    expect([t.data[0], t.data[4], t.data[8], t.data[12]]).toEqual([10, 10, 200, 200]);
    // 第 1 列（y 1 → ⌊1/2⌋=0）同上
    expect([t.data[16], t.data[24]]).toEqual([10, 200]);
  });

  it('差值：|src − dst|；沒有底時就是自己；對齊的兩張一樣的影像差值為 0', () => {
    const t = wide(2, 1);
    compositeOver({ target: t, gray: new Uint8Array([100, 0]), lut: gray, opacity: 1 });
    compositeOver({ target: t, gray: new Uint8Array([100, 250]), lut: gray, opacity: 1, blendMode: 'difference' });
    expect(t.data[0]).toBe(0); // 相同 → 0
    expect(t.data[4]).toBe(250); // 底是 0 → 差 250
    const empty = wide(1, 1);
    compositeOver({ target: empty, gray: new Uint8Array([80]), lut: gray, opacity: 1, blendMode: 'difference' });
    expect(empty.data[0]).toBe(80);
  });
});
