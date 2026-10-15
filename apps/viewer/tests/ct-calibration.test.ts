/** CT 校正曲線 —— 貼上的點表（表頭、分隔符號、錯誤行）、比對規則的文字、畫圖座標、組成的文字。 */

import { describe, expect, it } from 'vitest';

import { compositionText, curvePath, formatPoints, matchText, parsePoints } from '../src/react/dosecalc/ctCalibrationModel';

describe('點表', () => {
  it('逗號、Tab、空白、分號都可以；表頭與 # 註解略過', () => {
    const [pts, problem] = parsePoints('HU, density\n# CIRS 062M\n-1000, 0.001\n0\t1.0\n1000 1.61\n3000;2.8\n\n');
    expect(problem).toBeNull();
    expect(pts).toEqual([
      [-1000, 0.001],
      [0, 1],
      [1000, 1.61],
      [3000, 2.8],
    ]);
  });
  it('中間的壞行要指出行號；少於兩點也不行', () => {
    expect(parsePoints('-1000, 0.001\n0, x\n')[1]).toMatch(/2/);
    expect(parsePoints('-1000, 0.001, 3\n0, 1')[1]).not.toBeNull();
    expect(parsePoints('0, 1')[1]).not.toBeNull();
    expect(parsePoints('')[1]).not.toBeNull();
  });
  it('點表 → 文字 → 點表：原樣（編輯與複製的底）', () => {
    const pts: Array<[number, number]> = [
      [-1000, 0.00121],
      [100, 1.1199],
      [101, 1.076792],
      [2995, 4.54],
    ];
    expect(parsePoints(formatPoints(pts))).toEqual([pts, null]);
  });
});

describe('顯示', () => {
  it('比對規則', () => {
    expect(matchText({ manufacturer: 'Siemens', model: 'SOMATOM go.Up', kvp: 120 })).toBe('Siemens · SOMATOM go.Up · 120 kVp');
    expect(matchText({ manufacturer: '', model: 'X', kvp: null })).toBe('X');
    expect(matchText({ manufacturer: '', model: '', kvp: null, default: true })).toMatch(/預設/);
  });
  it('畫圖座標：HU 從 −1000 開始、密度軸留 10% 空間', () => {
    const { x, y, path, rhoMax } = curvePath({ hu: [-1000, 0, 2000], density: [0.001, 1, 2], material: [0, 5, 23] }, 528, 228, 14);
    expect(x(-1000)).toBe(14);
    expect(x(2000)).toBe(514);
    expect(rhoMax).toBeCloseTo(2.2);
    expect(y(0)).toBe(214);
    expect(path.startsWith('M14.0 ')).toBe(true);
    expect(path.split('L')).toHaveLength(3);
  });
  it('組成：大到小、最多 5 個', () => {
    expect(compositionText({ O: 0.749, H: 0.103, C: 0.105, N: 0.031, P: 0.002, S: 0.003, Cl: 0.003 })).toBe('O 74.9% · C 10.5% · H 10.3% · N 3.1% · S 0.3%');
  });
});
