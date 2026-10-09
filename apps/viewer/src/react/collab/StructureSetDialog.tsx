/**
 * 新建／編輯結構集：label 必填、description 選填。
 * 送出走 `api.http`（POST 新建；PATCH 改），成功後呼叫端 refresh。
 */
import { useState } from 'react';

import type { StructureSetInfo, ViewerApi } from '../../core/panels/api';
import { Dialog } from '../components/Dialog';
import { describeSetError } from './structureSetActions';
import { t } from '../../core/i18n';
import { setLabel as displaySetLabel } from '../components/structureGroups';

export function StructureSetDialog(props: {
  api: ViewerApi;
  /** 編輯：帶既有的集；新建：null。 */
  set: StructureSetInfo | null;
  /** 新建時掛在哪一組影像。 */
  frameOfReferenceUid: string;
  onClose: () => void;
  onSaved: (set: StructureSetInfo) => void;
}): React.JSX.Element {
  const editing = props.set !== null;
  // 名稱欄顯示的是介面語言的名稱（預設工作集「physicist 的結構集」在英文介面是「physicist's structure set」）；
  // 沒改就送回原本存的那個，不要因為按了儲存就把預設名稱改成某一種語言
  const shownLabel = props.set ? displaySetLabel(props.set) : '';
  const [label, setLabel] = useState(shownLabel);
  const [description, setDescription] = useState(props.set?.description ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const caseId = props.api.state.caseId;
  const submit = (): void => {
    if (!caseId || label.trim() === '') return;
    setBusy(true);
    setError(null);
    const base = `/cases/${encodeURIComponent(caseId)}/structure-sets`;
    const req = editing
      ? props.api.http.patchJson<Record<string, unknown>>(`${base}/${encodeURIComponent(props.set!.structureSetId)}`, {
          label: label.trim() === shownLabel.trim() ? props.set!.label : label.trim(),
          description: description.trim(),
        })
      : props.api.http.postJson<Record<string, unknown>>(base, {
          label: label.trim(),
          description: description.trim(),
          frame_of_reference_uid: props.frameOfReferenceUid,
        });
    req
      .then((w) => {
        const text = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
        props.onSaved({
          ...(props.set ?? {
            structureSetId: text(w['structure_set_id']),
            seriesInstanceUid: null,
            imageSeriesUid: text(w['image_series_uid']),
            imageLabel: text(w['image_label']),
            frameOfReferenceUid: props.frameOfReferenceUid,
            date: '',
            roiCount: 0,
            role: 'work' as const,
            kind: 'work' as const,
            owner: typeof w['owner'] === 'string' ? w['owner'] : null,
            mine: true,
            editable: true,
          }),
          label: text(w['label'], label.trim()),
          description: text(w['description'], description.trim()),
        });
        props.onClose();
      })
      .catch((e: unknown) => {
        setBusy(false);
        setError(describeSetError(e instanceof Error ? e.message : String(e)));
      });
  };
  return (
    <Dialog label={editing ? t('編輯結構集') : t('新結構集')} className="structure-set-dialog" busy={busy} onClose={props.onClose}>
      <h3>{editing ? t('編輯「{label}」', { label: shownLabel }) : t('新結構集')}</h3>
      <label>
        {t('名稱')}
        <input
          data-autofocus
          value={label}
          maxLength={120}
          placeholder={t('例：計畫 B、ART 第 2 版')}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
        />
      </label>
      <label>
        {t('描述（選填）')}
        <textarea value={description} maxLength={2000} rows={3} placeholder={t('用途、來源、注意事項')} onChange={(e) => setDescription(e.target.value)} />
      </label>
      {!editing && <p className="muted small">{t('會掛在目前這一組影像下，只有你（與 admin）能改；一人在同一組影像可以有多套。')}</p>}
      {error && <p className="error">{error}</p>}
      <div className="dialog-actions">
        <button type="button" onClick={props.onClose} disabled={busy}>
          {t('取消')}
        </button>
        <button type="button" className="primary" onClick={submit} disabled={busy || label.trim() === ''}>
          {editing ? t('儲存') : t('建立')}
        </button>
      </div>
    </Dialog>
  );
}
