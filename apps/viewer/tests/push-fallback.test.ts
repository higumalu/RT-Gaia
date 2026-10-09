/**
 * 哪些面板請求會改病例（推送沒到就自己拿）。
 */

import { describe, expect, it } from 'vitest';

import { isCaseMutation } from '../src/react/components/pushFallback';

describe('會改病例的請求', () => {
  it('結構、結構集、合併、簽核、劑量運算、對位、存成 RTDOSE', () => {
    for (const p of [
      '/studies/1.2.3/structures',
      '/structures/gtv/copy',
      '/structures/gtv/review',
      '/structures/gtv/propagate-frames',
      '/cases/case_1/structure-sets',
      '/cases/case_1/structure-sets/ws_1/merge',
      '/studies/1.2.3/dose-ops',
      '/dose/derived_1/save',
      '/transforms',
    ]) {
      expect(isCaseMutation(p), p).toBe(true);
    }
  });
  it('不會推的不算', () => {
    for (const p of ['/dvh/export', '/render3d', '/measurements/m1', '/auth/me/preferences', '/studies/1.2.3/grids', '/dose/derived_1/max']) {
      expect(isCaseMutation(p), p).toBe(false);
    }
  });
});
