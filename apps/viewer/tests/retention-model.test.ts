/** 暫存區／封存區頁面的純邏輯。 */
import { describe, expect, it } from 'vitest';

import { daysLeft, describeRetentionError, fmtStudy } from '../src/react/retention/retentionModel';
import { hashFor, routeFromHash } from '../src/react/hooks/useHashRoute';
import { NAV_ITEMS, visibleNavItems } from '../src/react/components/AppNav';

describe('retention model', () => {
  it('剩餘天數向上取整、過期為 0、沒有到期日為 null', () => {
    const now = new Date('2026-09-24T12:00:00Z');
    expect(daysLeft('2026-10-08T12:00:00+00:00', now)).toBe(14);
    expect(daysLeft('2026-09-24T13:00:00+00:00', now)).toBe(1);
    expect(daysLeft('2026-09-20T00:00:00+00:00', now)).toBe(0);
    expect(daysLeft(null, now)).toBeNull();
  });
  it('日期與錯誤訊息', () => {
    expect(fmtStudy('20260924', 'Pelvis')).toBe('2026-09-24 Pelvis');
    expect(describeRetentionError('HTTP 409 …ID_TAKEN')).toContain('同 id');
    expect(describeRetentionError('HTTP 403 … NOT_DELETER')).toContain('刪除它的人');
  });
  it('路由與選單：暫存區所有人可見、封存區只有 admin', () => {
    expect(routeFromHash('#/trash')).toBe('trash');
    expect(routeFromHash('#/archive')).toBe('archive');
    expect(hashFor('archive')).toBe('#/archive');
    const keys = (role: string): string[] => visibleNavItems({ username: 'u', role } as never).map((i) => i.key);
    expect(keys('contourer')).toContain('trash');
    expect(keys('contourer')).not.toContain('archive');
    expect(keys('admin')).toContain('archive');
    expect(NAV_ITEMS.find((i) => i.key === 'archive')?.adminOnly).toBe(true);
  });
});
