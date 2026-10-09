/** 結構集選單的可用動作與訊息。 */
import { describe, expect, it } from 'vitest';

import type { StructureSetInfo } from '../src/core/panels/api';
import { deleteConfirmText, describeSetError, structureSetActions, withSetPermissions } from '../src/react/collab/structureSetActions';

const base: StructureSetInfo = {
  structureSetId: 'work:me:abc',
  label: '我的',
  seriesInstanceUid: null,
  imageSeriesUid: 's',
  imageLabel: 'CT',
  frameOfReferenceUid: 'for.a',
  date: '',
  roiCount: 2,
  role: 'work',
  kind: 'work',
  owner: 'me',
  description: '',
  mine: true,
  editable: true,
};

describe('structureSetActions', () => {
  it('匯入集／別人的工作集沒有選單；暫存集也沒有（走保存／丟棄）', () => {
    expect(structureSetActions({ ...base, kind: 'import', editable: false }, null)).toEqual([]);
    expect(structureSetActions({ ...base, owner: 'other', mine: false, editable: false }, null)).toEqual([]);
    expect(structureSetActions({ ...base, kind: 'transient' }, null)).toEqual([]);
  });
  it('自己的工作集：改、刪；有可編輯且在別套、同 FoR 的作用中結構才有「搬進來」', () => {
    expect(structureSetActions(base, null)).toEqual(['edit', 'delete']);
    const active = { structureId: 'GTV', structureSetId: 'work:me:other', editable: true, frameOfReferenceUid: 'for.a' };
    expect(structureSetActions(base, active)).toEqual(['edit', 'delete', 'move-here']);
    expect(structureSetActions(base, { ...active, structureSetId: base.structureSetId })).toEqual(['edit', 'delete']);
    expect(structureSetActions(base, { ...active, editable: false })).toEqual(['edit', 'delete']);
    expect(structureSetActions(base, { ...active, frameOfReferenceUid: 'for.b' })).toEqual(['edit', 'delete']);
  });
  it('刪除確認點名已簽核；錯誤碼翻成一句話', () => {
    expect(deleteConfirmText(base, [{ name: 'A', status: 'edited' }])).toContain('1 個結構');
    expect(deleteConfirmText(base, [{ name: 'A', status: 'approved' }, { name: 'B', status: 'edited' }])).toContain('1 個已簽核（A）');
    expect(describeSetError('HTTP 409 /x: {"code":"SET_HAS_APPROVED"}')).toContain('撤回簽核');
    expect(describeSetError('HTTP 409 ... NAME_CONFLICT')).toContain('同名結構');
    expect(describeSetError('boom')).toBe('boom');
  });
});

describe('withSetPermissions', () => {
  const raw = { ...base, mine: undefined, editable: undefined } as unknown as typeof base;
  it('後端沒帶 editable 時依 kind／owner／角色補算；有帶就原樣', () => {
    expect(withSetPermissions([raw], { username: 'me', role: 'contourer' })[0]!.editable).toBe(true);
    expect(withSetPermissions([raw], { username: 'other', role: 'contourer' })[0]!.editable).toBe(false);
    expect(withSetPermissions([raw], { username: 'other', role: 'admin' })[0]!.editable).toBe(true);
    expect(withSetPermissions([{ ...raw, kind: 'import' }], { username: 'me', role: 'admin' })[0]!.editable).toBe(false);
    expect(withSetPermissions([raw], null)[0]!.editable).toBe(false);
    expect(withSetPermissions([{ ...base, editable: false }], { username: 'me', role: 'admin' })[0]!.editable).toBe(false);
  });
});
