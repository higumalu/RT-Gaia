/**
 * DIMSE API：節點、服務設定、遠端查詢／拉回、送出。
 * 純 fetch 與 wire 型別；純邏輯在 `model.ts`。後端 `routes_dimse.py`。
 */

export interface NodeRoles {
  readonly send: boolean;
  readonly receive: boolean;
}

export type Capability = 'echo' | 'find' | 'move' | 'get' | 'store';
export type Supports = Partial<Record<Capability, boolean>>;

export interface DicomNode {
  readonly node_id: string;
  readonly name: string;
  readonly ae_title: string;
  readonly host: string;
  readonly port: number;
  readonly our_calling_aet: string;
  readonly move_destination_aet: string;
  readonly tls: boolean;
  readonly supports: Supports;
  readonly roles: NodeRoles;
  readonly inbound_ip: string | null;
  readonly description: string;
  readonly created_by: string;
  readonly created_at: string;
  readonly last_echo_at: string | null;
  readonly last_echo_ok: boolean | null;
  /** 我方宣告的最大 PDU（0 ＝ 預設）、對它提議的 Transfer Syntax（空 ＝ 預設）。舊後端沒有。 */
  readonly max_pdu?: number;
  readonly transfer_syntaxes?: readonly string[];
}

/** 表單送出的形狀（`Node.from_wire`）。 */
export interface NodeInput {
  name: string;
  ae_title: string;
  host: string;
  port: number | '';
  roles: NodeRoles;
  inbound_ip: string;
  our_calling_aet: string;
  move_destination_aet: string;
  supports: Supports;
  description: string;
  max_pdu: number | '';
  transfer_syntaxes: string[];
}

export interface EchoResult {
  readonly ok: boolean;
  readonly latency_ms: number | null;
  readonly error: string | null;
  readonly node: DicomNode;
}

export interface ProbeResult extends EchoResult {
  readonly supports: Supports;
  /** 真的送一個不會命中的 STUDY C-FIND 的結果（對方不接受 FIND 就沒有）。 */
  readonly find_test?: { readonly ok: boolean; readonly status: string | null; readonly matches: number; readonly error: string | null } | null;
}

export interface FindResult {
  readonly total: number;
  /** 超過上限（`max_results`）時後端送 C-CANCEL、只回前面這些。 */
  readonly truncated?: boolean;
  readonly max_results?: number;
  readonly rows: FindRow[];
}

export interface DimseSettings {
  ae_title: string;
  scp_enabled: boolean;
  scp_port: number;
  scp_host: string;
  accept_unknown_callers: boolean;
  unsupported_sop_policy: 'store' | 'reject';
  idle_seconds: number;
  acse_timeout: number;
  dimse_timeout: number;
  network_timeout: number;
  /** TCP 連線逾時（秒）；沒有它 ECHO 關機的節點會卡約 2 分鐘。 */
  connect_timeout: number;
}

export interface ScpStatus {
  readonly ae_title: string;
  readonly port: number;
  readonly host: string;
  readonly running: boolean;
  readonly started_at: string | null;
  readonly received_total: number;
  readonly rejected_total: number;
  readonly last_rejected: { calling_aet: string; remote: string; at: string } | null;
  readonly last_batch: { batch_id: string; calling_aet: string; remote: string; received: number; unsupported: number; finished_at: string; node_id?: string | null } | null;
  readonly open_associations: number;
  readonly verify_callers: boolean;
  readonly unsupported_policy: string;
  readonly idle_seconds: number;
}

export interface SettingsView {
  readonly dimse: DimseSettings;
  readonly sources: Readonly<Record<string, 'env' | 'db'>>;
  readonly updated: { updated_by: string; updated_at: string } | null;
  readonly readonly: readonly { key: string; label: string; value: string }[];
  readonly scp: ScpStatus | null;
  readonly scp_error: string | null;
  readonly scp_owner: boolean;
}

export interface DimseStatus {
  readonly our_ae_title: string;
  readonly scp_port: number;
  readonly scp_enabled: boolean;
  readonly scp: ScpStatus | null;
  readonly scp_error: string | null;
}

/** C-FIND 結果列：鍵是 DICOM 關鍵字（`dimse._FIND_KEYS`）。 */
export type FindRow = Readonly<Record<string, string | string[] | null | undefined>>;

