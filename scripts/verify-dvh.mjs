#!/usr/bin/env node
/**
 * DVH 補強 —— headless Chrome ＋ CDP（骨架同 `verify-ui-polish.mjs`、零相依），真的滑鼠事件：
 *
 *   表格多 D98、D2 兩欄
 *   部分覆蓋（量測病例最後一組影像的 CouchSurface 有一部分在劑量網格外）：徽章、整體統計「–」、Dmax 照給
 *   滑鼠移到曲線上 → 提示（名稱、游標處的 Gy → % 體積）；點曲線 → 那一列強調、其他變淡；再點 → 恢復
 *   匯出：CSV（完整，匿名 → 檔名與內容沒有病歷號）、CSV（曲線，不匿名 → 檔名帶病歷號、四欄表頭）、PNG；每次都有稽核
 *
 * 需要一個開著量測病例（`.rtgaia/perf/case.json`，要有 RTPLAN 與劑量）的堆疊：
 *   scripts/perf/stack.sh start && scripts/perf/stack.sh load
 *   node scripts/verify-dvh.mjs --url http://127.0.0.1:5183/#/viewer [--out-dir DIR]
 * 退出碼：任一步失敗 → 1。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? 'true' : arr[i + 1]]);
    return acc;
  }, []),
);
const url = args.url ?? 'http://127.0.0.1:5183/#/viewer';
const outDir = args['out-dir'] ?? null;
const port = Number(args.port ?? 9341);
const chrome = args.chrome ?? process.env.CHROME ?? 'google-chrome';
const token = args.token ?? process.env.TOKEN ?? null;
const origin = new URL(url).origin;

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-dvh22-'));
const proc = spawn(chrome, ['--headless=new', '--no-sandbox', '--password-store=basic', '--disable-gpu', '--hide-scrollbars', '--window-size=1600,1000', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], {
  stdio: 'ignore',
});
process.on('exit', () => {
  try {
    proc.kill('SIGKILL');
  } catch {
    /* already gone */
  }
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets = null;
for (let i = 0; i < 100 && targets === null; i += 1) {
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  } catch {
    await sleep(100);
  }
}
if (targets === null) throw new Error('Chrome 沒有起來');
const ws = new WebSocket((targets.find((t) => t.type === 'page') ?? targets[0]).webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let seq = 0;
const pending = new Map();
const errors = [];
ws.onmessage = (event) => {
  const msg = JSON.parse(String(event.data));
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? ''));
  return r.result.value;
};
const shot = async (name) => {
  if (!outDir) return;
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(outDir, name), Buffer.from(data, 'base64'));
};
const waitFor = async (expression, what, ms = 60000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(expression)) return;
    } catch {
      /* 頁面還在換 */
    }
    await sleep(250);
  }
  await shot('dvh22-failed.png').catch(() => undefined);
  throw new Error(`等不到：${what}`);
};
const step = (s) => console.log(`✓ ${s}`);
const clickAt = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(250);
};
const centerOf = (expr) => evaluate(`(() => { const r = (${expr}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
const cellSel = (label) => `[...document.querySelectorAll('.viewport-cell')].find((c) => c.querySelector('.viewport-label')?.textContent.trim() === ${JSON.stringify(label)})`;

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { if (!localStorage.getItem('rtgaia.lang')) localStorage.setItem('rtgaia.lang', 'zh-TW'); localStorage.setItem('rtgaia.tour.v1', 'done'); localStorage.setItem('rtgaia.layout.current.v1', '2x2'); localStorage.removeItem('rtgaia.dock.v1'); localStorage.removeItem('rtgaia.layout.trees.v1'); } catch {}" });
if (token) await send('Network.setCookie', { name: 'rtgaia_session', value: token, url: origin, httpOnly: true });
const downloads = mkdtempSync(join(tmpdir(), 'rtgaia-dvh22-dl-'));
await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
await send('Page.navigate', { url });
await waitFor(`document.querySelectorAll('.viewport-cell canvas').length >= 3 && !!document.querySelector('.dvh-toggle button')`, '病例載入（要有 RTDOSE）');
await waitFor(`!document.querySelector('.mask-loading')`, '載入完', 60000);
await sleep(800);

// 開 DVH
await evaluate(`document.querySelector('.dvh-toggle button').click(); true`);
await waitFor(`document.querySelectorAll('.dvh-table tbody tr').length > 0 && !document.querySelector('.dvh-loading')`, 'DVH 表格', 60000);
const heads = await evaluate(`[...document.querySelectorAll('.dvh-table thead th')].map((th) => th.textContent.trim())`);
for (const h of ['D98', 'D95', 'D50', 'D2']) if (!heads.includes(h)) throw new Error(`表頭少了 ${h}：${heads}`);
step(`表頭：${heads.join(' ')}`);

// 勾最後一組（fx2 CBCT）的 CouchSurface —— 約 2/3 在計畫劑量網格外（primary 那組的完全在外，Dmax 也會是「–」）
const before = await evaluate(`document.querySelectorAll('.dvh-table tbody tr').length`);
const ticked = await evaluate(`(() => { const g = [...document.querySelectorAll('.dvh-structs-group')].at(-1); const l = g && [...g.querySelectorAll('label')].find((x) => x.textContent.trim() === 'CouchSurface'); if (!l) return false; l.querySelector('input').click(); return true; })()`);
if (!ticked) throw new Error('找不到最後一組的 CouchSurface');
await waitFor(`document.querySelectorAll('.dvh-table tbody tr').length === ${before + 1} && !document.querySelector('.dvh-loading')`, 'CouchSurface 進表格', 60000);
await sleep(400);
const couch = await evaluate(`(() => { const tr = [...document.querySelectorAll('.dvh-table tbody tr')].find((r) => r.cells[0].textContent.includes('CouchSurface')); const idx = (h) => [...document.querySelectorAll('.dvh-table thead th')].findIndex((th) => th.textContent.trim() === h); return { badge: !!tr.querySelector('.badge'), dmean: tr.cells[idx('Dmean')].textContent.trim(), dmax: tr.cells[idx('Dmax')].textContent.trim(), d98: tr.cells[idx('D98')].textContent.trim(), title: tr.title }; })()`);
if (!couch.badge || couch.dmean !== '–' || couch.d98 !== '–' || !/^\d/.test(couch.dmax) || !couch.title.includes('下限')) throw new Error(`部分覆蓋的列不對：${JSON.stringify(couch)}`);
const full = await evaluate(`(() => { const tr = [...document.querySelectorAll('.dvh-table tbody tr')].find((r) => r.cells[0].textContent.trim().startsWith('Kidney_R')); return tr ? [...tr.cells].map((c) => c.textContent.trim()) : null; })()`);
if (!full || full.slice(3).some((c) => c === '–')) throw new Error(`完整覆蓋的列不該有「–」：${JSON.stringify(full)}`);
step(`部分覆蓋：CouchSurface 有徽章、Dmean／D98「–」、Dmax ${couch.dmax}；Kidney_R 統計完整`);
await shot('dvh22-table.png');

// 滑鼠提示：沿著幾條直線往下掃，碰到曲線就停
const rect = await evaluate(`(() => { const r = document.querySelector('.dvh-canvas').getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`);
let hit = null;
for (const fx of [0.2, 0.3, 0.4, 0.5]) {
  const x = rect.left + 36 + (rect.width - 46) * fx;
  for (let y = rect.top + 10; y < rect.top + rect.height - 26 && hit === null; y += 2) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    if (await evaluate(`!!document.querySelector('.dvh-tooltip')`)) hit = { x, y };
  }
  if (hit) break;
}
if (!hit) throw new Error('滑鼠掃過圖上找不到任何曲線（沒有提示）');
const tip = await evaluate(`document.querySelector('.dvh-tooltip').textContent`);
if (!/Gy → [\d.]+% 體積/.test(tip) || !/cc/.test(tip)) throw new Error(`提示內容不對：${tip}`);
const tipName = await evaluate(`document.querySelector('.dvh-tooltip strong').textContent`);
const tipBox = await evaluate(`(() => { const t = document.querySelector('.dvh-tooltip').getBoundingClientRect(); const c = document.querySelector('.dvh-canvas-wrap').getBoundingClientRect(); return { tl: t.left, tr: t.right, cl: c.left, cr: c.right }; })()`);
if (tipBox.tl < tipBox.cl - 1 || tipBox.tr > tipBox.cr + 1) throw new Error(`提示超出圖的範圍（會被格子切掉）：${JSON.stringify(tipBox)}`);
await shot('dvh22-hover.png');
step(`滑鼠提示：${tip.slice(0, 70)}…`);

// 點曲線 → 強調那一列；再點 → 恢復
await clickAt(hit.x, hit.y);
const focusedRows = await evaluate(`[...document.querySelectorAll('.dvh-table tbody tr.focused')].map((r) => r.cells[0].textContent.trim())`);
const dimmed = await evaluate(`document.querySelectorAll('.dvh-table tbody tr.dimmed').length`);
if (focusedRows.length === 0 || !focusedRows.every((n) => n.startsWith(tipName)) || dimmed === 0) throw new Error(`點曲線後應強調 ${tipName}：${JSON.stringify({ focusedRows, dimmed })}`);
await shot('dvh22-focus.png');
await clickAt(hit.x, hit.y);
if (await evaluate(`document.querySelectorAll('.dvh-table tbody tr.focused, .dvh-table tbody tr.dimmed').length`)) throw new Error('再點一次應恢復');
// 表格列也能點
await evaluate(`[...document.querySelectorAll('.dvh-table tbody tr')][0].click(); true`);
await sleep(150);
const rowFocus = await evaluate(`document.querySelectorAll('.dvh-table tbody tr.focused').length`);
await evaluate(`[...document.querySelectorAll('.dvh-table tbody tr')][0].click(); true`);
if (rowFocus !== 1) throw new Error('點表格列應強調那一列');
step(`強調：點 ${tipName} 的曲線 → 那一列強調、${dimmed} 列變淡；再點恢復；點表格列也行`);

// 匯出
const pid = await evaluate(`fetch('/api/v1/sessions/current').then((r) => r.json()).then((s) => (s.layers ?? s.state?.layers ?? []).find((l) => l.kind === 'dose')?.seriesMeta?.patient_id ?? null)`);
if (!pid) throw new Error('拿不到劑量的病歷號（seriesMeta.patient_id）');
const waitFile = async (re, what) => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const f = readdirSync(downloads).find((n) => re.test(n) && !n.endsWith('.crdownload'));
    if (f) return join(downloads, f);
    await sleep(200);
  }
  throw new Error(`沒有下載到 ${what}：${readdirSync(downloads)}`);
};
const clickButton = (label) => evaluate(`(() => { const b = [...document.querySelectorAll('.dvh-export-bar button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);
const anonBox = `document.querySelector('.dvh-export-bar input[type=checkbox]')`;
if (!(await evaluate(`${anonBox}.checked`))) throw new Error('匿名預設應該是勾的');
if (!(await clickButton('CSV（完整）'))) throw new Error('找不到 CSV（完整）');
const fullPath = await waitFile(/^DVH_\d{8}-\d{4}\.csv$/, '匿名的完整 CSV');
const fullText = readFileSync(fullPath, 'utf8');
if (fullText.includes(pid) || !fullText.includes('partial') || !/CouchSurface,[^\r\n]*,yes,/.test(fullText) || !fullText.includes('structure,dose,dose_gy,volume_pct')) throw new Error(`匿名完整 CSV 內容不對（或含病歷號）：${fullText.slice(0, 400)}`);
await evaluate(`${anonBox}.click(); true`);
await sleep(150);
if (!(await clickButton('CSV（曲線）'))) throw new Error('找不到 CSV（曲線）');
const safePid = pid.replace(/[^A-Za-z0-9._-]+/g, '_');
const curvesPath = await waitFile(new RegExp(`^DVH_${safePid}_curves_\\d{8}-\\d{4}\\.csv$`), '不匿名的曲線 CSV');
const curvesText = readFileSync(curvesPath, 'utf8').replace(/^﻿/, '');
if (!curvesText.startsWith('structure,dose,dose_gy,volume_pct\r\n')) throw new Error(`曲線 CSV 表頭不對：${curvesText.slice(0, 80)}`);
if (!(await clickButton('PNG'))) throw new Error('找不到 PNG');
const pngPath = await waitFile(/\.png$/, 'PNG');
if (statSync(pngPath).size < 2000) throw new Error('PNG 太小');
step(`匯出：${fullPath.split('/').pop()}（無病歷號）、${curvesPath.split('/').pop()}、${pngPath.split('/').pop()}（${statSync(pngPath).size} bytes）`);

// 稽核
const audit = await evaluate(`fetch('/api/v1/audit?limit=200').then((r) => r.json()).then((evs) => evs.filter((e) => e.action.endsWith('/dvh/export')).map((e) => e.detail.dvh_export))`);
const fmts = audit.map((a) => `${a.format}:${a.anonymized ? 'anon' : 'id'}`);
for (const want of ['csv-full:anon', 'csv-curves:id', 'png:id']) if (!fmts.includes(want)) throw new Error(`稽核少了 ${want}：${fmts}`);
step(`稽核：${fmts.slice(-3).join('、')}`);

// 英文模式：DVH 面板的新字串都有譯文（匯出列、表頭、列的說明、徽章）
await send('Page.navigate', { url: url.replace('/#/', '/?lang=en#/') });
await waitFor(`document.querySelectorAll('.viewport-cell canvas').length >= 3 && !!document.querySelector('.dvh-toggle button')`, '英文模式載入');
if (!(await evaluate(`!!document.querySelector('.dvh-table')`))) await evaluate(`document.querySelector('.dvh-toggle button').click(); true`);
await waitFor(`document.querySelectorAll('.dvh-table tbody tr').length > 0 && !document.querySelector('.dvh-loading')`, '英文模式的 DVH 表格', 60000);
const enText = await evaluate(`[document.querySelector('.dvh-export-bar').innerText, document.querySelector('.dvh-export-bar label').title, ...[...document.querySelectorAll('.dvh-export-bar button')].map((b) => b.title), document.querySelector('.dvh-table thead').innerText, ...[...document.querySelectorAll('.dvh-table tbody tr')].map((r) => r.title + ' ' + (r.querySelector('.badge')?.textContent ?? ''))].join(' | ')`);
const cjk = enText.match(/[\u3000-\u9fff\uff00-\uffef]+/g);
if (cjk) throw new Error(`英文模式還有中文：${cjk.join(' ')} —— ${enText.slice(0, 300)}`);
step('英文模式：DVH 匯出列、表頭、列說明沒有中文');

if (errors.length) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
