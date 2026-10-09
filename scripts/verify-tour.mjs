#!/usr/bin/env node
/**
 * 導覽的焦點與鍵盤、任務引導 —— headless Chrome ＋ CDP（骨架同 `verify-temporal-compose.mjs`）。
 *
 *   1. 資料頁「怎麼開病例？」→ 任務引導第 1 步、焦點在「下一步」；按一次 Enter → 只前進一步（以前全域攔 Enter ＋ 按鈕本身 → 一次跳兩步）；
 *      Tab 繞三次焦點都還在說明卡裡；→ 到最後一步；Enter → 完成、焦點回到「怎麼開病例？」
 *   2. 檢視器說明選單「任務：畫一個結構」→ 4 步（選結構、ROI 編輯、畫一筆、確認存好了）；Esc → 關掉
 *
 *   scripts/perf/stack.sh start
 *   node scripts/verify-tour.mjs --url http://127.0.0.1:5183/#/library
 * 退出碼：任一步失敗 → 1。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? 'true' : arr[i + 1]]);
    return acc;
  }, []),
);
const url = args.url ?? 'http://127.0.0.1:5183/#/library';
const outDir = args['out-dir'] ?? null;
const port = Number(args.port ?? 9350);
const chrome = args.chrome ?? process.env.CHROME ?? 'google-chrome';
const token = args.token ?? process.env.TOKEN ?? null;
const origin = new URL(url).origin;

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-tour-'));
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
  await shot('tour-failed.png').catch(() => undefined);
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
const initScript = await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { if (!localStorage.getItem('rtgaia.lang')) localStorage.setItem('rtgaia.lang', 'zh-TW'); localStorage.setItem('rtgaia.tour.v1', 'done'); localStorage.setItem('rtgaia.layout.current.v1', '2x2'); localStorage.removeItem('rtgaia.dock.v1'); localStorage.removeItem('rtgaia.layout.trees.v1'); } catch {}" });
if (token) await send('Network.setCookie', { name: 'rtgaia_session', value: token, url: origin, httpOnly: true });

const rowWith = (kind, text) => `[...document.querySelectorAll('.catalog-tree tr[data-kind="${kind}"]')].find((r) => r.textContent.includes(${JSON.stringify(text)}))`;
const rowsWith = (kind, text) => `[...document.querySelectorAll('.catalog-tree tr[data-kind="${kind}"]')].filter((r) => r.textContent.includes(${JSON.stringify(text)}))`;
/** 資料頁：清空選取 → 展開病人 → 展開第一個描述含 `study` 的 study。 */
const openStudy = async (patientId, study, { reload = true } = {}) => {
  if (reload) await send('Page.navigate', { url: `${origin}/#/library` });
  else await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '資料庫…').click(); true`);
  await waitFor(`!!${rowWith('patient', patientId)}`, `資料頁有 ${patientId}`, 60000);
  await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '清空')?.click(); true`);
  await evaluate(`${rowWith('patient', patientId)}.click(); true`);
  await waitFor(`!!${rowWith('study', study)}`, `${patientId} 的 study「${study}」`);
  await evaluate(`${rowWith('study', study)}.click(); true`);
  await waitFor(`!!document.querySelector('.catalog-tree tr[data-kind="image"], .catalog-tree tr[data-kind="temporal"]')`, `${study} 的影像`);
  await sleep(500);
};
const summary = () => evaluate(`document.querySelector('.selection-summary')?.textContent.trim() ?? ''`);
const openCase = async (needTime = false) => {
  // 勾影像要先抓它的 RT 列才進選取（懶載入）→ 等摘要有主要影像再按開啟
  await waitFor(`document.querySelector('.selection-summary')?.textContent.includes('主要影像')`, '選取有主要影像', 20000);
  await evaluate(`[...document.querySelectorAll('button.primary')].find((b) => b.textContent.trim() === '開啟').click(); true`);
  await waitFor(`location.hash.includes('viewer') && document.querySelectorAll('.viewport-cell canvas').length >= 3${needTime ? " && !!document.querySelector('.time-group')" : ''}`, '病例開起來', 180000);
  await waitFor(`!document.querySelector('.mask-loading')`, '結構載入完', 120000);
  await sleep(1500);
};
const pageText = () => evaluate(`document.body.innerText`);
const structureCount = () => evaluate(`document.querySelectorAll('.structure-list li').length`);
/** 資料面板的「▸ 結構（…）」收合時清單不渲染 → 展開。 */
const expandStructures = () => evaluate(`(() => { const h = [...document.querySelectorAll('button, summary, span, div')].find((e) => e.children.length === 0 && /^▸ 結構（/.test(e.textContent.trim())); h?.click(); return !!h; })()`);


