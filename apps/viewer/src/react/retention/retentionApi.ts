/** 暫存區／封存區的 HTTP（`/api/v1/trash`、`/api/v1/archive`）。 */

const API = '/api/v1';

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    method,
    ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${path}: ${(await r.text()).slice(0, 300)}`);
  const text = await r.text();
  return (text.trim() === '' ? undefined : JSON.parse(text)) as T;
}

export interface DeletedStructure {
  readonly case_id: string;
  readonly structure_id: string;
  readonly name: string;
  readonly color_rgb: readonly number[];
  readonly status: string;
  readonly set_label: string;
  readonly deleted_by: string;
  readonly deleted_at: string | null;
  readonly archived_at: string | null;
  readonly archive_note: string;
  readonly version_count: number;
  readonly patient_id: string | null;
  readonly study_date: string;
  readonly study_description: string;
  readonly expires_at?: string | null;
}

export interface LibraryTrashItem {
  readonly item_id: string;
  readonly level: string;
  readonly key: string;
  readonly series_uids: readonly string[];
  readonly file_count: number;
  readonly deleted_by: string;
  readonly deleted_at: string | null;
  readonly expires_at: string | null;
}

export interface TrashListing {
  readonly available: boolean;
  readonly days: number;
  readonly items: readonly DeletedStructure[];
  readonly library: readonly LibraryTrashItem[];
  readonly is_admin: boolean;
}

export interface ArchiveDetail extends DeletedStructure {
  readonly versions: readonly { version_id: string; frame_index: number | null; kind: string; created_by: string; created_at: string; voxel_count: number; note: string }[];
  readonly review_events: readonly { event_id: string; from_status: string; to_status: string; user: string; at: string; note: string; tier?: string }[];
}

const enc = encodeURIComponent;

export const retentionApi = {
  trash: (): Promise<TrashListing> => call('GET', '/trash'),
  restoreStructure: (c: string, s: string): Promise<unknown> => call('POST', `/trash/structures/${enc(c)}/${enc(s)}/restore`, {}),
  purgeStructure: (c: string, s: string): Promise<unknown> => call('DELETE', `/trash/structures/${enc(c)}/${enc(s)}`),
  restoreLibrary: (id: string): Promise<unknown> => call('POST', `/trash/library/${enc(id)}/restore`, {}),
  purgeLibrary: (id: string): Promise<unknown> => call('DELETE', `/trash/library/${enc(id)}`),
  archive: (): Promise<{ available: boolean; items: DeletedStructure[] }> => call('GET', '/archive'),
  archiveDetail: (c: string, s: string): Promise<ArchiveDetail> => call('GET', `/archive/${enc(c)}/${enc(s)}`),
  archiveNote: (c: string, s: string, note: string): Promise<unknown> => call('PATCH', `/archive/${enc(c)}/${enc(s)}`, { note }),
  restoreArchived: (c: string, s: string): Promise<unknown> => call('POST', `/archive/${enc(c)}/${enc(s)}/restore`, {}),
  purgeArchived: (c: string, s: string): Promise<unknown> => call('DELETE', `/archive/${enc(c)}/${enc(s)}`),
};
