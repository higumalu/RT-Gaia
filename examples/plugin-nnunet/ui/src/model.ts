/**
 * 面板的純邏輯（無 React，可單獨測）：ROI 選擇、設定表單驗證、job 狀態文字。
 * 會顯示的句子用原文（繁中）寫；面板傳入 SDK 的 `t` 換成介面語言（測試不傳 → 原文）。
 */

/** 原文 → 介面語言（SDK 的 `t`）。預設只代入參數。 */
export type Translate = (text: string, params?: Readonly<Record<string, string | number>>) => string;

const fill: Translate = (text, params) => text.replace(/\{(\w+)\}/g, (whole, name: string) => (params && params[name] !== undefined ? String(params[name]) : whole));

export interface LabelInfo {
  readonly name: string;
  readonly color: readonly [number, number, number];
  readonly tg263: string | null;
}

export type Labels = Readonly<Record<string, LabelInfo>>;

export interface Settings {
  readonly mode: 'local' | 'remote';
  readonly remote_url: string;
  readonly remote_port: number;
  readonly remote_token_set: boolean;
  readonly engine: string;
}

/** 依名稱排序的 ROI 列（value 是 labelmap 整數值的字串）。 */
export function sortedLabels(labels: Labels): { value: string; info: LabelInfo }[] {
  return Object.entries(labels)
    .map(([value, info]) => ({ value, info }))
    .sort((a, b) => a.info.name.localeCompare(b.info.name));
}

/** 名稱過濾（大小寫不敏感，也比 TG-263 代碼）。 */
export function filterLabels(rows: { value: string; info: LabelInfo }[], query: string): { value: string; info: LabelInfo }[] {
  const q = query.trim().toLowerCase();
  if (q === '') return rows;
  return rows.filter((r) => r.info.name.toLowerCase().includes(q) || (r.info.tg263 ?? '').toLowerCase().includes(q));
}

export function toggle(selected: ReadonlySet<string>, name: string): Set<string> {
  const next = new Set(selected);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  return next;
}

/** `params.structures`：空陣列＝全部（契約 params_schema 的語意）。 */
export function structuresParam(selected: ReadonlySet<string>, total: number): string[] {
  if (selected.size === 0 || selected.size === total) return [];
  return [...selected].sort();
}

/**
 * 模式切換的規則（否則遠端按鈕會無法使用）：切到 remote **先只改畫面**，讓 URL／port 欄位出現；
 * 按「儲存」才驗證並送出。切到 local 立即送出。回傳要不要立刻 PATCH。
 */
export function modeChangeAction(next: 'local' | 'remote'): 'patch-now' | 'show-form' {
  return next === 'local' ? 'patch-now' : 'show-form';
}

/** 遠端設定的表單驗證；回 null ＝ 合法。 */
export function validateRemote(url: string, port: string, tr: Translate = fill): string | null {
  if (!/^https?:\/\/[^\s/]+/.test(url.trim())) return tr('URL 要以 http:// 或 https:// 開頭，例如 http://gpu-box');
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return tr('port 要是 1–65535 的整數');
  return null;
}

export interface JobView {
  readonly status: 'queued' | 'running' | 'done' | 'failed';
  readonly percent?: number;
  readonly phase?: string;
  readonly error?: string;
}

export function jobLine(job: JobView | null, tr: Translate = fill): string {
  if (job === null) return tr('尚未執行');
  switch (job.status) {
    case 'queued':
      return tr('排隊中');
    case 'running': {
      const percent = Math.round(job.percent ?? 0);
      return job.phase ? tr('執行中 {percent}%（{phase}）', { percent, phase: job.phase }) : tr('執行中 {percent}%', { percent });
    }
    case 'done':
      return tr('完成：結果已放入「plugin 結果（未儲存）」');
    case 'failed':
      return tr('失敗：{error}', { error: job.error ?? tr('未知原因') });
  }
}

/** 面板看得到的影像 layer（SDK `api.state.layers` 的子集；只用到這些欄位）。 */
export interface ImageLayerLike {
  readonly layerId: string;
  readonly kind: string;
  readonly contentRef: string;
  readonly visible: boolean;
  readonly label: string;
  readonly modality?: string | null;
  readonly seriesMeta?: Readonly<Record<string, unknown>> | null;
}

export interface ImageChoice {
  readonly layerId: string;
  /** 送給宿主 `POST /plugins/{id}/run` 的 `image_series_id`。 */
  readonly seriesId: string;
  readonly label: string;
}

function metaText(layer: ImageLayerLike, key: string): string {
  const v = layer.seriesMeta?.[key];
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * 可以推論的影像（讓人選要 infer 哪一組 CT）：病例裡每一個影像 layer 一項，
 * 名稱＝模態 日期 描述（跟宿主資料面板同一套）；同名才補序列 UID 尾碼。
 */
export function imageChoices(layers: readonly ImageLayerLike[]): ImageChoice[] {
  const base = layers
    .filter((l) => l.kind === 'image')
    .map((l) => {
      const d = metaText(l, 'series_date');
      const date = /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d;
      const name = [l.modality ?? '', date, metaText(l, 'series_description')].filter(Boolean).join(' ') || l.label;
      return { layerId: l.layerId, seriesId: l.contentRef, name };
    });
  return base.map((c) => ({
    layerId: c.layerId,
    seriesId: c.seriesId,
    label: base.filter((b) => b.name === c.name).length > 1 ? `${c.name} …${c.seriesId.slice(-6)}` : c.name,
  }));
}

/** 預設選哪一組：作用中的影像 → 第一個顯示中的 → 第一個。 */
export function defaultImageSeries(
  choices: readonly ImageChoice[],
  layers: readonly ImageLayerLike[],
  activeImageLayerId: string | null | undefined,
): string | null {
  const active = choices.find((c) => c.layerId === activeImageLayerId);
  if (active) return active.seriesId;
  const visible = choices.find((c) => layers.find((l) => l.layerId === c.layerId)?.visible);
  return (visible ?? choices[0])?.seriesId ?? null;
}

