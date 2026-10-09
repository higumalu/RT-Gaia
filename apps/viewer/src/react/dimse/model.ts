/**
 * DIMSE 設定頁與遠端查詢的**純邏輯**。零 React、零 fetch —— `dimse-model.test.ts` 直接測。
 *
 * 一張節點表，每個節點勾角色（可送出＝它當 SCP；可接收＝它當 SCU）；SCP／SCU 是連線角色，不是節點屬性。
 */

import type { Capability, DicomNode, DimseSettings, FindRow, NodeInput, SendBody, Supports } from './dimseApi';
import { msg, t } from '../../core/i18n';

export const CAPABILITIES: readonly Capability[] = ['echo', 'find', 'move', 'get', 'store'];
export const CAPABILITY_LABEL: Record<Capability, string> = { echo: 'ECHO', find: msg('查詢 FIND'), move: msg('拉回 MOVE'), get: msg('拉回 GET'), store: msg('接收 STORE') };

export const EMPTY_NODE_INPUT: NodeInput = {
  name: '',
  ae_title: '',
  host: '',
  port: 104,
  roles: { send: true, receive: true },
  inbound_ip: '',
  our_calling_aet: '',
  move_destination_aet: '',
  supports: {},
  description: '',
  max_pdu: '',
  transfer_syntaxes: [],
};

// ── 節點層級的 PDU 與 Transfer Syntax ────────────────────────────────────

export const MIN_PDU = 4096;
export const MAX_PDU = 4194304;
export const EXPLICIT_LE = '1.2.840.10008.1.2.1';
export const IMPLICIT_LE = '1.2.840.10008.1.2';

export type TsPreset = 'default' | 'implicit' | 'explicit' | 'explicit+implicit' | 'custom';
export const TS_PRESETS: Readonly<Record<Exclude<TsPreset, 'custom'>, readonly string[]>> = {
  default: [],
  implicit: [IMPLICIT_LE],
  explicit: [EXPLICIT_LE],
  'explicit+implicit': [EXPLICIT_LE, IMPLICIT_LE],
};
export const TS_PRESET_LABEL: Record<TsPreset, string> = {
  default: msg('預設（Explicit／Implicit LE 等）'),
  implicit: msg('只用 Implicit VR Little Endian（老系統）'),
  explicit: msg('只用 Explicit VR Little Endian'),
  'explicit+implicit': msg('Explicit 優先、Implicit 備用'),
  custom: msg('自訂'),
};

export function tsPresetOf(list: readonly string[]): TsPreset {
  for (const [k, v] of Object.entries(TS_PRESETS) as [Exclude<TsPreset, 'custom'>, readonly string[]][]) {
    if (v.length === list.length && v.every((u, i) => u === list[i])) return k;
  }
  return 'custom';
}

export function pduProblem(pdu: number | ''): string | null {
  if (pdu === '' || pdu === 0) return null;
  if (!Number.isInteger(pdu) || pdu < MIN_PDU || pdu > MAX_PDU) return t('最大 PDU 要空白（預設）或 {min}–{max} bytes', { min: MIN_PDU, max: MAX_PDU });
  return null;
}

/** 前端分頁（C-FIND 一次拿滿，翻頁不重查）。`page` 從 0 起；超出範圍夾回最後一頁。 */
export function pageOf<T>(rows: readonly T[], page: number, size: number): { items: T[]; page: number; pages: number; from: number; to: number } {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const p = Math.min(pages - 1, Math.max(0, page));
  const from = p * size;
  const items = rows.slice(from, from + size);
  return { items, page: p, pages, from: rows.length === 0 ? 0 : from + 1, to: from + items.length };
}

export function nodeToInput(n: DicomNode, ourAet: string): NodeInput {
  return {
    name: n.name,
    ae_title: n.ae_title,
    host: n.host,
    port: n.port || '',
    roles: { ...n.roles },
    inbound_ip: n.inbound_ip ?? '',
    // 與全域相同就留空（＝跟著全域）
    our_calling_aet: n.our_calling_aet === ourAet ? '' : n.our_calling_aet,
    move_destination_aet: n.move_destination_aet === ourAet ? '' : n.move_destination_aet,
    supports: { ...n.supports },
    description: n.description,
    max_pdu: n.max_pdu ? n.max_pdu : '',
    transfer_syntaxes: [...(n.transfer_syntaxes ?? [])],
  };
}

