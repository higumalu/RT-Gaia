#!/usr/bin/env node
/**
 * 版面分割樹 —— headless Chrome ＋ CDP 真的拖分隔線（與 `verify-probe-rois.mjs` 同一套骨架、零相依）：
 *
 *   1. 開檢視器（要有病例）→ 2×2 版面有 3 條分隔線
 *   2. 滑鼠拖中間那條直的 +240px → 左欄變寬、放開才存（`rtgaia.layout.trees.v1`）；軸向格的 DOM 沒換（viewport 沒重掛）
 *   3. 軸向格選單「左右分割」→ 5 格、新格也是軸向、有 canvas；軸向格 DOM 還是同一個
 *   4. 新格選單「關閉這一格」→ 回到 4 格
 *   5. 雙擊那條分隔線 → 平分；方向鍵微調
 *   6. 重新整理 → 分割與大小還在（auth off：存在這個瀏覽器；給 `--token` 時另查帳號上的偏好 `/auth/me/preferences` 也有）
 *   7. 工具列「重設版面」→ 回到 2×2 原樣、存的樹清掉
 *
 * 需要一個開著病例的堆疊，例如：
 *   scripts/perf/stack.sh start && scripts/perf/stack.sh load
 *   node scripts/verify-layout-tree.mjs --url http://127.0.0.1:5183/#/viewer [--out-dir DIR]
 * 有帳號的堆疊（RTGAIA_AUTH=required）：`--token <rtgaia_session 值>`（該帳號要有開著的病例）；先清掉帳號上的版面偏好再開始。
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
if (token) {
  const r = await fetch(`${origin}/api/v1/auth/me/preferences`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...Object.fromEntries(LAYOUT_KEYS.map((k) => [k, null])), 'rtgaia.layout.current.v1': '2x2' }),
  });
  if (!r.ok) throw new Error(`清帳號偏好失敗：HTTP ${r.status}`);
}
const remotePrefs = async () =>
  (await (await fetch(`${origin}/api/v1/auth/me/preferences`, { headers: { authorization: `Bearer ${token}` } })).json()).preferences;

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-layout-'));
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
  await shot('layout-failed.png').catch(() => undefined);
  throw new Error(`等不到：${what}`);
};
const step = (s) => console.log(`✓ ${s}`);
const cells = () =>
  evaluate(`[...document.querySelectorAll('.viewport-tree > .viewport-cell')].map((c) => { const r = c.getBoundingClientRect(); return { id: c.dataset.cell, left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height), canvas: !!c.querySelector('canvas'), content: c.querySelector('select.cell-picker')?.value ?? '' }; })`);
const splitters = () =>
  evaluate(`[...document.querySelectorAll('.layout-splitter')].map((s) => { const r = s.getBoundingClientRect(); return { key: s.dataset.splitter, x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })`);
const saved = () => evaluate(`localStorage.getItem('rtgaia.layout.trees.v1')`);
const pick = (cellId, value) =>
  evaluate(`(() => { const s = document.querySelector('.viewport-cell[data-cell="${cellId}"] select.cell-picker'); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
const markAxial = () => evaluate(`(document.querySelector('.viewport-cell[data-cell="axial"]').__mark = 'kept', true)`);
const axialKept = () => evaluate(`document.querySelector('.viewport-cell[data-cell="axial"]')?.__mark === 'kept'`);
const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, ...extra });

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: "try { if (!localStorage.getItem('rtgaia.lang')) localStorage.setItem('rtgaia.lang', 'zh-TW'); localStorage.setItem('rtgaia.tour.v1', 'done'); if (!sessionStorage.getItem('layout-verify')) { sessionStorage.setItem('layout-verify', '1'); localStorage.removeItem('rtgaia.layout.trees.v1'); localStorage.removeItem('rtgaia.layout.overrides.v1'); localStorage.setItem('rtgaia.layout.current.v1', '2x2'); } } catch {}",
});
if (token) await send('Network.setCookie', { name: 'rtgaia_session', value: token, url: origin, httpOnly: true });
await send('Page.navigate', { url });
await waitFor(`document.querySelectorAll('.viewport-tree > .viewport-cell canvas').length >= 3`, '病例載入、2×2 版面畫出來（要先開一個病例）');
await sleep(800);

// 1
const c0 = await cells();
const s0 = await splitters();
if (c0.length !== 4 || s0.length !== 3) throw new Error(`2×2 應 4 格 3 條分隔線：${c0.length} 格 ${s0.length} 條`);
const ax0 = c0.find((c) => c.id === 'axial');
const co0 = c0.find((c) => c.id === 'coronal');
if (Math.abs(ax0.width - co0.width) > 3) throw new Error(`一開始左右等寬：${ax0.width} vs ${co0.width}`);
step(`2×2：4 格、3 條分隔線（軸向 ${ax0.width}×${ax0.height}）`);
await markAxial();

// 2
const rootLine = s0.find((s) => s.key === ':0');
// 避開十字交叉點（那裡是橫的分隔線）
const root = { ...rootLine, y: rootLine.y - rootLine.h / 4 };
await mouse('mouseMoved', root.x, root.y, { buttons: 0 });
await mouse('mousePressed', root.x, root.y, { clickCount: 1 });
for (let i = 1; i <= 8; i += 1) {
  await mouse('mouseMoved', root.x + 30 * i, root.y);
  await sleep(30);
}
const during = await saved();
await mouse('mouseReleased', root.x + 240, root.y, { clickCount: 1 });
await sleep(400);
const c1 = await cells();
const ax1 = c1.find((c) => c.id === 'axial');
if (ax1.width - ax0.width < 200) throw new Error(`拖完軸向格應寬約 240px：${ax0.width} → ${ax1.width}`);
if (during !== null) throw new Error('拖曳中不該存（放開才存）');
const tree1 = JSON.parse((await saved()) ?? '{}')['2x2'];
if (!tree1 || !(tree1.sizes[0] > 0.55)) throw new Error(`放開後要存比例：${await saved()}`);
if (!(await axialKept())) throw new Error('拖曳不該讓軸向格重掛');
step(`拖直分隔線 +240px：軸向 ${ax0.width} → ${ax1.width}px，存下比例 ${tree1.sizes.map((x) => x.toFixed(3)).join(' / ')}`);
await shot('layout-dragged.png');

// 3
await pick('axial', 'act:split-row');
await waitFor(`document.querySelectorAll('.viewport-tree > .viewport-cell').length === 5`, '分割出第 5 格');
await sleep(1200);
const c2 = await cells();
const fresh = c2.find((c) => !['axial', 'coronal', 'sagittal', 'volume3d'].includes(c.id));
const ax2 = c2.find((c) => c.id === 'axial');
if (!fresh || fresh.content !== 'vp:axial' || !fresh.canvas) throw new Error(`新格應是有 canvas 的軸向格：${JSON.stringify(fresh)}`);
if (Math.abs(fresh.left - (ax2.left + ax2.width)) > 4 || Math.abs(fresh.top - ax2.top) > 2) throw new Error('新格應在軸向格右邊');
if (!(await axialKept())) throw new Error('分割不該讓原本的軸向格重掛');
step(`軸向格「左右分割」：5 格，新格 ${fresh.id}（軸向、${fresh.width}×${fresh.height}），原格沒重掛`);
await shot('layout-split.png');

// 4
await pick(fresh.id, 'act:close');
await waitFor(`document.querySelectorAll('.viewport-tree > .viewport-cell').length === 4`, '關回 4 格');
await sleep(400);
const c3 = await cells();
const ax3 = c3.find((c) => c.id === 'axial');
if (Math.abs(ax3.width - ax1.width) > 3) throw new Error(`關掉後軸向格回到分割前的寬：${ax1.width} vs ${ax3.width}`);
step(`關閉新格：回到 4 格、軸向寬 ${ax3.width}px`);

// 5
const root2Line = (await splitters()).find((s) => s.key === ':0');
const root2 = { ...root2Line, y: root2Line.y - root2Line.h / 4 };
await mouse('mouseMoved', root2.x, root2.y, { buttons: 0 });
await mouse('mousePressed', root2.x, root2.y, { clickCount: 1 });
await mouse('mouseReleased', root2.x, root2.y, { clickCount: 1 });
await mouse('mousePressed', root2.x, root2.y, { clickCount: 2 });
await mouse('mouseReleased', root2.x, root2.y, { clickCount: 2 });
await sleep(400);
const c4 = await cells();
const ax4 = c4.find((c) => c.id === 'axial');
const co4 = c4.find((c) => c.id === 'coronal');
if (Math.abs(ax4.width - co4.width) > 3) throw new Error(`雙擊應平分：${ax4.width} vs ${co4.width}`);
await evaluate(`(() => { const s = document.querySelector('.layout-splitter[data-splitter="0:0"]'); s.focus(); s.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true })); return true; })()`);
await sleep(300);
const c5 = await cells();
const axH = c5.find((c) => c.id === 'axial').height;
if (axH - ax4.height < 40) throw new Error(`Shift+↓ 應讓軸向格變高約 10%：${ax4.height} → ${axH}`);
step(`雙擊分隔線平分（${ax4.width} / ${co4.width}px）；Shift+↓ 軸向高 ${ax4.height} → ${axH}px`);

if (token) {
  await sleep(1500); // savePref 合併 800ms 才送
  const remote = await remotePrefs();
  const tree = JSON.parse(remote['rtgaia.layout.trees.v1'] ?? '{}')['2x2'];
  if (!tree || tree.kind !== 'split') throw new Error(`帳號上應有 2×2 的樹：${JSON.stringify(remote)}`);
  step('帳號偏好（/auth/me/preferences）已存 2×2 的樹');
}

// 6
await send('Page.reload');
await waitFor(`document.querySelectorAll('.viewport-tree > .viewport-cell canvas').length >= 3`, '重新整理後版面畫出來');
await sleep(800);
const c6 = await cells();
const ax6 = c6.find((c) => c.id === 'axial');
if (Math.abs(ax6.height - axH) > 3) throw new Error(`重新整理後大小應保留：${axH} vs ${ax6.height}`);
step(`重新整理後大小還在（軸向高 ${ax6.height}px）`);

// 7
await evaluate(`[...document.querySelectorAll('button.layout-reset')][0].click(); true`);
await sleep(500);
const c7 = await cells();
const ax7 = c7.find((c) => c.id === 'axial');
const sag7 = c7.find((c) => c.id === 'sagittal');
if (Math.abs(ax7.height - sag7.height) > 3 || c7.length !== 4) throw new Error(`重設後應回到 2×2 原樣：${JSON.stringify(c7)}`);
const left = JSON.parse((await saved()) ?? '{}');
if (left['2x2'] !== undefined) throw new Error('重設後存的樹要清掉');
step('工具列「重設版面」：回到 2×2 原樣、存的樹清掉');
if (token) {
  await sleep(1500);
  const tree = JSON.parse((await remotePrefs())['rtgaia.layout.trees.v1'] ?? '{}')['2x2'];
  if (tree !== undefined) throw new Error('帳號上的樹也要清掉');
  step('帳號偏好的樹也清掉');
}

if (errors.length > 0) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
