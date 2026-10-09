#!/usr/bin/env node
/**
 * 介面的畫面修正（字型、選單鍵盤操作、資料庫列）—— headless Chrome ＋ CDP（骨架同 `verify-mask-fill.mjs`、零相依），真的鍵盤事件：
 *
 *   預設（緊湊）密度的介面字型是 system-ui（以前是瀏覽器預設 Times New Roman）；切到舒適也不換字型
 *   品牌選單：End 到最後一個語言項目（menuitemradio）、↓ 循環回第一項、Esc 焦點回按鈕；
 *       說明選單：開啟聚焦第一項、↓ 到第二項、Esc 回按鈕
 *   資料庫頁：study 列維持表格列（display: table-row，以前被遠端查詢的 `.study-row { display:flex }` 蓋掉）
 *
 * 需要一個開著病例的堆疊，例如：
 *   scripts/perf/stack.sh start && scripts/perf/stack.sh load
 *   node scripts/verify-review-ui-fixes.mjs --url http://127.0.0.1:5183/#/viewer [--out-dir DIR] [--token <rtgaia_session>]
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
const url = args.url ?? 'http://127.0.0.1:5183/#/viewer';
const outDir = args['out-dir'] ?? null;
const port = Number(args.port ?? 9337);
const chrome = args.chrome ?? process.env.CHROME ?? 'google-chrome';
const token = args.token ?? process.env.TOKEN ?? null;
const origin = new URL(url).origin;

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-uifix-'));
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
  await shot('uifix-failed.png').catch(() => undefined);
  throw new Error(`等不到：${what}`);
};
const step = (s) => console.log(`✓ ${s}`);
const key = async (k) => {
  const vk = { Escape: 27, End: 35, Home: 36, ArrowUp: 38, ArrowDown: 40 }[k];
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: vk });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: vk });
  await sleep(150);
};
const focused = () => evaluate(`(() => { const a = document.activeElement; return a ? { role: a.getAttribute('role'), cls: a.className, text: a.textContent.trim().slice(0, 30) } : null; })()`);
const click = async (selector) => {
  const box = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await sleep(250);
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { if (!localStorage.getItem('rtgaia.lang')) localStorage.setItem('rtgaia.lang', 'zh-TW'); localStorage.setItem('rtgaia.tour.v1', 'done'); localStorage.removeItem('rtgaia.density.v1'); } catch {}" });
if (token) await send('Network.setCookie', { name: 'rtgaia_session', value: token, url: origin, httpOnly: true });
await send('Page.navigate', { url });
await waitFor(`document.querySelectorAll('.viewport-cell canvas').length >= 3 && !!document.querySelector('.brand-button')`, '檢視器載入（要先開一個病例）');
await sleep(1000);

// 介面字型
const font = await evaluate(`({ density: document.documentElement.dataset.density ?? '(預設)', body: getComputedStyle(document.body).fontFamily, button: getComputedStyle(document.querySelector('.brand-button')).fontFamily })`);
if (/times/i.test(font.body) || !/system-ui/.test(font.body)) throw new Error(`預設密度的字型應是 system-ui：${font.body}`);
if (font.button !== font.body) throw new Error(`按鈕字型應繼承：${font.button} vs ${font.body}`);
await evaluate(`document.documentElement.dataset.density = 'comfortable'; true`);
const comfy = await evaluate(`getComputedStyle(document.body).fontFamily`);
await evaluate(`delete document.documentElement.dataset.density; true`);
if (comfy !== font.body) throw new Error(`切到舒適不該換字型：${comfy} vs ${font.body}`);
step(`字型（${font.density}）：${font.body.split(',')[0]}；舒適模式同一個`);

// 品牌選單
await click('.brand-button');
await waitFor(`!!document.querySelector('.brand-dropdown')`, '品牌選單開啟', 3000);
await key('End');
const end = await focused();
if (end?.role !== 'menuitemradio') throw new Error(`End 應到最後一個語言項目（menuitemradio）：${JSON.stringify(end)}`);
await key('ArrowDown');
const wrap = await focused();
if (wrap?.role !== 'menuitem') throw new Error(`最後一項再 ↓ 應循環到第一項：${JSON.stringify(wrap)}`);
await key('ArrowUp');
if ((await focused())?.role !== 'menuitemradio') throw new Error('第一項 ↑ 應回到最後一個語言項目');
await key('Escape');
const back = await focused();
if (!String(back?.cls).includes('brand-button') || (await evaluate(`!!document.querySelector('.brand-dropdown')`))) throw new Error(`Esc 應關閉並回到品牌按鈕：${JSON.stringify(back)}`);
step(`品牌選單：End → ${end.text}（語言）、↓ 循環回「${wrap.text}」、Esc 回按鈕`);

// 說明選單
await click('.help-toggle');
await waitFor(`!!document.querySelector('.help-dropdown')`, '說明選單開啟', 3000);
const first = await focused();
if (first?.role !== 'menuitem') throw new Error(`說明選單開啟應聚焦第一項：${JSON.stringify(first)}`);
await key('ArrowDown');
const second = await focused();
if (second?.role !== 'menuitem' || second.text === first.text) throw new Error(`↓ 應到第二項：${JSON.stringify(second)}`);
await key('Escape');
if (!String((await focused())?.cls).includes('help-toggle')) throw new Error('說明選單 Esc 應回到按鈕');
step(`說明選單：開啟聚焦「${first.text}」、↓ 到「${second.text}」、Esc 回按鈕`);

// 資料庫頁
await send('Page.navigate', { url: `${origin}/#/library` });
await waitFor(`document.querySelectorAll('.catalog-tree tr.patient-row').length > 0`, '資料庫頁的病人列', 30000);
await evaluate(`document.querySelector('.catalog-tree tr.patient-row').click(); true`);
await waitFor(`document.querySelectorAll('.catalog-tree tr.study-row').length > 0`, '展開後的 study 列', 15000);
const rows = await evaluate(`[...document.querySelectorAll('.catalog-tree tr.study-row')].map((r) => getComputedStyle(r).display)`);
await shot('uifix-library.png');
if (!rows.every((d) => d === 'table-row')) throw new Error(`study 列應是 table-row：${rows.join(',')}`);
step(`資料庫頁 ${rows.length} 個 study 列都是 table-row`);

if (errors.length > 0) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