/** `POST /dimse/nodes/{id}/send`：序列、整個 study、整個病人（後端展開成目錄裡的全部序列）或匯出結果。 */
export interface SendBody {
  series_uids?: string[];
  study_uids?: string[];
  patient_ids?: string[];
  export_job_id?: string;
  case_id?: string;
  /** 內容含 RT-Gaia 劑量運算存的 RTDOSE 時要帶（使用者確認過）。 */
  confirm_derived?: boolean;
}

export interface RemoteJob {
  readonly job_id: string;
  readonly kind: string;
  readonly status: 'queued' | 'running' | 'done' | 'failed';
  readonly phase: string;
  readonly percent: number;
  readonly requested_by?: string;
  readonly requested_at?: string;
  readonly error?: string | null;
  // send
  readonly sent?: number;
  readonly total?: number;
  readonly series_count?: number;
  readonly failed?: readonly { path: string; status: unknown }[];
  // retrieve
  readonly method?: 'move' | 'get';
  readonly completed?: number;
  readonly received?: number;
  readonly import?: { counts: Record<string, number> };
  readonly node?: { name: string; ae_title: string };
}

const API = '/api/v1';

/** 共用的 fetch：非 2xx 丟 `Error(detail.message ?? code)`；匯出紀錄也用它。 */
export async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API}${path}`, init);
  if (!r.ok) {
    let message = `HTTP ${r.status}`;
    try {
      const body = (await r.json()) as { detail?: { message?: string; code?: string } | string; message?: string };
      const d = body.detail;
      message = typeof d === 'string' ? d : d?.message ?? body.message ?? (d?.code ? `${message} ${d.code}` : message);
    } catch {
      /* 非 JSON */
    }
    throw new Error(message);
  }
  if (r.status === 204) return undefined as T;
  return (await r.json()) as T;
}
export const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export const dimseApi = {
  status: (): Promise<DimseStatus> => call('/dimse/status'),
  nodes: (): Promise<DicomNode[]> => call('/dimse/nodes'),
  createNode: (body: Record<string, unknown>): Promise<DicomNode> => call('/dimse/nodes', json('POST', body)),
  updateNode: (id: string, body: Record<string, unknown>): Promise<DicomNode> => call(`/dimse/nodes/${encodeURIComponent(id)}`, json('PATCH', body)),
  deleteNode: (id: string): Promise<void> => call(`/dimse/nodes/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  echo: (id: string): Promise<EchoResult> => call(`/dimse/nodes/${encodeURIComponent(id)}/echo`, { method: 'POST' }),
  probe: (id: string): Promise<ProbeResult> => call(`/dimse/nodes/${encodeURIComponent(id)}/probe`, { method: 'POST' }),
  // 一次拿滿（上限 500），前端分頁 —— 翻頁不再對 PACS 重查
  find: (id: string, level: 'patient' | 'study' | 'series', query: Record<string, string>): Promise<FindResult> =>
    call(`/dimse/nodes/${encodeURIComponent(id)}/find`, json('POST', { level, query, limit: 500 })),
  retrieve: (id: string, body: { study_uids?: string[]; series_uids?: string[]; method: 'move' | 'get' }): Promise<RemoteJob> =>
    call(`/dimse/nodes/${encodeURIComponent(id)}/retrieve`, json('POST', body)),
  send: (id: string, body: SendBody): Promise<RemoteJob> =>
    call(`/dimse/nodes/${encodeURIComponent(id)}/send`, json('POST', body)),
  settings: (): Promise<SettingsView> => call('/settings'),
  putSettings: (patch: Partial<DimseSettings>): Promise<SettingsView> => call('/settings/dimse', json('PUT', patch)),
  restartScp: (): Promise<{ restarted: boolean; running: boolean; error?: string; scp: ScpStatus | null; scp_error: string | null }> =>
    call('/dimse/scp/restart', { method: 'POST' }),
  job: (id: string): Promise<RemoteJob> => call(`/jobs/${encodeURIComponent(id)}`),
  jobs: (kind: string, limit = 20): Promise<RemoteJob[]> => call(`/jobs?kind=${encodeURIComponent(kind)}&limit=${limit}`),
};