/** AE Title：1–16 個 ASCII、不含空白（DICOM PS3.5 AE VR；後端 `Node.from_wire` 同一規則）。 */
export function aetProblem(aet: string): string | null {
  const v = aet.trim();
  if (!v) return t('AE Title 必填');
  if (v.length > 16) return t('AE Title 最多 16 個字元');
  if (!/^[\x21-\x7e]+$/.test(v)) return t('AE Title 只能是 ASCII、不含空白');
  return null;
}

export function portProblem(port: number | string): string | null {
  if (port === '' || port === undefined) return t('Port 必填');
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return t('Port 必須在 1–65535');
  return null;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
export function ipProblem(ip: string): string | null {
  const v = ip.trim();
  if (!v) return null;
  const m = IPV4.exec(v);
  if (!m || m.slice(1).some((oct) => Number(oct) > 255)) return t('只接受 IPv4 位址（如 192.0.2.30）');
  return null;
}

/** 節點表單的全部問題（空陣列＝可送）。 */
export function nodeProblems(input: NodeInput): string[] {
  const out: string[] = [];
  const aet = aetProblem(input.ae_title);
  if (aet) out.push(aet);
  if (!input.roles.send && !input.roles.receive) out.push(t('至少勾一個角色（可送出／可接收）'));
  if (input.roles.send) {
    if (!input.host.trim()) out.push(t('可送出的節點要有主機／IP'));
    const p = portProblem(input.port);
    if (p) out.push(p);
  } else if (input.port !== '' && portProblem(input.port)) {
    out.push(portProblem(input.port) as string);
  }
  if (input.roles.receive) {
    const ip = ipProblem(input.inbound_ip);
    if (ip) out.push(ip);
  }
  const pdu = pduProblem(input.max_pdu);
  if (pdu) out.push(pdu);
  for (const [field, label] of [
    ['our_calling_aet', t('我方呼叫用 AE Title')],
    ['move_destination_aet', t('C-MOVE 目的地 AE Title')],
  ] as const) {
    const v = input[field].trim();
    if (v && aetProblem(v)) out.push(t('{label}：{p1}', { label, p1: aetProblem(v) }));
  }
  return out;
}

/** 表單 → 後端 body（空字串的選配欄位不送；只接收的節點 host／port 可空）。 */
export function nodeBody(input: NodeInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: input.name.trim() || input.ae_title.trim(),
    ae_title: input.ae_title.trim(),
    host: input.host.trim(),
    port: input.port === '' ? 0 : Number(input.port),
    roles: { send: input.roles.send, receive: input.roles.receive },
    inbound_ip: input.roles.receive && input.inbound_ip.trim() ? input.inbound_ip.trim() : null,
    supports: input.supports,
    description: input.description.trim(),
    our_calling_aet: input.our_calling_aet.trim() || null,
    move_destination_aet: input.move_destination_aet.trim() || null,
    max_pdu: input.max_pdu === '' ? 0 : input.max_pdu,
    transfer_syntaxes: input.transfer_syntaxes,
  };
  return body;
}

/** 表格的「角色」欄：「送出 接收」。 */
export function rolesLabel(n: Pick<DicomNode, 'roles'>): string {
  const parts: string[] = [];
  if (n.roles.send) parts.push(t('送出'));
  if (n.roles.receive) parts.push(t('接收'));
  return parts.join(' ') || '—';
}

/** 表格的「支援」欄：只列勾了的；沒偵測過顯示「未偵測」。 */
export function supportsLabel(s: Supports): string {
  const on = CAPABILITIES.filter((c) => s[c] === true);
  if (on.length === 0) return Object.keys(s).length === 0 ? t('未偵測') : '—';
  return on.map((c) => c).join(' ');
}

/** 哪些節點能拿來「從節點拉」：可送出，且 find 沒被明確標為不支援。 */
export function queryableNodes(nodes: readonly DicomNode[]): DicomNode[] {
  return nodes.filter((n) => n.roles.send && n.host && n.supports.find !== false);
}

