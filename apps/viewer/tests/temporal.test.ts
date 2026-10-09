/**
 * 時間軸。
 *
 * > 🔴 **時間軸不是「將來要擴充的缺口」，而是核心空間定義的一部分。**
 */

import { describe, expect, it } from 'vitest';

import {
  advanceCursor,
  createTemporalGroup,
  createViewReference,
  DEFAULT_PLAYBACK,
  playbackQuality,
  validateFrameIndex,
  type TemporalGroup,
} from '../src/core';
import { fromWire, toWire } from '../src/core/transport/wire';

function group(overrides: Partial<TemporalGroup> = {}): TemporalGroup {
  return createTemporalGroup({
    temporalGroupId: 'tg_resp',
    kind: 'cyclic',
    frameCount: 10,
    axisLabel: 'time',
    cursor: 0,
    playback: { ...DEFAULT_PLAYBACK },
    ...overrides,
  });
}

describe('三種軸的結構差異', () => {
  it('T1 週期相位軸：閉環，游標會迴繞', () => {
    const tg = group();
    tg.cursor = 9;
    expect(advanceCursor(tg)).toBe(0);
    tg.cursor = 0;
    expect(advanceCursor(tg, -1)).toBe(9);
  });

  it('T2 不規則時間序列：間隔可不等', () => {
    const tg = group({
      kind: 'series',
      frameCount: 4,
      frameTimes: Float64Array.from([0, 5, 12, 40]),
    });
    expect(tg.frameTimes?.[3]).toBe(40);
  });

  it('T3 串流：frameCount 必須為 null（只有視窗常駐）', () => {
    expect(() => group({ kind: 'stream', frameCount: 960 })).toThrowError(/T3/);
    const tg = group({ kind: 'stream', frameCount: null });
    tg.cursor = 10_000;
    expect(advanceCursor(tg)).toBe(10_001);
  });

  it('T4 參數軸：結構同 T2，以 axisLabel 區分', () => {
    const tg = group({ kind: 'series', frameCount: 4, axisLabel: 'b_value' });
    expect(tg.axisLabel).toBe('b_value');
  });

  it('cyclic 必須有 frameCount', () => {
    expect(() => group({ frameCount: null })).toThrowError(/T3/);
  });
});

describe('frameIndex 驗證', () => {
  it('超出範圍即拒絕', () => {
    const tg = group();
    expect(() => validateFrameIndex(tg, 10)).toThrowError(/T6/);
    expect(() => validateFrameIndex(tg, -1)).toThrowError(/T6/);
    expect(() => validateFrameIndex(tg, null)).toThrowError(/T6/);
    expect(() => validateFrameIndex(tg, 9)).not.toThrow();
  });
});

describe('播放與靜止是兩種品質狀態', () => {
  it('播放中一律低解析度，暫停後補到全解析度', () => {
    const tg = group();
    expect(playbackQuality(tg)).toBe('final');
    tg.playback.playing = true;
    expect(playbackQuality(tg)).toBe('interactive');
  });
});

describe('cursor 與 playback 是前端狀態，不在 wire 上', () => {
  it('toWire 不含 cursor／playback', () => {
    const wire = toWire.temporalGroup(group());
    expect(wire).not.toHaveProperty('cursor');
    expect(wire).not.toHaveProperty('playback');
    expect(wire).toMatchObject({ temporal_group_id: 'tg_resp', kind: 'cyclic', frame_count: 10 });
  });

  it('fromWire 補上本地預設值', () => {
    const tg = fromWire.temporalGroup({
      temporal_group_id: 'tg',
      kind: 'cyclic',
      frame_count: 4,
      frame_times: null,
      axis_label: 'time',
    });
    expect(tg.cursor).toBe(0);
    expect(tg.playback).toEqual(DEFAULT_PLAYBACK);
  });
});

describe('ViewReference 必須帶相位', () => {
  it('temporalGroupId 與 frameIndex 必須同時有或同時無', () => {
    const base = {
      frameOfReferenceUid: 'for.1',
      displayGridId: 'dg',
      planeOrigin: [0, 0, 0] as [number, number, number],
      viewPlaneNormal: [0, 0, 1] as [number, number, number],
      viewUp: [0, -1, 0] as [number, number, number],
      slabThicknessMm: 0,
    };
    expect(() =>
      createViewReference({ ...base, temporalGroupId: 'tg', frameIndex: null }),
    ).toThrowError(/V5/);
    expect(() =>
      createViewReference({ ...base, temporalGroupId: null, frameIndex: 3 }),
    ).toThrowError(/V5/);
    expect(() =>
      createViewReference({ ...base, temporalGroupId: 'tg', frameIndex: 3 }),
    ).not.toThrow();
  });

  it('🔴 「在相位 3 上量的距離」必須可重現', () => {
    const vr = createViewReference({
      frameOfReferenceUid: 'for.1',
      displayGridId: 'dg',
      planeOrigin: [0, 0, 0],
      viewPlaneNormal: [0, 0, 1],
      viewUp: [0, -1, 0],
      slabThicknessMm: 3,
      temporalGroupId: 'tg_resp',
      frameIndex: 3,
    });
    const roundTrip = fromWire.viewReference(toWire.viewReference(vr));
    expect(roundTrip.frameIndex).toBe(3);
    expect(roundTrip.temporalGroupId).toBe('tg_resp');
    expect(roundTrip.slabThicknessMm).toBe(3);
  });
});
