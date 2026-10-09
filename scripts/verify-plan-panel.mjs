#!/usr/bin/env node
/**
 * 計畫與射束（只看）—— headless Chrome ＋ CDP（骨架同 `verify-ui-polish.mjs`、零相依），真的滑鼠事件：
 *
 *   工具列出現「計畫」（病例有 RTPLAN）；2D 格上畫出金色 ISO 標記
 *   計畫面板：計畫名稱與治療機（跟 API 一致）、HFS、20 Gy · 10 次、射束表（治療在前、setup 在後；弧的機架起止與方向、MU、CP）
 *   兩個 ISO 各自「到 ISO」→ 三格切片 ＝ ISO 的 primary 座標換算到顯示網格的索引
 *   「影像上顯示 ISO」關掉 → 金色標記消失；打開 → 回來
 *   英文模式沒有中文
 *
 * 需要一個開著量測病例（`.rtgaia/perf/case.json`，要有 RTPLAN；射束表的預期值是開發時用的那個病例）的堆疊：
 *   scripts/perf/stack.sh start && scripts/perf/stack.sh load
 *   node scripts/verify-plan-panel.mjs --url http://127.0.0.1:5183/#/viewer [--out-dir DIR]
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
const port = Number(args.port ?? 9345);
const chrome = args.chrome ?? process.env.CHROME ?? 'google-chrome';
const token = args.token ?? process.env.TOKEN ?? null;
const origin = new URL(url).origin;

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-plan23a-'));
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
  await shot('plan23a-failed.png').catch(() => undefined);
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
await send('Page.navigate', { url });
await waitFor(`document.querySelectorAll('.viewport-cell canvas').length >= 3 && !!document.querySelector('.plan-toggle button')`, '病例載入（要有 RTPLAN → 工具列「計畫」）');
await waitFor(`!document.querySelector('.mask-loading')`, '載入完', 60000);
await sleep(1200);

const GOLD = [244, 197, 66];
const goldIn = (label) => evaluate(`(() => { const host = ${cellSel(label)}.querySelector('.viewport-canvas-host'); let n = 0; for (const c of host.querySelectorAll('canvas')) { const ctx = c.getContext('2d'); if (!ctx) continue; const d = ctx.getImageData(0, 0, c.width, c.height).data; for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - ${GOLD[0]}) < 16 && Math.abs(d[i + 1] - ${GOLD[1]}) < 16 && Math.abs(d[i + 2] - ${GOLD[2]}) < 16 && d[i + 3] > 120) n += 1; } return n; })()`);
const slices = () => evaluate(`Object.fromEntries([...document.querySelectorAll('.viewport-cell')].map((c) => [c.querySelector('.viewport-label')?.textContent.trim(), c.querySelector('.viewport-slice')?.textContent.trim()]))`);

// 1. ISO 標記在 2D 格
const g0 = { 軸向: await goldIn('軸向'), 冠狀: await goldIn('冠狀'), 矢狀: await goldIn('矢狀') };
if (Object.values(g0).some((n) => n < 20)) throw new Error(`每個 2D 格都應畫出金色 ISO：${JSON.stringify(g0)}`);
step(`ISO 標記：金色像素 ${JSON.stringify(g0)}`);

// 2. 計畫面板
await evaluate(`document.querySelector('.plan-toggle button').click(); true`);
await waitFor(`!!document.querySelector('.plan-panel .plan-beams tbody tr')`, '計畫面板的射束表', 20000);
const summary = await evaluate(`document.querySelector('.plan-panel .plan-summary').innerText`);
const plan0 = await evaluate(`fetch('/api/v1/sessions/current').then((r) => r.json()).then((s) => fetch('/api/v1/studies/' + encodeURIComponent(s.studyId) + '/plans')).then((r) => r.json()).then((d) => d.plans[0])`);
const machine0 = plan0.machines[0] ? [plan0.machines[0].name, [plan0.machines[0].manufacturer, plan0.machines[0].model].filter(Boolean).join(' ')].filter(Boolean).join(' · ') : '';
for (const want of [plan0.label, machine0, 'HFS', '20 Gy', '10 次', 'MU']) if (!summary.includes(want)) throw new Error(`計畫摘要少了「${want}」：${summary}`);
const rows = await evaluate(`[...document.querySelectorAll('.plan-panel .plan-beams tbody tr')].map((r) => [...r.cells].map((c) => c.textContent.trim()))`);
const numbers = rows.map((r) => r[0]);
if (numbers.join() !== '2,3,4,5,6,1') throw new Error(`射束順序應治療在前、setup 在後：${numbers}`);
if (rows[0][2] !== '弧' || rows[0][3] !== '179 → 180.1 CC' || rows[0][7] !== '182.6' || rows[0][8] !== '180' || rows[1][3] !== '180.1 → 179 CW') throw new Error(`第一、二個射束不對：${JSON.stringify(rows.slice(0, 2))}`);
if (rows[5][2] !== '設定' || rows[5][7] !== '–') throw new Error(`setup 射野應標「設定」、沒有 MU：${JSON.stringify(rows[5])}`);
const isoRows = await evaluate(`[...document.querySelectorAll('.plan-panel .plan-iso-row')].map((r) => r.innerText.replace(/\\s+/g, ' '))`);
if (isoRows.length !== 2) throw new Error(`這個計畫有兩個等中心：${JSON.stringify(isoRows)}`);
await shot('plan23a-panel.png');
step(`計畫面板：${summary.replace(/\s+/g, ' ').slice(0, 90)}…；射束 ${numbers.join(',')}；ISO ${isoRows.length} 個`);

// 3. 到 ISO（兩個）
const sid = await evaluate(`fetch('/api/v1/sessions/current').then((r) => r.json()).then((s) => s.studyId)`);
const plans = await evaluate(`fetch('/api/v1/studies/' + encodeURIComponent(${JSON.stringify(sid)}) + '/plans').then((r) => r.json())`);
const g = await evaluate(`fetch('/api/v1/sessions/current').then((r) => r.json()).then((s) => s.gridSet.display_grid.grid)`);
for (let i = 0; i < 2; i += 1) {
  const iso = plans.plans[0].isocenters[i].position_primary_mm;
  const idx = [0, 1, 2].map((a) => Math.round((iso[a] - g.origin[a]) / g.spacing[a]));
  const want = { 軸向: idx[2] + 1, 矢狀: idx[0] + 1, 冠狀: idx[1] + 1 };
  await evaluate(`[...document.querySelectorAll('.plan-panel .plan-iso-row')][${i}].querySelector('button').click(); true`);
  await sleep(1200);
  const got = await slices();
  const off = Object.entries(want).filter(([k, v]) => Math.abs(Number(String(got[k]).split('/')[0]) - v) > 1);
  if (off.length) throw new Error(`到 ISO${i + 1} 後切片應是 ${JSON.stringify(want)}：${JSON.stringify(got)}`);
  step(`到 ISO${i + 1}（${iso.map((v) => v.toFixed(1)).join(', ')}）：切片 ${JSON.stringify(got)}`);
}
await shot('plan23a-iso.png');

// 4. 關掉 ISO 顯示 → 消失；打開 → 回來
const isoBox = `[...document.querySelectorAll('.plan-panel .plan-iso label')].find((l) => l.querySelector('input[type=checkbox]')).querySelector('input')`;
// 結構與等劑量線也可能有接近金色的像素 —— 比較開／關的差，不看絕對值
const cellsAll = ['軸向', '冠狀', '矢狀'];
await evaluate(`${isoBox}.click(); true`);
await sleep(600);
const gOff = Object.fromEntries(await Promise.all(cellsAll.map(async (c) => [c, await goldIn(c)])));
await evaluate(`${isoBox}.click(); true`);
await sleep(600);
const gOn = Object.fromEntries(await Promise.all(cellsAll.map(async (c) => [c, await goldIn(c)])));
const weak = cellsAll.filter((c) => gOn[c] - gOff[c] < 30);
if (weak.length) throw new Error(`ISO 顯示開關：關 ${JSON.stringify(gOff)}、開 ${JSON.stringify(gOn)}（${weak} 差不到 30）`);
step(`ISO 顯示開關：關 ${JSON.stringify(gOff)} → 開 ${JSON.stringify(gOn)}`);

// 5. 英文模式
await send('Page.navigate', { url: url.replace('/#/', '/?lang=en#/') });
await waitFor(`document.querySelectorAll('.viewport-cell canvas').length >= 3 && !!document.querySelector('.plan-toggle button')`, '英文模式載入');
if (!(await evaluate(`!!document.querySelector('.plan-panel')`))) await evaluate(`document.querySelector('.plan-toggle button').click(); true`);
await waitFor(`!!document.querySelector('.plan-panel .plan-beams tbody tr')`, '英文模式的計畫面板', 20000);
const enText = await evaluate(`[document.querySelector('.plan-toggle').innerText, document.querySelector('.plan-toggle button').title, document.querySelector('.plan-panel').innerText, ...[...document.querySelectorAll('.plan-panel [title]')].map((e) => e.title)].join(' | ')`);
const cjk = enText.match(/[　-鿿＀-￯]+/g);
if (cjk) throw new Error(`英文模式還有中文：${cjk.join(' ')}`);
step('英文模式：計畫按鈕與面板沒有中文');

if (errors.length) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
