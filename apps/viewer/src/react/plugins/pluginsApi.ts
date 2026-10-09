/**
 * Plugin 登錄 API（後端 `routes_plugins.py`）。純 fetch 與 wire 型別；純邏輯在 `model.ts`。
 */

export type PluginStatus = 'active' | 'disabled' | 'failed' | 'version-mismatch' | 'license';

export interface PluginSoup {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly kind?: string;
  readonly url?: string;
}

/** `GET /plugins` 的一列。非 admin 只有前半段欄位（`endpoint` 等為 undefined）。 */
export interface PluginRow {
  readonly plugin_id: string;
  readonly version: string;
  readonly label: string;
  readonly icon: string | null;
  readonly description: string;
  readonly has_ui: boolean;
  readonly required_role: string;
  readonly status: PluginStatus;
  readonly enabled: boolean;
  readonly allowed: boolean;
  // admin
  readonly endpoint?: string;
  readonly token_set?: boolean;
  readonly manifest?: { readonly licenses?: string[]; readonly soup?: PluginSoup[]; readonly capabilities?: string[]; readonly execution?: { timeout_s?: number } };
  readonly error?: string | null;
  readonly allow_licenses?: string[];
  readonly registered_by?: string;
  readonly created_at?: string;
  readonly last_seen_at?: string | null;
  readonly health_failures?: number;
}

export interface RegisterBody {
  endpoint: string;
  token: string;
  allow_licenses?: string[];
}

const API = '/api/v1';

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API}${path}`, init);
  if (!r.ok) {
    let message = `HTTP ${r.status}`;
    try {
      const body = (await r.json()) as { detail?: { message?: string; code?: string } | string; message?: string; code?: string };
      const d = body.detail;
      message = typeof d === 'string' ? d : d?.message ?? body.message ?? (body.code ? `${message} ${body.code}` : message);
    } catch {
      /* 非 JSON */
    }
    throw new Error(message);
  }
  if (r.status === 204) return undefined as T;
  return (await r.json()) as T;
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export const pluginsApi = {
  list: (): Promise<PluginRow[]> => call('/plugins'),
  register: (body: RegisterBody): Promise<PluginRow> => call('/plugins', json('POST', body)),
  update: (id: string, patch: Partial<RegisterBody> & { enabled?: boolean }): Promise<PluginRow> =>
    call(`/plugins/${encodeURIComponent(id)}`, json('PATCH', patch)),
  remove: (id: string): Promise<void> => call(`/plugins/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  refresh: (id: string): Promise<PluginRow> => call(`/plugins/${encodeURIComponent(id)}/refresh`, { method: 'POST' }),
};
