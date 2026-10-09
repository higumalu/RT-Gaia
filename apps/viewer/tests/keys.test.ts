/** 快捷鍵單一來源。 */
import { describe, expect, it } from 'vitest';

import { CORE_KEYS, duplicateHotkeys, mouseBindingRows, resolveGlobalKey, toolKeyBindings } from '../src/core/keys';
import { registerCoreBuiltins } from '../src/core';
import { listTools } from '../src/core/tools/registry';

registerCoreBuiltins();
const tools = listTools();
const ev = (key: string, extra: Partial<{ ctrlKey: boolean; shiftKey: boolean; inTextInput: boolean; altKey: boolean }> = {}) => ({
  key,
  ctrlKey: false,
  shiftKey: false,
  inTextInput: false,
  ...extra,
});

describe('keys', () => {
  it('核心工具都有不重複的字母鍵，表裡列得出來', () => {
    const bindings = toolKeyBindings(tools);
    expect(bindings.map((b) => b.id)).toContain('tool:brush');
    expect(duplicateHotkeys(tools)).toEqual([]);
    expect(CORE_KEYS.some((k) => k.id === 'undo')).toBe(true);
    expect(mouseBindingRows().some((r) => r.label.includes('換切片'))).toBe(true);
  });
  it('全域鍵：字母 → 工具；Ctrl+Z／Y；?；文字輸入中不攔；沒對到回 null', () => {
    expect(resolveGlobalKey(ev('b'), tools)).toEqual({ kind: 'tool', toolId: 'brush' });
    expect(resolveGlobalKey(ev('B'), tools)).toEqual({ kind: 'tool', toolId: 'brush' });
    expect(resolveGlobalKey(ev('z', { ctrlKey: true }), tools)).toEqual({ kind: 'undo' });
    expect(resolveGlobalKey(ev('Z', { ctrlKey: true, shiftKey: true }), tools)).toEqual({ kind: 'redo' });
    expect(resolveGlobalKey(ev('y', { ctrlKey: true }), tools)).toEqual({ kind: 'redo' });
    expect(resolveGlobalKey(ev('?'), tools)).toEqual({ kind: 'help' });
    expect(resolveGlobalKey(ev('F1'), tools)).toEqual({ kind: 'help' });
    expect(resolveGlobalKey(ev('b', { inTextInput: true }), tools)).toBeNull();
    expect(resolveGlobalKey(ev('b', { altKey: true }), tools)).toBeNull();
    expect(resolveGlobalKey(ev('ArrowDown'), tools)).toBeNull();
    expect(resolveGlobalKey(ev('s', { ctrlKey: true }), tools)).toBeNull(); // Ctrl+S 不搶
  });
});
