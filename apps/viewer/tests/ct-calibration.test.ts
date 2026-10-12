/** CT 校正曲線 —— 貼上的點表（表頭、分隔符號、錯誤行）、比對規則的文字、畫圖座標、組成的文字。 */

import { describe, expect, it } from 'vitest';

import { compositionText, curvePath, matchText, parsePoints } from '../src/react/dosecalc/ctCalibrationModel';

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
});

describe('顯示', () => {
  it('比對規則', () => {
    expect(matchText({ manufacturer: 'Siemens', model: 'SOMATOM go.Up', kvp: 120 })).toBe('Siemens · SOMATOM go.Up · 120 kVp');
    expect(matchText({ manufacturer: '', model: 'X', kvp: null })).toBe('X');
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
