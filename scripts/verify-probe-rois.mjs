#!/usr/bin/env node
/**
 * 左下角讀數列出所在 ROI —— headless Chrome ＋ CDP 真的移動滑鼠（與 `screenshot.mjs` 同一套骨架、零相依）：
 *
 *   1. 開檢視器（要有病例）→ 結構「全顯示」→ 在軸向格掃點、挑 ROI 最多的一點→ 狀態列「ROI」列出色塊＋名稱，BODY 這類大的排最後、最多 5 個
 *   2. 移到軸向格左上角（空氣）→ 沒有 ROI
 *   3. 回到中心、把清單第一個 ROI 在結構清單關掉 → 它從狀態列消失（只列顯示中的）
 *   4. 滑鼠離開影像格 → 座標 N/A、ROI 清空
 *
 * 需要一個開著病例的堆疊，例如：
 *   scripts/perf/stack.sh start && scripts/perf/stack.sh load
 *   node scripts/verify-probe-rois.mjs --url http://127.0.0.1:5183/#/viewer [--out-dir DIR]
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

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-probe-'));
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
  await shot('probe-failed.png').catch(() => undefined);
  throw new Error(`等不到：${what}`);
};
const move = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await sleep(400);
};
/** 狀態列目前的 ROI 名稱（依畫面順序）與座標欄。 */
const status = () =>
  evaluate(`({
    world: document.querySelector('.probe-world')?.textContent.trim() ?? '',
    rois: [...document.querySelectorAll('.probe-roi')].map((e) => e.textContent.trim()),
    swatches: [...document.querySelectorAll('.probe-roi-swatch')].map((e) => e.style.background),
    more: document.querySelector('.probe-roi-more')?.textContent.trim() ?? '',
  })`);
/** 軸向格（標籤「軸向」所在的那張 canvas）的矩形。 */
const axialRect = () =>
  evaluate(`(() => {
    const label = [...document.querySelectorAll('*')].find((e) => e.childElementCount === 0 && e.textContent.trim() === '軸向');
    const at = label.getBoundingClientRect();
    const c = [...document.querySelectorAll('canvas')].map((x) => x.getBoundingClientRect()).find((r) => r.width > 100 && at.left >= r.left - 2 && at.left <= r.right && at.top >= r.top - 2 && at.top <= r.bottom);
    return { left: c.left, top: c.top, width: c.width, height: c.height };
  })()`);
const step = (s) => console.log(`✓ ${s}`);

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { if (!localStorage.getItem('rtgaia.lang')) localStorage.setItem('rtgaia.lang', 'zh-TW'); localStorage.setItem('rtgaia.tour.v1', 'done') } catch {}" });
await send('Page.navigate', { url });
await waitFor(`/結構（[1-9]/.test(document.body.innerText) && [...document.querySelectorAll('*')].some((e) => e.childElementCount === 0 && e.textContent.trim() === '軸向')`, '病例載入（要先開一個病例）');
// 全顯示：讓中心點同時落在好幾個 ROI 裡（排序與「前 5 個」才驗得到）；等分批載入完
const showAll = `[...document.querySelectorAll('.structure-list button')].find((b) => b.textContent.trim() === '全顯示')`;
await waitFor(`!!${showAll}`, '初始的 mask 載入完', 120000);
await evaluate(`${showAll}.click(); true`);
await sleep(500);
await waitFor(`[...document.querySelectorAll('.structure-list button')].some((b) => b.textContent.trim() === '全顯示')`, '全顯示的 mask 載入完', 120000);
await sleep(1000);

const r = await axialRect();
// 在軸向格中央 60% 掃 9×9 個點，挑落在最多 ROI 裡的那一點（排序與「前 5 個＋N」才驗得到）
let best = null;
for (let a = 0; a < 9; a += 1) {
  for (let b = 0; b < 9; b += 1) {
    const x = r.left + r.width * (0.2 + (0.6 * a) / 8);
    const y = r.top + r.height * (0.2 + (0.6 * b) / 8);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await sleep(60);
    const st = await status();
    const n = st.rois.length + (st.more ? Number(st.more.replace(/\D/g, '')) : 0);
    if (best === null || n > best.n) best = { x, y, n };
  }
}
const cx = best.x;
const cy = best.y;
await move(cx, cy);
const inBody = await status();
if (inBody.rois.length === 0) throw new Error(`軸向格應該有點在某些 ROI 裡：${JSON.stringify(inBody)}`);
if (inBody.rois.length > 5) throw new Error(`最多列 5 個：${inBody.rois.length}`);
if (!inBody.swatches.every((b) => b.startsWith('rgb'))) throw new Error('每個 ROI 要有顏色');
const bodyIdx = inBody.rois.findIndex((n) => /^body/i.test(n));
if (bodyIdx >= 0 && bodyIdx !== inBody.rois.length - 1 && inBody.more === '') throw new Error(`BODY 應排最後（體積最大）：${inBody.rois.join('、')}`);
step(`軸向格 ROI 最多的一點（共 ${best.n} 個）：${inBody.world}｜ROI：${inBody.rois.join('、')}${inBody.more ? `（${inBody.more}）` : ''}`);
await shot('probe-center.png');

await move(r.left + 12, r.top + 40);
const inAir = await status();
if (inAir.rois.length !== 0) throw new Error(`空氣裡不該有 ROI：${inAir.rois.join('、')}`);
step(`軸向格左上（空氣）：${inAir.world}｜沒有 ROI`);

const first = inBody.rois[0];
await evaluate(`(() => {
  const row = [...document.querySelectorAll('li')].find((li) => li.querySelector('input[type=checkbox]') && li.textContent.trim().startsWith(${JSON.stringify(first)}));
  if (!row) throw new Error('結構清單找不到 ' + ${JSON.stringify(first)});
  row.querySelector('input[type=checkbox]').click();
  return true;
})()`);
await move(cx + 1, cy);
const afterHide = await status();
if (afterHide.rois.includes(first)) throw new Error(`關掉的 ${first} 不該再列：${afterHide.rois.join('、')}`);
step(`關掉 ${first} 後：${afterHide.rois.join('、') || '（無）'}`);
await shot('probe-hidden.png');

await move(r.left + r.width / 2, 20); // 工具列
const outside = await status();
if (outside.rois.length !== 0 || !outside.world.includes('N/A')) throw new Error(`離開影像格應 N/A 且清空：${JSON.stringify(outside)}`);
step('滑鼠離開影像格：N/A、ROI 清空');

if (errors.length > 0) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
