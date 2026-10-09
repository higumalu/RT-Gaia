/**
 * 時間軸：倉庫依相位存取影像與 mask、播放範圍內的逐格規則、面板的文字與時間曲線。
 */

import { describe, expect, it } from 'vitest';

import { createGrid, stepInRange, type Grid } from '../src/core/geometry';
import { imageVolumeKey, VolumeStore } from '../src/core/scene/volumeStore';
import type { Layer } from '../src/core/layers/types';
import { curvePath, frameText, groupTitle } from '../src/react/modules/temporal/model';

const grid: Grid = createGrid({ size: [2, 2, 1], spacing: [1, 1, 1], origin: [0, 0, 0], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], frameOfReferenceUid: 'for.4d' });
const vox = (v: number): Int16Array => new Int16Array([v, v, v, v]);
const imageLayer: Layer = { layerId: 'img:s', kind: 'image', label: 'CT', groupId: null, frameOfReferenceUid: 'for.4d', contentRef: 's', visible: true, opacity: 1, order: 0, temporalGroupId: 'tg' };
const maskLayer: Layer = { layerId: 'mask:g', kind: 'mask', label: 'GTV', groupId: null, frameOfReferenceUid: 'for.4d', contentRef: 'g', visible: true, opacity: 1, order: 1, temporalGroupId: 'tg' };

function store(): { s: VolumeStore; cursor: { v: number } } {
  const s = new VolumeStore();
  const cursor = { v: 0 };
  s.setFrameResolver(() => cursor.v);
  return { s, cursor };
}

describe('倉庫的相位', () => {
  it('影像依 (序列, lod, 相位) 存；預設取目前相位；lod 0 沒有退 lod 2；volumeKey 帶相位', () => {
    const { s } = store();
    s.putImage({ seriesId: 's', lod: 2, frameIndex: 0, grid, voxels: vox(10), defaultWindow: { center: 0, width: 1 } });
    s.putImage({ seriesId: 's', lod: 2, frameIndex: 3, grid, voxels: vox(13), defaultWindow: { center: 0, width: 1 } });
    s.putImage({ seriesId: 's', lod: 0, frameIndex: 3, grid, voxels: vox(130), defaultWindow: { center: 0, width: 1 } });
    s.setSeriesFrame('s', 3);
    expect(s.image('s')?.voxels[0]).toBe(130);
    expect(s.image('s', 2)?.voxels[0]).toBe(13);
    expect(s.forLayer(imageLayer)?.volumeKey).toBe('s@lod0#f3');
    s.setSeriesFrame('s', 0);
    expect(s.image('s')?.voxels[0]).toBe(10); // 相位 0 只有 lod 2
    expect(s.hasImageLod('s', 0)).toBe(false);
    expect(s.hasImageLod('s', 0, 3)).toBe(true);
    expect(s.residentFrames('s')).toEqual([0, 3]);
    expect(s.residentFrames('s', 0)).toEqual([3]);
  });

  it('目前相位還沒到 → 退到最近的已到相位（播放時不空白）', () => {
    const { s } = store();
    s.putImage({ seriesId: 's', lod: 2, frameIndex: 0, grid, voxels: vox(10), defaultWindow: { center: 0, width: 1 } });
    s.putImage({ seriesId: 's', lod: 2, frameIndex: 5, grid, voxels: vox(15), defaultWindow: { center: 0, width: 1 } });
    s.setSeriesFrame('s', 4);
    expect(s.image('s')?.voxels[0]).toBe(15);
    s.setSeriesFrame('s', 1);
    expect(s.image('s')?.voxels[0]).toBe(10);
  });

  it('靜態序列的 key 不變；卸載只動指定相位', () => {
    const { s } = store();
    expect(imageVolumeKey('ct', 0)).toBe('ct@lod0');
    expect(imageVolumeKey('ct', 0, 2)).toBe('ct@lod0#f2');
    s.putImage({ seriesId: 's', lod: 0, frameIndex: 1, grid, voxels: vox(1), defaultWindow: { center: 0, width: 1 } });
    s.putImage({ seriesId: 's', lod: 0, frameIndex: 2, grid, voxels: vox(2), defaultWindow: { center: 0, width: 1 } });
    expect(s.dropImage('s', 0, 1)).toBe(8);
    expect(s.residentFrames('s')).toEqual([2]);
  });

  it('mask 依群組游標取相位；靜態結構 null', () => {
    const { s, cursor } = store();
    expect(s.frameOf(maskLayer)).toBe(0);
    cursor.v = 7;
    expect(s.frameOf(maskLayer)).toBe(7);
    expect(s.frameOf({ temporalGroupId: null })).toBeNull();
    expect(s.forLayer(maskLayer)).toBeNull(); // 相位 7 的 mask 還沒到
  });
});

describe('播放範圍內逐格', () => {
  it('範圍內前進／後退；循環繞回；不循環停在邊上並要求停止播放', () => {
    expect(stepInRange({ cursor: 2, delta: 1, from: 0, to: 9, loop: false })).toEqual({ frame: 3, stop: false });
    expect(stepInRange({ cursor: 9, delta: 1, from: 0, to: 9, loop: true })).toEqual({ frame: 0, stop: false });
    expect(stepInRange({ cursor: 0, delta: -1, from: 0, to: 9, loop: true })).toEqual({ frame: 9, stop: false });
    expect(stepInRange({ cursor: 9, delta: 1, from: 0, to: 9, loop: false })).toEqual({ frame: 9, stop: true });
  });

  it('時間窗（範圍）：游標在外面 → 跳進來；順序反過來也行', () => {
    expect(stepInRange({ cursor: 0, delta: 1, from: 3, to: 6, loop: true })).toEqual({ frame: 3, stop: false });
    expect(stepInRange({ cursor: 9, delta: -1, from: 6, to: 3, loop: true })).toEqual({ frame: 6, stop: false });
    expect(stepInRange({ cursor: 6, delta: 1, from: 6, to: 3, loop: true })).toEqual({ frame: 3, stop: false });
  });
});

describe('面板', () => {
  it('標題與相位文字（1 起算、有時間戳加秒數）', () => {
    expect(groupTitle({ kind: 'cyclic', axisLabel: '' })).toBe('呼吸／心臟相位');
    expect(groupTitle({ kind: 'series', axisLabel: 'b_value' })).toBe('擴散 b 值'); // 已知的參數軸用中文名
    expect(groupTitle({ kind: 'series', axisLabel: 'gradient_direction' })).toBe('gradient_direction');
    expect(frameText({ kind: 'cyclic', cursor: 2, frameCount: 10, frameTimes: null })).toBe('相位 3／10');
    expect(frameText({ kind: 'series', cursor: 0, frameCount: 30, frameTimes: [4.5, 9, 13.5] })).toBe('第 1／30 個時間點 · t = 4.50 s');
  });

  it('時間曲線：缺值斷開、上下界', () => {
    const c = curvePath([0, 10, null, 20], 100, 20, 0);
    expect(c.min).toBe(0);
    expect(c.max).toBe(20);
    expect(c.d).toBe('M0.0 20.0L33.3 10.0M100.0 0.0');
    expect(c.points.map((p) => p.i)).toEqual([0, 1, 3]);
    expect(curvePath([null, null], 10, 10).d).toBe('');
  });
});