/** 哪些節點能拿來「送到節點」：可送出，且 store 沒被明確標為不支援。 */
export function storeTargets(nodes: readonly DicomNode[]): DicomNode[] {
  return nodes.filter((n) => n.roles.send && n.host && n.supports.store !== false);
}

/** 拉回方法：明確支援 get 就用 get（同一條連線回來、不需對方登錄我方）；否則 move。 */
export function retrieveMethod(n: Pick<DicomNode, 'supports'>): 'move' | 'get' {
  if (n.supports.get === true) return 'get';
  return 'move';
}

// ── 服務設定 ─────────────────────────────────────────────────────────────────

export const SETTING_LABEL: Record<keyof DimseSettings, string> = {
  ae_title: msg('我方 AE Title'),
  scp_enabled: msg('接收端（SCP）'),
  scp_port: msg('接收端 port'),
  scp_host: msg('綁定位址'),
  accept_unknown_callers: msg('接受未登錄的來源'),
  unsupported_sop_policy: msg('不支援的 SOP Class'),
  idle_seconds: msg('批次閒置收尾（秒）'),
  acse_timeout: msg('ACSE 逾時（秒）'),
  dimse_timeout: msg('DIMSE 逾時（秒）'),
  network_timeout: msg('網路逾時（秒）'),
  connect_timeout: msg('TCP 連線逾時（秒）'),
};

/** 與後端 `DimseSettings.problems()` 同一套規則。 */
export function settingsProblems(s: DimseSettings): string[] {
  const out: string[] = [];
  const aet = aetProblem(s.ae_title);
  if (aet) out.push(aet);
  const port = portProblem(s.scp_port);
  if (port) out.push(t('接收端 {port}', { port }));
  if (!s.scp_host.trim()) out.push(t('綁定位址必填（0.0.0.0 ＝ 全部介面）'));
  if (!(s.idle_seconds >= 3 && s.idle_seconds <= 60)) out.push(t('閒置秒數必須在 3–60'));
  for (const k of ['acse_timeout', 'dimse_timeout', 'network_timeout'] as const) {
    if (!(Number.isInteger(s[k]) && s[k] >= 1 && s[k] <= 3600)) out.push(t('{p0} 必須在 1–3600', { p0: t(SETTING_LABEL[k]) }));
  }
  if (!(Number.isInteger(s.connect_timeout) && s.connect_timeout >= 1 && s.connect_timeout <= 60)) out.push(t('{connect_timeout} 必須在 1–60', { connect_timeout: t(SETTING_LABEL.connect_timeout) }));
  return out;
}

/** 只送有改的欄位（PUT 是部分更新；沒改的欄位維持 env 預設）。 */
export function settingsPatch(before: DimseSettings, after: DimseSettings): Partial<DimseSettings> {
  const patch: Partial<DimseSettings> = {};
  for (const k of Object.keys(after) as (keyof DimseSettings)[]) {
    if (before[k] !== after[k]) (patch as Record<string, unknown>)[k] = after[k];
  }
  return patch;
}

/** 改了 AE Title 或 port，對方（已登錄我方的 PACS／TPS）要同步更新。 */
export function peerSyncWarnings(before: DimseSettings, after: DimseSettings): string[] {
  const out: string[] = [];
  if (before.ae_title !== after.ae_title) out.push(t('我方 AE Title 從 {ae_title} 改為 {ae_title2}：對方登錄的 {ae_title3} 會失效，要同步更新。', { ae_title: before.ae_title, ae_title2: after.ae_title, ae_title3: before.ae_title }));
  if (before.scp_port !== after.scp_port) out.push(t('接收端 port 從 {scp_port} 改為 {scp_port2}：對方登錄的目的地要同步更新。', { scp_port: before.scp_port, scp_port2: after.scp_port }));
  if (before.accept_unknown_callers && !after.accept_unknown_callers) out.push(t('關掉「接受未登錄的來源」後，只有「可接收」節點清單裡的 AE Title 送得進來。'));
  return out;
}

