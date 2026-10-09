import { probeLine } from '../src/react/panels/probeModel';
import type { ProbeReadout } from '../src/core';

const reading = (over: Partial<ProbeReadout['readings'][number]>): ProbeReadout['readings'][number] =>
  ({ layerId: 'l', label: 'CT（主）', acquisitionIjk: [240, 224, 80], value: 45, unit: 'HU', approximate: false, unavailable: null, ...over }) as ProbeReadout['readings'][number];

describe('讀數列（左下角、N/A）', () => {
  it('沒有讀數 → N/A；指標離開 → N/A', () => {
    expect(probeLine(null).world).toBe('N/A');
    expect(probeLine({ world: [1, 2, 3], viewportId: 'a', source: 'frozen', readings: [reading({})] }).world).toBe('N/A');
    expect(probeLine({ world: [1, 2, 3], viewportId: 'a', source: 'frozen', readings: [reading({})] }).readings).toEqual([]);
  });
  it('指到影像 → 座標 ＋ 每序列的索引與值；體積外 → N/A 且不顯示填充值', () => {
    const line = probeLine({ world: [-22, 54.7, 115], viewportId: 'a', source: 'pointer', readings: [reading({}), reading({ layerId: 'cb', label: 'CBCT', value: null, acquisitionIjk: null, unavailable: 'outside-volume' })] });
    expect(line.world).toBe('-22.0, 54.7, 115.0 mm');
    expect(line.readings[0]).toMatchObject({ label: 'CT（主）', ijk: '(240, 224, 80)', value: '45 HU', na: false });
    expect(line.readings[1]).toMatchObject({ label: 'CBCT', ijk: null, value: 'N/A', na: true });
    expect(line.readings[1]!.title).toMatch(/體積之外/);
  });
});
