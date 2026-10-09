/**
 * 多語系（整個介面，繁中＋英文）。
 *
 * * **原文當 key（gettext 式）**：`t('匯出紀錄')`、`t('送出 {sent} / {total}', { sent, total })`。繁中就是原文本身；
 *   英文字典以原文對應譯文。缺譯文時退回原文 —— 不會因為漏翻就壞掉（防退步測試會抓漏翻）。
 * * 同字不同義用 `ctx`：`t('開啟', { ctx: '病例' })` 查 `病例|開啟`，查不到再查 `開啟`。
 * * 英文複數：字典的值可以是函式 `(p) => …`。
 * * 不加套件（商品化要追 SOUP／授權，這點需求不值得一個相依）。
 * * 語言：`?lang=en` ＞ localStorage（`rtgaia.lang`）＞ 預設英文。`setLang` 通知訂閱者；React 端 App 以 `useLang()` 訂閱，
 *   整棵樹重畫（專案沒有 `React.memo`，一次重畫就全到）。
 * * **不翻**：DICOM 內容（病人、結構名稱、StructureSetLabel、序列描述）、使用者輸入、LPS／HU／Gy／mm 等單位。
 */

// 英文字典（約 180 KB 原始碼）**不跟主程式一起下載** —— 切到英文（或開頁時就是英文）才載入。

export type Lang = 'zh-TW' | 'en';
export const LANGS: readonly Lang[] = ['zh-TW', 'en'];
export const LANG_LABEL: Readonly<Record<Lang, string>> = { 'zh-TW': '中文', en: 'English' };
export const LANG_STORAGE_KEY = 'rtgaia.lang';
/** 沒有 `?lang=`、也沒選過語言時用的。`index.html` 的開機字樣跟著同一個規則。 */
export const DEFAULT_LANG: Lang = 'en';

export type MessageParams = Readonly<Record<string, string | number | null | undefined>> & { readonly ctx?: string };
export type MessageEntry = string | ((p: MessageParams) => string);

const catalogs: Record<Lang, Map<string, MessageEntry>> = { 'zh-TW': new Map(), en: new Map() };
let englishLoaded = false;
let englishLoading: Promise<void> | null = null;

/** 核心英文字典放進來（plugin 先註冊的同一條不蓋掉）。lazy 載入與測試共用。 */
export function installEnglish(messages: Readonly<Record<string, MessageEntry>>): void {
  const map = catalogs.en;
  for (const [k, v] of Object.entries(messages)) if (!map.has(k)) map.set(k, v);
  englishLoaded = true;
}

/** 這個語言要的字典載好（英文第一次用時 `import('./en')`）。繁中是原文本身，不用載。 */
export function ensureLang(lang: Lang): Promise<void> {
  if (lang !== 'en' || englishLoaded) return Promise.resolve();
  englishLoading ??= import('./en').then((m) => installEnglish(m.EN));
  return englishLoading;
}
const listeners = new Set<() => void>();
let current: Lang = detectLang();

function detectLang(): Lang {
  try {
    const q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('lang') : null;
    if (q === 'en' || q === 'zh-TW') return q;
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(LANG_STORAGE_KEY) : null;
    if (saved === 'en' || saved === 'zh-TW') return saved;
  } catch {
    /* 私密視窗、沒有 DOM（測試） */
  }
  return DEFAULT_LANG;
}

/** 加一批譯文（核心、模組、plugin 都可以；後加的覆蓋先加的）。 */
export function registerMessages(lang: Lang, messages: Readonly<Record<string, MessageEntry>>): void {
  const map = catalogs[lang];
  for (const [k, v] of Object.entries(messages)) map.set(k, v);
}

export function getLang(): Lang {
  return current;
}

/**
 * 換語言。英文字典還沒載入 → 先載入、載好才換（畫面不會先出現一半中文一半英文）；回傳的 Promise 在換好時完成。
 */
export function setLang(lang: Lang): Promise<void> {
  if (lang === current) return Promise.resolve();
  if (lang === 'en' && !englishLoaded) return ensureLang(lang).then(() => setLang(lang));
  current = lang;
  try {
    localStorage.setItem(LANG_STORAGE_KEY, lang);
  } catch {
    /* 私密視窗 */
  }
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
  for (const fn of listeners) fn();
  return Promise.resolve();
}

/** 語言變更時通知；回傳取消訂閱。 */
export function onLangChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function interpolate(text: string, params: MessageParams | undefined): string {
  if (params === undefined) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = params[name];
    return v === undefined || v === null ? whole : String(v);
  });
}

/** 查某語言的譯文（不插值）；沒有回 undefined。給測試與 `t` 用。 */
export function lookup(lang: Lang, source: string, ctx?: string): MessageEntry | undefined {
  const map = catalogs[lang];
  return (ctx !== undefined ? map.get(`${ctx}|${source}`) : undefined) ?? map.get(source);
}

/**
 * 翻譯。`source` 是繁中原文（也是 key）；`{name}` 以 `params` 插值。
 * 目前語言沒有這條 → 用原文（繁中永遠是原文本身）。
 */
export function t(source: string, params?: MessageParams): string {
  const entry = current === 'zh-TW' ? undefined : lookup(current, source, params?.ctx);
  if (entry === undefined) return interpolate(source, params);
  return typeof entry === 'function' ? entry(params ?? {}) : interpolate(entry, params);
}

/**
 * 標記「這是要翻的原文」但先不翻（模組層級的常數：導覽項目、表格標題…）—— 值原樣回傳，顯示時再 `t(value)`。
 * 防退步測試把 `msg()` 與 `t()` 裡的字面值都算作已處理。
 */
export function msg(source: string): string {
  return source;
}

/** 日期時間（跟語言走）。 */
export function formatDateTime(value: string | number | Date, opts?: Intl.DateTimeFormatOptions): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString(current, opts);
}

export function formatDate(value: string | number | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString(current);
}

/** 子句連接（錯誤清單等）：中文「；」、英文「; 」。 */
export function joinClauses(items: readonly string[]): string {
  return items.join(current === 'zh-TW' ? '；' : '; ');
}

/** 列表連接：中文「、」、英文「, 」。 */
export function joinList(items: readonly string[]): string {
  return items.join(current === 'zh-TW' ? '、' : ', ');
}

let headerInstalled = false;

/**
 * 每個 `/api/` 請求帶 `Accept-Language`（跟介面語言，不是瀏覽器語言）—— 後端依它翻錯誤訊息、
 * 運算清單、服務設定等。包 `window.fetch` 一次（transport、資料頁、各面板都打 API，逐一加會漏）；呼叫端自己給了就不蓋。
 */
export function installLanguageHeader(): void {
  if (headerInstalled || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  headerInstalled = true;
  const original = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes('/api/')) return original(input, init);
    const headers = new Headers(init?.headers ?? (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined));
    if (!headers.has('Accept-Language')) headers.set('Accept-Language', current);
    return original(input, { ...init, headers });
  });
}