/** 改了這些要重啟接收端（後端 `scp_changed`）。 */
export function needsRestart(patch: Partial<DimseSettings>): boolean {
  return ['ae_title', 'scp_enabled', 'scp_port', 'scp_host', 'network_timeout'].some((k) => k in patch);
}

// ── 遠端查詢（C-FIND）──────────────────────────────────────────────────────

export interface RemoteQuery {
  patientId: string;
  patientName: string;
  dateFrom: string; // YYYYMMDD
  dateTo: string;
  modality: string;
}

export const EMPTY_REMOTE_QUERY: RemoteQuery = { patientId: '', patientName: '', dateFrom: '', dateTo: '', modality: '' };

/** 表單 → Study Root C-FIND 的 study 層查詢鍵；空的不送。PatientID 自動加尾端萬用字元。 */
export function studyQuery(q: RemoteQuery): Record<string, string> {
  const out: Record<string, string> = {};
  const pid = q.patientId.trim();
  if (pid) out['PatientID'] = pid.includes('*') ? pid : `${pid}*`;
  const name = q.patientName.trim();
  if (name) out['PatientName'] = name.includes('*') ? name : `*${name}*`;
  if (q.dateFrom || q.dateTo) out['StudyDate'] = q.dateFrom && q.dateTo ? `${q.dateFrom}-${q.dateTo}` : q.dateFrom ? `${q.dateFrom}-` : `-${q.dateTo}`;
  if (q.modality.trim()) out['ModalitiesInStudy'] = q.modality.trim().toUpperCase();
  return out;
}

export function hasRemoteQuery(q: RemoteQuery): boolean {
  return Object.keys(studyQuery(q)).length > 0;
}

function str(v: FindRow[string]): string {
  if (v === null || v === undefined) return '';
  return Array.isArray(v) ? v.join('\\') : String(v);
}

export interface RemoteStudy {
  readonly studyUid: string;
  readonly patientId: string;
  readonly patientName: string;
  readonly date: string;
  readonly description: string;
  readonly modalities: readonly string[];
  readonly seriesCount: number | null;
  readonly instanceCount: number | null;
}

export function toRemoteStudy(row: FindRow): RemoteStudy {
  const mods = row['ModalitiesInStudy'];
  return {
    studyUid: str(row['StudyInstanceUID']),
    patientId: str(row['PatientID']),
    patientName: str(row['PatientName']).replace(/\^/g, ' ').trim(),
    date: str(row['StudyDate']),
    description: str(row['StudyDescription']),
    modalities: Array.isArray(mods) ? mods.map(String) : str(mods) ? str(mods).split('\\') : [],
    seriesCount: str(row['NumberOfStudyRelatedSeries']) ? Number(str(row['NumberOfStudyRelatedSeries'])) : null,
    instanceCount: str(row['NumberOfStudyRelatedInstances']) ? Number(str(row['NumberOfStudyRelatedInstances'])) : null,
  };
}

export interface RemoteSeries {
  readonly seriesUid: string;
  readonly studyUid: string;
  readonly modality: string;
  readonly description: string;
  readonly number: string;
  readonly instanceCount: number | null;
}

export function toRemoteSeries(row: FindRow): RemoteSeries {
  return {
    seriesUid: str(row['SeriesInstanceUID']),
    studyUid: str(row['StudyInstanceUID']),
    modality: str(row['Modality']),
    description: str(row['SeriesDescription']),
    number: str(row['SeriesNumber']),
    instanceCount: str(row['NumberOfSeriesRelatedInstances']) ? Number(str(row['NumberOfSeriesRelatedInstances'])) : null,
  };
}

/** RT 相關 series 排前面、再依 series number。 */
export function sortSeries(rows: readonly RemoteSeries[]): RemoteSeries[] {
  const rank = (m: string): number => (['CT', 'MR', 'PT'].includes(m) ? 0 : m === 'RTSTRUCT' ? 1 : m === 'RTPLAN' ? 2 : m === 'RTDOSE' ? 3 : m === 'REG' ? 4 : 5);
  return [...rows].sort((a, b) => rank(a.modality) - rank(b.modality) || Number(a.number) - Number(b.number) || a.seriesUid.localeCompare(b.seriesUid));
}

