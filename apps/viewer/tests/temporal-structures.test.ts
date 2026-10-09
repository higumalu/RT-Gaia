/**
 * 4D 的結構 —— 自動找「同一個結構在不同相位」（名字去掉相位尾巴）、合成後涵蓋的幀、時間軸上的相位結構。
 */

import { describe, expect, it } from 'vitest';

import { frameName, mergedFrames, phaseStem, phaseStructureGroups, phaseStructures, type PhaseStructure } from '../src/react/modules/temporal/model';
import type { Layer } from '../src/core';

const LABELS = ['0%', '10%', '20%', '30%', '40%', '50%', '60%', '70%', '80%', '90%'];
const ps = (structureId: string, name: string, frames: number[]): PhaseStructure => ({ structureId, name, frames });

describe('名字去掉相位尾巴', () => {
  it('常見的相位命名', () => {
    expect(phaseStem('GTV_c00')).toBe('GTV');
    expect(phaseStem('GTV_c90')).toBe('GTV');
    expect(phaseStem('GTV_50')).toBe('GTV');
    expect(phaseStem('GTV 50%')).toBe('GTV');
    expect(phaseStem('CTV-T3')).toBe('CTV');
    expect(phaseStem('GTV_ph2')).toBe('GTV');
    expect(phaseStem('Lesion Ex 75%', 'Ex 75%')).toBe('Lesion');
    expect(phaseStem('GTV')).toBe('GTV');
    expect(phaseStem('50')).toBe('50'); // 名字就是數字 → 原名
  });
});

describe('自動分組', () => {
  it('ct2 的十個相位 → 一組 GTV；只有一個的不算；已涵蓋全部幀的不算', () => {
    const items = [
      ...LABELS.map((_, k) => ps(`g${k}`, `GTV_c${String(k * 10).padStart(2, '0')}`, [k])),
      ps('cord', 'SpinalCord_50', [5]),
      ps('all', 'GTV', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
    ];
    const groups = phaseStructureGroups(items, LABELS, 10);
    expect(groups.map((g) => g.stem)).toEqual(['GTV']);
    expect(groups[0]!.members.map((m) => m.structureId)).toEqual(LABELS.map((_, k) => `g${k}`));
  });

  it('同名（每個相位都叫 GTV）也成一組；幀重疊的不成組；不分大小寫', () => {
    expect(phaseStructureGroups([ps('a', 'GTV', [0]), ps('b', 'gtv', [5])], LABELS, 10)).toHaveLength(1);
    expect(phaseStructureGroups([ps('a', 'GTV_00', [0]), ps('b', 'GTV_c00', [0])], LABELS, 10)).toHaveLength(0);
  });

  it('合成後的幀；重疊 → null；幀名', () => {
    expect(mergedFrames([ps('a', 'x', [5]), ps('b', 'y', [0, 2])])).toEqual([0, 2, 5]);
    expect(mergedFrames([ps('a', 'x', [5]), ps('b', 'y', [5])])).toBeNull();
    expect(frameName(LABELS, 5)).toBe('50%');
    expect(frameName(null, 5)).toBe('#6');
  });
});

describe('時間軸上的相位結構', () => {
  const mask = (over: Partial<Layer>): Layer => ({ layerId: 'm', kind: 'mask', label: 'x', groupId: null, frameOfReferenceUid: 'F', contentRef: 'x', visible: true, opacity: 1, order: 100, ...over });
  it('只取這條時間軸、有幀的 mask；依第一幀排', () => {
    const layers = [
      mask({ layerId: 'mask:b', contentRef: 'b', label: 'GTV_50', temporalGroupId: 'tg', frames: [5] }),
      mask({ layerId: 'mask:a', contentRef: 'a', label: 'GTV_00', temporalGroupId: 'tg', frames: [0] }),
      mask({ layerId: 'mask:itv', contentRef: 'itv', label: 'ITV', temporalGroupId: null }),
      mask({ layerId: 'mask:o', contentRef: 'o', label: 'GTV_10', temporalGroupId: 'other', frames: [1] }),
    ];
    expect(phaseStructures(layers, 'tg').map((s) => s.structureId)).toEqual(['a', 'b']);
  });
});
