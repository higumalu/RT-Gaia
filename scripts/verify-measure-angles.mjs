#!/usr/bin/env node
/**
 * 量測擴充 —— headless Chrome ＋ CDP 真的在軸向格上點（骨架同 `verify-layout-tree.mjs`、零相依）：
 *
 *   1. 開檢視器（要有病例）→ 開「量測」→ 工具列有角度／Cobb 角／曲線長度
 *   2. 角度：點三下（直角）→ 表格多一列「角度 N」≈ 90.0°
 *   3. Cobb 角：點四下（兩條各傾斜 ±atan(1/4) 的線）→ ≈ 28.1°
 *   4. 曲線：點三下再按 Enter → 長度 ＝ 兩段相加（px→mm 用畫面上的距離量測對照）
 *   5. 範本「RECIST」：開始 → 自動切到距離工具；拖兩次 → 兩列叫「長徑」「短徑」、顯示完成
 *   6. 重新整理 → 這些量測從後端回來、值不變
 *   7. 收尾：刪掉這次建的量測
 *
 * 需要一個開著病例的堆疊，例如：
 *   scripts/perf/stack.sh start && scripts/perf/stack.sh load
 *   node scripts/verify-measure-angles.mjs --url http://127.0.0.1:5183/#/viewer [--out-dir DIR] [--token <rtgaia_session>]
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
const LAYOUT_KEYS = ['rtgaia.layout.trees.v1', 'rtgaia.layout.overrides.v1'];
const remotePrefs = async () =>
  (await (await fetch(`${origin}/api/v1/auth/me/preferences`, { headers: { authorization: `Bearer ${token}` } })).json()).preferences;

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-measure10-'));
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
  await shot('measure10-failed.png').catch(() => undefined);
  throw new Error(`等不到：${what}`);
};
const step = (s) => console.log(`✓ ${s}`);
const mouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 });
const click = async (x, y) => {
  await mouse('mouseMoved', x, y);
  await mouse('mousePressed', x, y);
  await mouse('mouseReleased', x, y);
  await sleep(350); // 兩下之間隔開，不被當成雙擊
};
const drag = async (a, b) => {
  await mouse('mouseMoved', a.x, a.y);
  await mouse('mousePressed', a.x, a.y);
  for (let i = 1; i <= 8; i += 1) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x + ((b.x - a.x) * i) / 8, y: a.y + ((b.y - a.y) * i) / 8, button: 'left', buttons: 1 });
    await sleep(20);
  }
  await mouse('mouseReleased', b.x, b.y);
  await sleep(400);
};
const key = async (k) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: k === 'Enter' ? 13 : 0 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: k === 'Enter' ? 13 : 0 });
  await sleep(300);
};
const rows = () => evaluate(`[...document.querySelectorAll('.measure-panel .measure-table tr[data-measurement]')].map((r) => ({ id: r.dataset.measurement, label: r.children[1].textContent.trim(), value: r.children[2].textContent.trim() }))`);
const toolButton = (label) => `[...document.querySelectorAll('button')].find((b) => [...b.querySelectorAll('span')].some((s) => s.textContent.trim() === ${JSON.stringify(label)}))`;
const pickTool = async (label) => {
  await waitFor(`!!${toolButton(label)}`, `工具 ${label}`, 10000);
  await evaluate(`${toolButton(label)}.click(); true`);
  await sleep(200);
};
/** 按鈕（文字相同；量測開關後面可能帶筆數「量測 6」）。 */
const clickButton = (text) =>
  waitFor(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)} || x.textContent.trim().startsWith(${JSON.stringify(text + ' ')})); if (!b) return false; b.click(); return true; })()`, `按鈕 ${text}`, 10000);
const axialRect = () =>
  evaluate(`(() => { const cell = [...document.querySelectorAll('.viewport-cell')].find((c) => c.querySelector('.viewport-label')?.textContent.trim() === '軸向'); const r = cell.querySelector('canvas').getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`);
const newRows = async (before) => (await rows()).filter((r) => !before.some((b) => b.id === r.id));
const num = (v) => Number(v.replace(/[^\d.]/g, ''));

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { if (!localStorage.getItem('rtgaia.lang')) localStorage.setItem('rtgaia.lang', 'zh-TW'); localStorage.setItem('rtgaia.tour.v1', 'done'); localStorage.setItem('rtgaia.layout.current.v1', '2x2'); } catch {}" });
if (token) await send('Network.setCookie', { name: 'rtgaia_session', value: token, url: origin, httpOnly: true });
await send('Page.navigate', { url });
await waitFor(`document.querySelectorAll('.viewport-cell canvas').length >= 3 && [...document.querySelectorAll('button')].some((x) => /^量測( \\d+)?$/.test(x.textContent.trim()))`, '病例載入（要先開一個病例）');
await sleep(800);

// 1
for (let i = 0; i < 5 && !(await evaluate(`!!document.querySelector('.measure-panel')`)); i += 1) {
  await clickButton('量測');
  await sleep(1200);
}
for (const label of ['角度', 'Cobb 角', '曲線長度']) await waitFor(`!!${toolButton(label)}`, `工具列的 ${label}`, 10000);
const start = await rows();
step(`量測開著：工具列有角度、Cobb 角、曲線長度（既有量測 ${start.length} 筆）`);
const r = await axialRect();
const cx = r.left + r.width / 2;
const cy = r.top + r.height / 2;

// 2
await pickTool('角度');
await click(cx + 80, cy - 60);
await click(cx, cy - 60);
await click(cx, cy + 20);
let added = await newRows(start);
if (added.length !== 1 || !/角度 \d+$/.test(added[0].label) || Math.abs(num(added[0].value) - 90) > 0.6 || !added[0].value.endsWith('°')) throw new Error(`角度應 ≈ 90°：${JSON.stringify(added)}`);
step(`角度：${added[0].label} = ${added[0].value}`);
await shot('measure10-angle.png');

// 3
await pickTool('Cobb 角');
const before3 = await rows();
await click(cx - 150, cy + 60);
await click(cx - 70, cy + 80);
await click(cx - 150, cy + 150);
await click(cx - 70, cy + 130);
added = await newRows(before3);
const cobbExpect = (2 * Math.atan(20 / 80) * 180) / Math.PI;
if (added.length !== 1 || Math.abs(num(added[0].value) - cobbExpect) > 0.8) throw new Error(`Cobb 應 ≈ ${cobbExpect.toFixed(1)}°：${JSON.stringify(added)}`);
step(`Cobb 角：${added[0].label} = ${added[0].value}（預期 ${cobbExpect.toFixed(1)}°）`);

// 4：曲線 ＝ 30 px 右 ＋ 40 px 下（5 的倍數）＋ 再 40 px 右；用一條同樣 50 px 的距離量測當尺
await pickTool('距離');
const before4 = await rows();
await drag({ x: cx + 100, y: cy + 100 }, { x: cx + 130, y: cy + 140 });
const ruler = (await newRows(before4))[0];
await pickTool('曲線長度');
const before4b = await rows();
await click(cx + 100, cy - 150);
await click(cx + 130, cy - 110);
await click(cx + 170, cy - 110);
await key('Enter');
added = await newRows(before4b);
const unit = num(ruler.value) / 50; // mm／px
const curveExpect = 90 * unit;
if (added.length !== 1 || Math.abs(num(added[0].value) - curveExpect) > 0.02 * curveExpect + 0.2) throw new Error(`曲線應 ≈ ${curveExpect.toFixed(1)} mm：${JSON.stringify(added)}`);
step(`曲線：${added[0].label} = ${added[0].value}（尺 ${ruler.value}／50 px → 預期 ${curveExpect.toFixed(1)} mm）`);
await shot('measure10-shapes.png');

// 5
const before5 = await rows();
await evaluate(`(() => { const s = document.querySelector('.measure-templates select'); s.value = 'builtin:recist'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
await sleep(200);
await clickButton('開始');
await waitFor(`${toolButton('距離')}?.getAttribute('aria-pressed') === 'true' && !!document.querySelector('[data-template-step="0"]')`, '範本開始後切到距離工具、第 1 步', 5000);
await drag({ x: cx - 150, y: cy - 150 }, { x: cx - 60, y: cy - 150 });
await waitFor(`!!document.querySelector('[data-template-step="1"]')`, '範本第 2 步', 5000);
await drag({ x: cx + 20, y: cy + 60 }, { x: cx + 70, y: cy + 60 }); // 空白處（別從上一條線上起拖 —— 那是搬它）
await waitFor(`/範本「.*」量完了/.test(document.querySelector('.measure-templates').textContent)`, '範本完成', 5000);
const tpl = await newRows(before5);
if (tpl.length !== 2 || !tpl[0].label.endsWith('長徑') || !tpl[1].label.endsWith('短徑')) throw new Error(`範本命名不對：${JSON.stringify(tpl)}`);
step(`範本 RECIST：${tpl.map((x) => `${x.label} ${x.value}`).join('、')}；顯示完成`);
await shot('measure10-template.png');

// 6
const mine = await newRows(start);
await send('Page.reload');
await waitFor(`document.querySelectorAll('.viewport-cell canvas').length >= 3 && [...document.querySelectorAll('button')].some((x) => /^量測( \\d+)?$/.test(x.textContent.trim()))`, '重新整理後病例');
await sleep(800);
for (let i = 0; i < 5 && !(await evaluate(`!!document.querySelector('.measure-panel')`)); i += 1) {
  await clickButton('量測');
  await sleep(1200);
}
await waitFor(`document.querySelectorAll('.measure-panel .measure-table tr[data-measurement]').length >= ${start.length + mine.length}`, '量測從後端回來', 15000);
const back = await rows();
for (const m of mine) {
  const got = back.find((b) => b.id === m.id);
  if (!got || got.value !== m.value || got.label !== m.label) throw new Error(`重新整理後 ${m.label} 應還在且值不變：${JSON.stringify(got)} vs ${JSON.stringify(m)}`);
}
step(`重新整理後 ${mine.length} 筆量測從後端回來、值不變`);

// 7
for (const m of mine) {
  await evaluate(`document.querySelector('.measure-panel tr[data-measurement="${m.id}"] .measure-delete').click(); true`);
  await sleep(250);
}
if ((await rows()).length !== start.length) throw new Error('收尾刪除沒刪乾淨');
step('收尾：刪掉這次建的量測');

if (errors.length > 0) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