/**
 * 勾選 → retrieve body。整個 study 都勾了（或沒展開 series 就勾 study）送 study_uids；否則送 series_uids。
 */
export function retrieveBody(
  studies: ReadonlySet<string>,
  series: ReadonlySet<string>,
  method: 'move' | 'get',
): { study_uids?: string[]; series_uids?: string[]; method: 'move' | 'get' } {
  const body: { study_uids?: string[]; series_uids?: string[]; method: 'move' | 'get' } = { method };
  if (studies.size > 0) body.study_uids = [...studies];
  if (series.size > 0) body.series_uids = [...series];
  return body;
}

export const RETRIEVE_PHASE_LABEL: Record<string, string> = { queued: msg('排隊中'), associate: msg('連線'), import: msg('匯入'), done: msg('完成'), failed: msg('失敗') };
export const SEND_PHASE_LABEL: Record<string, string> = { queued: msg('排隊中'), associate: msg('連線'), store: msg('傳送'), done: msg('完成'), failed: msg('失敗') };

export function summarizeRetrieve(j: { method?: string; completed?: number; received?: number; import?: { counts: Record<string, number> }; error?: string | null }): string {
  if (j.error) return j.error;
  const parts: string[] = [];
  if (j.method === 'get') {
    if (j.received !== undefined) parts.push(t('收到 {received}', { received: j.received }));
    const c = j.import?.counts;
    if (c) parts.push(t('接受 {p0}{p1}', { p0: c['accepted'] ?? 0, p1: c['duplicate_same'] ? t(' · 重複 {p0}', { p0: c['duplicate_same'] }) : '' }));
  } else if (j.completed !== undefined) {
    parts.push(t('對方已送 {completed} 個（由接收端匯入）', { completed: j.completed }));
  }
  return parts.join(' · ');
}

// ── 資料頁「送到節點」────────────────────────────────────────────────────

/** 資料頁一列 → 送出目標：病人、study 或單一序列（影像或 RT 物件都是序列）。 */
export interface SendTarget {
  readonly level: 'patient' | 'study' | 'series';
  readonly id: string;
  /** 給人看的：「病人 P001」「2026-06-01 Pelvis」「CT · 187 檔」。 */
  readonly label: string;
  /** 已知的序列數／檔數（列上有就帶，對話框顯示用）。 */
  readonly seriesCount?: number;
  readonly instanceCount?: number;
}

export const SEND_LEVEL_LABEL: Record<SendTarget['level'], string> = { patient: msg('整個病人'), study: msg('整個 study'), series: msg('這個序列') };

export function sendBody(target: SendTarget): SendBody {
  if (target.level === 'patient') return { patient_ids: [target.id] };
  if (target.level === 'study') return { study_uids: [target.id] };
  return { series_uids: [target.id] };
}

/** 對話框的一句話：「整個 study（5 個序列 · 187 檔）」。 */
export function describeSendTarget(target: SendTarget): string {
  const parts: string[] = [];
  if (target.seriesCount !== undefined) parts.push(t('{seriesCount} 個序列', { seriesCount: target.seriesCount }));
  if (target.instanceCount !== undefined) parts.push(t('{instanceCount} 檔', { instanceCount: target.instanceCount }));
  return t('{p0}{p1}', { p0: t(SEND_LEVEL_LABEL[target.level]), p1: parts.length ? t('（{p0}）', { p0: parts.join(' · ') }) : '' });
}

export function summarizeSend(j: { sent?: number; total?: number; series_count?: number; failed?: readonly unknown[]; error?: string | null }): string {
  if (j.error) return j.error;
  const parts: string[] = [];
  if (j.sent !== undefined) parts.push(t('送出 {sent}{p1}', { sent: j.sent, p1: j.total !== undefined ? ` / ${j.total}` : '' }));
  if (j.series_count !== undefined && j.series_count > 1) parts.push(t('{series_count} 個序列', { series_count: j.series_count }));
  if (j.failed && j.failed.length > 0) parts.push(t('失敗 {length}', { length: j.failed.length }));
  return parts.join(' · ');
}
