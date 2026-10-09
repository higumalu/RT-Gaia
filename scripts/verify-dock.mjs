#!/usr/bin/env node
/**
 * 側欄面板 dock —— headless Chrome ＋ CDP 真的拖 dock 列（骨架同 `verify-layout-tree.mjs`、零相依）：
 *
 *   1. 開檢視器（要有病例）→ 打開 MPR、DVH → 左欄「資料」、右欄 MPR、DVH 都有 dock 列
 *   2. 拖 DVH 的 dock 列到 MPR 上半 → 右欄順序變 DVH、MPR；存進 `rtgaia.dock.v1`
 *   3. 拖 MPR 到左欄「資料」上半 → 左欄 MPR、資料
 *   4. 摺起「資料」→ 內容隱藏但沒卸載（DOM 還在）
 *   5. 拖 DVH 到左欄 → 右欄空了；再拖一次時右側出現放置區 → 拖回右欄
 *   6. 拖曳中按 Esc → 取消、不動
 *   7. 重新整理 → 擺法還在
 *   8. 選單「所有面板回預設位置」→ 回到預設
 *
 * 需要一個開著病例的堆疊，例如：
 *   scripts/perf/stack.sh start && scripts/perf/stack.sh load
 *   node scripts/verify-dock.mjs --url http://127.0.0.1:5183/#/viewer [--out-dir DIR] [--token <rtgaia_session>]
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
const LAYOUT_KEYS = ['rtgaia.dock.v1'];
if (token) {
  const r = await fetch(`${origin}/api/v1/auth/me/preferences`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...Object.fromEntries(LAYOUT_KEYS.map((k) => [k, null])) }),
  });
  if (!r.ok) throw new Error(`清帳號偏好失敗：HTTP ${r.status}`);
}
const remotePrefs = async () =>
  (await (await fetch(`${origin}/api/v1/auth/me/preferences`, { headers: { authorization: `Bearer ${token}` } })).json()).preferences;

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-dock-'));
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
  await shot('dock-failed.png').catch(() => undefined);
  throw new Error(`等不到：${what}`);
};
const step = (s) => console.log(`✓ ${s}`);
const column = (side) => evaluate(`[...document.querySelectorAll('[data-dock-item][data-dock-side="${side}"]')].map((e) => e.dataset.dockItem)`);
const barCenter = (id) => evaluate(`(() => { const r = document.querySelector('[data-dock-item="${id}"] .dock-title').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
const itemBox = (id) => evaluate(`(() => { const r = document.querySelector('[data-dock-item="${id}"]').getBoundingClientRect(); return { x: r.left + r.width / 2, top: r.top, bottom: r.bottom }; })()`);
const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, ...extra });
/** 按住 id 的 dock 列、分幾步移到 (x, y)、放開（`cancel` → 放開前按 Esc）。 */
const dragTo = async (id, to, { cancel = false } = {}) => {
  const from = await barCenter(id);
  await mouse('mouseMoved', from.x, from.y, { buttons: 0 });
  await mouse('mousePressed', from.x, from.y, { clickCount: 1 });
  for (let i = 1; i <= 10; i += 1) {
    await mouse('mouseMoved', from.x + ((to.x - from.x) * i) / 10, from.y + ((to.y - from.y) * i) / 10);
    await sleep(30);
  }
  await sleep(150);
  if (cancel) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(100);
  }
  await mouse('mouseReleased', to.x, to.y, { clickCount: 1 });
  await sleep(400);
};
/** 工具列按鈕（病例載入中工具列會重畫：等到按得到為止）。 */
const clickButton = (text) =>
  waitFor(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true; })()`, `按鈕 ${text}`, 10000);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: "try { if (!localStorage.getItem('rtgaia.lang')) localStorage.setItem('rtgaia.lang', 'zh-TW'); localStorage.setItem('rtgaia.tour.v1', 'done'); if (!sessionStorage.getItem('dock-verify')) { sessionStorage.setItem('dock-verify', '1'); localStorage.removeItem('rtgaia.dock.v1'); } } catch {}",
});
if (token) await send('Network.setCookie', { name: 'rtgaia_session', value: token, url: origin, httpOnly: true });
await send('Page.navigate', { url });
await waitFor(`document.querySelectorAll('.viewport-cell canvas').length >= 3 && !!document.querySelector('[data-dock-item="core.data"]')`, '病例載入、左欄資料面板（要先開一個病例）');
await sleep(500);

// 1
for (const b of ['MPR', 'DVH']) await clickButton(b);
await waitFor(`document.querySelectorAll('[data-dock-side="right"]').length >= 2`, '右欄出現 MPR、DVH');
const right0 = await column('right');
const left0 = await column('left');
if (right0.length !== 2 || !same(left0, ['core.data'])) throw new Error(`預設擺法不對：左 ${left0} 右 ${right0}`);
const [mprId, dvhId] = right0;
step(`預設：左欄 ${left0.join('、')}；右欄 ${right0.join('、')}`);

// 2
const mprBox = await itemBox(mprId);
await dragTo(dvhId, { x: mprBox.x, y: mprBox.top + 8 });
const right1 = await column('right');
if (!same(right1, [dvhId, mprId])) throw new Error(`DVH 應在 MPR 前面：${right1}`);
const saved1 = JSON.parse((await evaluate(`localStorage.getItem('rtgaia.dock.v1')`)) ?? 'null');
if (!saved1?.placement?.[dvhId]) throw new Error('擺法要存進 rtgaia.dock.v1');
step(`拖 DVH 到 MPR 上半：右欄 ${right1.join('、')}（已存）`);

// 3
const dataBox = await itemBox('core.data');
await dragTo(mprId, { x: dataBox.x, y: dataBox.top + 8 });
const left2 = await column('left');
if (!same(left2, [mprId, 'core.data']) || !same(await column('right'), [dvhId])) throw new Error(`MPR 應移到左欄最上面：左 ${left2}`);
step(`拖 MPR 到左欄：左欄 ${left2.join('、')}；右欄 ${dvhId}`);
await shot('dock-moved.png');

// 4
await evaluate(`document.querySelector('[data-dock-item="core.data"] .dock-fold').click(); true`);
await sleep(200);
const folded = await evaluate(`(() => { const body = document.querySelector('[data-dock-item="core.data"] .dock-body'); return { hidden: body.hidden, mounted: !!body.querySelector('[data-panel-id="core.data"]'), h: body.getBoundingClientRect().height }; })()`);
if (!folded.hidden || !folded.mounted || folded.h !== 0) throw new Error(`摺起來要隱藏但不卸載：${JSON.stringify(folded)}`);
step('摺起「資料」：內容隱藏、面板沒卸載');
await evaluate(`document.querySelector('[data-dock-item="core.data"] .dock-fold').click(); true`);

// 5
const left5 = await itemBox('core.data');
await dragTo(dvhId, { x: left5.x, y: Math.min(left5.bottom - 4, 940) }); // 資料面板可能比視窗高：取看得到的下半部
if ((await column('right')).length !== 0) throw new Error(`DVH 移走後右欄應空：${await column('right')}`);
if (!(await evaluate(`!!document.querySelector('.sidebar-right[data-empty="true"]')`))) throw new Error('右欄空了應不佔位');
const dvhBar = await barCenter(dvhId);
await mouse('mouseMoved', dvhBar.x, dvhBar.y, { buttons: 0 });
await mouse('mousePressed', dvhBar.x, dvhBar.y, { clickCount: 1 });
await mouse('mouseMoved', dvhBar.x + 20, dvhBar.y + 5);
await sleep(200);
const zone = await evaluate(`(() => { const z = document.querySelector('[data-dock-drop="right"]'); if (!z) return null; const r = z.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
if (zone === null) throw new Error('拖曳中空的右欄要出現放置區');
for (let i = 1; i <= 10; i += 1) {
  await mouse('mouseMoved', dvhBar.x + ((zone.x - dvhBar.x) * i) / 10, dvhBar.y + ((zone.y - dvhBar.y) * i) / 10);
  await sleep(30);
}
await mouse('mouseReleased', zone.x, zone.y, { clickCount: 1 });
await sleep(400);
if (!same(await column('right'), [dvhId])) throw new Error(`拖到放置區應回右欄：${await column('right')}`);
step('DVH 移到左欄 → 右欄空（不佔位）；拖曳中右側出現放置區 → 拖回右欄');

// 6
const before6 = [await column('left'), await column('right')];
const target6 = await itemBox('core.data');
await dragTo(dvhId, { x: target6.x, y: target6.top + 8 }, { cancel: true });
if (!same([await column('left'), await column('right')], before6)) throw new Error('Esc 應取消拖曳');
step('拖曳中按 Esc：取消、擺法不變');

if (token) {
  await sleep(1500);
  const remote = await remotePrefs();
  const dock = JSON.parse(remote['rtgaia.dock.v1'] ?? 'null');
  if (dock?.placement?.[mprId]?.side !== 'left') throw new Error(`帳號偏好應存 dock 擺法：${remote['rtgaia.dock.v1']}`);
  step('帳號偏好（/auth/me/preferences）已存 dock 擺法');
}

// 7
await send('Page.reload');
await waitFor(`document.querySelectorAll('.viewport-cell canvas').length >= 3 && !!document.querySelector('[data-dock-item="core.data"]') && [...document.querySelectorAll('button')].some((x) => x.textContent.trim() === 'DVH')`, '重新整理後病例與左欄出現');
// 病例剛載入就點模式開關：其餘影像陸續到齊時 host 會重建，模式要帶過去 —— 點一次、等 4 s 還在
for (const b of ['MPR', 'DVH']) await clickButton(b);
await sleep(4000);
await waitFor(`!!document.querySelector('[data-dock-item="${mprId}"]') && !!document.querySelector('[data-dock-item="${dvhId}"]')`, '重新整理後 MPR、DVH 面板');
await sleep(300);
if (!same(await column('left'), [mprId, 'core.data']) || !same(await column('right'), [dvhId])) throw new Error(`重新整理後擺法應保留：左 ${await column('left')} 右 ${await column('right')}`);
step('重新整理後擺法還在');

// 8
await evaluate(`(() => { const s = document.querySelector('[data-dock-item="core.data"] select.dock-menu'); s.value = 'reset'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
await sleep(300);
if (!same(await column('left'), ['core.data']) || !same(await column('right'), [mprId, dvhId])) throw new Error(`回預設後：左 ${await column('left')} 右 ${await column('right')}`);
step('選單「所有面板回預設位置」：回到預設');
for (const b of ['MPR', 'DVH']) await clickButton(b);

if (errors.length > 0) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
