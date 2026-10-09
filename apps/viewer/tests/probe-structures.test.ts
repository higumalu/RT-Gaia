/**
 * 讀數點落在哪些**顯示中**的 ROI —— 核心取樣（`probeStructures`）與
 * 狀態列的排版邏輯（`probeRois`：體積小的在前、前 5 個、同名加集的短名、未載入另計、指標離開清空）。
 */

import { describe, expect, it } from 'vitest';

import { createGrid, indexToWorld, primaryFrameGroupOf, type FrameGroup, type Grid } from '../src/core/geometry';
import type { Layer } from '../src/core/layers/types';
import type { StructureMeta, StructureSetInfo } from '../src/core/panels/api';
import { probeStructures, type ProbeReadout } from '../src/core/scene/probe';
import { blockGridOf, type MaskEntry } from '../src/core/scene/volumeStore';
import { PROBE_ROI_LIMIT, probeRois } from '../src/react/panels/probeModel';

const FOR = 'for-p';
const maskGrid: Grid = createGrid({ size: [20, 20, 20], spacing: [1, 1, 1], origin: [0, 0, 0], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], frameOfReferenceUid: FOR });
const primary = primaryFrameGroupOf(FOR, 'ct');

/** 一個 bbox 區塊：offset、size，區塊內全部 1（`hole` 那一格設 0）。 */
function mask(structureId: string, offset: [number, number, number], size: [number, number, number], hole?: [number, number, number]): MaskEntry {
  const voxels = new Uint8Array(size[0] * size[1] * size[2]).fill(1);
  if (hole) voxels[hole[0] + size[0] * (hole[1] + size[1] * hole[2])] = 0;
  return { structureId, frameIndex: null, blockGrid: blockGridOf(maskGrid, offset, size), offsetIjk: offset, sizeIjk: size, voxels, contentHash: 'h', revision: 0 };
}

const layer = (id: string, visible = true, extra: Partial<Layer> = {}): Layer =>
  ({ layerId: `mask:${id}`, kind: 'mask', label: id.toUpperCase(), groupId: 'structures', frameOfReferenceUid: FOR, contentRef: id, visible, opacity: 1, order: 0, color: [255, 0, 0], ...extra });

describe('probeStructures（核心取樣）', () => {
  const masks = new Map<string, MaskEntry>([
    ['body', mask('body', [0, 0, 0], [20, 20, 20])],
    ['ptv', mask('ptv', [5, 5, 5], [4, 4, 4], [1, 1, 1])],
  ]);
  const fg = (): FrameGroup => primary;
  const at = (ijk: [number, number, number], layers: Layer[], maskFor = (l: Layer) => masks.get(l.contentRef)) =>
    probeStructures({ world: indexToWorld(maskGrid, ijk), layers, maskFor, frameGroupFor: fg });

  it('區塊內且值 ≠ 0 才算在裡面；區塊外、洞（值 0）不算；最近鄰（半格內）', () => {
    expect(at([6, 5, 5], [layer('body'), layer('ptv')]).inside.map((h) => h.structureId)).toEqual(['body', 'ptv']);
    expect(at([12, 12, 12], [layer('body'), layer('ptv')]).inside.map((h) => h.structureId)).toEqual(['body']);
    expect(at([6, 6, 6], [layer('body'), layer('ptv')]).inside.map((h) => h.structureId)).toEqual(['body']); // 洞
    const nearEdge = probeStructures({ world: [8.4, 5, 5], layers: [layer('ptv')], maskFor: (l) => masks.get(l.contentRef), frameGroupFor: fg });
    expect(nearEdge.inside).toHaveLength(1); // 8.4 → 最近鄰 8（區塊 5..8）
    const outside = probeStructures({ world: [8.6, 5, 5], layers: [layer('ptv')], maskFor: (l) => masks.get(l.contentRef), frameGroupFor: fg });
    expect(outside.inside).toHaveLength(0);
  });

  it('只看顯示中的 mask；影像／劑量圖層忽略；沒常駐的另列', () => {
    const r = at([6, 5, 5], [layer('body', false), layer('ptv'), { ...layer('img'), kind: 'image' }, layer('gtv')]);
    expect(r.inside.map((h) => h.structureId)).toEqual(['ptv']);
    expect(r.notResident.map((h) => h.structureId)).toEqual(['gtv']);
    expect(r.inside[0]!.colorRgb).toEqual([255, 0, 0]);
  });

  it('次要 FoR 的結構經 transformToPrimary 的逆變換', () => {
    const shift = 30;
    const secondary: FrameGroup = { frameOfReferenceUid: 'for-s', seriesId: 'cbct', role: 'secondary', transformToPrimary: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, shift, 0, 0, 1], transformKind: 'rigid', coverageMaskId: null };
    const cbctPtv = layer('cbct-ptv', true, { frameOfReferenceUid: 'for-s' });
    const own = indexToWorld(maskGrid, [6, 6, 5]); // 在 ptv 區塊內（不是洞）
    const r = probeStructures({ world: [own[0] + shift, own[1], own[2]], layers: [cbctPtv], maskFor: () => masks.get('ptv'), frameGroupFor: (uid) => (uid === 'for-s' ? secondary : primary) });
    expect(r.inside).toHaveLength(1);
    const miss = probeStructures({ world: own, layers: [cbctPtv], maskFor: () => masks.get('ptv'), frameGroupFor: (uid) => (uid === 'for-s' ? secondary : primary) });
    expect(miss.inside).toHaveLength(0);
  });
});

