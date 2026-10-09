/** 管理頁 Plugins 分頁的純邏輯（可單獨測）。 */

import type { PluginRow, PluginStatus } from './pluginsApi';
import { joinList, msg, t } from '../../core/i18n';

export const STATUS_LABEL: Record<PluginStatus, string> = {
  active: msg('運作中'),
  disabled: msg('已停用'),
  failed: msg('連不上'),
  'version-mismatch': msg('版本不相容'),
  license: msg('授權未放行'),
};

export function statusClass(status: PluginStatus): 'ok' | 'muted' | 'error' | 'warning' {
  if (status === 'active') return 'ok';
  if (status === 'disabled') return 'muted';
  if (status === 'failed') return 'error';
  return 'warning';
}

/** 登錄表單驗證；回 null ＝ 合法。 */
export function registerProblems(endpoint: string, token: string): string | null {
  const e = endpoint.trim();
  if (!/^https?:\/\/[^\s/]+/.test(e)) return t('endpoint 要是 http(s)://主機[:port]，例如 http://plugin-nnunet:8702');
  if (/[\s]/.test(token)) return t('token 不能含空白');
  return null;
}

/** 允許放行的授權：逗號或空白分隔 → 去重的 SPDX 字串陣列。 */
export function parseAllowLicenses(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
}

/** 權重（model-weights）與非白名單授權要在表上醒目：回一句提醒或 null。 */
export function licenseNotice(row: PluginRow): string | null {
  const weights = (row.manifest?.soup ?? []).filter((s) => s.kind === 'model-weights');
  const nc = weights.filter((w) => /NC|non-?commercial/i.test(w.license));
  if (nc.length > 0) return t('模型權重 {p0} 為非商業授權，僅供研究用途', { p0: joinList(nc.map((w) => t('{name}（{license}）', { name: w.name, license: w.license }))) });
  if ((row.allow_licenses ?? []).length > 0) return t('已由 admin 放行授權：{p0}', { p0: joinList(row.allow_licenses!) });
  return null;
}

export function sortRows(rows: readonly PluginRow[]): PluginRow[] {
  return [...rows].sort((a, b) => a.label.localeCompare(b.label));
}
