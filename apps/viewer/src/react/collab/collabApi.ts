/**
 * 多人「各自新增、可合併」的 API。
 * 用原生 fetch 而不是 `ModuleHttp`：合併的 409 要拿到完整的 `detail.conflicts`（transport 的錯誤訊息會截斷 body）。
 */

import type { StructureSetInfo } from '../../core/panels/api';
import { t } from '../../core/i18n';

export interface StructureSetWire extends StructureSetInfo {
  readonly mine: boolean;
  readonly editable: boolean;
  readonly structureCount: number;
}

export type ConflictAction = 'skip' | 'replace' | 'rename';

export interface MergeConflict {
  readonly structure_id: string;
  readonly name: string;
  readonly existing_structure_id: string;
  /** 目標結構的簽核狀態；`approved` 不能覆蓋（後端 409 APPROVED_LOCKED）。 */
  readonly existing_status?: string;
}

export interface MergeResult {
  readonly target_structure_set_id: string;
  readonly merged: readonly { source_structure_id: string; action: 'add' | 'rename' | 'replace' | 'skip' | 'already'; structure_id: string | null; name?: string }[];
}

export class MergeConflictError extends Error {
  constructor(
    readonly targetStructureSetId: string,
    readonly conflicts: readonly MergeConflict[],
  ) {
    super(t('目標結構集已有 {length} 個同名結構', { length: conflicts.length }));
  }
}

const API = '/api/v1';

function setOfWire(w: Record<string, unknown>): StructureSetWire {
  const text = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
  return {
    structureSetId: text(w.structure_set_id),
    label: text(w.label),
    seriesInstanceUid: typeof w.series_instance_uid === 'string' ? w.series_instance_uid : null,
    imageSeriesUid: text(w.image_series_uid),
    imageLabel: text(w.image_label),
    frameOfReferenceUid: text(w.frame_of_reference_uid),
    date: text(w.date),
    roiCount: Number(w.roi_count ?? 0),
    role: w.role === 'secondary' ? 'secondary' : w.role === 'work' ? 'work' : 'primary',
    kind: w.kind === 'work' ? 'work' : 'import',
    owner: typeof w.owner === 'string' ? w.owner : null,
    mine: Boolean(w.mine),
    editable: Boolean(w.editable),
    structureCount: Number(w.structure_count ?? 0),
  };
}

async function readError(r: Response): Promise<{ status: number; detail: Record<string, unknown> | null; text: string }> {
  const text = await r.text();
  try {
    const body = JSON.parse(text) as { detail?: unknown };
    return { status: r.status, detail: typeof body.detail === 'object' && body.detail !== null ? (body.detail as Record<string, unknown>) : null, text };
  } catch {
    return { status: r.status, detail: null, text };
  }
}

export const collabApi = {
  structureSets: async (caseId: string): Promise<StructureSetWire[]> => {
    const r = await fetch(`${API}/cases/${encodeURIComponent(caseId)}/structure-sets`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return ((await r.json()) as Record<string, unknown>[]).map(setOfWire);
  },
  ensureMine: async (caseId: string, frameOfReferenceUid?: string): Promise<StructureSetWire> => {
    const r = await fetch(`${API}/cases/${encodeURIComponent(caseId)}/structure-sets/mine`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(frameOfReferenceUid ? { frame_of_reference_uid: frameOfReferenceUid } : {}),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return setOfWire((await r.json()) as Record<string, unknown>);
  },
  rename: async (caseId: string, setId: string, label: string): Promise<StructureSetWire> => {
    const r = await fetch(`${API}/cases/${encodeURIComponent(caseId)}/structure-sets/${encodeURIComponent(setId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return setOfWire((await r.json()) as Record<string, unknown>);
  },
  /** 合併到我的工作集；同名沒決定 → 丟 `MergeConflictError`（帶衝突清單，給對話框）。 */
  merge: async (caseId: string, structureIds: readonly string[], onConflict: Readonly<Record<string, ConflictAction>>, target = 'mine'): Promise<MergeResult> => {
    const r = await fetch(`${API}/cases/${encodeURIComponent(caseId)}/structure-sets/${encodeURIComponent(target)}/merge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ structure_ids: structureIds, on_conflict: onConflict }),
    });
    if (r.ok) return (await r.json()) as MergeResult;
    const err = await readError(r);
    const text = (v: unknown): string => (typeof v === 'string' ? v : '');
    if (r.status === 409 && err.detail?.code === 'NAME_CONFLICT') {
      throw new MergeConflictError(text(err.detail.target_structure_set_id), (err.detail.conflicts as MergeConflict[]) ?? []);
    }
    const message = text(err.detail?.message) || text(err.detail?.code) || `HTTP ${r.status}`;
    throw new Error(message);
  },
};
