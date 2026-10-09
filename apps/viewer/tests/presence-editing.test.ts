/**
 * presence「正在編輯哪個結構」的純函式。
 */
import { describe, expect, it } from 'vitest';

import { isEditingTool } from '../src/core/tools/builtins';
import type { PresenceUser } from '../src/core/panels/api';
import { editorsByStructure, onlineDetails } from '../src/react/collab/model';

const p = (user: string, editing: string | null, connections = 1, sessionId = `s-${user}`): PresenceUser => ({ user, sessionId, connections, createdAt: '', editing });

describe('editorsByStructure', () => {
  it('只算在線、不是我、有 editing 的；同一人多個分頁去重', () => {
    const m = editorsByStructure([p('me', 'gtv'), p('wang', 'gtv'), p('wang', 'gtv', 1, 's2'), p('lin', 'ctv'), p('chen', 'gtv', 0), p('su', null)], 'me');
    expect(Object.fromEntries(m)).toEqual({ gtv: ['wang'], ctv: ['lin'] });
  });
});

describe('onlineDetails', () => {
  const names: Record<string, string> = { gtv: 'GTV', ctv: 'CTV' };
  it('每人一行：檢視／編輯哪個；看不到的結構只說「編輯中」', () => {
    expect(onlineDetails([p('me', 'gtv'), p('wang', 'gtv'), p('lin', null), p('su', 'hidden')], 'me', (id) => names[id] ?? null)).toEqual(['lin：檢視', 'su：編輯中', 'wang：編輯 GTV']);
  });
});

describe('isEditingTool', () => {
  it('筆刷、橡皮擦、閾值筆刷、剪刀才算編輯', () => {
    expect(['brush', 'eraser', 'threshold-brush', 'scissors'].every(isEditingTool)).toBe(true);
    expect(isEditingTool('navigate')).toBe(false);
    expect(isEditingTool(null)).toBe(false);
  });
});
