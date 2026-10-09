/**
 * 時間軸那一張影像帶的分組結果 → 被排除的相位、已重新取樣的相位（時間軸列的「重新取樣補進來／改回排除」）。
 */

import { describe, expect, it } from 'vitest';

import { resampleInfo } from '../src/react/modules/temporal/model';
import type { Layer } from '../src/core';

const img = (over: Partial<Layer>): Layer => ({ layerId: 'image:s', kind: 'image', label: 'CT', groupId: 'images', frameOfReferenceUid: 'F', contentRef: 's', visible: true, opacity: 1, order: 0, temporalGroupId: 'tg', ...over });

describe('重新取樣的狀態', () => {
  it('排除了 30%、70% → 列出來；開著重新取樣 → resampled', () => {
    const excluded = [
      { series_uid: 'a', label: '30%', reason: 'slice_count', detail: '39 片（其他 40 片）', position: 3 },
      { series_uid: 'b', label: '70%', reason: 'grid', detail: '範圍 …', position: 7 },
    ];
    const off = resampleInfo([img({ seriesMeta: { temporal: { excluded, resampled: [], resample: false } } })], 'tg');
    expect(off?.excluded.map((x) => x.label)).toEqual(['30%', '70%']);
    expect(off?.resample).toBe(false);
    const on = resampleInfo([img({ seriesMeta: { temporal: { excluded: [], resampled: excluded, resample: true } } })], 'tg');
    expect(on?.resampled.map((x) => x.label)).toEqual(['30%', '70%']);
    expect(on?.resample).toBe(true);
  });

  it('沒有分組結果、攤開的那幾張（不帶 temporal）、別條時間軸 → null', () => {
    expect(resampleInfo([img({})], 'tg')).toBeNull();
    expect(resampleInfo([img({ frameIndex: 0, seriesMeta: { temporal: { excluded: [] } } })], 'tg')).toBeNull();
    expect(resampleInfo([img({ seriesMeta: { temporal: { excluded: [] } } })], 'other')).toBeNull();
  });
});