const rows = `[...document.querySelectorAll('.frame-group .image-row')]`;
const caseId = () => evaluate(`fetch('/api/v1/sessions/current').then((r) => r.json()).then((s) => s.caseId)`);
const studyId = () => evaluate(`fetch('/api/v1/sessions/current').then((r) => r.json()).then((s) => s.studyId)`);
/** 某一格 canvas 的指紋（取樣像素和）—— 比較兩張畫面是不是同一張。 */
const canvasSum = (label) => evaluate(`(() => { const c = ${cellSel(label)}?.querySelector('canvas'); const x = c?.getContext('2d'); if (!x) return -1; const d = x.getImageData(0, 0, c.width, c.height).data; let s = 0; for (let i = 0; i < d.length; i += 16) s += d[i]; return s; })()`);
const timeText = () => evaluate(`document.querySelector('.time-group .time-text')?.textContent.trim() ?? null`);
const clickButton = (scope, text) => evaluate(`(() => { const b = [...(${scope}).querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true; })()`);


const key = async (k, code = k, extra = {}) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: { Enter: 13, Tab: 9, Escape: 27, ArrowRight: 39 }[k] ?? 0, ...(k === 'Enter' ? { text: '\r' } : {}), ...extra });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: { Enter: 13, Tab: 9, Escape: 27, ArrowRight: 39 }[k] ?? 0, ...extra });
  await sleep(250);
};
const stepId = () => evaluate(`document.querySelector('.tour-overlay')?.dataset.step ?? null`);
const focusInCard = () => evaluate(`!!document.activeElement?.closest('.tour-card')`);

// 1
await send('Page.navigate', { url: `${origin}/#/library` });
await waitFor(`!!document.querySelector('.library-guide')`, '資料頁的「怎麼開病例？」', 60000);
await waitFor(`!!document.querySelector('.catalog-tree')`, '病人清單', 60000);
await evaluate(`document.querySelector('.library-guide').focus(); document.querySelector('.library-guide').click(); true`);
await waitFor(`!!document.querySelector('.tour-overlay')`, '任務引導');
if ((await stepId()) !== 'open-pick') throw new Error(`第 1 步：${await stepId()}`);
if (!(await evaluate(`document.activeElement?.classList.contains('primary') && !!document.activeElement.closest('.tour-card')`))) throw new Error('打開時焦點應該在「下一步」');
await key('Enter');
if ((await stepId()) !== 'open-check') throw new Error(`Enter 一次應該只前進一步：${await stepId()}`);
for (let i = 0; i < 3; i += 1) {
  await key('Tab');
  if (!(await focusInCard())) throw new Error(`Tab 第 ${i + 1} 次焦點跑出說明卡`);
}
await key('ArrowRight');
if ((await stepId()) !== 'open-go') throw new Error(`→ 之後：${await stepId()}`);
await evaluate(`document.querySelector('.tour-card .primary').focus(); true`);
const lastLabel = await evaluate(`document.querySelector('.tour-card .primary').textContent`);
await key('Enter');
await waitFor(`!document.querySelector('.tour-overlay')`, '最後一步 Enter → 完成', 3000);
if (!(await evaluate(`document.activeElement?.classList.contains('library-guide')`))) throw new Error(`焦點應該回到「怎麼開病例？」：${await evaluate(`document.activeElement?.outerHTML.slice(0, 80)`)}`);
step(`資料頁任務引導：焦點在「下一步」、Enter 只前進一步、Tab 不跑出說明卡、最後一步「${lastLabel}」按 Enter 完成、焦點回到原處`);

// 2
await openStudy('SYN4D-CT1', 'synth4d');
await waitFor(`!!${rowWith('temporal', '4D · 10 個相位')}`, 'SYN4D-CT1 的 4D 組');
await evaluate(`${rowWith('temporal', '4D · 10 個相位')}.querySelector('input[type=checkbox]').click(); true`);
await openCase(true);
await evaluate(`document.querySelector('.help-toggle').click(); true`);
await waitFor(`!!document.querySelector('.help-dropdown')`, '說明選單');
await clickButton(`document.querySelector('.help-dropdown')`, '任務：畫一個結構');
await waitFor(`!!document.querySelector('.tour-overlay')`, '畫結構的任務引導');
const total = await evaluate(`document.querySelector('.tour-progress').textContent`);
if (!/／4/.test(total) || (await stepId()) !== 'draw-pick') throw new Error(`任務引導：${total} ${await stepId()}`);
await shot('tour-draw.png');
await key('Escape');
await waitFor(`!document.querySelector('.tour-overlay')`, 'Esc 關掉', 3000);
step(`檢視器「任務：畫一個結構」：${total.trim()}，Esc 關掉`);

if (errors.length > 0) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
