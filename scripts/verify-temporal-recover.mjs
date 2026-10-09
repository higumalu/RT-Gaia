#!/usr/bin/env node
/**
 * 4D 跟同一組的其他影像 —— headless Chrome ＋ CDP（骨架同 `verify-temporal-playback.mjs`、零相依）。
 *
 *   SYN4D-CT1（4D 組 ＋ AVG／MIP／MinIP 同一個 FoR）：
 *   1. 開啟 → 10 個相位都到全解析度；左欄 4 列影像各自標出名稱（第一列「4D · …」），以前都只寫「影像」
 *   2. 「只看」→ 4 張都可見 → 超過全解析度上限（headless 是 Tier C、上限 3）→ 逐出的是最早的靜態影像、
 *      4D 留著 10／10（以前 4D 第一個被逐出）；這 5 秒內 lod 0 的請求不超過 3 個（不會互相逐出、一直重抓）
 *   3. 把 AVG／MIP／MinIP 關掉 → 4D 的 10 個相位在 30 秒內補回全解析度（以前一直停在「高清 0／10」，播放永遠糊）
 *   4. 「設定」裡的不透明度打 35 → 上面那條滑桿跟著變 0.35
 *
 *   scripts/perf/stack.sh start
 *   node scripts/verify-temporal-recover.mjs --url http://127.0.0.1:5183/#/library [--out-dir DIR] [--token <rtgaia_session>]
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
const port = Number(args.port ?? 9339);
const chrome = args.chrome ?? process.env.CHROME ?? 'google-chrome';
const token = args.token ?? process.env.TOKEN ?? null;
const origin = new URL(url).origin;

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-recover-'));
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
  await shot('recover-failed.png').catch(() => undefined);
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


const FULL = `document.querySelectorAll('.time-group .time-resident i.is-full').length`;
let lod0Requests = 0;
const countLod0 = (msg) => {
  if (msg.method === 'Network.requestWillBeSent' && /\/image\?.*lod=0/.test(msg.params.request.url)) lod0Requests += 1;
};
const prevOnMessage = ws.onmessage;
ws.onmessage = (event) => {
  prevOnMessage(event);
  countLod0(JSON.parse(String(event.data)));
};
await send('Network.enable');

const rows = `[...document.querySelectorAll('.frame-group .image-row')]`;
const fullCount = () => evaluate(`${FULL}`);
await openStudy('SYN4D-CT1', 'synth4d');
await waitFor(`!!${rowWith('temporal', '4D · 10 個相位')}`, 'SYN4D-CT1 的 4D 組');
await evaluate(`${rowWith('temporal', '4D · 10 個相位')}.querySelector('input[type=checkbox]').click(); true`);
await openCase(true);
await waitFor(`${FULL} === 10`, '10 個相位都到全解析度', 120000);
const names = await evaluate(`${rows}.map((r) => r.querySelector('.image-row-name')?.textContent.trim() ?? null)`);
if (names.length !== 4 || names.some((n) => !n) || new Set(names).size !== 4 || !names[0].startsWith('4D · ')) throw new Error(`影像列名稱：${JSON.stringify(names)}`);
step(`開啟：10 個相位都是全解析度；左欄影像列 ${names.join('／')}`);

const tier = await evaluate(`(document.body.innerText.match(/Tier\\s*([ABC])/) ?? [])[1] ?? '?'`);
lod0Requests = 0;
await evaluate(`document.querySelector('.frame-group .solo').click(); true`);
await sleep(5000);
const afterSolo = await fullCount();
const visibleNow = await evaluate(`${rows}.filter((r) => r.dataset.visible === 'true').length`);
if (visibleNow !== 4) throw new Error(`「只看」之後可見 ${visibleNow} 張`);
// 看得見的 4D 最後才逐出 → 逐出的是最早的靜態影像，4D 留著全解析度（以前 4D 第一個被逐出）
if (tier === 'C' && afterSolo !== 10) throw new Error(`Tier C 上限 3、4 張可見，4D 應該留著全解析度（${afterSolo}／10）`);
if (lod0Requests > 3) throw new Error(`「只看」之後 5 秒內抓了 ${lod0Requests} 次 lod 0（互相逐出、一直重抓？）`);
step(`「只看」→ 4 張可見（Tier ${tier}）：4D 全解析度 ${afterSolo}／10、5 秒內 lod 0 請求 ${lod0Requests} 次`);
await shot('recover-solo.png');

for (let i = 1; i < 4; i += 1) await evaluate(`${rows}[${i}].querySelector('.visibility input').click(); true`);
const t0 = Date.now();
await waitFor(`${FULL} === 10`, '關掉 AVG／MIP／MinIP 後 4D 補回全解析度', 30000);
const hint = await evaluate(`document.querySelector('.time-group .time-text').textContent.trim()`);
if (hint.includes('高清')) throw new Error(`補回來了還顯示：${hint}`);
step(`關掉其他三張 → ${((Date.now() - t0) / 1000).toFixed(1)} s 內 4D 的 10 個相位補回全解析度`);

// 不透明度：「設定」裡打數字（React 受控元件 → 用原生 setter ＋ input 事件）
const opacityRow = `${rows}[0]`;
await evaluate(`(() => { const r = ${opacityRow}; if (!r.querySelector('.opacity-setting')) r.querySelector('.row-more').click(); return true; })()`);
await waitFor(`!!${opacityRow}.querySelector('.opacity-setting input.num')`, '設定裡有不透明度數字欄');
await evaluate(`(() => { const el = ${opacityRow}.querySelector('.opacity-setting input.num'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, '35'); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
await waitFor(`${opacityRow}.querySelector('label.opacity input[type=range]').value === '0.35'`, '上面的滑桿跟著變 0.35', 5000);
step('設定裡不透明度打 35 → 滑桿 0.35');

if (errors.length > 0) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
