/** 簽核模組的純邏輯：動作是否有意義、送出 body、分組排序、摘要、事件文案、角色。 */

import { describe, expect, it } from 'vitest';

import type { StructureMeta } from '../src/core';
import { actionAllowed, canReview, formatEvent, groupByStatus, reviewBody, summarize, targetStatus } from '../src/react/modules/review/model';

const s = (id: string, status: string, name = id): StructureMeta => ({ structureId: id, status, volumeCc: 1, name });
const all = [s('ptv', 'edited', 'PTV'), s('body', 'approved', 'Body'), s('cord', 'ai_generated', 'SpinalCord'), s('bad', 'rejected', 'Bad'), s('a', 'under_review', 'A')];

describe('動作與狀態', () => {
  it('approved 不能再 approve；只有 approved／rejected 能 reopen；approved 不能 reject', () => {
    expect(actionAllowed('approve', 'edited')).toBe(true);
    expect(actionAllowed('approve', 'approved')).toBe(false);
    expect(actionAllowed('reject', 'approved')).toBe(false);
    expect(actionAllowed('reopen', 'approved')).toBe(true);
    expect(actionAllowed('reopen', 'rejected')).toBe(true);
    expect(actionAllowed('reopen', 'edited')).toBe(false);
    expect(targetStatus('reopen')).toBe('under_review');
  });
  it('body 只含有意義的結構；全都沒意義 → null', () => {
    const sel = new Set(['ptv', 'body', 'cord']);
    expect(reviewBody('approve', all, sel, 'ok')).toEqual({ structure_statuses: { ptv: 'approved', cord: 'approved' }, note: 'ok' });
    expect(reviewBody('reopen', all, new Set(['ptv', 'cord']), '')).toBeNull();
  });
  it('審核者與管理者可簽核', () => {
    expect(canReview('approver')).toBe(true);
    expect(canReview('admin')).toBe(true);
    expect(canReview('contourer')).toBe(false);
    expect(canReview(null)).toBe(false);
  });
});

describe('分組與文案', () => {
  it('順序：已編輯 → 待審 → 模型產生 → 退回 → 已簽核；組內依名稱', () => {
    const groups = groupByStatus([...all, s('z', 'edited', 'Aorta')]);
    expect(groups.map((g) => g.status)).toEqual(['edited', 'under_review', 'ai_generated', 'rejected', 'approved']);
    expect(groups[0]!.items.map((i) => i.name)).toEqual(['Aorta', 'PTV']);
    expect(summarize(all)).toBe('已編輯 1 · 待審 1 · 模型產生 1 · 退回 1 · 已簽核 1');
  });
  it('事件一句話', () => {
    const text = formatEvent(
      { event_id: 'e', structure_id: 'ptv', frame_index: null, from_status: 'edited', to_status: 'approved', note: 'ok', user: 'dr', at: 'not-a-date' },
      (id) => (id === 'ptv' ? 'PTV' : id),
    );
    expect(text).toBe('not-a-date dr 把 PTV 從 已編輯 改為 已簽核「ok」');
  });
  it('結構已刪除：用事件當下記的名稱，不是內部 id', () => {
    const ev = { event_id: 'e', structure_id: 'user_009', frame_index: null, from_status: 'edited', to_status: 'deleted', note: '', user: 'dr', at: 'x' };
    const gone = (id: string): string => id;
    expect(formatEvent({ ...ev, structure_name: 'SpinalCord' }, gone)).toContain('把 SpinalCord 從');
    // 結構還在（可能改過名）→ 用現在的名稱；舊事件沒記名稱 → 退回 id
    expect(formatEvent({ ...ev, structure_name: 'cord' }, () => 'SpinalCord')).toContain('把 SpinalCord 從');
    expect(formatEvent(ev, gone)).toContain('把 user_009 從');
  });
});


describe('動作數量', () => {
  it('只算選取中對該動作有效的', async () => {
    const { actionCount } = await import('../src/react/modules/review/model');
    const structures = [
      { structureId: 'a', status: 'edited', volumeCc: 1 },
      { structureId: 'b', status: 'approved', volumeCc: 1 },
      { structureId: 'c', status: 'rejected', volumeCc: 1 },
    ];
    const all = new Set(['a', 'b', 'c']);
    expect(actionCount('approve', structures, all)).toBe(2);
    expect(actionCount('reject', structures, all)).toBe(1);
    expect(actionCount('reopen', structures, all)).toBe(2);
    expect(actionCount('approve', structures, new Set(['b']))).toBe(0);
  });
});

describe('簽核事件帶 Tier', () => {
  it('有 tier 就附在描述後面；舊事件沒有就不加', async () => {
    const { formatEvent } = await import('../src/react/modules/review/model');
    const base = { event_id: 'e', structure_id: 'gtv', frame_index: null, from_status: 'edited', to_status: 'approved', note: '', user: 'dr', at: '2026-09-24T10:00:00Z' };
    expect(formatEvent({ ...base, tier: 'C' }, (id) => id)).toMatch(/（Tier C）$/);
    expect(formatEvent(base, (id) => id)).not.toMatch(/Tier/);
  });
});
