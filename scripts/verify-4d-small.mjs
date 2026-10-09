#!/usr/bin/env node
/**
 * 4D 小項 —— headless Chrome ＋ CDP（骨架同 `verify-temporal-compose.mjs`、零相依）。
 * 逐出優先順序由 `verify-temporal-recover.mjs` 驗。
 *
 *   SYN4D-CT1（10 個相位）：
 *   1. 3D 格也有「相位」選單；鎖在第 6 幀 → 送去伺服器出圖的影像圖層 frame_index ＝ 5（以前 3D 只跟游標）→ 解除
 *   2. 軸向格鎖在第 6 幀 → ROI「新建」→ 新結構只屬第 6 幀；軸向格改鎖第 3 幀 → 筆刷在軸向格上拖 →
 *      提示列「「FrameProbe」不在這一幀（第 3 幀），筆刷沒有作用…」、後端體積仍是 0（以前什麼都不說）
 *   結束時刪掉 FrameProbe、解除鎖定。
 *
 *   scripts/perf/stack.sh start
 *   node scripts/verify-4d-small.mjs --url http://127.0.0.1:5183/#/library [--out-dir DIR] [--token <rtgaia_session>]
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
const port = Number(args.port ?? 9345);
const chrome = args.chrome ?? process.env.CHROME ?? 'google-chrome';
const token = args.token ?? process.env.TOKEN ?? null;
const origin = new URL(url).origin;

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-4d-small-'));
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
  await shot('4d-small-failed.png').catch(() => undefined);
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


const render3dBodies = [];
await send('Network.enable');
ws.addEventListener('message', (e) => {
  const m = JSON.parse(String(e.data));
  if (m.method === 'Network.requestWillBeSent' && /\/render3d(\?|$)/.test(m.params.request.url) && m.params.request.postData) render3dBodies.push(m.params.request.postData);
});
const setLock = (vp, value) =>
  evaluate(`(() => { const s = document.querySelector('.phase-lock[data-viewport="${vp}"] select'); if (!s) return false; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, '${value}'); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);

await openStudy('SYN4D-CT1', 'synth4d');
await waitFor(`!!${rowWith('temporal', '4D · 10 個相位')}`, 'SYN4D-CT1 的 4D 組');
await evaluate(`${rowWith('temporal', '4D · 10 個相位')}.querySelector('input[type=checkbox]').click(); true`);
await openCase(true);
const sid = await studyId();
for (const s of await evaluate(`fetch('/api/v1/studies/${sid}/structures').then((r) => r.json()).then((l) => (Array.isArray(l) ? l : l.structures ?? []).filter((x) => x.name === 'FrameProbe').map((x) => x.structure_id))`)) {
  await evaluate(`fetch('/api/v1/structures/${s}', { method: 'DELETE' }).then((r) => r.status)`);
}

// 1
const has3dCell = await evaluate(`!!document.querySelector('.render3d-view, .render3d')`) || (await evaluate(`[...document.querySelectorAll('.viewport-cell select')].some((s) => s.value === 'vp:3d')`));
const vp3d = await evaluate(`[...document.querySelectorAll('.phase-lock')].map((p) => p.dataset.viewport).find((v) => !['axial', 'coronal', 'sagittal'].includes(v)) ?? null`);
if (vp3d === null && has3dCell) throw new Error('3D 格沒有相位選單');
if (vp3d === null) {
  // 帳號的版面偏好沒有 3D 格（例如帳號把第四格換成了 BEV）—— 不去改別人的版面，略過這一步
  console.log('－ 略過 1：這個帳號的版面沒有 3D 格');
} else {
render3dBodies.length = 0;
await setLock(vp3d, '5');
let hit = false;
for (let i = 0; i < 80 && !hit; i += 1) {
  await sleep(250);
  hit = render3dBodies.some((b) => { try { return (JSON.parse(b).layers ?? []).some((l) => l.renderer === 'volume-3d' && l.frame_index === 5); } catch { return false; } });
}
if (!hit) throw new Error(`3D 格鎖第 6 幀後沒有送 frame_index 5（送了 ${render3dBodies.length} 次：${render3dBodies.map((b) => b.slice(0, 600)).join(" ‖ ")}）`);
await setLock(vp3d, 'follow');
step(`3D 格（${vp3d}）有相位選單；鎖在第 6 幀 → 伺服器出圖的影像 frame_index ＝ 5`);
}

// 2
await setLock('axial', '5');
await waitFor(`document.querySelector('.phase-lock[data-viewport="axial"] label')?.classList.contains('is-locked')`, '軸向格鎖第 6 幀');
await clickButton('document', 'ROI 編輯');
await waitFor(`!!document.querySelector('.roi-panel')`, 'ROI 編輯面板');
const ac = await centerOf(`${cellSel('軸向')}.querySelector('canvas')`);
await clickAt(ac.x + 30, ac.y + 20);
await clickButton(`document.querySelector('.roi-panel')`, '新建');
await waitFor(`!!document.querySelector('.roi-create .roi-name')`, '新建欄位');
await evaluate(`(() => { const el = document.querySelector('.roi-create .roi-name'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'FrameProbe'); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
await clickButton(`document.querySelector('.roi-create')`, '建立');
const probe = () => evaluate(`fetch('/api/v1/studies/${sid}/structures').then((r) => r.json()).then((l) => (Array.isArray(l) ? l : l.structures ?? []).find((x) => x.name === 'FrameProbe') ?? null)`);
await waitFor(`fetch('/api/v1/studies/${sid}/structures').then((r) => r.json()).then((l) => (Array.isArray(l) ? l : l.structures ?? []).some((x) => x.name === 'FrameProbe'))`, 'FrameProbe 建好', 15000);
const created = await probe();
if (JSON.stringify(created.frames) !== '[5]') throw new Error(`FrameProbe 應只屬第 6 幀：${JSON.stringify(created.frames)}`);
await setLock('axial', '2');
await waitFor(`document.querySelector('.phase-lock[data-viewport="axial"] select')?.value === '2'`, '軸向格改鎖第 3 幀');
await clickButton(`document.querySelector('.roi-panel')`, '筆刷');
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: ac.x, y: ac.y, button: 'left', buttons: 1, clickCount: 1 });
for (let i = 1; i <= 8; i += 1) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: ac.x + i * 3, y: ac.y + i, buttons: 1, button: 'left' });
  await sleep(30);
}
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: ac.x + 24, y: ac.y + 8, button: 'left', buttons: 0, clickCount: 1 });
await waitFor(`[...document.querySelectorAll('.notices span[data-kind="tool"]')].some((s) => s.textContent.includes('FrameProbe') && s.textContent.includes('第 3 幀'))`, '提示列說明筆刷沒有作用', 10000);
await shot('4d-small-brush-hint.png');
await sleep(1500);
const after = await probe();
const vol = Array.isArray(after.volume_cc) ? after.volume_cc[0] : after.volume_cc;
if (vol !== 0) throw new Error(`不該畫進去：${JSON.stringify(after.volume_cc)}`);
const note = await evaluate(`[...document.querySelectorAll('.notices span[data-kind="tool"]')].map((s) => s.textContent).join(' | ')`);
await clickButton(`document.querySelector('.roi-panel')`, '筆刷');
await clickButton('document', 'ROI 編輯');
await evaluate(`fetch('/api/v1/structures/${created.structure_id}', { method: 'DELETE' }).then((r) => r.status)`);
await setLock('axial', 'follow');
step(`軸向格鎖第 3 幀、FrameProbe 只在第 6 幀 → 筆刷沒寫、提示列「${note}」`);

if (errors.length > 0) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
