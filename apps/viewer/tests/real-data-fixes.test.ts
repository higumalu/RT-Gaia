/**
 * 真實 demo 資料測出來的問題（前端部分）—— 資料頁「動態 ×N」用拆分後的幀數、b 值不見的 DWI、
 * 兩條時間軸的標題分得出來、Gamma Knife 計畫不畫射束／BEV、shot 標記。
 */

import { describe, expect, it } from 'vitest';

import { dynamicBadge, dynamicTitle } from '../src/react/data/temporalRows';
import { defaultBevBeam, drawableIsocenters, isGammaKnife, isoLabel, SHOT_NEAR_MM, type PlanInfo } from '../src/react/modules/plan/model';
import { frameText, groupCaption, groupTitle } from '../src/react/modules/temporal/model';

describe('資料頁的動態徽章', () => {
  it('拆掉相位圖／ADC 之後的幀數；軸決定名稱；舊後端只有 repeats 照舊', () => {
    expect(dynamicBadge({ dynamic: { repeats: 12, frames: 6, axis: 'time', split_off: [{ kind: 'phase_image', count: 120 }] } })).toBe('動態 ×6');
    expect(dynamicBadge({ dynamic: { repeats: 4, frames: 3, axis: 'b_value', labeled: true } })).toBe('b 值 ×3');
    expect(dynamicBadge({ dynamic: { repeats: 4, frames: 4, axis: 'b_value', labeled: false } })).toBe('b 值未知 ×4');
    expect(dynamicBadge({ dynamic: { repeats: 4, frames: 4, axis: 'echo_time', labeled: true } })).toBe('多回波 ×4');
    expect(dynamicBadge({ dynamic: { repeats: 8, frames: 8, axis: 'phase' } })).toBe('4D ×8');
    expect(dynamicBadge({ dynamic: { repeats: 12 } })).toBe('動態 ×12');
    expect(dynamicBadge({ dynamic: { repeats: 3, error: '每個位置的影像數不同' } })).toBe('無法分幀');
  });

  it('滑鼠提示：拆出去的影像、b 值不見、分不成幀的原因', () => {
    const title = dynamicTitle({ dynamic: { repeats: 12, frames: 6, axis: 'time', split_off: [{ kind: 'phase_image', count: 120 }] } });
    expect(title).toContain('另有 120 張相位影像');
    expect(dynamicTitle({ dynamic: { repeats: 4, frames: 4, axis: 'b_value', labeled: false } })).toContain('沒有 b 值標籤');
    expect(dynamicTitle({ dynamic: { repeats: 3, error: '每個位置的影像數不同（2～3 張）' } })).toBe('每個位置的影像數不同（2～3 張）');
  });
});

describe('時間軸列', () => {
  it('b 值不見的 DWI：標題「擴散（b 值未知）」、幀文字「第 2／4 組」（不是時間點）', () => {
    expect(groupTitle({ kind: 'series', axisLabel: 'b_value', frameLabels: null })).toBe('擴散（b 值未知）');
    expect(groupTitle({ kind: 'series', axisLabel: 'b_value', frameLabels: ['b 0', 'b 500'] })).toBe('擴散 b 值');
    expect(frameText({ kind: 'series', cursor: 1, frameCount: 4, frameTimes: null, axisLabel: 'b_value', frameLabels: null, unit: null })).toBe('第 2／4 組');
  });

  it('兩條以上時加上影像名稱（DCE 和 DWI 兩列不再都叫「時間序列」）；只有一條照舊', () => {
    const layers = [
      { kind: 'image', label: 'MR DCE', temporalGroupId: 'a' },
      { kind: 'image', label: 'MR SAG DWI', temporalGroupId: 'b' },
      { kind: 'mask', label: 'GTV', temporalGroupId: 'a' },
    ];
    const a = { kind: 'series', axisLabel: 'time', temporalGroupId: 'a' } as const;
    const b = { kind: 'series', axisLabel: 'b_value', temporalGroupId: 'b', frameLabels: null } as const;
    expect(groupCaption(a, layers, 2)).toBe('時間序列 · MR DCE');
    expect(groupCaption(b, layers, 2)).toBe('擴散（b 值未知） · MR SAG DWI');
    expect(groupCaption(a, layers, 1)).toBe('時間序列');
  });
});

const plan = (technique: PlanInfo['technique']): PlanInfo =>
  ({
    plan_id: 'p',
    label: 'Plan1',
    name: '',
    frame_of_reference_uid: 'F',
    technique,
    patient_positions: [],
    fractions_planned: null,
    prescription_gy: [],
    machines: [{ name: 'PFX', manufacturer: '', model: '' }],
    beams: [1, 2].map((n) => ({ number: n, name: `A${n}`, is_treatment: true })),
    isocenters: [
      { position_mm: [0, 0, 0], position_primary_mm: [0, 0, 0], beam_numbers: [1] },
      { position_mm: [0, 0, 4], position_primary_mm: [0, 0, 4], beam_numbers: [2] },
    ],
    mappable: true,
  }) as unknown as PlanInfo;

describe('Gamma Knife 計畫', () => {
  it('沒有 BEV 射束（BEV、弧、小 BEV 都靠它 → 都不畫）；直線加速器照舊', () => {
    expect(isGammaKnife(plan('gamma_knife'))).toBe(true);
    expect(defaultBevBeam(plan('gamma_knife'), undefined)).toBeNull();
    expect(defaultBevBeam(plan('external_beam'), undefined)).toBe(1);
    expect(defaultBevBeam(plan(undefined), 2)).toBe(2); // 舊後端沒有 technique
  });

  it('shot 標「S1」「S2」、離切面太遠不畫；一般 ISO 不受影響', () => {
    const shots = drawableIsocenters([plan('gamma_knife')]);
    expect(shots.map((s) => s.label)).toEqual(['S1', 'S2']);
    expect(shots[0]!.maxDistanceMm).toBe(SHOT_NEAR_MM);
    expect(isoLabel(0, 0, 2, [0, 0, 1], 'S1')).toBe('S1');
    expect(isoLabel(4, 1, 2, [0, 0, 1], 'S2')).toBe('S2 4.0 mm S');
    const isos = drawableIsocenters([plan('external_beam')]);
    expect(isos[0]!.label).toBeUndefined();
    expect(isoLabel(0, 0, 2)).toBe('ISO1');
  });
});