describe('probeRois（狀態列）', () => {
  const hit = (id: string, label = id.toUpperCase()) => ({ layerId: `mask:${id}`, structureId: id, label, colorRgb: [10, 20, 30] as [number, number, number] });
  const meta = (id: string, volumeCc: number, extra: Partial<StructureMeta> = {}): StructureMeta => ({ structureId: id, status: 'draft', volumeCc, ...extra });
  const readout = (inside: ReturnType<typeof hit>[], notResident: ReturnType<typeof hit>[] = [], source: ProbeReadout['source'] = 'pointer'): ProbeReadout => ({
    world: [0, 0, 0],
    viewportId: 'vp',
    source,
    readings: [],
    structures: { inside, notResident },
  });

  it('體積由小到大、體積未知排最後；顏色與提示', () => {
    const r = probeRois(readout([hit('body'), hit('ptv'), hit('gtv'), hit('x')]), [meta('body', 30000), meta('ptv', 500), meta('gtv', 40)], [], null);
    expect(r.shown.map((c) => c.name)).toEqual(['GTV', 'PTV', 'BODY', 'X']);
    expect(r.shown[0]!.color).toBe('rgb(10, 20, 30)');
    expect(r.shown[0]!.title).toContain('40.0 cc');
  });

  it('前 5 個、其餘「＋N」與名單', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const r = probeRois(readout(ids.map((i) => hit(i))), ids.map((i, n) => meta(i, n + 1)), [], null);
    expect(PROBE_ROI_LIMIT).toBe(5);
    expect(r.shown.map((c) => c.name)).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(r.more).toBe(2);
    expect(r.moreTitle).toBe('F、G');
  });

  it('同名出現在不同集才加短名：我的／別人／匯入集標籤', () => {
    const sets: StructureSetInfo[] = [
      { structureSetId: 'rs1', label: 'CT_PLAN', seriesInstanceUid: null, imageSeriesUid: 'ct', imageLabel: 'CT', frameOfReferenceUid: FOR, date: '', roiCount: 1, role: 'primary', kind: 'import', owner: null },
      { structureSetId: 'w1', label: 'wang 的', seriesInstanceUid: null, imageSeriesUid: 'ct', imageLabel: 'CT', frameOfReferenceUid: FOR, date: '', roiCount: 1, role: 'work', kind: 'work', owner: 'wang' },
    ];
    const metas = [
      meta('b1', 100, { structureSetId: 'rs1', structureSetKind: 'import' }),
      meta('b2', 101, { structureSetId: 'w1', structureSetKind: 'work', structureSetOwner: 'wang' }),
      meta('p', 5, { structureSetId: 'rs1', structureSetKind: 'import' }),
    ];
    const r = probeRois(readout([hit('b1', 'BODY'), hit('b2', 'Body'), hit('p', 'PTV')]), metas, sets, 'wang');
    expect(r.shown.map((c) => c.name)).toEqual(['PTV', 'BODY · CT_PLAN', 'Body · 我的']);
    const other = probeRois(readout([hit('b1', 'BODY'), hit('b2', 'BODY')]), metas, sets, 'lin');
    expect(other.shown.map((c) => c.name)).toEqual(['BODY · CT_PLAN', 'BODY · wang']);
  });

  it('未載入另計；指標離開（frozen）或沒有讀數時清空', () => {
    const r = probeRois(readout([], [hit('gtv'), hit('ctv')]), [], [], null);
    expect(r.shown).toEqual([]);
    expect(r.notResident).toBe(2);
    expect(r.notResidentTitle).toContain('GTV、CTV');
    expect(probeRois(readout([hit('gtv')], [], 'frozen'), [], [], null).shown).toEqual([]);
    expect(probeRois(null, [], [], null).shown).toEqual([]);
  });
});
